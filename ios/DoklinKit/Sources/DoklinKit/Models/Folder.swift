// A folder of the workspace, as a screen shows it: what it holds, read off
// this iPhone's copy, and the changes a person makes from a list — a new
// note, a new folder, a rename, a move, a removal. Each lands on disk first
// and reaches every other device through sync.

import Foundation
import Observation

/// How far a screen has got with what it shows.
public enum LoadPhase: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)
}

@MainActor
@Observable
public final class FolderModel {
    public let workspace: Workspace
    /// `""` is the workspace itself.
    public let dir: String
    public private(set) var entries: [FolderEntry] = []
    public private(set) var phase: LoadPhase = .idle

    public init(workspace: Workspace, dir: String) {
        self.workspace = workspace
        self.dir = dir
    }

    public var title: String { dir.isEmpty ? workspace.name : DocLinks.name(of: dir) }

    public func load() {
        do {
            entries = try workspace.files.list(dir)
            phase = .loaded
        } catch let error as DoklinError {
            entries = []
            phase = .failed(error.message)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Make a note here and answer its path.
    public func createNote(named name: String) async throws -> String {
        let path = try workspace.files.createNote(in: dir, named: name)
        await workspace.wrote([path])
        load()
        return path
    }

    public func createFolder(named name: String) async throws -> String {
        let path = try workspace.files.createFolder(in: dir, named: name)
        await workspace.wrote([path])
        load()
        return path
    }

    public func rename(_ entry: FolderEntry, to name: String) async throws {
        let (_, changed) = try workspace.files.rename(entry, to: name)
        await workspace.wrote(changed)
        load()
    }

    public func move(_ entry: FolderEntry, into folder: String) async throws {
        let (_, changed) = try workspace.files.move(entry, into: folder)
        await workspace.wrote(changed)
        load()
    }

    public func remove(_ entry: FolderEntry) async throws {
        // No Trash here: history is the only copy, so what is pending goes
        // into it first.
        try? await Engine.shared.run("versions_flush", ["ms": 2000])
        let gone = try workspace.files.remove(entry)
        await workspace.wrote(gone)
        load()
    }

    /// Who will see something made here, in words — nil where nothing can be.
    public var whoSeesNew: String? {
        switch workspace.audience(of: dir) {
        case .everyone: return "Everyone in \(workspace.name) will see it."
        case .onlyYou: return "Only you will see it."
        case .folder(let name): return "The people of “\(name)” will see it."
        case .folders, .nowhere: return nil
        }
    }

    /// Nothing is made directly in the folder that holds the restricted ones.
    public var canHoldNotes: Bool { workspace.audience(of: dir) != .folders }

    /// A section's own folder is managed, not renamed, moved or removed.
    public func isManaged(_ entry: FolderEntry) -> Bool {
        guard case .folder(let path) = entry, workspace.status?.sections == true else { return false }
        let lower = path.lowercased()
        return lower == "private" || lower == "restricted"
            || (workspace.status?.spaces.contains { $0.path.lowercased() == lower } ?? false)
    }

    /// Moving `entry` into `folder` lets more people see it: the sentence
    /// that says who, to confirm first — or nil when nobody new will.
    public func widening(_ entry: FolderEntry, into folder: String) -> String? {
        let before = workspace.audience(of: entry.path)
        let after = workspace.audience(of: folder)
        guard before != after else { return nil }
        switch (before, after) {
        case (_, .everyone):
            return "Everyone in \(workspace.name) will be able to see it."
        case (.onlyYou, .folder(let name)), (.nowhere, .folder(let name)):
            return "The people of “\(name)” will be able to see it."
        case (.folder, .folder(let name)):
            return "The people of “\(name)” will be able to see it, and they may not be the same people."
        default:
            return nil
        }
    }
}
