// A folder of the workspace, and the changes a person makes in it from the
// tree — a new note, a new folder, a rename, a move, a removal. Each lands on
// disk first and reaches every other device through sync.

import Foundation

/// How far a screen has got with what it shows.
public enum LoadPhase: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)
}

@MainActor
public struct FolderModel {
    public let workspace: Workspace
    /// `""` is the workspace's own folder, which holds the three folders.
    public let dir: String

    public init(workspace: Workspace, dir: String) {
        self.workspace = workspace
        self.dir = dir
    }

    /// Make a note here, "Untitled" until it is named, and answer its path.
    public func createNote() async throws -> String {
        let path = try workspace.files.createNote(in: dir)
        await workspace.wrote([path])
        return path
    }

    public func createFolder(named name: String) async throws -> String {
        let path = try workspace.files.createFolder(in: dir, named: name)
        await workspace.wrote([path])
        return path
    }

    public func rename(_ entry: FolderEntry, to name: String) async throws {
        let (_, moved) = try workspace.files.rename(entry, to: name)
        await workspace.moved(moved)
    }

    public func move(_ entry: FolderEntry, into folder: String) async throws {
        let (_, moved) = try workspace.files.move(entry, into: folder)
        await workspace.moved(moved)
    }

    public func remove(_ entry: FolderEntry) async throws {
        // No Trash here: history is the only copy, so what is pending goes
        // into it first.
        try? await Engine.shared.run("versions_flush", ["ms": 2000])
        let gone = try workspace.files.remove(entry)
        await workspace.wrote(gone)
    }

    /// Who will see something made here, in words — nil where nothing made
    /// would sync.
    public var whoSeesNew: String? {
        switch workspace.place(of: dir) {
        case .library: return "Everyone in \(workspace.name) will see it."
        case .mine: return "Only you will see it."
        case .share(let space): return "Everyone who can open “\(space.name)” will see it."
        case .nowhere: return nil
        }
    }

    /// Nothing is made at the top of the workspace, which holds the three
    /// folders, or straight under Shared with me: nobody would have shared it.
    public var canHoldNotes: Bool { !dir.isEmpty && dir.lowercased() != TreeModel.sharedFolder.lowercased() }

    /// Library, My files and Shared with me themselves are never renamed,
    /// moved, removed or shared.
    public func isSection(_ entry: FolderEntry) -> Bool {
        guard case .folder(let path) = entry else { return false }
        return TreeModel.isSectionFolder(path)
    }
}
