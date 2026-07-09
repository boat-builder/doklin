// MLX "polish" pass: a quantized instruct model (default Qwen3-4B) that
// corrects raw STT chunks — and, as a background job, maintains the rolling
// document summary the correction prompt uses as context.
//
// One model, one GPU: every request funnels through a two-lane queue where
// corrections always run before summary jobs, so polish latency never waits
// on housekeeping.
import Foundation
import Hub
import MLX
import MLXLLM
import MLXLMCommon

struct CorrectRequest {
    let id: String
    let chunk: String
    let summary: String
    let headingPath: String
    let before: String
    let after: String
}

struct SummarizeRequest {
    let id: String
    let summary: String  // existing summary ("" → build from docText)
    let delta: String  // newly added/changed text
    let docText: String  // full doc (truncated by caller) for initial builds
}

actor Corrector {
    private var container: ModelContainer?
    private var loading = false
    private var debug = false

    // Two-lane FIFO: corrections (user-visible latency) before summaries.
    private var lane0: [@Sendable () async -> Void] = []
    private var lane1: [@Sendable () async -> Void] = []
    private var pumping = false

    func configure(debug: Bool) { self.debug = debug }

    func load(model: String, downloadBase: URL) async {
        guard container == nil, !loading else {
            if container != nil { emitModel("llm", "ready") }
            return
        }
        loading = true
        defer { loading = false }
        do {
            emitModel("llm", "downloading", progress: 0)
            let hub = HubApi(downloadBase: downloadBase)
            let config = ModelConfiguration(id: model)
            container = try await LLMModelFactory.shared.loadContainer(hub: hub, configuration: config) {
                progress in
                emitModel("llm", "downloading", progress: progress.fractionCompleted)
            }
            // Prewarm: the first generate pays Metal pipeline compilation
            // (~seconds). Burn it on a throwaway so the first real correction
            // fits the latency budget.
            emitModel("llm", "loading")
            if let container {
                _ = try? await generate(container, system: "Reply with OK.", user: "OK?", maxTokens: 3)
            }
            emitModel("llm", "ready")
        } catch {
            emitModel("llm", "error", message: String(describing: error))
        }
    }

    var isReady: Bool { container != nil }
    /// Nothing loading, nothing queued, nothing generating.
    var isIdle: Bool { !loading && !pumping && lane0.isEmpty && lane1.isEmpty }

    /// Idle-unload: drop the model AND flush MLX's Metal buffer cache — the
    /// weights are anonymous GPU buffers the OS can only swap, not reclaim,
    /// so this is the one real way to give the ~2.5 GB back.
    func unload() {
        guard isIdle, container != nil else { return }
        container = nil
        MLX.GPU.clearCache()
        emitModel("llm", "idle")
    }

    func enqueueCorrect(_ req: CorrectRequest) {
        enqueue(priority: true) { [weak self] in await self?.runCorrect(req) }
    }

    func enqueueSummarize(_ req: SummarizeRequest) {
        enqueue(priority: false) { [weak self] in await self?.runSummarize(req) }
    }

    private func enqueue(priority: Bool, _ job: @escaping @Sendable () async -> Void) {
        if priority { lane0.append(job) } else { lane1.append(job) }
        if !pumping {
            pumping = true
            Task { await self.pump() }
        }
    }

    private func pump() async {
        while true {
            let job: (@Sendable () async -> Void)?
            if !lane0.isEmpty {
                job = lane0.removeFirst()
            } else if !lane1.isEmpty {
                job = lane1.removeFirst()
            } else {
                job = nil
            }
            guard let job else { break }
            await job()
        }
        pumping = false
    }

    // MARK: - Jobs

    private func runCorrect(_ req: CorrectRequest) async {
        guard let container else {
            emit(["event": "correct", "id": req.id, "ok": false, "message": "llm not loaded"])
            return
        }
        let started = Date()
        let system = Self.correctionSystemPrompt
        let user = Self.correctionUserPrompt(req)
        do {
            let raw = try await generate(container, system: system, user: user, maxTokens: 1024)
            let text = Self.cleanModelOutput(raw)
            var payload: [String: Any] = [
                "event": "correct", "id": req.id, "ok": !text.isEmpty, "text": text,
                "ms": Int(Date().timeIntervalSince(started) * 1000),
            ]
            if debug {
                payload["prompt"] = "SYSTEM:\n\(system)\n\nUSER:\n\(user)"
                payload["raw"] = raw
            }
            emit(payload)
        } catch {
            emit([
                "event": "correct", "id": req.id, "ok": false,
                "message": String(describing: error),
                "ms": Int(Date().timeIntervalSince(started) * 1000),
            ])
        }
    }

    private func runSummarize(_ req: SummarizeRequest) async {
        guard let container else {
            emit(["event": "summary", "id": req.id, "ok": false, "message": "llm not loaded"])
            return
        }
        let started = Date()
        let system = Self.summarySystemPrompt
        let user: String
        if req.summary.isEmpty {
            user = "DOCUMENT:\n\(req.docText)\n\nWrite the summary of DOCUMENT."
        } else {
            user =
                "CURRENT SUMMARY:\n\(req.summary)\n\nNEWLY ADDED TEXT:\n\(req.delta)\n\nUpdate CURRENT SUMMARY to also cover NEWLY ADDED TEXT. Output only the updated summary."
        }
        do {
            let raw = try await generate(container, system: system, user: user, maxTokens: 320)
            let text = Self.cleanModelOutput(raw)
            var payload: [String: Any] = [
                "event": "summary", "id": req.id, "ok": !text.isEmpty, "summary": text,
                "ms": Int(Date().timeIntervalSince(started) * 1000),
            ]
            if debug { payload["prompt"] = "SYSTEM:\n\(system)\n\nUSER:\n\(user)" }
            emit(payload)
        } catch {
            emit([
                "event": "summary", "id": req.id, "ok": false,
                "message": String(describing: error),
            ])
        }
    }

    private func generate(
        _ container: ModelContainer, system: String, user: String, maxTokens: Int
    ) async throws -> String {
        // Fresh single-turn session per request: corrections must not inherit
        // chat history from each other.
        let session = ChatSession(
            container,
            instructions: system,
            generateParameters: GenerateParameters(maxTokens: maxTokens, temperature: 0.0)
        )
        return try await session.respond(to: user)
    }

    // MARK: - Prompts

    static let correctionSystemPrompt = """
        You correct speech-to-text transcripts. The user dictated text into a document; \
        the STT engine may have misheard words, chosen wrong homophones, mangled technical \
        terms or proper nouns, or garbled words from accented / non-native pronunciation.

        Your ONLY job is to fix transcription errors, punctuation, and capitalization in the text \
        between <chunk> and </chunk>.
        - Do NOT rewrite, rephrase, restructure, shorten, expand, summarize, or "improve" style.
        - Preserve the speaker's exact wording and meaning. Keep their phrasing even if informal.
        - Use the surrounding context ONLY to disambiguate likely-misheard words and domain terms. \
        NEVER copy any context text (summary, section, text before/after) into your output.
        - If the chunk is already correct, return it unchanged.
        Output ONLY the corrected chunk text — no tags, no quotes, no explanations, no markdown fences.
        """

    static func correctionUserPrompt(_ req: CorrectRequest) -> String {
        var parts: [String] = []
        if !req.summary.isEmpty { parts.append("DOCUMENT SUMMARY:\n\(req.summary)") }
        if !req.headingPath.isEmpty { parts.append("SECTION:\n\(req.headingPath)") }
        if !req.before.isEmpty { parts.append("TEXT BEFORE CURSOR (context only):\n\(req.before)") }
        if !req.after.isEmpty { parts.append("TEXT AFTER CURSOR (context only):\n\(req.after)") }
        parts.append("Correct this chunk:\n<chunk>\(req.chunk)</chunk>")
        return parts.joined(separator: "\n\n")
    }

    static let summarySystemPrompt = """
        You maintain a compact rolling summary of a document a user is writing. \
        The summary exists to give a transcription-correction model context: it must be \
        dense and factual, preserving key names, technical terms, and topics. \
        4-6 sentences maximum. Output only the summary text.
        """

    /// Strip wrappers small models add despite instructions: markdown fences,
    /// surrounding quotes, echoed <chunk> tags, `<think>` blocks from
    /// reasoning-tuned checkpoints.
    static func cleanModelOutput(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = s.range(of: "</think>") {
            s = String(s[r.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        s = s.replacingOccurrences(of: "<chunk>", with: "")
            .replacingOccurrences(of: "</chunk>", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("```") {
            s = s.replacingOccurrences(
                of: "^```[a-zA-Z]*\\n?", with: "", options: .regularExpression)
            if let r = s.range(of: "```", options: .backwards) { s = String(s[..<r.lowerBound]) }
            s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if s.count > 1, s.hasPrefix("\""), s.hasSuffix("\"") {
            s = String(s.dropFirst().dropLast())
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
