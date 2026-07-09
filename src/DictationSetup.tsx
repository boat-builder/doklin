// Dictation settings modal (Settings → "Dictation settings…"). Follows
// ShareSetup's modal/field vocabulary. Session controls live in the recording
// bar, not here: Flow ⇄ Walkie and Fast ⇄ Polished are flipped there and
// remembered between sessions. This modal only holds what you set rarely —
// which models, which language, and the debug inspector.
//
// Nothing needs configuring for dictation to work: the defaults download
// both models on first use and run fully on-device.

import { useEffect, useState } from "react";
import {
  DEFAULT_DICTATION_CONFIG,
  saveDictationConfig,
  type DictationConfig,
} from "./dictation";

// WhisperKit variants in argmaxinc/whisperkit-coreml. Turbo is the accuracy
// tier this feature exists for; small.en is a fallback for tight disks.
const STT_MODELS: { value: string; label: string }[] = [
  { value: "large-v3-v20240930", label: "Whisper large-v3-turbo — best accuracy (~1.5 GB)" },
  { value: "large-v3-v20240930_626MB", label: "Whisper large-v3-turbo compressed (~0.6 GB)" },
  { value: "small.en", label: "Whisper small English — fastest, lighter accuracy (~0.5 GB)" },
];

// MLX ids on Hugging Face. 4B is the speed/accuracy sweet spot; 8B is
// noticeably better on tough audio and technical terms if the RAM is there.
const LLM_MODELS: { value: string; label: string }[] = [
  { value: "mlx-community/Qwen3-4B-Instruct-2507-4bit", label: "Qwen3 4B — fast, great for most dictation (~2.3 GB)" },
  { value: "mlx-community/Qwen3-8B-4bit", label: "Qwen3 8B — best accuracy, wants 24 GB+ RAM (~4.5 GB)" },
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
  const [language, setLanguage] = useState(config.language);
  const [sttModel, setSttModel] = useState(config.sttModel);
  const [llmModel, setLlmModel] = useState(config.llmModel);
  const [inspector, setInspector] = useState(config.inspector);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A hand-edited dictation.json may name a model outside the presets; keep
  // it selectable instead of silently overwriting it on save.
  const sttOptions = STT_MODELS.some((m) => m.value === sttModel)
    ? STT_MODELS
    : [...STT_MODELS, { value: sttModel, label: `Custom — ${sttModel}` }];
  const llmOptions = LLM_MODELS.some((m) => m.value === llmModel)
    ? LLM_MODELS
    : [...LLM_MODELS, { value: llmModel, label: `Custom — ${llmModel}` }];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (busy) return;
    const next: DictationConfig = {
      sttModel: sttModel.trim() || DEFAULT_DICTATION_CONFIG.sttModel,
      llmModel: llmModel.trim() || DEFAULT_DICTATION_CONFIG.llmModel,
      polish: config.polish,
      mode: config.mode,
      language,
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
            automatically on first use. Dictation style (Flow / Walkie-talkie) and Fast / Polished
            are switched in the recording bar and remembered for next time.
          </p>

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
            <select className="share-field-input" value={sttModel} onChange={(e) => setSttModel(e.target.value)}>
              {sttOptions.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          <div className="share-field">
            <div className="share-field-label">Polish model</div>
            <select className="share-field-input" value={llmModel} onChange={(e) => setLlmModel(e.target.value)}>
              {llmOptions.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <div className="setup-step-note">
              The polish pass only fixes what the speech model misheard — it never rewrites.
              Chunks wait for it as ghost text; the ✦ pill in the recording bar skips the wait.
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
