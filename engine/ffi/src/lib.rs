//! The engine behind a C interface, for an app with no Tauri: the iPhone's
//! (ios/, through `DoklinKit`'s `Engine`). Three functions, declared for C in
//! include/doklin_engine.h — change both:
//!
//! - `doklin_engine_start` once, with where things are kept and where events go;
//! - `doklin_engine_call` for every command, by name (the engine's
//!   command.rs), answered on a callback;
//! - `doklin_engine_free` for a string this side handed over.
//!
//! Every string crossing is UTF-8 and NUL-terminated. A string handed to a
//! callback is the callback's to read until it returns, and no longer.

use std::collections::BTreeSet;
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use doklin_engine::{Core, Host, Setup};
use serde_json::Value;

/// `(event name, payload as JSON)`.
pub type EventCallback = extern "C" fn(event: *const c_char, payload: *const c_char);
/// `(context, ok, answer)`: the command's answer as JSON when `ok`, else a
/// sentence saying why not.
pub type DoneCallback = extern "C" fn(context: *mut c_void, ok: bool, answer: *const c_char);

struct Running {
    core: Arc<Core>,
    /// Owned here so the engine's tasks live as long as the process does.
    runtime: tokio::runtime::Runtime,
}

static RUNNING: OnceLock<Running> = OnceLock::new();

/// The app, as the engine sees it: screens that listen on one callback, and
/// a folder nothing but the app writes into.
struct AppHost {
    on_event: EventCallback,
    /// Where cloud.json is: which workspaces are connected.
    data_dir: PathBuf,
}

impl Host for AppHost {
    fn emit(&self, event: &str, payload: Value) {
        let (Ok(event), Ok(payload)) = (CString::new(event), CString::new(payload.to_string())) else { return };
        (self.on_event)(event.as_ptr(), payload.as_ptr());
    }

    /// Every connected workspace is open for as long as the app runs.
    fn open_folders(&self) -> BTreeSet<String> {
        doklin_engine::cloud::connected_roots(&self.data_dir).into_iter().collect()
    }

    fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        std::fs::write(path, bytes).map_err(|e| format!("write {}: {}", path.display(), e))?;
        if let Some(running) = RUNNING.get() {
            running.core.touched(&path.to_string_lossy());
        }
        Ok(())
    }

    /// There is none to move a file to: a deletion is outright, and what was
    /// deleted is in the folder's version history.
    fn trash(&self, path: &Path) -> Result<(), String> {
        Err(format!("there is no trash to move {} to", path.display()))
    }
}

/// What `doklin_engine_start` is told, as JSON (camelCase keys).
#[derive(Default)]
struct Config {
    data_dir: String,
    join_dir: String,
    anchor: Option<String>,
    client: String,
    device_name: String,
}

impl Config {
    fn parse(text: &str) -> Result<Config, String> {
        let value: Value = serde_json::from_str(text).map_err(|e| format!("the engine's setup isn't JSON: {}", e))?;
        let text_of = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        let needed = |key: &str| {
            text_of(key).filter(|s| !s.is_empty()).ok_or_else(|| format!("the engine's setup has no `{}`", key))
        };
        Ok(Config {
            data_dir: needed("dataDir")?,
            join_dir: needed("joinDir")?,
            anchor: text_of("anchor").filter(|s| !s.is_empty()),
            client: needed("client")?,
            device_name: needed("deviceName")?,
        })
    }
}

fn start(config: &str, on_event: EventCallback) -> Result<(), String> {
    if RUNNING.get().is_some() {
        return Ok(());
    }
    let config = Config::parse(config)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("doklin-engine")
        .enable_all()
        .build()
        .map_err(|e| format!("the engine couldn't start: {}", e))?;
    let anchor = config.anchor.map(PathBuf::from);
    let data_dir = PathBuf::from(config.data_dir);
    let core = Core::new(Setup {
        data_dir: data_dir.clone(),
        // The folder the platform can move is the widest one the engine may
        // never delete, which is what `home` is for.
        home: anchor.clone(),
        join_dir: Some(PathBuf::from(config.join_dir)),
        anchor,
        client: config.client,
        device_name: config.device_name,
        watch: false,
        runtime: runtime.handle().clone(),
        host: Arc::new(AppHost { on_event, data_dir }),
    });
    if RUNNING.set(Running { core, runtime }).is_err() {
        return Ok(());
    }
    // Inside the runtime: the managers spawn their tasks as they start.
    let running = RUNNING.get().expect("just set");
    let _entered = running.runtime.enter();
    doklin_engine::cloud::init(&running.core);
    doklin_engine::versions::init(&running.core);
    Ok(())
}

