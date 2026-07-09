// Voice dictation — config, sidecar wiring, and the session controller.
//
// The Rust side (src-tauri/src/dictation.rs) hosts the doklin-stt sidecar and
// forwards its NDJSON output as `dictation:event`. This module owns everything
// above that: the persisted config (<app_data_dir>/dictation.json, mirroring
// share.json), the session state machine (Flow / Walkie-talkie gating), the
// chunk pipeline (STT final → optional LLM polish → ordered commit into the
// editor), the guards that keep polish from ever making things worse, and the
// background rolling summary that gives the polish prompt document context.
//
// Polish has no per-chunk time limit: a chunk waits until its correction
// lands, visible as tinted ghost text and the HUD's pending pill. The user
// skips the wait explicitly (pill click / Fast / second Esc); a generous
// failsafe only catches a hung engine. Ending a session is a handshake —
// stop the sidecar, let its last `final` and the polish queue drain, then
// close — so the last utterance is never cut off.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { appDataDir, join } from "@tauri-apps/api/path";
import type { EditorHandle } from "./Editor";
import type { GhostSegment } from "./ghostText";

/* ---------- Config ---------- */

export type DictationMode = "flow" | "walkie";

export type DictationConfig = {
  /// WhisperKit variant in argmaxinc/whisperkit-coreml. The default is
  /// whisper large-v3-turbo (~1.5 GB, the accuracy tier this feature is for).
  sttModel: string;
  /// MLX model id for the polish pass.
  llmModel: string;
  /// Polish (LLM correction) on by default? Mirrors the last HUD choice.
  polish: boolean;
  /// Gating style for new sessions; mirrors the last HUD choice.
  mode: DictationMode;
  /// Whisper language hint; "auto" lets the model detect.
  language: string;
  /// Show the dictation inspector (advanced; prompt/response introspection).
  inspector: boolean;
};

export const DEFAULT_DICTATION_CONFIG: DictationConfig = {
  sttModel: "large-v3-v20240930",
  llmModel: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
  polish: true,
  mode: "walkie",
  language: "auto",
  inspector: false,
};

/// Polish has no UX timeout — this exists only to catch a hung engine, at
/// which point the chunk commits raw and the HUD says something went wrong.
const POLISH_FAILSAFE_MS = 30_000;

let configPromise: Promise<DictationConfig> | null = null;

export function getDictationConfig(): Promise<DictationConfig> {
  if (!configPromise) {
    configPromise = (async () => {
      try {
        const dir = await appDataDir();
        const path = await join(dir, "dictation.json");
        const result = await invoke<{ contents: string }>("read_file", { path });
        const parsed = JSON.parse(result.contents) as Partial<DictationConfig> | null;
        const merged = { ...DEFAULT_DICTATION_CONFIG, ...(parsed ?? {}) };
        // Known keys only, so retired settings don't linger in the file.
        return {
          sttModel: merged.sttModel,
          llmModel: merged.llmModel,
          polish: merged.polish,
          mode: merged.mode,
          language: merged.language,
          inspector: merged.inspector,
        };
      } catch {
        return { ...DEFAULT_DICTATION_CONFIG };
      }
    })();
  }
  return configPromise;
}

export async function saveDictationConfig(config: DictationConfig): Promise<void> {
  const dir = await appDataDir();
  const path = await join(dir, "dictation.json");
  await invoke("write_file", {
    path,
    contents: `${JSON.stringify(config, null, 2)}\n`,
    expected: null, // settings file: last write wins
  });
  configPromise = Promise.resolve(config);
}

/* ---------- Sidecar events ---------- */

type SidecarEvent = {
  event: string;
  [key: string]: unknown;
};

export type ModelStatus = {
  status: "idle" | "downloading" | "loading" | "ready" | "error";
  progress: number;
  message?: string;
};

/* ---------- Inspector ---------- */

export type InspectorEntry = {
  ts: number;
  kind: "correct" | "summary" | "event";
  title: string;
  detail?: Record<string, unknown>;
};

/* ---------- UI state ---------- */

export type DictationUiState = {
  session: "idle" | "starting" | "active" | "stopping";
  gate: "listening" | "paused";
  mode: DictationMode;
  polish: boolean;
  level: number;
  interim: string;
  pendingChunks: number;
  stt: ModelStatus;
  llm: ModelStatus;
  error: string | null;
};

