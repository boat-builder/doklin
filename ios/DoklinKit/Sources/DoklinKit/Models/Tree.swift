// Browse: a workspace as one tree, its folders opening in place — what each
// holds read off this iPhone's copy by the Mac sidebar's rules
// (`WorkspaceFiles.list`), under the Mac sidebar's three headings: Library,
// My files, and Shared with me, each its folder at the top of the
// workspace; then anything else there, which is in no section. What is open
// is kept on the device, by workspace.

import Foundation
import Observation

/// A part of the tree, as the Mac's sidebar heads them.
public enum TreeSection: Hashable, Sendable {
    /// Everyone in the workspace has it: what is in `Library/`.
    case library
    /// This person's own, where what they share stays: `My files/`.
    case mine
    /// What others shared with this person: `Shared with me/`.
    case shared
    /// At the top of the workspace but in no section: it stays on this iPhone.
    case nowhere

    /// The section an entry at the top of the workspace is, by its name,
    /// whatever its case.
    public static func of(top entry: FolderEntry) -> TreeSection {
        guard case .folder(let path) = entry else { return .nowhere }
        switch path.lowercased() {
        case TreeModel.libraryFolder.lowercased(): return .library
        case TreeModel.myFilesFolder.lowercased(): return .mine
        case TreeModel.sharedFolder.lowercased(): return .shared
        default: return .nowhere
        }
    }

    /// The section's own folder at the top of the workspace, as `doklin`
    /// spells it — nil for what is in none.
    public var folder: String? {
        switch self {
        case .library: return TreeModel.libraryFolder
        case .mine: return TreeModel.myFilesFolder
        case .shared: return TreeModel.sharedFolder
        case .nowhere: return nil
        }
    }
}

public struct TreeRow: Identifiable, Hashable, Sendable {
    public let entry: FolderEntry
    /// How deep in its section: 0 at the top.
    public let depth: Int
    /// A folder shown open.
    public let open: Bool

    public var id: String { entry.id }
    public var isFolder: Bool {
        if case .folder = entry { return true }
        return false
    }
}

public struct TreeGroup: Identifiable, Hashable, Sendable {
    public let section: TreeSection
    /// The folder the section is, workspace-relative, as the disk spells it:
    /// `Library`, `My files`, `Shared with me` — `""` for what is in none.
    public let folder: String
    public let rows: [TreeRow]

    public var id: TreeSection { section }
}

@MainActor
@Observable
public final class TreeModel {
    public let workspace: Workspace
    public private(set) var groups: [TreeGroup] = []
    public private(set) var phase: LoadPhase = .idle
    /// Narrows the tree to the names with this in them, and their folders.
    public var filter = "" {
        didSet { if filter != oldValue { load() } }
    }

    @ObservationIgnored private var open: Set<String>
    @ObservationIgnored private let defaults: UserDefaults
    /// Where `open` is kept: by the workspace's id, or by its folder while
    /// the engine has not said the id yet — as just after joining, when the
    /// tree is the first screen shown (`settle`).
    @ObservationIgnored private var key: String

    /// The three folders at the top of a workspace: Library, which everyone
    /// has and where everything new lands; a person's own files; and what
    /// others shared with them (`LIBRARY_DIR`, `MY_FILES_DIR`, `SHARED_DIR`,
    /// engine/src/cloud/space.rs and src/cloud.ts; `LIBRARY_FOLDER`,
    /// `MY_FILES_FOLDER`, `SHARED_FOLDER`, cloud-worker/src/layout.ts:
    /// change all four).
    public nonisolated static let libraryFolder = "Library"
    public nonisolated static let myFilesFolder = "My files"
    public nonisolated static let sharedFolder = "Shared with me"

    /// Whether `path` is one of the three folders themselves, whatever its
    /// case: never a row, and never renamed, moved, removed or shared.
    public nonisolated static func isSectionFolder(_ path: String) -> Bool {
        [libraryFolder, myFilesFolder, sharedFolder].contains { $0.lowercased() == path.lowercased() }
    }

    public init(workspace: Workspace, defaults: UserDefaults = .standard) {
        self.workspace = workspace
        self.defaults = defaults
        key = Self.key(of: workspace)
        open = Set(defaults.stringArray(forKey: key) ?? [])
    }

    private static func key(_ wsId: String) -> String { "tree-open-\(wsId)" }
    private static func key(of workspace: Workspace) -> String { key(workspace.status?.wsId ?? workspace.root) }

    /// The id came after the tree was made: what was kept by the folder
    /// moves to it, so that leaving the workspace forgets it.
    private func settle() {
        let now = Self.key(of: workspace)
        guard now != key else { return }
        open.formUnion(defaults.stringArray(forKey: now) ?? [])
        defaults.removeObject(forKey: key)
        key = now
        defaults.set(Array(open).sorted(), forKey: key)
    }

    /// A workspace left this device: what was open in its tree goes too.
    public static func forget(_ wsId: String, in defaults: UserDefaults) {
        defaults.removeObject(forKey: key(wsId))
    }

