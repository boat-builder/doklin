// WhisperKit session: model download/load, then the streaming loop that turns
// the gated mic buffer into `partial` and `final` events.
//
// The loop ticks every ~0.15 s. While the gate is open and the buffer has
// voice, a background decode re-transcribes the utterance-so-far; WhisperKit's
// per-token callback streams its text into `stream`, and the loop emits the
// growing text as `partial` events (the live ghost text). An utterance
// *finalizes* — one last transcription of the whole buffer, emitted as
// `final`, buffer cleared — when the gate closes (talk key released) or the
// buffer nears Whisper's 30 s window. After a gate-close finalize the host
// gets an `utterance done` ack: nothing more is coming for that release, so
// it can hand the editor back to the keyboard.
//
// Finalize never races the partial decode: it cancels it (the token callback
// returns false → WhisperKit early-stops), waits for the engine to go idle,
// and only then takes the buffer. Utterances are never dropped — a failed
// final decode is retried once, then surfaced as an `error` event.
import Foundation
import WhisperKit

/// Cross-thread cancellation flag for an in-flight decode. WhisperKit invokes
/// the token callback on a detached task, so this must be lock-protected.
private final class CancelFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var cancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return flag
    }
    func cancel() {
        lock.lock()
        flag = true
        lock.unlock()
    }
}

/// Latest streamed text from the in-flight partial decode. Token callbacks
/// (detached, unordered) write; the transcriber's loop drains from actor
/// context, so `partial` events stay strictly ordered against `final` and
/// `session` events. Within one decode pass the text only grows (out-of-order
/// callbacks can't regress it); a completed pass may shrink it, since Whisper
/// sometimes revises earlier words on the fuller buffer.
private final class StreamText: @unchecked Sendable {
    private let lock = NSLock()
    private var gen = -1
    private var text = ""
    private var dirty = false

    func update(gen: Int, text: String, passComplete: Bool = false) {
        lock.lock()
        defer { lock.unlock() }
        if gen != self.gen {
            self.gen = gen
            self.text = ""
        }
        guard passComplete || text.count > self.text.count else { return }
        guard text != self.text else { return }
        self.text = text
        dirty = true
    }

    /// The freshest text, once, if it belongs to the current utterance.
    func take(currentGen: Int) -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard dirty, gen == currentGen else { return nil }
        dirty = false
        return text
    }
}

