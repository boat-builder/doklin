// WhisperKit session: model download/load, then the streaming loop that turns
// the gated mic buffer into `partial` and `final` events.
//
// The loop ticks every ~0.6 s. While the gate is open and the buffer has
// voice, each tick re-transcribes the utterance-so-far and emits a `partial`
// (the ghost text). An utterance *finalizes* — one last transcription of the
// whole buffer, emitted as `final`, buffer cleared — when:
//   • walkie mode: the gate closes (key released), or
//   • flow mode: ~1 s of trailing silence after voice, or
//   • either mode: the buffer nears Whisper's 30 s window.
import Foundation
import WhisperKit

actor Transcriber {
    enum Mode: String { case flow, walkie }

    private var whisper: WhisperKit?
    private var capture: AudioCapture?
    private var loopTask: Task<Void, Never>?
    private var language: String?
    private var running = false
    private var mode: Mode = .flow

    /// Serialize transcription calls (partial ticks vs finalize).
    private var busy = false

    static let minSamples = Int(0.35 * AudioCapture.sampleRate)  // ignore blips <0.35s
    static let maxSamples = Int(28.0 * AudioCapture.sampleRate)  // force-finalize near 30s
    static let flowSilence = 1.0  // seconds of quiet that ends a flow utterance

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
        do {
            emitModel("stt", "downloading", progress: 0)
            let folder = try await WhisperKit.download(
                variant: model,
                downloadBase: downloadBase,
                useBackgroundSession: false
            ) { progress in
                emitModel("stt", "downloading", progress: progress.fractionCompleted)
            }
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
        } catch {
            emitModel("stt", "error", message: String(describing: error))
        }
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

    func start(mode: Mode) {
        guard whisper != nil else {
            emitError("stt", "start before model ready")
            return
        }
        guard !running else { return }
        self.mode = mode
        let cap = AudioCapture()
        do {
            try cap.start()
        } catch {
            emitError("mic", String(describing: error))
            return
        }
        capture = cap
        cap.setGate(mode == .flow)  // flow: hot mic; walkie: armed but closed
        running = true
        emit(["event": "session", "state": mode == .flow ? "listening" : "paused"])
        loopTask = Task { await self.loop() }
    }

    func setGate(_ open: Bool) async {
        guard running, let cap = capture else { return }
        let was = cap.gateOpen
        cap.setGate(open)
        emit(["event": "session", "state": open ? "listening" : "paused"])
        if was && !open {  // key released → utterance over
            await finalize()
        }
    }

    func setMode(_ m: Mode) async {
        guard running, let cap = capture else { return }
        mode = m
        if m == .flow && !cap.gateOpen {
            cap.setGate(true)
            emit(["event": "session", "state": "listening"])
        }
        if m == .walkie && cap.gateOpen {
            cap.setGate(false)
            emit(["event": "session", "state": "paused"])
            await finalize()
        }
    }

    func stop() async {
        guard running else { return }
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
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard running, let cap = capture else { break }
            let snap = cap.snapshot()

            if snap.samples.count >= Self.maxSamples {
                await finalize()
                continue
            }
            if mode == .flow, snap.gate, snap.voiced, snap.silenceSecs > Self.flowSilence {
                await finalize()
                continue
            }
            if snap.gate, snap.voiced, snap.samples.count >= Self.minSamples {
                if let text = await transcribe(snap.samples), !text.isEmpty {
                    emit(["event": "partial", "text": text])
                }
            } else if !snap.voiced {
                cap.trimSilence(keepLast: 1.0)
            }
        }
    }

    private func finalize() async {
        guard let cap = capture else { return }
        let (samples, voiced) = cap.take()
        defer { emit(["event": "partial", "text": ""]) }  // clear any stale ghost
        guard voiced, samples.count >= Self.minSamples else { return }
        guard var text = await transcribe(samples) else { return }
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return }
        let secs = Double(samples.count) / AudioCapture.sampleRate
        if secs < 1.5 && Self.junkFinals.contains(text.lowercased()) { return }
        emit(["event": "final", "text": text, "secs": secs])
    }

    private func transcribe(_ samples: [Float]) async -> String? {
        guard let whisper, !busy else { return nil }
        busy = true
        defer { busy = false }
        let options = DecodingOptions(
            task: .transcribe,
            language: language,
            temperature: 0,
            usePrefillPrompt: true,
            skipSpecialTokens: true,
            withoutTimestamps: true
        )
        do {
            let results = try await whisper.transcribe(audioArray: samples, decodeOptions: options)
            let text = results.map(\.text).joined(separator: " ")
                .replacingOccurrences(of: "  ", with: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return text
        } catch {
            emitError("stt", String(describing: error))
            return nil
        }
    }
}