export const INITIAL_DICTATION_UI: DictationUiState = {
  session: "idle",
  gate: "paused",
  mode: "walkie",
  polish: true,
  level: 0,
  interim: "",
  pendingChunks: 0,
  stt: { status: "idle", progress: 0 },
  llm: { status: "idle", progress: 0 },
  error: null,
};

/* ---------- Controller ---------- */

type Chunk = {
  id: number;
  raw: string;
  status: "polishing" | "done";
  text: string; // committed text (raw or corrected) once done
};

type ControllerDeps = {
  getEditor: () => EditorHandle | null;
  onState: (s: DictationUiState) => void;
  onInspect: (e: InspectorEntry) => void;
};

// Small models sometimes glue the surrounding context onto the corrected
// chunk despite instructions ("never copy context into your output"). Strip a
// leading echo of `before`'s tail sentences and a trailing echo of `after`'s
// head sentences — deterministic, so a well-behaved output passes untouched.
export function stripContextEcho(out: string, before: string, after: string): string {
  let s = out.trim();
  const beforeTail = before.trim();
  if (beforeTail) {
    const sentences = beforeTail.split(/(?<=[.!?…])\s+/).filter(Boolean);
    for (let i = 0; i < sentences.length; i++) {
      const tail = sentences.slice(i).join(" ").trim();
      if (tail.length >= 8 && s.toLowerCase().startsWith(tail.toLowerCase())) {
        s = s.slice(tail.length).trimStart();
        break;
      }
    }
  }
  const afterHead = after.trim();
  if (afterHead) {
    const sentences = afterHead.split(/(?<=[.!?…])\s+/).filter(Boolean);
    for (let i = sentences.length; i > 0; i--) {
      const head = sentences.slice(0, i).join(" ").trim();
      if (head.length >= 8 && s.toLowerCase().endsWith(head.toLowerCase())) {
        s = s.slice(0, s.length - head.length).trimEnd();
        break;
      }
    }
  }
  return s;
}

// Reject a "correction" that rewrote instead of corrected: a real fix keeps
// roughly the same shape. Character-length band + word-level overlap.
export function correctionLooksSafe(raw: string, out: string): boolean {
  if (!out) return false;
  const ratio = out.length / Math.max(1, raw.length);
  if (ratio < 0.55 || ratio > 1.8) return false;
  const rawWords = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const outWords = new Set(out.toLowerCase().split(/\s+/).filter(Boolean));
  if (rawWords.length >= 6) {
    let kept = 0;
    for (const w of rawWords) if (outWords.has(w)) kept++;
    if (kept / rawWords.length < 0.5) return false;
  }
  return true;
}

export class DictationController {
  private deps: ControllerDeps;
  private config: DictationConfig = { ...DEFAULT_DICTATION_CONFIG };
  private ui: DictationUiState = { ...INITIAL_DICTATION_UI };
  private unlisten: (() => void) | null = null;

  private chunkSeq = 0;
  private reqSeq = 0;
  private chunks: Chunk[] = [];

  // Stop handshake: the session closes once the sidecar confirmed it stopped
  // (its last `final` is in) AND the polish queue drained.
  private sidecarStopped = false;
  private stopFallback: number | null = null;
  private noticeTimer: number | null = null;

