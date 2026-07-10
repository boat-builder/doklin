// Dictation settings modal (Settings → "Dictation settings…"). A compact
// preferences card in the shared-modal shell: grouped rows with the control
// on the right, macOS-settings style. This modal only holds what you set
// rarely — which models, which language, the polish instructions, and the
// debug inspector.
//
// Long-form settings drill in instead of inlining: a row navigates to a
// subview inside the same modal (back arrow in the header, Escape backs out
// one level). The polish-instructions editor is the first such subview; a
// future exposed prompt would follow the same pattern with its own row.
//
// Nothing needs configuring for dictation to work: the defaults download
// both models on first use and run fully on-device.

import { useEffect, useState } from "react";
import {
  DEFAULT_DICTATION_CONFIG,
  saveDictationConfig,
  type DictationConfig,
} from "./dictation";
import { DEFAULT_POLISH_PROMPT, POLISH_REQUEST_TEMPLATE } from "./prompts";

type ModelOption = { value: string; label: string; detail: string };

// WhisperKit variants in argmaxinc/whisperkit-coreml. Turbo is the accuracy
// tier this feature exists for; small.en is a fallback for tight disks.
const STT_MODELS: ModelOption[] = [
  { value: "large-v3-v20240930", label: "Whisper large-v3-turbo", detail: "Best accuracy · ~1.5 GB" },
  { value: "large-v3-v20240930_626MB", label: "Whisper large-v3-turbo compressed", detail: "Near-turbo accuracy · ~0.6 GB" },
  { value: "small.en", label: "Whisper small (English)", detail: "Fastest, lighter accuracy · ~0.5 GB" },
];