/// A string for the other side to read and hand back to `doklin_engine_free`.
fn handed_over(text: String) -> *mut c_char {
    CString::new(text.replace('\0', "")).map(CString::into_raw).unwrap_or(std::ptr::null_mut())
}

/// # Safety
/// `text` is null or a NUL-terminated string that outlives the call.
unsafe fn text_of(text: *const c_char) -> String {
    if text.is_null() {
        return String::new();
    }
    CStr::from_ptr(text).to_string_lossy().into_owned()
}

/// Start the engine. `config` is JSON: `dataDir` (where the engine keeps its
/// own files), `joinDir` (where a workspace is downloaded), `anchor` (the
/// folder the platform can move, if it can), `client` (`x-doklin-client`) and
/// `deviceName`. Answers null, or a sentence saying why it did not start —
/// the caller's to free. A second call changes nothing and answers null.
///
/// # Safety
/// `config` is a NUL-terminated string; `on_event` stays callable for the
/// life of the process, from any thread.
#[no_mangle]
pub unsafe extern "C" fn doklin_engine_start(config: *const c_char, on_event: EventCallback) -> *mut c_char {
    match start(&text_of(config), on_event) {
        Ok(()) => std::ptr::null_mut(),
        Err(why) => handed_over(why),
    }
}

/// A caller's context, carried to the task that answers it.
struct Context(*mut c_void);
// The pointer is the caller's, and is only ever handed back to it.
unsafe impl Send for Context {}

/// Run the command called `name` with `args` (a JSON object) and answer on
/// `done`, once, from a thread of the engine's.
///
/// # Safety
/// `name` and `args` are NUL-terminated strings; `done` may be called from
/// any thread, and `context` is whatever it needs.
#[no_mangle]
pub unsafe extern "C" fn doklin_engine_call(
    name: *const c_char,
    args: *const c_char,
    context: *mut c_void,
    done: DoneCallback,
) {
    let (name, args) = (text_of(name), text_of(args));
    let context = Context(context);
    let answer = move |context: Context, outcome: Result<Value, String>| {
        let (ok, text) = match outcome {
            Ok(value) => (true, value.to_string()),
            Err(why) => (false, why),
        };
        let text = CString::new(text.replace('\0', "")).unwrap_or_default();
        done(context.0, ok, text.as_ptr());
    };
    let Some(running) = RUNNING.get() else {
        return answer(context, Err("the engine isn't running yet".to_string()));
    };
    running.runtime.spawn(async move {
        let outcome = match serde_json::from_str::<Value>(if args.is_empty() { "{}" } else { &args }) {
            Ok(args) => doklin_engine::command::call(&running.core, &name, args).await,
            Err(e) => Err(format!("the arguments of {} aren't JSON: {}", name, e)),
        };
        answer(context, outcome);
    });
}

/// Free a string `doklin_engine_start` answered with. Null is fine.
///
/// # Safety
/// `text` is null or a string this library handed over, not yet freed.
#[no_mangle]
pub unsafe extern "C" fn doklin_engine_free(text: *mut c_char) {
    if !text.is_null() {
        drop(CString::from_raw(text));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_setup_names_where_things_are_kept() {
        let config = Config::parse(
            r#"{"dataDir":"/d","joinDir":"/j","anchor":"/a","client":"ios/1.0","deviceName":"Ada's iPhone"}"#,
        )
        .unwrap();
        assert_eq!(config.data_dir, "/d");
        assert_eq!(config.join_dir, "/j");
        assert_eq!(config.anchor.as_deref(), Some("/a"));
        assert_eq!(config.client, "ios/1.0");
        assert_eq!(config.device_name, "Ada's iPhone");
    }

    #[test]
    fn a_setup_missing_a_part_says_which() {
        let why = Config::parse(r#"{"dataDir":"/d","client":"ios/1.0","deviceName":"x"}"#).err().unwrap();
        assert!(why.contains("joinDir"), "{}", why);
        assert!(Config::parse("not json").is_err());
    }
}
