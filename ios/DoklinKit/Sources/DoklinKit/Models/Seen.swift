// What this person has read on this device: for each document, the content
// it held when it was last shown here. Home dots what changed since; a
// document opened again marks what changed since then. It stays on the
// device, beside the engine's files, and never syncs: what one device has
// shown says nothing about another.

import Foundation

public final class SeenStore: @unchecked Sendable {
    /// `{since, workspaces: {wsId: {key: hash}}}`.
    private struct Stored: Codable {
        var since: Int
        var workspaces: [String: [String: String]]
    }

    private let file: URL?
    private let lock = NSLock()
    private var stored: Stored

    /// Kept in `file`, read from it when it is there; with nil, kept in
    /// memory only.
    public init(file: URL?, now: Int = Clock.now) {
        self.file = file
        if let file, let data = try? Data(contentsOf: file), let read = try? JSONDecoder().decode(Stored.self, from: data) {
            stored = read
        } else {
            stored = Stored(since: now, workspaces: [:])
        }
    }

    /// When this device started keeping count: a document nobody has shown
    /// here is unread only if it changed after that, so a phone that just
    /// joined does not call the whole workspace new.
    public var since: Int {
        lock.lock()
        defer { lock.unlock() }
        return stored.since
    }

    /// The key a file is kept under: its id, which a rename keeps — or its
    /// path, until a manifest gives it one.
    public static func key(fileId: String?, path: String) -> String {
        fileId ?? "path:" + path.lowercased()
    }

    /// The content last shown under `key` in workspace `wsId`.
    public func hash(_ wsId: String, _ key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return stored.workspaces[wsId]?[key]
    }

    /// Shown now, holding `hash`.
    public func saw(_ wsId: String, _ entries: [(key: String, hash: String)]) {
        lock.lock()
        var changed = false
        for entry in entries where stored.workspaces[wsId]?[entry.key] != entry.hash {
            stored.workspaces[wsId, default: [:]][entry.key] = entry.hash
            changed = true
        }
        let snapshot = stored
        lock.unlock()
        if changed { write(snapshot) }
    }

    /// A workspace left this device: what was read in it goes too.
    public func forget(_ wsId: String) {
        lock.lock()
        stored.workspaces[wsId] = nil
        let snapshot = stored
        lock.unlock()
        write(snapshot)
    }

    private func write(_ snapshot: Stored) {
        if let file, let data = try? JSONEncoder().encode(snapshot) {
            try? data.write(to: file, options: .atomic)
        }
    }
}