  // Rolling summary state — maintained in the background, invisible to the
  // user. `summary` is whatever the polish prompt gets; staleness is fine.
  private summary = "";
  private summaryDelta = "";
  private summaryTimer: number | null = null;
  private summaryInFlight = false;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
  }

  async init(): Promise<void> {
    this.config = await getDictationConfig();
    this.ui.mode = this.config.mode;
    this.ui.polish = this.config.polish;
    if (!this.unlisten) {
      this.unlisten = await listen<SidecarEvent>("dictation:event", (e) => {
        this.handleEvent(e.payload);
      });
    }
    this.push();
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  get state(): DictationUiState {
    return this.ui;
  }

  /// Re-read config (after the settings modal saves). Model changes require a
  /// sidecar restart; do that lazily — shut it down, next start re-inits.
  async reloadConfig(): Promise<void> {
    const before = this.config;
    configPromise = null;
    this.config = await getDictationConfig();
    if (this.ui.session === "idle") {
      this.ui.mode = this.config.mode;
      this.ui.polish = this.config.polish;
    }
    if (
      before.sttModel !== this.config.sttModel ||
      before.llmModel !== this.config.llmModel ||
      before.language !== this.config.language
    ) {
      this.ui.stt = { status: "idle", progress: 0 };
      this.ui.llm = { status: "idle", progress: 0 };
      try {
        await invoke("dictation_shutdown");
      } catch {
        // not running — fine
      }
    }
    this.push();
  }

  async toggle(): Promise<void> {
    if (this.ui.session === "idle") await this.start();
    else await this.stop();
  }

  async start(): Promise<void> {
    if (this.ui.session !== "idle") return;
    const editor = this.deps.getEditor();
    if (!editor) return;
    if (this.stopFallback != null) window.clearTimeout(this.stopFallback);
    this.stopFallback = null;
    this.ui = {
      ...INITIAL_DICTATION_UI,
      session: "starting",
      mode: this.config.mode,
      polish: this.config.polish,
      stt: this.ui.stt,
      llm: this.ui.llm,
    };
    this.push();
    try {
      await invoke("dictation_init", {
        config: {
          sttModel: this.config.sttModel,
          llmModel: this.config.llmModel,
          llmEnabled: this.config.polish,
          language: this.config.language,
          debug: this.config.inspector,
        },
      });
    } catch (e) {
      this.fail(String(e));
      return;
    }
    if (!editor.dictationBegin()) {
      this.fail("editor not ready");
      return;
    }
    this.chunks = [];
    this.summary = "";
    this.summaryDelta = "";
    // Session start is the earliest moment we can have a summary ready; the
    // doc snapshot seeds it while the models finish loading.
    this.scheduleSummary(true);
    // If the STT model is already resident this resolves instantly; otherwise
    // the HUD shows download/load progress and we begin once ready.
    this.waitForStt();
  }

  private waitForStt(): void {
    if (this.ui.session !== "starting") return;
    if (this.ui.stt.status === "ready") {
      void invoke("dictation_cmd", {
        payload: { cmd: "start", mode: this.ui.mode },
      }).catch((e) => this.fail(String(e)));
      this.ui.session = "active";
      this.ui.gate = this.ui.mode === "flow" ? "listening" : "paused";
      this.push();
      return;
    }
    if (this.ui.stt.status === "error") {
      this.fail(this.ui.stt.message ?? "speech model failed to load");
      return;
    }
    window.setTimeout(() => this.waitForStt(), 250);
  }

  /// Graceful finish: stop the sidecar (it finalizes the utterance in
  /// flight), wait for its last `final` and the polish queue to drain, then
  /// close. Called again while stopping (second Esc), it stops waiting and
  /// flushes pending chunks as raw text. `immediate` skips all waiting — for
  /// contexts like tab switches where the target editor is going away.
  async stop(immediate = false): Promise<void> {
    if (this.ui.session === "idle") {
      if (this.ui.error) {
        this.ui.error = null;
        this.push();
      }
      return;
    }
    if (this.ui.session === "stopping") {
      this.flushPending();
      this.finishStop();
      return;
    }
    this.ui.session = "stopping";
    this.sidecarStopped = false;
    this.push();
    try {
      await invoke("dictation_cmd", { payload: { cmd: "stop" } });
    } catch {
      // Sidecar already gone — nothing to wait for.
      this.finishStop();
      return;
    }
    if (immediate) {
      this.finishStop();
      return;
    }
    // The handshake may have completed during the await above.
    if (this.ui.session !== "stopping") return;
    // Failsafe only: the normal path ends via the sidecar's session-idle
    // handshake plus the last polish commit (see maybeFinishStop).
    this.stopFallback = window.setTimeout(() => this.finishStop(), POLISH_FAILSAFE_MS + 15_000);
  }

  private maybeFinishStop(): void {
    if (this.ui.session !== "stopping" || !this.sidecarStopped) return;
    if (this.chunks.length > 0) return;
    this.finishStop();
  }

  private finishStop(): void {
    if (this.ui.session === "idle") return;
    if (this.stopFallback != null) window.clearTimeout(this.stopFallback);
    this.stopFallback = null;
    for (const c of this.chunks) {
      if (c.status === "polishing") {
        c.status = "done";
        c.text = c.raw;
      }
    }
    this.commitReady();
    const editor = this.deps.getEditor();
    editor?.dictationEnd();
    this.chunks = [];
    if (this.summaryTimer != null) window.clearTimeout(this.summaryTimer);
    this.summaryTimer = null;
    this.ui = { ...this.ui, session: "idle", gate: "paused", interim: "", level: 0, pendingChunks: 0 };
    this.push();
  }

  /// Skip the polish queue: commit every pending chunk as raw text right now.
  /// (Pending-pill click, flipping to Fast mid-session, or a second Esc.)
  flushPending(): void {
    let flushed = false;
    for (const c of this.chunks) {
      if (c.status === "polishing") {
        c.status = "done";
        c.text = c.raw;
        flushed = true;
      }
    }
    if (!flushed) return;
    this.commitReady();
    this.refreshGhost();
    this.maybeFinishStop();
    this.push();
  }

  setGate(open: boolean): void {
    if (this.ui.session !== "active" || this.ui.mode !== "walkie") return;
    if ((this.ui.gate === "listening") === open) return;
    this.ui.gate = open ? "listening" : "paused";
    this.push();
    void invoke("dictation_cmd", { payload: { cmd: "gate", open } }).catch(() => {});
  }

  setMode(mode: DictationMode): void {
    if (this.ui.mode === mode) return;
    this.ui.mode = mode;
    if (this.ui.session === "active") {
      this.ui.gate = mode === "flow" ? "listening" : "paused";
      void invoke("dictation_cmd", { payload: { cmd: "mode", mode } }).catch(() => {});
    }
    this.persistToggles();
    this.push();
  }

  setPolish(polish: boolean): void {
    if (this.ui.polish === polish) return;
    this.ui.polish = polish;
    if (polish && this.ui.llm.status === "idle") {
      void invoke("dictation_cmd", { payload: { cmd: "load_llm" } }).catch(() => {});
    }
    // Fast means now — don't leave already-pending chunks waiting on polish.
    if (!polish) this.flushPending();
    this.persistToggles();
    this.push();
  }

  /// The HUD toggles are the real controls; remember them as the defaults for
  /// the next session (the settings modal no longer duplicates them).
  private persistToggles(): void {
    if (this.config.mode === this.ui.mode && this.config.polish === this.ui.polish) return;
    this.config = { ...this.config, mode: this.ui.mode, polish: this.ui.polish };
    void saveDictationConfig(this.config).catch(() => {});
  }

  /// Transient, non-fatal problem worth telling the user about — shown in the
  /// HUD status line for a few seconds.
  private notice(message: string): void {
    this.ui.error = message;
    if (this.noticeTimer != null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.noticeTimer = null;
      if (this.ui.error === message) {
        this.ui.error = null;
        this.push();
      }
    }, 6000);
    this.push();
  }

  /* ---------- Event handling ---------- */

  private handleEvent(ev: SidecarEvent): void {
    switch (ev.event) {
      case "model": {
        const comp = ev.component === "llm" ? "llm" : "stt";
        const status: ModelStatus = {
          status: (ev.status as ModelStatus["status"]) ?? "idle",
          progress: typeof ev.progress === "number" ? ev.progress : 0,
          message: typeof ev.message === "string" ? ev.message : undefined,
        };
        this.ui[comp] = status;
        this.push();
        break;
      }
      case "level": {
        const rms = typeof ev.rms === "number" ? ev.rms : 0;
        // Perceptual-ish scaling for the HUD meter.
        this.ui.level = Math.min(1, Math.sqrt(rms) * 3.2);
        this.push();
        break;
      }
      case "partial": {
        if (this.ui.session !== "active") break;
        const text = typeof ev.text === "string" ? ev.text : "";
        // Walkie: the gate is closed between utterances — a non-empty partial
        // arriving then is a stale echo of an already-finalized decode, and
        // painting it would strand ghost text.
        if (text && this.ui.mode === "walkie" && this.ui.gate === "paused") break;
        this.ui.interim = text;
        this.refreshGhost();
        this.push();
        break;
      }
      case "final": {
        if (this.ui.session !== "active" && this.ui.session !== "stopping") break;
        const raw = typeof ev.text === "string" ? ev.text.trim() : "";
        this.ui.interim = "";
        if (raw) this.acceptFinal(raw);
        this.refreshGhost();
        this.push();
        break;
      }
      case "session": {
        // Sidecar's view of the gate (e.g. force-finalize near the 30s window
        // doesn't change it; gate/mode acks do). Trust it while active.
        if (this.ui.session === "active" && (ev.state === "listening" || ev.state === "paused")) {
          this.ui.gate = ev.state;
          this.push();
        }
        // Stop handshake: the sidecar has finalized and gone idle — its last
        // `final` (if any) is already in, so only the polish queue remains.
        if (ev.state === "idle" && this.ui.session === "stopping") {
          this.sidecarStopped = true;
          this.maybeFinishStop();
        }
        break;
      }
      case "exited": {
        if (this.ui.session === "stopping") {
          this.finishStop();
        } else if (this.ui.session !== "idle") {
          this.fail("dictation engine stopped unexpectedly");
        }
        this.ui.stt = { status: "idle", progress: 0 };
        this.ui.llm = { status: "idle", progress: 0 };
        this.push();
        break;
      }
      case "error": {
        const scope = String(ev.scope ?? "");
        const message = String(ev.message ?? "");
        if (scope === "mic") {
          // No microphone = no session; without this the UI waits forever.
          this.fail(message || "microphone unavailable");
        } else if (scope === "stt" && this.ui.session !== "idle") {
          this.notice(message || "transcription failed");
        }
        this.deps.onInspect({
          ts: Date.now(),
          kind: "event",
          title: `error(${scope}): ${message}`,
        });
        break;
      }
      case "stderr":
      case "log": {
        if (this.config.inspector) {
          this.deps.onInspect({
            ts: Date.now(),
            kind: "event",
            title: String(ev.message ?? "").slice(0, 300),
          });
        }
        break;
      }
      default:
        break;
    }
  }

  /* ---------- Chunk pipeline ---------- */

  private acceptFinal(raw: string): void {
    const chunk: Chunk = { id: this.chunkSeq++, raw, status: "polishing", text: raw };
    this.chunks.push(chunk);
    const polishing = this.ui.polish && this.ui.llm.status === "ready";
    if (!polishing) {
      chunk.status = "done";
      this.commitReady();
      return;
    }
    this.refreshGhost();
    void this.polish(chunk);
  }

  private async polish(chunk: Chunk): Promise<void> {
    const editor = this.deps.getEditor();
    const ctx = editor?.dictationContext();
    const id = `c${this.reqSeq++}`;
    const started = performance.now();
    let decision = "";
    let res: Record<string, unknown> | null = null;
    try {
      res = await invoke<Record<string, unknown>>("dictation_request", {
        payload: {
          cmd: "correct",
          id,
          chunk: chunk.raw,
          summary: this.summary,
          headingPath: ctx?.headingPath ?? "",
          before: ctx?.before ?? "",
          after: ctx?.after ?? "",
        },
        timeoutMs: POLISH_FAILSAFE_MS,
      });
    } catch (e) {
      if (String(e) === "timeout") {
        decision = `failsafe (${POLISH_FAILSAFE_MS / 1000}s) — engine unresponsive, committed raw`;
        this.notice("Polish is not responding — inserted the raw transcription.");
      } else {
        decision = `error: ${String(e)}`;
      }
    }
    // The user may have skipped this chunk (pill click / Fast / second Esc)
    // while we waited — it's already committed raw; drop the late result.
    if (chunk.status !== "polishing") {
      this.inspectCorrection(chunk, res, decision || "late — chunk was already committed raw", performance.now() - started);
      return;
    }
    if (res) {
      const rawOut = typeof res.text === "string" ? res.text.trim() : "";
      const out = stripContextEcho(rawOut, ctx?.before ?? "", ctx?.after ?? "");
      if (res.ok && correctionLooksSafe(chunk.raw, out)) {
        chunk.text = out;
        decision = out === chunk.raw ? "accepted (unchanged)" : "accepted";
      } else {
        decision = res.ok ? "rejected: rewrite guard" : `failed: ${String(res.message ?? "")}`;
      }
    }
    this.inspectCorrection(chunk, res, decision, performance.now() - started);
    chunk.status = "done";
    this.commitReady();
    this.refreshGhost();
    this.maybeFinishStop();
    this.push();
  }

  /// Commit finished chunks in order; a still-polishing chunk blocks the ones
  /// behind it so text never lands out of sequence.
  private commitReady(): void {
    const editor = this.deps.getEditor();
    while (this.chunks.length > 0 && this.chunks[0].status === "done") {
      const chunk = this.chunks.shift()!;
      if (chunk.text) {
        editor?.dictationCommit(chunk.text);
        this.summaryDelta += (this.summaryDelta ? " " : "") + chunk.text;
        this.scheduleSummary(false);
      }
    }
    this.ui.pendingChunks = this.chunks.length;
  }

  private refreshGhost(): void {
    const editor = this.deps.getEditor();
    if (!editor) return;
    const segments: GhostSegment[] = this.chunks
      .filter((c) => c.status === "polishing")
      .map((c) => ({ id: `chunk-${c.id}`, text: c.raw, state: "polishing" as const }));
    if (this.ui.interim) {
      segments.push({ id: "interim", text: this.ui.interim, state: "listening" });
    }
    editor.dictationSetGhost(segments);
    this.ui.pendingChunks = this.chunks.filter((c) => c.status === "polishing").length;
  }

  /* ---------- Rolling summary (background, low priority) ---------- */

  private scheduleSummary(initial: boolean): void {
    if (!this.ui.polish) return;
    if (this.summaryTimer != null) window.clearTimeout(this.summaryTimer);
    this.summaryTimer = window.setTimeout(() => {
      this.summaryTimer = null;
      void this.runSummary(initial);
    }, initial ? 400 : 3000);
  }

  private async runSummary(initial: boolean): Promise<void> {
    if (this.summaryInFlight || this.ui.llm.status !== "ready") {
      // Model busy/not up yet — try again later; staleness is acceptable.
      if (this.ui.session !== "idle") this.scheduleSummary(initial);
      return;
    }
    const editor = this.deps.getEditor();
    if (!editor) return;
    const delta = this.summaryDelta;
    this.summaryDelta = "";
    if (!initial && !delta) return;
    const docText = initial ? (editor.dictationContext()?.docText ?? "") : "";
    if (initial && !docText.trim()) return; // empty doc: nothing to summarize yet
    this.summaryInFlight = true;
    const id = `s${this.reqSeq++}`;
    try {
      const res = await invoke<Record<string, unknown>>("dictation_request", {
        payload: {
          cmd: "summarize",
          id,
          summary: initial ? "" : this.summary,
          delta,
          docText,
        },
        timeoutMs: 30_000,
      });
      if (res.ok && typeof res.summary === "string" && res.summary.trim()) {
        this.summary = res.summary.trim();
      }
      this.deps.onInspect({
        ts: Date.now(),
        kind: "summary",
        title: `summary ${initial ? "seeded" : "rolled"} (${String(res.ms ?? "?")}ms)`,
        detail: { summary: this.summary, prompt: res.prompt, ok: res.ok },
      });
    } catch {
      // Put the delta back so the next commit retries it.
      this.summaryDelta = delta + (this.summaryDelta ? ` ${this.summaryDelta}` : "");
    } finally {
      this.summaryInFlight = false;
    }
  }

  /* ---------- misc ---------- */

  private inspectCorrection(
    chunk: Chunk,
    res: Record<string, unknown> | null,
    decision: string,
    elapsedMs: number,
  ): void {
    this.deps.onInspect({
      ts: Date.now(),
      kind: "correct",
      title: `polish #${chunk.id}: ${decision} (${Math.round(elapsedMs)}ms)`,
      detail: {
        raw: chunk.raw,
        corrected: res?.text,
        decision,
        summaryUsed: this.summary,
        prompt: res?.prompt,
        modelRaw: res?.raw,
        sidecarMs: res?.ms,
      },
    });
  }

  private fail(message: string): void {
    if (this.stopFallback != null) window.clearTimeout(this.stopFallback);
    this.stopFallback = null;
    const editor = this.deps.getEditor();
    editor?.dictationEnd();
    this.chunks = [];
    this.ui = { ...this.ui, session: "idle", gate: "paused", interim: "", error: message };
    this.push();
  }

  private push(): void {
    this.deps.onState({ ...this.ui });
  }
}