    /// ONE-TIME, to be deleted with `Sections.fromLibraryLayout`: the
    /// folders kept open in a workspace's tree follow its `Private` and
    /// `Restricted` to `My files` and `Shared with me`.
    static func moveFromLibraryLayout(_ wsId: String, in defaults: UserDefaults) {
        guard let open = defaults.stringArray(forKey: key(wsId)) else { return }
        defaults.set(Set(open.map { Sections.fromLibraryLayout($0).lowercased() }).sorted(), forKey: key(wsId))
    }

    public var isFiltering: Bool { !filter.trimmingCharacters(in: .whitespaces).isEmpty }

    public func isOpen(_ path: String) -> Bool { open.contains(path.lowercased()) }

    /// Open a folder that is shut, or shut one that is open.
    public func toggle(_ path: String) {
        let lower = path.lowercased()
        if open.contains(lower) {
            open.remove(lower)
        } else {
            open.insert(lower)
        }
        settle()
        defaults.set(Array(open).sorted(), forKey: key)
        load()
    }

    /// Open every folder `path` is in, so its row shows.
    public func reveal(_ path: String) {
        var folder = DocLinks.directory(of: path)
        while !folder.isEmpty {
            open.insert(folder.lowercased())
            folder = DocLinks.directory(of: folder)
        }
        settle()
        defaults.set(Array(open).sorted(), forKey: key)
        load()
    }

    /// Something shared is somewhere else on this iPhone now: the folders
    /// open at or under where it was are open where it is.
    public func follow(_ moves: [SpaceMove]) {
        for move in moves where move.dir {
            let from = move.from.lowercased(), to = move.to.lowercased()
            open = Set(open.map { $0 == from ? to : $0.hasPrefix(from + "/") ? to + $0.dropFirst(from.count) : $0 })
        }
        settle()
        defaults.set(Array(open).sorted(), forKey: key)
        load()
    }

    /// Read the tree again.
    public func load() {
        settle()
        let files = workspace.files
        let top: [FolderEntry]
        do {
            top = try files.list("")
        } catch let error as DoklinError {
            groups = []
            phase = .failed(error.message)
            return
        } catch {
            groups = []
            phase = .failed(error.localizedDescription)
            return
        }
        let folder = { (section: TreeSection) in top.first { TreeSection.of(top: $0) == section }?.path }
        let strays = top.filter { TreeSection.of(top: $0) == .nowhere }
        let wanted = filter.trimmingCharacters(in: .whitespaces).lowercased()
        let keep: Set<String>? = wanted.isEmpty ? nil : matching(wanted)
        func flatten(_ entries: [FolderEntry], depth: Int) -> [TreeRow] {
            guard depth < 12 else { return [] }
            var rows: [TreeRow] = []
            for entry in entries {
                if let keep, !keep.contains(entry.id) { continue }
                let isOpen: Bool
                if case .folder = entry { isOpen = keep != nil || open.contains(entry.id) } else { isOpen = false }
                rows.append(TreeRow(entry: entry, depth: depth, open: isOpen))
                if isOpen, case .folder(let path) = entry { rows += flatten((try? files.list(path)) ?? [], depth: depth + 1) }
            }
            return rows
        }
        func group(_ section: TreeSection, _ dir: String) -> TreeGroup {
            TreeGroup(section: section, folder: dir, rows: flatten((try? files.list(dir)) ?? [], depth: 0))
        }
        // The three headings are always there, as in the Mac's sidebar: the
        // engine makes each folder when there is something to put in it.
        var out = [TreeSection.library, .mine, .shared].map { section in
            group(section, folder(section) ?? section.folder ?? "")
        }
        if !strays.isEmpty { out.append(TreeGroup(section: .nowhere, folder: "", rows: flatten(strays, depth: 0))) }
        if keep != nil { out = out.filter { !$0.rows.isEmpty } }
        groups = out
        phase = .loaded
    }

    /// The ids of every entry whose name has `wanted` in it, and of every
    /// folder above one.
    private func matching(_ wanted: String) -> Set<String> {
        var keep = Set<String>()
        var seen = 0
        func walk(_ dir: String, depth: Int) {
            guard depth < 12, seen < 5000, let entries = try? workspace.files.list(dir) else { return }
            for entry in entries {
                seen += 1
                if entry.name.lowercased().contains(wanted) {
                    var path = entry.path
                    keep.insert(path.lowercased())
                    while !DocLinks.directory(of: path).isEmpty {
                        path = DocLinks.directory(of: path)
                        keep.insert(path.lowercased())
                    }
                }
                if case .folder(let path) = entry { walk(path, depth: depth + 1) }
            }
        }
        walk("", depth: 0)
        return keep
    }
}

extension WorkspaceFiles {
    /// The sections' own folders at the top of the workspace, as the disk
    /// spells them: what search looks in, and never what is in none.
    public func sectionFolders() -> [String] {
        ((try? list("")) ?? []).filter { TreeSection.of(top: $0) != .nowhere }.map(\.path)
    }
}
