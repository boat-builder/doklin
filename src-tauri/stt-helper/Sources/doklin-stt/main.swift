// doklin-stt entry point: NDJSON command loop over stdin/stdout.
//
// Commands (one JSON object per line on stdin):
//   {"cmd":"init","dataDir":"…","sttModel":"…","llmModel":"…","llmEnabled":true,
//    "language":"en"|null,"debug":false}
//   {"cmd":"start","mode":"flow"|"walkie"}     begin a dictation session
//   {"cmd":"gate","open":true|false}           walkie talk-key press/release
//   {"cmd":"mode","mode":"flow"|"walkie"}      switch style mid-session
//   {"cmd":"stop"}                             end session (finalizes pending)
//   {"cmd":"load_llm"}                         load polish model on demand
//   {"cmd":"correct",…}  {"cmd":"summarize",…} see Corrector.swift
//   {"cmd":"shutdown"}
//
// Events (one JSON object per line on stdout): ready, model, session, level,
// partial, final, correct, summary, error, log. The Rust host forwards them
// to the webview verbatim; correct/summary answers are also matched by id.
import Foundation

let transcriber = Transcriber()
let corrector = Corrector()

// Filled by `init`; models land under <dataDir>/stt-models/ so wiping the
// app's data dir removes them too.
var modelsDir = FileManager.default.temporaryDirectory.appendingPathComponent("doklin-stt-models")
var sttModel = "large-v3-v20240930"  // = whisper large-v3-turbo in whisperkit-coreml
var llmModel = "mlx-community/Qwen3-4B-Instruct-2507-4bit"
var language: String? = nil
var idleUnloadSecs: Double = 300  // init can override (tests use seconds)

// MARK: - Idle unload
//
// The models (~4-5 GB together) are ours to manage — the OS won't reclaim
// idle Metal buffers, it can only swap them. So: while a session is live the
// models stay hot; once the app has been quiet for `idleUnloadSecs` (or the
// system signals memory pressure) both are dropped and the RAM goes back.
// The next session start re-sends `init`, which reloads from the disk cache.

var idleUnloadTask: Task<Void, Never>?

func cancelIdleUnload() {
    idleUnloadTask?.cancel()
    idleUnloadTask = nil
}

func scheduleIdleUnload() {
    cancelIdleUnload()
    idleUnloadTask = Task {
        try? await Task.sleep(nanoseconds: UInt64(idleUnloadSecs * 1_000_000_000))
        guard !Task.isCancelled else { return }
        await unloadIfIdle(reschedule: true)
    }
}

func unloadIfIdle(reschedule: Bool) async {
    if await transcriber.isRunning { return }  // live session — never unload
    if await !corrector.isIdle {
        // A correction/summary is mid-flight; try again after another window.
        if reschedule { scheduleIdleUnload() }
        return
    }
    let hadStt = await transcriber.isReady
    let hadLlm = await corrector.isReady
    await transcriber.unload()
    await corrector.unload()
    if hadStt || hadLlm { emitLog("idle: models unloaded") }
}

// Memory pressure: give the RAM back immediately (unless mid-session).
let memoryPressure = DispatchSource.makeMemoryPressureSource(
    eventMask: [.warning, .critical], queue: .global())

func str(_ obj: [String: Any], _ key: String) -> String {
    (obj[key] as? String) ?? ""
}

func handle(_ line: String) async {
    guard !line.isEmpty,
        let data = line.data(using: .utf8),
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let cmd = obj["cmd"] as? String
    else { return }

    switch cmd {
    case "init":
        if let dir = obj["dataDir"] as? String, !dir.isEmpty {
            modelsDir = URL(fileURLWithPath: dir).appendingPathComponent("stt-models")
        }
        try? FileManager.default.createDirectory(at: modelsDir, withIntermediateDirectories: true)
        if case let m = str(obj, "sttModel"), !m.isEmpty { sttModel = m }
        if case let m = str(obj, "llmModel"), !m.isEmpty { llmModel = m }
        language = (obj["language"] as? String).flatMap { $0.isEmpty || $0 == "auto" ? nil : $0 }
        if let secs = obj["idleUnloadSecs"] as? Double, secs > 0 { idleUnloadSecs = secs }
        await corrector.configure(debug: obj["debug"] as? Bool ?? false)
        let wantLLM = obj["llmEnabled"] as? Bool ?? false
        Task { await transcriber.load(model: sttModel, downloadBase: modelsDir, language: language) }
        if wantLLM {
            Task { await corrector.load(model: llmModel, downloadBase: modelsDir) }
        }
        // Backstop: if init is never followed by a session, don't hold 4-5 GB
        // forever. A `start` cancels this.
        scheduleIdleUnload()

    case "load_llm":
        Task { await corrector.load(model: llmModel, downloadBase: modelsDir) }

    case "start":
        cancelIdleUnload()
        let mode = Transcriber.Mode(rawValue: str(obj, "mode")) ?? .flow
        await transcriber.start(mode: mode)

    case "gate":
        await transcriber.setGate(obj["open"] as? Bool ?? false)

    case "mode":
        if let m = Transcriber.Mode(rawValue: str(obj, "mode")) {
            await transcriber.setMode(m)
        }

    case "stop":
        await transcriber.stop()
        scheduleIdleUnload()

    case "correct":
        await corrector.enqueueCorrect(
            CorrectRequest(
                id: str(obj, "id"),
                chunk: str(obj, "chunk"),
                summary: str(obj, "summary"),
                headingPath: str(obj, "headingPath"),
                before: str(obj, "before"),
                after: str(obj, "after")
            ))

    case "summarize":
        await corrector.enqueueSummarize(
            SummarizeRequest(
                id: str(obj, "id"),
                summary: str(obj, "summary"),
                delta: str(obj, "delta"),
                docText: str(obj, "docText")
            ))

    case "shutdown":
        await transcriber.stop()
        emit(["event": "bye"])
        exit(0)

    default:
        emitError("proto", "unknown cmd: \(cmd)")
    }
}

// MARK: - Run loop

memoryPressure.setEventHandler {
    Task { await unloadIfIdle(reschedule: false) }
}
memoryPressure.resume()

emit(["event": "ready", "pid": Int(ProcessInfo.processInfo.processIdentifier)])

let runLoop = Task {
    do {
        for try await line in FileHandle.standardInput.bytes.lines {
            await handle(line.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    } catch {
        emitError("stdin", String(describing: error))
    }
    // stdin closed → host is gone; don't linger as an orphan.
    await transcriber.stop()
    exit(0)
}

// Keep the process alive for AVAudioEngine callbacks etc.
RunLoop.main.run()
_ = runLoop
