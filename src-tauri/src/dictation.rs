//! Dictation sidecar host.
//!
//! Doklin's voice input runs in a separate signed helper (`doklin-stt`, built
//! from src-tauri/stt-helper) that owns the microphone, WhisperKit STT, and
//! the MLX polish model. This module spawns it, pipes NDJSON commands in, and
//! fans its stdout events out to the webview as `dictation:event` — the same
//! streaming shape as the file watcher. `correct`/`summarize` are
//! request/response: the webview supplies an `id`, we park a oneshot in
//! `pending`, and the reader thread completes it when the matching event
//! arrives.
//!
//! The sidecar exits on its own when our end of stdin drops (app quit, crash),
//! so no explicit reaping is needed.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct Dictation {
    proc: Mutex<Option<SidecarProc>>,
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Value>>>,
}

struct SidecarProc {
    child: Child,
    stdin: ChildStdin,
}

/// Locate the sidecar binary. Bundled: next to the app binary in
/// Contents/MacOS (Tauri strips the target-triple suffix), with its SPM
/// resource bundles (MLX Metal kernels) in Contents/Resources. Dev: run it
/// straight from src-tauri/binaries/ — tauri-build also copies the executable
/// next to target/debug/doklin, but NOT the resource bundles, and the sidecar
/// resolves those relative to itself.
fn sidecar_path() -> Result<PathBuf, String> {
    // macOS-only (like reveal_in_finder); a port would branch on consts::OS.
    let triple = format!("{}-apple-darwin", std::env::consts::ARCH);
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(debug_assertions) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(format!("doklin-stt-{triple}")),
        );
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("doklin-stt"));
            candidates.push(dir.join(format!("doklin-stt-{triple}")));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| "doklin-stt sidecar not found — run scripts/build-stt.sh".to_string())
}

fn spawn_sidecar(app: &AppHandle, state: &Dictation) -> Result<(), String> {
    let mut guard = state.proc.lock().unwrap();
    if let Some(proc) = guard.as_mut() {
        // Alive? try_wait returns Ok(None) while running.
        if matches!(proc.child.try_wait(), Ok(None)) {
            return Ok(());
        }
        *guard = None;
    }

    let path = sidecar_path()?;
    let mut child = Command::new(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn {}: {}", path.display(), e))?;

    let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("sidecar stderr unavailable")?;

    // stdout: NDJSON events → webview; correct/summary also resolve pending
    // request oneshots by id.
    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let event = value.get("event").and_then(Value::as_str).unwrap_or("");
            if matches!(event, "correct" | "summary") {
                if let Some(id) = value.get("id").and_then(Value::as_str) {
                    let dict = handle.state::<Dictation>();
                    let sender = dict.pending.lock().unwrap().remove(id);
                    if let Some(tx) = sender {
                        let _ = tx.send(value.clone());
                    }
                }
            }
            let _ = handle.emit("dictation:event", &value);
        }
        // Pipe closed: the sidecar died or was shut down. Tell the UI so an
        // active session doesn't hang in "listening" forever.
        let _ = handle.emit("dictation:event", &serde_json::json!({ "event": "exited" }));
        let dict = handle.state::<Dictation>();
        dict.pending.lock().unwrap().clear();
        *dict.proc.lock().unwrap() = None;
    });

    // stderr: surfaced as log events (WhisperKit/MLX print progress here).
    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let _ = handle.emit(
                "dictation:event",
                &serde_json::json!({ "event": "stderr", "message": line }),
            );
        }
    });

    *guard = Some(SidecarProc { child, stdin });
    Ok(())
}

fn write_line(state: &Dictation, payload: &Value) -> Result<(), String> {
    let mut guard = state.proc.lock().unwrap();
    let proc = guard.as_mut().ok_or("dictation sidecar not running")?;
    let mut line = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    line.push('\n');
    proc.stdin
        .write_all(line.as_bytes())
        .and_then(|_| proc.stdin.flush())
        .map_err(|e| format!("sidecar write: {}", e))
}

/// Spawn (if needed) and send `init` — model names, data dir, debug flag. Safe
/// to call repeatedly; the sidecar ignores re-init of an already-loaded model.
/// Model *changes* need `dictation_shutdown` first (the UI does this).
#[tauri::command]
pub fn dictation_init(app: AppHandle, state: State<'_, Dictation>, mut config: Value) -> Result<(), String> {
    spawn_sidecar(&app, &state)?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {}", e))?;
    config["cmd"] = Value::from("init");
    config["dataDir"] = Value::from(data_dir.to_string_lossy().to_string());
    write_line(&state, &config)
}

/// Fire-and-forget session commands: start / gate / stop.
#[tauri::command]
pub fn dictation_cmd(state: State<'_, Dictation>, payload: Value) -> Result<(), String> {
    write_line(&state, &payload)
}

/// Request/response (correct, summarize): payload must carry a unique `id`.
/// Resolves with the sidecar's answer event, or errors on timeout — the
/// caller treats a timeout as "commit the raw text" (latency budget).
#[tauri::command]
pub async fn dictation_request(
    state: State<'_, Dictation>,
    payload: Value,
    timeout_ms: u64,
) -> Result<Value, String> {
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .ok_or("payload missing id")?
        .to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    state.pending.lock().unwrap().insert(id.clone(), tx);
    if let Err(e) = write_line(&state, &payload) {
        state.pending.lock().unwrap().remove(&id);
        return Err(e);
    }
    match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err("sidecar exited before answering".into()),
        Err(_) => {
            state.pending.lock().unwrap().remove(&id);
            Err("timeout".into())
        }
    }
}

/// True while the sidecar process is alive (models may still be loading).
#[tauri::command]
pub fn dictation_running(state: State<'_, Dictation>) -> bool {
    let mut guard = state.proc.lock().unwrap();
    match guard.as_mut() {
        Some(proc) => matches!(proc.child.try_wait(), Ok(None)),
        None => false,
    }
}

/// Graceful stop: ask the sidecar to exit (it finalizes the session first),
/// then force-kill if it lingers. Used when changing models and on app quit.
#[tauri::command]
pub fn dictation_shutdown(state: State<'_, Dictation>) -> Result<(), String> {
    let _ = write_line(&state, &serde_json::json!({ "cmd": "shutdown" }));
    let proc = state.proc.lock().unwrap().take();
    if let Some(mut proc) = proc {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let _ = proc.child.kill();
            let _ = proc.child.wait();
        });
    }
    state.pending.lock().unwrap().clear();
    Ok(())
}