// MLX ids on Hugging Face. 4B is the speed/accuracy sweet spot; 8B is
// noticeably better on tough audio and technical terms if the RAM is there.
const LLM_MODELS: ModelOption[] = [
  { value: "mlx-community/Qwen3-4B-Instruct-2507-4bit", label: "Qwen3 4B", detail: "Fast, great for most dictation · ~2.3 GB" },
  { value: "mlx-community/Qwen3-8B-4bit", label: "Qwen3 8B", detail: "Best accuracy, wants 24 GB+ RAM · ~4.5 GB" },
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

// A hand-edited dictation.json may name a model outside the presets; keep
// it selectable instead of silently overwriting it on save.
function withCustom(options: ModelOption[], value: string): ModelOption[] {
  if (options.some((m) => m.value === value)) return options;
  return [...options, { value, label: "Custom", detail: value }];
}

export default function DictationSetup({
  config,
  onClose,
  onSaved,
}: {
  config: DictationConfig;
  onClose: () => void;
  onSaved: (c: DictationConfig) => void;
}) {
  const [view, setView] = useState<"main" | "prompt">("main");
  const [language, setLanguage] = useState(config.language);
  const [sttModel, setSttModel] = useState(config.sttModel);
  const [llmModel, setLlmModel] = useState(config.llmModel);
  const [prompt, setPrompt] = useState(config.polishPrompt || DEFAULT_POLISH_PROMPT);
  const [inspector, setInspector] = useState(config.inspector);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sttOptions = withCustom(STT_MODELS, sttModel);
  const llmOptions = withCustom(LLM_MODELS, llmModel);
  const sttDetail = sttOptions.find((m) => m.value === sttModel)?.detail;
  const llmDetail = llmOptions.find((m) => m.value === llmModel)?.detail;

  // An emptied editor also counts as default: "" is stored, and the sidecar
  // then runs the built-in text — never a blank system prompt.
  const promptCustomized =
    prompt.trim() !== "" && prompt.trim() !== DEFAULT_POLISH_PROMPT;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (view === "prompt") setView("main");
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, view]);

  const save = async () => {
    if (busy) return;
    const trimmedPrompt = prompt.trim();
    const next: DictationConfig = {
      sttModel: sttModel.trim() || DEFAULT_DICTATION_CONFIG.sttModel,
      llmModel: llmModel.trim() || DEFAULT_DICTATION_CONFIG.llmModel,
      language,
      polishPrompt: trimmedPrompt === DEFAULT_POLISH_PROMPT ? "" : trimmedPrompt,
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
      <div
        className={`shared-modal dictation-setup${view === "prompt" ? " dictation-setup--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Dictation settings"
      >
        <div className="shared-modal-header">
          {view === "prompt" && (
            <button className="dictation-back" onClick={() => setView("main")} aria-label="Back to dictation settings">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}
          <div className="shared-modal-title">
            {view === "prompt" ? "Polish instructions" : "Dictation"}
          </div>
          <button className="shared-modal-close" onClick={onClose} aria-label="Close">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {view === "main" ? (
          <div className="dictation-setup-body">
            <p className="dictation-intro">
              Hold Space to talk; release and the polish pass tidies the transcript.
              Everything runs on this Mac — audio and text never leave it, and models
              download automatically on first use.
            </p>

            <div className="dictation-rows">
              <div className="dictation-row">
                <label className="dictation-row-label" htmlFor="dictation-language">Spoken language</label>
                <span className="dictation-select">
                  <select id="dictation-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
                    {LANGUAGES.map((l) => (
                      <option key={l.value} value={l.value}>{l.label}</option>
                    ))}
                  </select>
                </span>
              </div>

              <div className="dictation-row">
                <label className="dictation-row-label" htmlFor="dictation-stt">Speech model</label>
                <span className="dictation-select">
                  <select id="dictation-stt" value={sttModel} onChange={(e) => setSttModel(e.target.value)}>
                    {sttOptions.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </span>
                {sttDetail && <div className="dictation-row-caption">{sttDetail}</div>}
              </div>

              <div className="dictation-row">
                <label className="dictation-row-label" htmlFor="dictation-llm">Polish model</label>
                <span className="dictation-select">
                  <select id="dictation-llm" value={llmModel} onChange={(e) => setLlmModel(e.target.value)}>
                    {llmOptions.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </span>
                {llmDetail && <div className="dictation-row-caption">{llmDetail}</div>}
              </div>

              <button type="button" className="dictation-row dictation-row--nav" onClick={() => setView("prompt")}>
                <span className="dictation-row-label">Polish instructions</span>
                <span className="dictation-row-value">
                  {promptCustomized ? "Customized" : "Default"}
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <polyline points="9 6 15 12 9 18" />
                  </svg>
                </span>
                <span className="dictation-row-caption">
                  What the polish pass is told to fix and preserve.
                </span>
              </button>

              <label className="dictation-row dictation-row--toggle">
                <span className="dictation-row-label">Dictation inspector</span>
                <span className="dictation-switch">
                  <input
                    type="checkbox"
                    checked={inspector}
                    onChange={(e) => setInspector(e.target.checked)}
                  />
                  <span className="dictation-switch-track" aria-hidden />
                </span>
                <span className="dictation-row-caption">
                  Advanced — a side panel logging every polish call: the exact prompt,
                  the model's response, and why it was accepted or rejected.
                </span>
              </label>
            </div>

            <p className="dictation-footnote">
              The polish pass cleans the transcript — fillers, stutters, self-corrections,
              misheard words — without rewriting what you meant to say. Chunks wait for it
              as ghost text; the ✦ pill in the recording bar skips the wait.
            </p>

            {error && <div className="share-error">{error}</div>}
          </div>
        ) : (
          <div className="dictation-setup-body">
            <p className="dictation-intro">
              These instructions are the system prompt for every polish call. Edit what
              the model is told to fix and preserve — the dictated chunk and document
              context are attached automatically and can't be changed here.
            </p>

            <textarea
              className="dictation-prompt-editor"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              spellCheck={false}
              aria-label="Polish instructions"
            />
            <div className="dictation-prompt-meta">
              <span>{promptCustomized ? "Customized" : "Default instructions"}</span>
              {promptCustomized && (
                <button
                  type="button"
                  className="dictation-prompt-reset"
                  onClick={() => setPrompt(DEFAULT_POLISH_PROMPT)}
                >
                  Reset to default
                </button>
              )}
            </div>

            <div className="dictation-template">
              <div className="dictation-template-title">Attached to every request</div>
              <div className="dictation-template-body">
                {POLISH_REQUEST_TEMPLATE.map((part) => (
                  <div key={part.heading} className="dictation-template-part">
                    <div>{part.heading}</div>
                    <div>
                      {part.chunk && <span className="dictation-template-lit">&lt;chunk&gt;</span>}
                      <span className="dictation-template-var">{part.token}</span>
                      {part.chunk && <span className="dictation-template-lit">&lt;/chunk&gt;</span>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="dictation-template-note">
                Context lines are included only when they have content; the polish model
                answers with the cleaned chunk text alone.
              </div>
            </div>

            {error && <div className="share-error">{error}</div>}
          </div>
        )}

        <div className="dictation-footer">
          <button className="share-btn" onClick={onClose}>Cancel</button>
          <button className="share-btn is-primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
