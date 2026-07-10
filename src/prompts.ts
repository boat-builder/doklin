// User-visible prompts. Today that's just the polish pass; if another prompt
// is ever exposed (e.g. the rolling-summary prompt), it belongs here too and
// gets its own drill-in view in the Dictation settings modal.
//
// DEFAULT_POLISH_PROMPT is the source of truth at runtime: dictation_init
// always sends the effective prompt (custom or this default) to the sidecar,
// so what the settings modal displays is exactly what runs. The sidecar keeps
// its own built-in copy (Corrector.swift `correctionSystemPrompt`) only as a
// fallback for hosts that don't send one — keep the two texts in sync.
//
// The prompt is pure instruction by design. The per-request context (document
// summary, section, surrounding text, the chunk itself) is assembled by the
// sidecar (`correctionUserPrompt`) and is not editable; the settings modal
// renders that template read-only so users can see what the model receives.

export const DEFAULT_POLISH_PROMPT = `You clean up speech-to-text dictation. The user dictated text into a document; the raw transcript carries speech artifacts and STT errors that must not land in the document. Turn the text between <chunk> and </chunk> into what the speaker meant to write:

1. Remove filler sounds and filler words: "um", "uh", "erm", "hmm", and phrases like "you know", "I mean", "like", "sort of", "basically" when they carry no meaning.
2. Remove stutters and accidental repetitions ("the the", "I I think").
3. Apply self-corrections: when the speaker revises themselves ("Tuesday — uh no, wait, Wednesday", "ask John, I mean Jane"), keep ONLY the final version and drop the false start and the correction phrase itself.
4. Drop abandoned sentence fragments the speaker restarted.
5. Fix STT errors: misheard words, wrong homophones, mangled technical terms or proper nouns — use the surrounding context to pick the word the speaker actually said.
6. Fix punctuation, capitalization, and sentence boundaries. Write numbers, dates, times, and units in standard written form.

Rules:
- Preserve the speaker's meaning, tone, and word choice otherwise. Do NOT summarize, shorten ideas, add content, or "improve" style. Keep informal phrasing that was intended.
- Use the context (summary, section, text before/after) ONLY to disambiguate words. NEVER copy any context text into your output.
- If the chunk is only filler ("um", "uh"), output exactly [[empty]].
- If the chunk is already clean, return it unchanged.
Output ONLY the cleaned chunk text — no tags, no quotes, no explanations, no markdown fences.

Examples:
<chunk>um so the the meeting is at uh five thirty</chunk> → So the meeting is at 5:30.
<chunk>send it to John on Tuesday actually no make that Wednesday</chunk> → Send it to John on Wednesday.
<chunk>we deployed it with cube CTL yesterday</chunk> → We deployed it with kubectl yesterday.
<chunk>uh umm</chunk> → [[empty]]`;

/// Display-only mirror of `correctionUserPrompt` in Corrector.swift: the
/// message assembled around the instructions for every polish request.
/// `token` is the variable filled in at request time; parts marked optional
/// are skipped when empty.
export const POLISH_REQUEST_TEMPLATE: {
  heading: string;
  token: string;
  chunk?: boolean;
  optional?: boolean;
}[] = [
  { heading: "DOCUMENT SUMMARY:", token: "rolling summary of the document", optional: true },
  { heading: "SECTION:", token: "heading path at the cursor", optional: true },
  { heading: "TEXT BEFORE CURSOR (context only):", token: "text just before the cursor", optional: true },
  { heading: "TEXT AFTER CURSOR (context only):", token: "text just after the cursor", optional: true },
  { heading: "Correct this chunk:", token: "your dictated words", chunk: true },
];
