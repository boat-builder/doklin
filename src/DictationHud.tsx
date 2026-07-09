// The dictation HUD — the only chrome a session adds. Floats over the editor
// bottom; nothing in the idle layout ever moves. Shows the recording state
// (red = hearing you, amber = paused/thinking), a live level meter, the
// current hint or error, and the two per-session toggles that get flipped
// often enough to live here: Flow ⇄ Walkie and Fast ⇄ Polished.

import type { DictationMode, DictationUiState } from "./dictation";

const BARS = 5;

export default function DictationHud({
  ui,
  onSetMode,
  onSetPolish,
  onStop,
}: {
  ui: DictationUiState;
  onSetMode: (m: DictationMode) => void;
  onSetPolish: (p: boolean) => void;
  onStop: () => void;
}) {
  if (ui.session === "idle") return null;

  const listening = ui.session === "active" && ui.gate === "listening";
  const starting = ui.session === "starting";

  let status: string;
  if (starting) {
    status = modelStatusLine(ui);
  } else if (ui.interim) {
    status = ui.interim;
  } else if (listening) {
    status = "Listening…";
  } else if (ui.mode === "walkie") {
    status = "Hold Space to talk · Esc to finish";
  } else {
    status = "Paused";
  }

  return (
    <div
      className={`dictation-hud ${listening ? "is-listening" : "is-paused"}`}
      role="status"
      aria-label="Dictation"
    >
      <span className="dictation-dot" aria-hidden />
      <span className="dictation-meter" aria-hidden>
        {Array.from({ length: BARS }, (_, i) => {
          // Center-weighted bars driven by the mic level.
          const weight = 1 - Math.abs(i - (BARS - 1) / 2) / BARS;
          const h = listening ? 3 + ui.level * 13 * (0.55 + weight) : 3;
          return <span key={i} className="dictation-bar" style={{ height: `${h}px` }} />;
        })}
      </span>
      <span className={`dictation-status ${ui.interim ? "is-interim" : ""}`}>{status}</span>
      {ui.pendingChunks > 0 && (
        <span className="dictation-pending" title="Chunks being polished">
          ✦ {ui.pendingChunks}
        </span>
      )}
      <span className="dictation-seg" role="group" aria-label="Dictation style">
        <button
          className={`dictation-seg-btn ${ui.mode === "flow" ? "is-active" : ""}`}
          onClick={() => onSetMode("flow")}
          title="Flow: keeps listening until you stop"
        >
          Flow
        </button>
        <button
          className={`dictation-seg-btn ${ui.mode === "walkie" ? "is-active" : ""}`}
          onClick={() => onSetMode("walkie")}
          title="Walkie: hold Space to talk, release to think"
        >
          Walkie
        </button>
      </span>
      <span className="dictation-seg" role="group" aria-label="Polish">
        <button
          className={`dictation-seg-btn ${!ui.polish ? "is-active" : ""}`}
          onClick={() => onSetPolish(false)}
          title="Commit raw transcription immediately"
        >
          Fast
        </button>
        <button
          className={`dictation-seg-btn ${ui.polish ? "is-active" : ""}`}
          onClick={() => onSetPolish(true)}
          title="Run each chunk through the on-device polish model"
        >
          Polished
        </button>
      </span>
      <button className="dictation-close" onClick={onStop} title="Finish dictation (Esc)" aria-label="Finish dictation">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

function modelStatusLine(ui: DictationUiState): string {
  const stt = ui.stt;
  if (stt.status === "downloading") {
    return `Downloading speech model… ${Math.round(stt.progress * 100)}%`;
  }
  if (stt.status === "loading") return "Preparing speech model…";
  if (stt.status === "error") return `Speech model failed: ${stt.message ?? "unknown error"}`;
  if (ui.polish && ui.llm.status === "downloading") {
    return `Speech ready — downloading polish model… ${Math.round(ui.llm.progress * 100)}%`;
  }
  return "Starting…";
}
