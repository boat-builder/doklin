// Browse: a workspace as one tree, its folders opening in place — what each
// holds read off this iPhone's copy by the Mac sidebar's rules
// (`WorkspaceFiles.list`), in the sections the Mac's sidebar has: the
// workspace, its restricted folders, and Private. What is open is kept on
// the device, by workspace.

import Foundation
import Observation

/// A part of the tree, as the Mac's sidebar heads them.
public enum TreeSection: Hashable, Sendable {
    /// Everyone in the workspace has it.
    case workspace
    /// Folders only the people chosen have: the restricted folders.
    case restricted
    /// Only this person has it.
    case personal
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
    /// The folder the section is, workspace-relative: `""`, `Restricted`, `Private`.
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

    public static let privateFolder = "Private"
    public static let restrictedFolder = "Restricted"

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
        let section = { (entry: FolderEntry) -> TreeSection in
            guard case .folder(let path) = entry else { return .workspace }
            switch path.lowercased() {
            case Self.privateFolder.lowercased(): return .personal
            case Self.restrictedFolder.lowercased(): return .restricted
            default: return .workspace
            }
        }
        let shared = top.filter { section($0) == .workspace }
        let restricted = top.first { section($0) == .restricted }?.path
        let personal = top.first { section($0) == .personal }?.path
        let wanted = filter.trimmingCharacters(in: .whitespaces).lowercased()
        let keep: Set<String>? = wanted.isEmpty ? nil : matching(wanted)
        func entries(_ dir: String) -> [FolderEntry] {
            dir.isEmpty ? shared : ((try? files.list(dir)) ?? [])
        }
        func flatten(_ dir: String, depth: Int) -> [TreeRow] {
            guard depth < 12 else { return [] }
            var rows: [TreeRow] = []
            for entry in entries(dir) {
                if let keep, !keep.contains(entry.id) { continue }
                let isOpen: Bool
                if case .folder = entry { isOpen = keep != nil || open.contains(entry.id) } else { isOpen = false }
                rows.append(TreeRow(entry: entry, depth: depth, open: isOpen))
                if isOpen, case .folder(let path) = entry { rows += flatten(path, depth: depth + 1) }
            }
            return rows
        }
        var out = [TreeGroup(section: .workspace, folder: "", rows: flatten("", depth: 0))]
        if let restricted { out.append(TreeGroup(section: .restricted, folder: restricted, rows: flatten(restricted, depth: 0))) }
        if let personal { out.append(TreeGroup(section: .personal, folder: personal, rows: flatten(personal, depth: 0))) }
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
