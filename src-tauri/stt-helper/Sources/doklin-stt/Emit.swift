// Thread-safe NDJSON writer — every event the sidecar sends rides through here
// so lines never interleave. stdout is written with FileHandle (unbuffered
// syscall) because stdio's full buffering under a pipe would starve the host.
import Foundation

private let emitLock = NSLock()
private let stdout = FileHandle.standardOutput

func emit(_ payload: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(payload),
        let data = try? JSONSerialization.data(withJSONObject: payload)
    else { return }
    emitLock.lock()
    defer { emitLock.unlock() }
    stdout.write(data)
    stdout.write(Data([0x0A]))
}

func emitError(_ scope: String, _ message: String) {
    emit(["event": "error", "scope": scope, "message": message])
}

func emitLog(_ message: String) {
    emit(["event": "log", "message": message])
}

/// Model lifecycle status for one component ("stt" | "llm").
func emitModel(_ component: String, _ status: String, progress: Double? = nil, message: String? = nil) {
    var p: [String: Any] = ["event": "model", "component": component, "status": status]
    if let progress { p["progress"] = progress }
    if let message { p["message"] = message }
    emit(p)
}
