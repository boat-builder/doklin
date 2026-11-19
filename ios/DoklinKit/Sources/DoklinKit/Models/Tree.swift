// Browse: a workspace as one tree, its folders opening in place — what each
// holds read off this iPhone's copy by the Mac sidebar's rules
// (`WorkspaceFiles.list`), in the sections the Mac's sidebar has: Library,
// the restricted folders, and Private, each its folder at the top of the
// workspace; then anything else there, which is in no section. What is open
// is kept on the device, by workspace.

import Foundation
import Observation

/// A part of the tree, as the Mac's sidebar heads them.
public enum TreeSection: Hashable, Sendable {
    /// Everyone in the workspace has it: what is in `Library/`.
    case library
    /// Folders only the people chosen have: the restricted folders.
    case restricted
    /// Only this person has it.
    case personal
    /// At the top of the workspace but in no section: it stays on this iPhone.
    case nowhere

    /// The section an entry at the top of the workspace is, by its name,
    /// whatever its case.
    public static func of(top entry: FolderEntry) -> TreeSection {
        guard case .folder(let path) = entry else { return .nowhere }
        switch path.lowercased() {
        case TreeModel.libraryFolder.lowercased(): return .library
        case TreeModel.restrictedFolder.lowercased(): return .restricted
        case TreeModel.privateFolder.lowercased(): return .personal
        default: return .nowhere
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
    /// The folder the section is, workspace-relative: `Library`, `Restricted`,
    /// `Private` — `""` for what is in none.
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
    @ObservationIgnored private let key: String

    /// The shared section's folder, at the top of the workspace, where
    /// everything new lands (`LIBRARY_DIR`, engine/src/cloud/space.rs;
    /// `LIBRARY_FOLDER`, cloud-worker/src/layout.ts; `LIBRARY_DIR`,
    /// src/cloud.ts: change all four).
    public nonisolated static let libraryFolder = "Library"
    public nonisolated static let privateFolder = "Private"
    public nonisolated static let restrictedFolder = "Restricted"

    /// Whether `name` is a section's own folder's, whatever its case. No
    /// folder at the top of Library has one either: the shared section holds
    /// nothing under them (`RESERVED_DIRS`, engine/src/cloud/space.rs).
    public nonisolated static func isSectionName(_ name: String) -> Bool {
        [libraryFolder, privateFolder, restrictedFolder].contains { $0.lowercased() == name.lowercased() }
    }

    public init(workspace: Workspace, defaults: UserDefaults = .standard) {
        self.workspace = workspace
        self.defaults = defaults
        key = Self.key(workspace.status?.wsId ?? workspace.root)
        open = Set(defaults.stringArray(forKey: key) ?? [])
    }

    private static func key(_ wsId: String) -> String { "tree-open-\(wsId)" }

    /// A workspace left this device: what was open in its tree goes too.
    public static func forget(_ wsId: String, in defaults: UserDefaults) {
        defaults.removeObject(forKey: key(wsId))
    }

    /// One-time stored-data migration: what was open in a workspace's tree,
    /// once its folder has moved into the Library layout (`Sections.moved`).
    public static func moveIntoLibrary(_ wsId: String, in defaults: UserDefaults) {
        guard let open = defaults.stringArray(forKey: key(wsId)) else { return }
        defaults.set(Set(open.map { Sections.moved($0).lowercased() }).sorted(), forKey: key(wsId))
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
        defaults.set(Array(open).sorted(), forKey: key)
        load()
    }

    /// Read the tree again.
    public func load() {
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
        // Library is always there: the engine brings its folder back when it goes.
        var out = [group(.library, folder(.library) ?? Self.libraryFolder)]
        if let restricted = folder(.restricted) { out.append(group(.restricted, restricted)) }
        if let personal = folder(.personal) { out.append(group(.personal, personal)) }
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
