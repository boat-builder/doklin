// The parts of a workspace only some people have, beside `Library/`, which
// everyone has: a person's Private, and restricted folders under
// `Restricted/` that only the people in them have, on their own devices.
// Nobody else sees one, or that it exists. Everyone in a restricted folder
// is equal: any of them adds people, takes them out, leaves, or deletes it
// for everyone.
//
// The engine names a new restricted folder and puts it in place — the app
// never makes one under `Restricted/` itself — and the workspace's status
// lists what this person is in, so a screen showing one reads it from there
// and follows it as it changes.

import Foundation
import Observation

extension Workspace {
    /// The section a path is in, when it is in one: the folder itself or
    /// anything under it, compared as the disk compares names.
    public func space(holding path: String) -> SpaceStatus? {
        Sections.space(holding: path, in: status)
    }

    public func space(id: String) -> SpaceStatus? {
        status?.spaces.first { $0.id == id }
    }

    /// The restricted folder whose own folder is `path`.
    public func restrictedFolder(at path: String) -> SpaceStatus? {
        guard let space = space(holding: path), space.kind == .restricted,
              space.path.lowercased() == path.lowercased() else { return nil }
        return space
    }

    /// Whether this person may make a restricted folder in this workspace.
    public var mayRestrict: Bool { status != nil && may("work") }
}

public enum Sections {
    /// Whether `path` is `folder` or something in it, compared as the disk
    /// compares names.
    public static func holds(_ folder: String, _ path: String) -> Bool {
        let folder = folder.lowercased(), path = path.lowercased()
        return path == folder || path.hasPrefix(folder + "/")
    }

    /// The section `path` is in, when it is in one.
    public static func space(holding path: String, in status: CloudStatus?) -> SpaceStatus? {
        guard let status else { return nil }
        return status.spaces.first { holds($0.path, path) }
    }

    /// What a move that lets more people see something asks — "Move “plan”
    /// to Library?", "Move “plan” to “Finance”?" — named for who will see it
    /// there, not for the folder it lands in.
    public static func moveTitle(_ name: String, to folder: String, in status: CloudStatus?) -> String {
        let to: String
        if case .folder(let space) = Audience.of(folder, in: status) { to = "“\(space)”" } else { to = TreeModel.libraryFolder }
        return "Move “\(name)” to \(to)?"
    }

    /// One-time stored-data migration: a workspace-relative path this
    /// iPhone kept from before its folder moved into the Library layout, as
    /// it is now — `Library/` in front, unless it already starts with a
    /// section's name (any case) or a hidden one. The engine's `moved_rel`
    /// (engine/src/cloud/layout.rs) and the Mac's `toLibraryLayout`
    /// (src/cloud.ts) move a path the same way: change all three.
    public static func moved(_ rel: String) -> String {
        let top = String(rel.prefix { $0 != "/" })
        if rel.isEmpty || top.hasPrefix(".") || TreeModel.isSectionName(top) { return rel }
        return "\(TreeModel.libraryFolder)/\(rel)"
    }

    /// Who gains sight of something moved from `from` to `to` — "Everyone in
    /// Acme will be able to see it", "All 3 people in “Finance” will…" — or
    /// nil when nobody does: a move that keeps who sees it, or narrows it,
    /// is never asked about. `widerAudience` (src/cloud.ts) — change both.
    public static func wider(in status: CloudStatus?, from: String, to: String) -> String? {
        let before = Audience.of(from, in: status), after = Audience.of(to, in: status)
        guard let status, before != .everyone else { return nil }
        switch after {
        case .everyone:
            return "Everyone in \(status.name) will be able to see it."
        case .folder:
            guard let target = space(holding: to, in: status) else { return nil }
            let source = space(holding: from, in: status)
            if source?.id == target.id { return nil }
            let had = source?.members ?? []
            let gained = target.members.filter { !had.contains($0) && $0 != status.meId }
            guard !gained.isEmpty else { return nil }
            let who = target.members.count == 2 ? "Both people" : "All \(target.members.count) people"
            return "\(who) in “\(target.name)” will be able to see it."
        default:
            return nil
        }
    }
}

/// A restricted folder that left this iPhone: this person was taken out of
/// it, or it was deleted — here or on another device. The engine has
/// already deleted its copy, so every screen inside it closes.
public struct FolderLeft: Equatable, Sendable {
    /// Its folder, workspace-relative, as it was here.
    public let path: String
    /// Moves with each folder that leaves, so one leaving twice is heard twice.
    public let count: Int

    /// Whether `path` was the folder or in it.
    public func holds(_ path: String) -> Bool { Sections.holds(self.path, path) }
}

/// What a restricted folder is made from: nothing, a folder that is there
/// (it becomes the restricted folder, and leaves the devices of everyone not
/// picked), or a private note (it moves into a new folder shared with the
/// people picked — there are no per-note permissions).
public enum RestrictedSource: Hashable, Identifiable, Sendable {
    case new
    case folder(String)
    case note(String)

