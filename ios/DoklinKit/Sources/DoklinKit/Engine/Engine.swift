// The engine: the Mac app's sync engine and version store (engine/, Rust),
// linked in and reached through three C functions (engine/ffi). Everything
// that talks to a domain is behind this; Swift sends commands in and hears
// events out, exactly as the Mac's frontend does — the same command names,
// the same arguments, the same answers (engine/src/command.rs). The one
// thing the engine asks of Swift is where sign-ins are kept: the Keychain,
// by workspace id, never the engine's own files.

import CDoklinEngine
import Foundation

/// One event the engine sent: its name (`cloud-status`, `cloud-applied`, …)
/// and its payload as JSON.
public struct EngineEvent: Sendable {
    public let name: String
    public let payload: Data

    public func decode<T: Decodable>(_ type: T.Type = T.self) -> T? {
        try? JSONDecoder().decode(type, from: payload)
    }
}

/// A JSON value for a command's arguments.
public enum JSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case string(String)
    case array([JSONValue])

    var any: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return value
        case .int(let value): return value
        case .string(let value): return value
        case .array(let values): return values.map(\.any)
        }
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByNilLiteral, ExpressibleByArrayLiteral
{
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .int(value) }
    public init(nilLiteral: ()) { self = .null }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }

    /// A string, or null for none.
    public static func optional(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
    public static func strings(_ values: [String]) -> JSONValue { .array(values.map(JSONValue.string)) }
}

/// What the engine is told once, when the app starts.
public struct EngineSetup: Sendable {
    /// Where this device's sign-ins are kept.
    public var secrets: SecretStore
    /// Where the engine keeps what is its own: `cloud.json`, the sync state,
    /// the version stores.
    public var dataDirectory: URL
    /// Where a workspace this device joins is downloaded, one folder each.
    public var workspacesDirectory: URL
    /// The folder iOS can move between launches — the app's container.
    /// Everything the engine writes down is relative to it.
    public var anchor: URL?
    /// `x-doklin-client`: `ios/<version>`.
    public var client: String
    public var deviceName: String
    /// What a person calls this kind of device — `iPhone`, `iPad` — in the
    /// engine's sentences about it.
    public var deviceKind: String

    public init(
        secrets: SecretStore, dataDirectory: URL, workspacesDirectory: URL, anchor: URL?, client: String, deviceName: String,
        deviceKind: String
    ) {
        self.deviceKind = deviceKind
        self.secrets = secrets
        self.dataDirectory = dataDirectory
        self.workspacesDirectory = workspacesDirectory
        self.anchor = anchor
        self.client = client
        self.deviceName = deviceName
    }
}

/// The running engine. One per process: `Engine.shared`.
public final class Engine: @unchecked Sendable {
    public static let shared = Engine()

    private let lock = NSLock()
    private var listeners: [UUID: AsyncStream<EngineEvent>.Continuation] = [:]
    private var keeper: SecretStore?

    private init() {}

    /// Start it. Calling again changes nothing: the engine keeps the first
    /// setup for the life of the process.
    public func start(_ setup: EngineSetup) throws {
        for directory in [setup.dataDirectory, setup.workspacesDirectory] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        var config: [String: Any] = [
            "dataDir": setup.dataDirectory.path,
            "joinDir": setup.workspacesDirectory.path,
            "client": setup.client,
            "deviceName": setup.deviceName,
            "deviceKind": setup.deviceKind,
        ]
        if let anchor = setup.anchor { config["anchor"] = anchor.path }
        let text = String(decoding: try JSONSerialization.data(withJSONObject: config), as: UTF8.self)
        lock.lock()
        if keeper == nil { keeper = setup.secrets }
        lock.unlock()
        if let refusal = doklin_engine_start(text, engineSaid, engineSecret, engineKeep) {
            defer { doklin_engine_free(refusal) }
            throw DoklinError(String(cString: refusal))
        }
    }

    /// Everything the engine says from now on. Each caller gets a stream of
    /// its own; it ends when the caller stops reading.
    public func events() -> AsyncStream<EngineEvent> {
        AsyncStream { continuation in
            let id = UUID()
            lock.lock()
            listeners[id] = continuation
            lock.unlock()
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.lock()
                self.listeners[id] = nil
                self.lock.unlock()
            }
        }
    }

    fileprivate var secrets: SecretStore? {
        lock.lock()
        defer { lock.unlock() }
        return keeper
    }

    fileprivate func deliver(_ event: EngineEvent) {
        lock.lock()
        let hearing = Array(listeners.values)
        lock.unlock()
        for listener in hearing { listener.yield(event) }
    }

    /// Run a command and decode its answer.
    public func call<T: Decodable>(_ name: String, _ args: [String: JSONValue] = [:], as type: T.Type = T.self) async throws -> T {
        let data = try await raw(name, args)
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw DoklinError("Doklin could not read what the engine answered to \(name): \(error)")
        }
    }

    /// Run a command whose answer is not needed.
    public func run(_ name: String, _ args: [String: JSONValue] = [:]) async throws {
        _ = try await raw(name, args)
    }

    /// Run a command; its answer as JSON.
    public func raw(_ name: String, _ args: [String: JSONValue] = [:]) async throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: args.mapValues(\.any))
        let text = String(decoding: body, as: UTF8.self)
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            let context = Unmanaged.passRetained(Pending(continuation)).toOpaque()
            doklin_engine_call(name, text, context, engineAnswered)
        }
    }
}

/// One call waiting on its answer.
private final class Pending {
    let continuation: CheckedContinuation<Data, Error>
    init(_ continuation: CheckedContinuation<Data, Error>) { self.continuation = continuation }
}

/// The engine's answer to one call, on a thread of its own.
private func engineAnswered(_ context: UnsafeMutableRawPointer?, _ ok: Bool, _ answer: UnsafePointer<CChar>?) {
    guard let context else { return }
    let pending = Unmanaged<Pending>.fromOpaque(context).takeRetainedValue()
    let text = answer.map { String(cString: $0) } ?? ""
    if ok {
        pending.continuation.resume(returning: Data(text.utf8))
    } else {
        pending.continuation.resume(throwing: DoklinError(DoklinError.sentence(text)))
    }
}

/// The sign-in kept for a workspace, handed over as the engine asks: a copy
/// from `malloc`, which the engine frees, or none. False when the store
/// could not be read, which the engine never takes for "none".
private func engineSecret(_ wsId: UnsafePointer<CChar>?, _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?) -> Bool {
    guard let wsId, let out, let secrets = Engine.shared.secrets else { return false }
    do {
        out.pointee = try secrets.secret(for: String(cString: wsId)).flatMap { strdup($0) }
        return true
    } catch {
        return false
    }
}

/// Keep a workspace's sign-in, or forget it when `token` is null.
private func engineKeep(_ wsId: UnsafePointer<CChar>?, _ token: UnsafePointer<CChar>?) -> Bool {
    guard let wsId, let secrets = Engine.shared.secrets else { return false }
    do {
        try secrets.setSecret(token.map { String(cString: $0) }, for: String(cString: wsId))
        return true
    } catch {
        return false
    }
}

/// An event, on whichever of the engine's threads it happened on.
private func engineSaid(_ event: UnsafePointer<CChar>?, _ payload: UnsafePointer<CChar>?) {
    guard let event, let payload else { return }
    Engine.shared.deliver(EngineEvent(name: String(cString: event), payload: Data(String(cString: payload).utf8)))
}
