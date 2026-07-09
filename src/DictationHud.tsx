// The dictation HUD — the only chrome a session adds. Floats over the editor
// bottom; nothing in the idle layout ever moves. Shows the recording state
// (red = hearing you, amber = paused/thinking), a live level meter, and the
// current hint or error. The pending pill (✦ N = chunks waiting on polish)
// doubles as the skip button: polish has no time limit, so the user decides
// when raw-now beats polished-later.

import type { DictationUiState } from "./dictation";

const BARS = 5;

export default function DictationHud({
  ui,
  onFlush,
  onStop,
}: {
  ui: DictationUiState;
  onFlush: () => void;
  onStop: () => void;
}) {
  // Idle with an error still renders (how else would the user see it);
  // closing it dismisses the error.
  if (ui.session === "idle" && !ui.error) return null;
  const idleError = ui.session === "idle";

  const listening = ui.session === "active" && ui.gate === "listening";
  const starting = ui.session === "starting";
  const stopping = ui.session === "stopping";

  let status: string;
  let statusClass = "";
  if (ui.error) {
    status = ui.error;
    statusClass = "is-error";
  } else if (starting) {
    status = modelStatusLine(ui);
  } else if (stopping) {
    status = ui.pendingChunks > 0 ? "Finishing — polishing the last words…" : "Finishing…";
  } else if (listening) {
    status = "Listening…";
  } else {
    status = "Hold Space to talk · Esc to finish";
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
      <span className={`dictation-status ${statusClass}`}>{status}</span>
      {ui.pendingChunks > 0 && (
        <button
          className="dictation-pending"
          onClick={onFlush}
          title="Being polished — click to insert as-is right now"
        >
          ✦ {ui.pendingChunks}
        </button>
      )}
      <button
        className="dictation-close"
        onClick={onStop}
        title={idleError ? "Dismiss" : "Finish dictation (Esc)"}
        aria-label={idleError ? "Dismiss" : "Finish dictation"}
      >
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
  if (ui.llm.status === "downloading") {
    return `Speech ready — downloading polish model… ${Math.round(ui.llm.progress * 100)}%`;
  }
  return "Starting…";
}
