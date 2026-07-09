// Dictation settings modal (Settings → "Dictation settings…"). Follows
// ShareSetup's modal/field vocabulary. Everything here is a *default* —
// the HUD's Flow/Walkie and Fast/Polished toggles override per session.
//
// Nothing needs configuring for dictation to work: the defaults download
// both models on first use and run fully on-device.

import { useEffect, useState } from "react";
import {
  DEFAULT_DICTATION_CONFIG,
  saveDictationConfig,
  type DictationConfig,
  type DictationMode,
} from "./dictation";

// WhisperKit variants in argmaxinc/whisperkit-coreml. Turbo is the accuracy
// tier this feature exists for; small.en is a fallback for tight disks.
const STT_MODELS: { value: string; label: string }[] = [
  { value: "large-v3-v20240930", label: "Whisper large-v3-turbo — best accuracy (~1.5 GB)" },
  { value: "large-v3-v20240930_626MB", label: "Whisper large-v3-turbo compressed (~0.6 GB)" },
  { value: "small.en", label: "Whisper small English — fastest, lighter accuracy (~0.5 GB)" },
];

const LANGUAGES: { value: string; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "de", label: "German" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
  { value: "pt", label: "Portuguese" },
  { value: "hi", label: "Hindi" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
];

export default function DictationSetup({
  config,
  onClose,
  onSaved,
}: {
  config: DictationConfig;
  onClose: () => void;
  onSaved: (c: DictationConfig) => void;
}) {
  const [mode, setMode] = useState<DictationMode>(config.mode);
  const [polish, setPolish] = useState(config.polish);
  const [language, setLanguage] = useState(config.language);
  const [sttModel, setSttModel] = useState(config.sttModel);
  const [llmModel, setLlmModel] = useState(config.llmModel);
  const [budget, setBudget] = useState(String(config.latencyBudgetMs));
  const [inspector, setInspector] = useState(config.inspector);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (busy) return;
    const budgetMs = Math.max(500, Math.min(15000, Number(budget) || DEFAULT_DICTATION_CONFIG.latencyBudgetMs));
    const next: DictationConfig = {
      sttModel: sttModel.trim() || DEFAULT_DICTATION_CONFIG.sttModel,
      llmModel: llmModel.trim() || DEFAULT_DICTATION_CONFIG.llmModel,
      polish,
      mode,
      language,
      latencyBudgetMs: budgetMs,
      inspector,
    };
    setBusy(true);
    setError(null);
    try {
      await saveDictationConfig(next);
      onSaved(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="shared-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="setup-modal dictation-setup" role="dialog" aria-modal="true" aria-label="Dictation settings">
        <div className="shared-modal-header">
          <div className="shared-modal-title">Dictation</div>
          <button className="shared-modal-close" onClick={onClose} aria-label="Close">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="setup-body">
          <p className="setup-intro">
            Everything runs on this Mac — audio and text never leave it. Models download
            automatically on first use. The style and polish choices here are defaults; you can
            flip both mid-dictation from the recording bar.
          </p>

          <div className="share-field">
            <div className="share-field-label">Dictation style</div>
            <div className="dictation-choice" role="radiogroup" aria-label="Dictation style">
              <label className={`dictation-choice-opt ${mode === "walkie" ? "is-active" : ""}`}>
                <input type="radio" name="dictation-mode" checked={mode === "walkie"} onChange={() => setMode("walkie")} />
                <span>
                  <strong>Walkie-talkie</strong> — hold <kbd>Space</kbd> to talk, release to think.
                  The key never types into your note.
                </span>
              </label>
              <label className={`dictation-choice-opt ${mode === "flow" ? "is-active" : ""}`}>
                <input type="radio" name="dictation-mode" checked={mode === "flow"} onChange={() => setMode("flow")} />
                <span>
                  <strong>Flow</strong> — keeps listening until you finish; sentences commit on
                  natural pauses.
                </span>
              </label>
            </div>
          </div>

          <div className="share-field">
            <label className="dictation-check">
              <input type="checkbox" checked={polish} onChange={(e) => setPolish(e.target.checked)} />
              <span>
                <strong>Polish with an on-device language model</strong> — fixes misheard words,
                homophones, and technical terms using your document as context. Adds a beat of
                latency; turn it off (or flip to Fast in the bar) when speed matters more.
              </span>
            </label>
          </div>

          <div className="share-field">
            <div className="share-field-label">Spoken language</div>
            <select className="share-field-input" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </div>

          <div className="share-field">
            <div className="share-field-label">Speech model</div>
            <select className="share-field-input" value={STT_MODELS.some((m) => m.value === sttModel) ? sttModel : STT_MODELS[0].value} onChange={(e) => setSttModel(e.target.value)}>
              {STT_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          <div className="share-field">
            <div className="share-field-label">Polish model (MLX id on Hugging Face)</div>
            <input
              className="share-field-input"
              value={llmModel}
              onChange={(e) => setLlmModel(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={DEFAULT_DICTATION_CONFIG.llmModel}
            />
            <div className="setup-step-note">
              Default is Qwen3-4B (~2.3 GB) — the sweet spot. Try{" "}
              <code>mlx-community/Qwen3-8B-4bit</code> for tougher audio on a Mac with 24 GB+.
            </div>
          </div>

          <div className="share-field">
            <div className="share-field-label">Polish time budget (ms)</div>
            <input
              className="share-field-input dictation-budget"
              value={budget}
              onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
            />
            <div className="setup-step-note">
              If polishing a chunk takes longer than this, the raw transcription is committed
              instead — dictation never stalls on the model.
            </div>
          </div>

          <div className="share-field">
            <label className="dictation-check">
              <input type="checkbox" checked={inspector} onChange={(e) => setInspector(e.target.checked)} />
              <span>
                <strong>Show the dictation inspector</strong> (advanced) — a side panel logging
                every polish call: the exact prompt, the model's response, and why it was accepted
                or rejected.
              </span>
            </label>
          </div>

          {error && <div className="share-error">{error}</div>}
          <div className="share-buttons">
            <button className="share-btn is-primary" onClick={() => void save()} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button className="share-btn" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