    public var id: String {
        switch self {
        case .new: return "new"
        case .folder(let path): return "folder:\(path)"
        case .note(let path): return "note:\(path)"
        }
    }

    public var title: String {
        switch self {
        case .new: return "New restricted folder"
        case .folder(let path): return "Restrict access to “\(DocLinks.name(of: path))”"
        case .note(let path): return "Share “\(DocLinks.stem(of: DocLinks.name(of: path)))”"
        }
    }

    public var hint: String {
        switch self {
        case .new:
            return "A restricted folder is only on the devices of the people in it. Nobody else in the workspace sees it, or that it exists."
        case .folder(let path):
            // Named for the section it is in now: its versions stay in that one's store.
            let section = String(path.prefix { $0 != "/" })
            return "It becomes a restricted folder: only the people you pick keep it, and it is removed from everyone else’s devices. Versions from before stay in \(section)’s history until they age out."
        case .note:
            return "The note moves into a new restricted folder that holds you and the people you pick. Nobody else sees it."
        }
    }

    public var nameLabel: String {
        if case .note = self { return "Folder name" }
        return "Name"
    }

    /// What the name starts as.
    public var prefill: String {
        switch self {
        case .new: return ""
        case .folder(let path): return DocLinks.name(of: path)
        case .note(let path): return DocLinks.stem(of: DocLinks.name(of: path))
        }
    }

    public var button: String {
        switch self {
        case .new: return "Create folder"
        case .folder: return "Restrict"
        case .note: return "Share"
        }
    }

    /// A folder needs a name; a note is shared *with* somebody, so it needs
    /// a person too.
    public func ready(name: String, picked: Int) -> Bool {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if case .note = self { return picked > 0 }
        return true
    }

    /// Who will have a restricted folder made from a folder, in words.
    public static func whoWillHave(_ names: [String]) -> String {
        (names.isEmpty ? "Only you will have it." : "You and \(names.joined(separator: ", ")) will have it.")
            + " People can be added later."
    }
}

/// Making a restricted folder: who can be in it, and making it.
@MainActor
@Observable
public final class RestrictedFolderModel {
    public let workspace: Workspace
    public let source: RestrictedSource
    /// Everyone on the workspace but this person; nil until the domain said.
    public private(set) var others: [MemberRecord]?
    public private(set) var busy = false
    public var problem: String?

    public init(workspace: Workspace, source: RestrictedSource) {
        self.workspace = workspace
        self.source = source
    }

    /// This person, in words.
    public var me: String { workspace.status?.me ?? "" }

    public func load() async {
        do {
            let people: People = try await Engine.shared.call("cloud_people", ["root": .string(workspace.root)])
            others = people.members.filter { $0.id != people.me }
        } catch {
            problem = (error as? DoklinError)?.message ?? error.localizedDescription
        }
    }

    /// Make it, with this person and `members` in it, and put in it what it
    /// was made from. Answers its folder, or nil with `problem` saying why not.
    public func create(name: String, members: [String]) async -> String? {
        busy = true
        problem = nil
        defer { busy = false }
        let from: JSONValue
        if case .folder(let path) = source { from = .string(workspace.files.absolute(path)) } else { from = .null }
        let made: SpaceStatus
        do {
            made = try await Engine.shared.call("cloud_space_create", [
                "root": .string(workspace.root),
                "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
                "members": .strings(members),
                "from": from,
            ])
        } catch {
            problem = (error as? DoklinError)?.message ?? error.localizedDescription
            return nil
        }
        switch source {
        case .new:
            workspace.changed([made.path])
        case .folder(let path):
            workspace.changed([path, made.path])
        case .note(let path):
            let note = (try? workspace.files.list(DocLinks.directory(of: path)))?.first { $0.path == path }
            do {
                guard let note else { throw DoklinError("“\(DocLinks.name(of: path))” is not there any more.") }
                let (_, changed) = try workspace.files.move(note, into: made.path)
                await workspace.wrote(changed)
            } catch {
                problem = "The folder was made, but the note could not be moved into it: \((error as? DoklinError)?.message ?? error.localizedDescription)"
                workspace.changed([made.path])
            }
        }
        return made.path
    }
}

/// Who can open one restricted folder, and the four things anyone in it may
/// do: add a person, take one out, leave, delete it.
@MainActor
@Observable
public final class SpaceAccessModel {
    public let workspace: Workspace
    public let id: String
    /// Everyone on the workspace, for names and for who can be added.
    public private(set) var everyone: [MemberRecord]?
    public private(set) var busy = false
    public var problem: String?
    private var meId: String?

    public init(workspace: Workspace, id: String) {
        self.workspace = workspace
        self.id = id
        self.meId = workspace.status?.meId
    }

    /// The folder as the status lists it now: nil once it has left this iPhone.
    public var space: SpaceStatus? { workspace.space(id: id) }

    public var me: String? { meId ?? workspace.status?.meId }