actor Transcriber {
    private var whisper: WhisperKit?
    private var capture: AudioCapture?
    private var loopTask: Task<Void, Never>?
    private var language: String?
    private var running = false

    /// One decode owns the engine at a time (partial or final).
    private var decodeBusy = false
    /// Cancels the in-flight partial decode when finalize wants the engine.
    private var partialCancel: CancelFlag?
    /// Bumped whenever the buffer is taken; stale partial text dies with it.
    private var utteranceGen = 0
    private let stream = StreamText()

    static let minSamples = Int(0.35 * AudioCapture.sampleRate)  // ignore blips <0.35s
    static let maxSamples = Int(28.0 * AudioCapture.sampleRate)  // force-finalize near 30s

    // Whisper's favourite fabrications on silence/noise — dropped when the
    // buffer barely contained voice.
    private static let junkFinals: Set<String> = [
        "you", "thank you", "thank you.", "thanks for watching", "thanks for watching!",
        "bye", "bye.", ".", "the", "so", "yeah",
    ]

    func load(model: String, downloadBase: URL, language: String?) async {
        self.language = language
        guard whisper == nil else {
            emitModel("stt", "ready")
            return
        }
        // Disk first: WhisperKit.download always phones the HuggingFace hub,
        // even when every file is already local — seconds of "Downloading…"
        // per cold start and a hard failure offline. A complete variant folder
        // loads directly; a corrupt one falls through to the network path,
        // which repairs it.
        if let cached = Self.cachedModelFolder(downloadBase: downloadBase, variant: model) {
            do {
                try await loadWhisper(folder: cached)
                return
            } catch {
                whisper = nil
                emitLog("cached speech model failed to load, re-downloading: \(error)")
            }
        }
        do {
            emitModel("stt", "downloading", progress: 0)
            let folder = try await WhisperKit.download(
                variant: model,
                downloadBase: downloadBase,
                useBackgroundSession: false
            ) { progress in
                emitModel("stt", "downloading", progress: progress.fractionCompleted)
            }
            try await loadWhisper(folder: folder)
        } catch {
            emitModel("stt", "error", message: String(describing: error))
        }
    }

    private func loadWhisper(folder: URL) async throws {
        emitModel("stt", "loading")
        let config = WhisperKitConfig(
            verbose: false,
            logLevel: .error,
            prewarm: true,
            load: true,
            download: false
        )
        config.modelFolder = folder.path
        whisper = try await WhisperKit(config)
        emitModel("stt", "ready")
    }

    /// A cached variant folder under <base>/models/argmaxinc/whisperkit-coreml
    /// with every CoreML bundle present. Mirrors the layout WhisperKit's own
    /// download creates (the repo prefixes its variants with "openai_whisper-").
    static func cachedModelFolder(downloadBase: URL, variant: String) -> URL? {
        let repo = downloadBase
            .appendingPathComponent("models")
            .appendingPathComponent("argmaxinc")
            .appendingPathComponent("whisperkit-coreml")
        let required = ["MelSpectrogram.mlmodelc", "AudioEncoder.mlmodelc", "TextDecoder.mlmodelc", "config.json"]
        for name in ["openai_whisper-\(variant)", variant] {
            let dir = repo.appendingPathComponent(name)
            let complete = required.allSatisfy {
                FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path)
            }
            if complete { return dir }
        }
        return nil
    }

    var isReady: Bool { whisper != nil }
    var isRunning: Bool { running }

    /// Idle-unload: drop the CoreML model so its memory goes back to the OS.
    /// No-op mid-session. The next `load` reloads from the on-disk cache in a
    /// few seconds — the UI already renders that as "Preparing speech model…".
    func unload() {
        guard !running, whisper != nil else { return }
        whisper = nil
        emitModel("stt", "idle")
    }

    func start() {
        guard whisper != nil else {
            emitError("stt", "start before model ready")
            return
        }
        guard !running else { return }
        let cap = AudioCapture()
        do {
            try cap.start()
        } catch {
            emitError("mic", String(describing: error))
            return
        }
        capture = cap
        cap.setGate(false)  // armed but closed until the talk key opens it
        running = true
        emit(["event": "session", "state": "paused"])
        loopTask = Task { await self.loop() }
    }

    func setGate(_ open: Bool) async {
        guard running, let cap = capture else { return }
        let was = cap.gateOpen
        cap.setGate(open)
        emit(["event": "session", "state": open ? "listening" : "paused"])
        if was && !open {  // key released → utterance over
            await finalize()
            // Ack: the decode for this release is done and its `final` (if
            // any) already emitted — the host can unlock the editor.
            emit(["event": "utterance", "state": "done"])
        }
    }

    /// End the session. Emits the final `session: idle` even when no session
    /// is running — the host uses that event as its stop handshake.
    func stop() async {
        guard running else {
            emit(["event": "session", "state": "idle"])
            return
        }
        running = false
        loopTask?.cancel()
        loopTask = nil
        await finalize()
        capture?.stop()
        capture = nil
        emit(["event": "session", "state": "idle"])
    }

    private func loop() async {
        while running && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard running, let cap = capture else { break }

            // Ghost text: emit the freshest streamed partial, actor-ordered.
            if let text = stream.take(currentGen: utteranceGen), !text.isEmpty {
                emit(["event": "partial", "text": text])
            }

            let snap = cap.snapshot()
            if snap.samples.count >= Self.maxSamples {
                await finalize()
                continue
            }
            if !decodeBusy, snap.gate, snap.voiced, snap.samples.count >= Self.minSamples {
                startPartialDecode(snap.samples)
            } else if !snap.voiced {
                cap.trimSilence(keepLast: 1.0)
            }
        }
    }

    /// Kick off a background decode of the utterance-so-far. The token
    /// callback streams text into `stream`; the loop emits it. Unawaited, so
    /// gate commands and finalize stay responsive mid-decode.
    private func startPartialDecode(_ samples: [Float]) {
        guard let whisper else { return }
        decodeBusy = true
        let flag = CancelFlag()
        partialCancel = flag
        let gen = utteranceGen
        let stream = stream
        let options = decodingOptions()
        let callback: TranscriptionCallback = { progress in
            if flag.cancelled { return false }
            stream.update(gen: gen, text: progress.text)
            return nil
        }
        Task {
            let results = try? await whisper.transcribe(
                audioArray: samples, decodeOptions: options, callback: callback)
            self.partialDecodeDone(gen: gen, text: results.map(Self.joinText), cancelled: flag.cancelled)
        }
    }

    private func partialDecodeDone(gen: Int, text: String?, cancelled: Bool) {
        decodeBusy = false
        partialCancel = nil
        // A completed pass may legitimately shrink the text (Whisper revised
        // earlier words); a cancelled one is superseded by the final.
        if !cancelled, let text, !text.isEmpty {
            stream.update(gen: gen, text: text, passComplete: true)
        }
    }

    /// One last decode of the whole buffer → `final`. Cancels any in-flight
    /// partial decode and waits for the engine — the buffer is only taken once
    /// the decode can actually run, so an utterance can't be dropped by
    /// unlucky timing. A decode failure is retried once, then reported.
    private func finalize() async {
        guard capture != nil else { return }
        partialCancel?.cancel()
        while decodeBusy {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        guard let cap = capture else { return }
        let (samples, voiced) = cap.take()
        utteranceGen += 1
        defer { emit(["event": "partial", "text": ""]) }  // clear any stale ghost
        guard voiced, samples.count >= Self.minSamples else { return }
        var decoded = await transcribeFinal(samples)
        if decoded == nil {
            decoded = await transcribeFinal(samples)
        }
        guard let decoded else {
            emitError("stt", "could not transcribe the last utterance")
            return
        }
        let text = decoded.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return }
        let secs = Double(samples.count) / AudioCapture.sampleRate
        if secs < 1.5 && Self.junkFinals.contains(text.lowercased()) { return }
        emit(["event": "final", "text": text, "secs": secs])
    }

    /// nil = the engine failed (worth retrying/reporting); "" = decoded nothing.
    private func transcribeFinal(_ samples: [Float]) async -> String? {
        guard let whisper else { return nil }
        decodeBusy = true
        defer { decodeBusy = false }
        do {
            let results = try await whisper.transcribe(
                audioArray: samples, decodeOptions: decodingOptions())
            return Self.joinText(results)
        } catch {
            emitLog("final transcription failed: \(error)")
            return nil
        }
    }

    private func decodingOptions() -> DecodingOptions {
        DecodingOptions(
            task: .transcribe,
            language: language,
            temperature: 0,
            usePrefillPrompt: true,
            skipSpecialTokens: true,
            withoutTimestamps: true
        )
    }

    private static func joinText(_ results: [TranscriptionResult]) -> String {
        results.map(\.text).joined(separator: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