    public func isYou(_ memberId: String) -> Bool { memberId == me }

    /// A person in it, by name — or by id when the list cannot say.
    public func name(of memberId: String) -> String {
        everyone?.first { $0.id == memberId }.map { $0.name.isEmpty ? $0.email : $0.name } ?? memberId
    }

    /// The people on the workspace who are not in it yet.
    public var addable: [MemberRecord] {
        let inIt = space?.members ?? []
        return (everyone ?? []).filter { !inIt.contains($0.id) }
    }

    /// The last person cannot leave: a folder is deleted, or handed to
    /// somebody, never left with nobody in it.
    public var alone: Bool { (space?.members.count ?? 0) <= 1 }

    public func load() async {
        do {
            let people: People = try await Engine.shared.call("cloud_people", ["root": .string(workspace.root)])
            everyone = people.members
            meId = people.me
        } catch {
            problem = (error as? DoklinError)?.message ?? error.localizedDescription
        }
    }

    private func act(_ change: () async throws -> Void) async {
        busy = true
        problem = nil
        defer { busy = false }
        do {
            try await change()
        } catch {
            problem = (error as? DoklinError)?.message ?? error.localizedDescription
        }
    }

    private func member(_ memberId: String, add: Bool) async throws {
        try await Engine.shared.run("cloud_space_member", [
            "root": .string(workspace.root), "id": .string(id), "memberId": .string(memberId), "add": .bool(add),
        ])
    }

    public func add(_ memberId: String) async {
        await act { try await member(memberId, add: true) }
    }

    /// Take somebody else out: their devices delete their copy.
    public func takeOut(_ memberId: String) async {
        await act { try await member(memberId, add: false) }
    }

    /// Leave it — after handing it to `heir`, when this person is the last
    /// one in it. This iPhone deletes its copy; the others keep theirs.
    public func leave(handingTo heir: String? = nil) async {
        guard let me, let space else {
            problem = "This iPhone does not know who you are here yet — try again in a moment."
            return
        }
        await act {
            if let heir { try await member(heir, add: true) }
            try await givingUp(space) { try await member(me, add: false) }
        }
    }

    /// Delete it for everyone in it: erased from the cloud, and from the
    /// devices of each of them.
    public func delete() async {
        guard let space else { return }
        await act {
            try await givingUp(space) {
                try await Engine.shared.run("cloud_space_delete", ["root": .string(workspace.root), "id": .string(id)])
            }
        }
    }

    /// The folder goes from this iPhone by this person's own doing: its
    /// going is no news to them — unless it did not go after all.
    private func givingUp(_ space: SpaceStatus, _ change: () async throws -> Void) async throws {
        workspace.givingUp(space.path)
        do {
            try await change()
        } catch {
            workspace.givingUp(space.path, false)
            throw error
        }
        workspace.changed([space.path])
    }
}

extension FolderModel {
    /// This is the folder that holds the restricted folders: nothing but
    /// them is made in it.
    public var holdsRestrictedFolders: Bool { workspace.audience(of: dir) == .folders }

    /// A folder of Library or of this person's Private, which can become a
    /// restricted folder.
    public func restrictable(_ entry: FolderEntry) -> Bool {
        guard case .folder(let path) = entry, workspace.mayRestrict, !isManaged(entry) else { return false }
        let audience = workspace.audience(of: path)
        return audience == .everyone || audience == .onlyYou
    }

    /// What can be renamed: anything that is not a section's own folder —
    /// and a restricted folder, which is then renamed for everyone in it.
    /// It is never moved or removed like the rows beside it: it is left, or
    /// deleted for everyone, from its access screen.
    public func renamable(_ entry: FolderEntry) -> Bool {
        !isManaged(entry) || workspace.restrictedFolder(at: entry.path) != nil
    }

    /// The question a move that lets more people see `entry` asks.
    public func wideningTitle(_ entry: FolderEntry, into folder: String) -> String {
        Sections.moveTitle(entry.name, to: folder, in: workspace.status)
    }

    /// A note of this person's Private, which is shared by moving it into a
    /// restricted folder with the people it is for.
    public func shareable(_ entry: FolderEntry) -> Bool {
        guard case .document = entry, workspace.mayRestrict else { return false }
        return workspace.audience(of: entry.path) == .onlyYou
    }

    /// What an empty section says it is for.
    public var emptyHint: String? {
        switch workspace.audience(of: dir) {
        case .folders: return "Folders only the people you choose can open."
        case .onlyYou where !dir.contains("/"): return "Only you can see what you put here."
        default: return nil
        }
    }
}

extension PresenceDevice {
    /// What another device here is doing, in words: "on MacBook Air ·
    /// editing Projects/plan.md · 2 min ago".
    public func words(now: Int = Clock.now) -> String {
        let on = !device.isEmpty && device != name ? "on \(device) · " : ""
        return on + (path.map { "editing \($0)" } ?? "here, idle") + " · \(Clock.ago(ts, now: now))"
    }
}
