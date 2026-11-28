// Who can open what. Beside `Library/`, which everyone in the workspace has,
// a person has `My files/`, which is theirs alone — and anything in it, a
// folder or one document, can be shared with people of the workspace where
// it is. It stays where it was; the people it is shared with find it under
// `Shared with me/`. Everyone who can open something shared reads it, edits
// it, renames it and shares it with more people, or stops sharing it with
// somebody. Only whoever can open the folder it sits in moves it or deletes
// it; anyone else leaves it.
//
// The workspace's status lists each of these sections with where its item is
// on this iPhone, so a screen reads who can open a path from there, and
// follows it as it changes. The rules and the words are the Mac's
// (src/cloud.ts, src/ShareDialog.tsx, src/Sidebar.tsx, src/App.tsx).

import Foundation
import Observation

/// Which part of a workspace a path is in, and so who can open it. The
/// Mac's `Place` (src/cloud.ts).
public enum Place: Equatable, Sendable {
    /// Everyone in the workspace: Library.
    case library
    /// Only this person, on every device of theirs: their My files, and
    /// nothing shared.
    case mine(SpaceStatus)
    /// Something shared — the folder or the document the section is, or
    /// anything inside that folder: the people it is shared with, and
    /// whoever can open the folder it sits in.
    case share(SpaceStatus)
    /// In no section, so it stays on this iPhone and syncs nowhere until it
    /// is moved: the workspace's folder itself and anything else at its top,
    /// and what is under `Shared with me` that nobody shared.
    case nowhere
}

extension Workspace {
    /// The section a path is in: the deepest one that holds it.
    public func place(of path: String) -> Place {
        Sections.place(of: path, in: status)
    }

    public func space(id: String) -> SpaceStatus? {
        status?.spaces.first { $0.id == id }
    }

    /// The share whose own item is at `path`: a shared folder at that
    /// folder, a shared document at any of its files.
    public func share(at path: String, isFolder: Bool) -> SpaceStatus? {
        Sections.share(at: path, isFolder: isFolder, in: status)
    }

    /// The share a row itself is, when it is one.
    public func share(_ entry: FolderEntry) -> SpaceStatus? {
        switch entry {
        case .folder(let path): return share(at: path, isFolder: true)
        case .document(let row): return share(at: row.path, isFolder: false)
        case .file: return nil
        }
    }

    /// This person's My files, once the domain has said it is theirs and its
    /// folder is here.
    public var myFiles: SpaceStatus? {
        status?.spaces.first { $0.kind == .private && !$0.path.isEmpty }
    }

    /// Who can open what is at `path`, in a few words.
    public func audience(of path: String) -> String? {
        status.map { Sections.audience(place(of: path), in: $0) }
    }

    /// Whether *Share* is offered on something: a folder or a document in My
    /// files, or in something shared, is shared where it is. What is in
    /// Library is everyone's already, what is in no section syncs nowhere,
    /// and only markdown and html documents sync.
    public func shareable(_ target: ShareTarget) -> Bool {
        guard status != nil, may("work"), !TreeModel.isSectionFolder(target.path) else { return false }
        guard target.isFolder || [.markdown, .html].contains(FileKind.of(target.path)) else { return false }
        switch place(of: target.path) {
        case .mine, .share: return true
        case .library, .nowhere: return false
        }
    }
}

public enum Sections {
    /// Whether `path` is `folder` or something in it, compared as the disk
    /// compares names.
    public static func holds(_ folder: String, _ path: String) -> Bool {
        let folder = folder.lowercased(), path = path.lowercased()
        return path == folder || path.hasPrefix(folder + "/")
    }

    /// A document's path without its extension: its markdown, its html and
    /// its comments are one document, under one name (`documentStem`,
    /// src/cloud.ts; `split_name`, engine/src/cloud/space.rs; `splitName`,
    /// cloud-worker/src/mount.ts — change all four).
    public static func documentStem(_ path: String) -> String {
        let name = DocLinks.name(of: path)
        let meta = ".meta.jsonl"
        if name.lowercased().hasSuffix(meta), name.count > meta.count { return String(path.dropLast(meta.count)) }
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return path }
        return String(path.dropLast(name.distance(from: dot, to: name.endIndex)))
    }

    /// Whether `path` names one of a document's files: its markdown, its
    /// html or its comments. Anything else that only begins like a document
    /// — a picture beside it, a folder called `Plan.1` — is not that
    /// document (`isDocumentFile`, src/cloud.ts — change both).
    static func isDocumentFile(_ path: String) -> Bool {
        DocLinks.isDocument(path) || path.lowercased().hasSuffix(".meta.jsonl")
    }

    /// The share whose own item is at `path` (`shareAt`, src/cloud.ts —
    /// change both).
    public static func share(at path: String, isFolder: Bool, in status: CloudStatus?) -> SpaceStatus? {
        guard isFolder || isDocumentFile(path) else { return nil }
        let at = (isFolder ? path : documentStem(path)).lowercased()
        let kind: SpaceKind = isFolder ? .folder : .document
        return status?.spaces.first { $0.kind == kind && !$0.path.isEmpty && $0.path.lowercased() == at }
    }

    /// The section `path` is in: the deepest one that holds it, a shared
    /// document's before the folder it sits in. Names are compared without
    /// case, as the disk compares them. The Mac's `placeOf` (src/cloud.ts) —
    /// change both.
    public static func place(of path: String, in status: CloudStatus?) -> Place {
        guard let status else { return .library }
        let lower = path.lowercased()
        let stem = documentStem(lower)
        var found: SpaceStatus?
        for space in status.spaces where !space.path.isEmpty {
            let at = space.path.lowercased()
            // A shared document holds its own files, and is itself where it is.
            let holds = space.kind == .document
                ? lower == at || (stem == at && isDocumentFile(lower))
                : lower == at || lower.hasPrefix(at + "/")
            guard holds else { continue }
            // A document is deeper than the folder it is in, whatever their lengths.
            if let now = found {
                let deeper = (space.kind == .document && now.kind != .document)
                    || (now.kind != .document && space.path.count > now.path.count)
                if !deeper { continue }
            }
            found = space
        }
        if let found { return found.kind == .private ? .mine(found) : .share(found) }
        let top = lower.prefix { $0 != "/" }
        return top == TreeModel.libraryFolder.lowercased() ? .library : .nowhere
    }

    /// Everyone who can open what is in `place`, by member id; nil for
    /// Library, which is everyone (`audienceOf`, src/cloud.ts).
    public static func people(of place: Place, in status: CloudStatus) -> [String]? {
        switch place {
        case .library: return nil
        case .nowhere: return []
        case .mine: return status.meId.map { [$0] } ?? []
        case .share(let space): return unique(space.members + space.above)
        }
    }

    /// Who can open what is in `place`, in a few words: the line under a
    /// note's title, and on the Share sheet. The Mac says the same
    /// (`audienceLine`, src/cloud.ts) and so does the engine of a link
    /// (`Engine::linked`) — change all three.
    public static func audience(_ place: Place, in status: CloudStatus) -> String {
        if place == .library { return "Everyone in \(status.name)" }
        if place == .nowhere { return "Only on this device" }
        let others = (people(of: place, in: status) ?? []).filter { $0 != status.meId }.count
        if others == 0 { return "Only you" }
        return "You and \(others) \(others == 1 ? "other" : "others")"
    }

    /// Who gains sight of something moved from one place to another —
    /// "Everyone in Acme", "All 3 people who can open “Finance”" — or nil
    /// when nobody does, which is every move that keeps the audience or
    /// narrows it. `widerAudience` (src/cloud.ts) — change both.
    public static func wider(in status: CloudStatus, from: Place, to: Place) -> String? {
        guard let before = people(of: from, in: status) else { return nil }
        if to == .nowhere { return nil }
        if case .mine = to { return nil }
        guard let after = people(of: to, in: status) else { return "Everyone in \(status.name)" }
        guard case .share(let target) = to else { return nil }
        if case .share(let source) = from, source.id == target.id { return nil }
        guard after.contains(where: { !before.contains($0) && $0 != status.meId }) else { return nil }
        return "\(after.count == 2 ? "Both people" : "All \(after.count) people") who can open “\(target.name)”"
    }

    /// What is shared from inside the folder at `dir`, the outermost of
    /// them: what is shared from inside one of those goes with it.
    public static func shares(inside dir: String, in status: CloudStatus?) -> [SpaceStatus] {
        let under = { (space: SpaceStatus, folder: String) in space.path.lowercased().hasPrefix(folder.lowercased() + "/") }
        let held = (status?.spaces ?? []).filter { $0.kind != .private && under($0, dir) }
        return held.filter { space in !held.contains { $0.id != space.id && under(space, $0.path) } }
    }

    /// What a move asks before it happens, when it changes who can open the
    /// thing: one that lets more people open it, and one that takes
    /// something shared into Library, where it is everyone's and no share of
    /// its own. Nil for every other move, which just happens. The Mac asks
    /// the same, in the same words (`confirmMove`, src/App.tsx) — change
    /// both; a move into no section, which it also asks about, is never
    /// offered here.
    public static func moveQuestion(_ entry: FolderEntry, into folder: String, in status: CloudStatus?) -> ShareQuestion? {
        guard let status else { return nil }
        let to = place(of: folder, in: status)
        let gains = wider(in: status, from: place(of: entry.path, in: status), to: to)
        var ending: [String] = []
        if to == .library {
            let isFolder: Bool
            if case .folder = entry { isFolder = true } else { isFolder = false }
            let at = (isFolder ? entry.path : documentStem(entry.path)).lowercased()
            ending = status.spaces
                .filter { $0.kind != .private && !$0.path.isEmpty }
                .filter { $0.path.lowercased() == at || (isFolder && $0.path.lowercased().hasPrefix(at + "/")) }
                .map { "“\($0.name)”" }
        }
        guard gains != nil || !ending.isEmpty else { return nil }
        let sees = gains.map { "\($0) will be able to open it." } ?? ""
        let ends: String
        switch ending.count {
        case 0: ends = ""
        case 1: ends = " \(ending[0]) stops being shared on its own."
        default: ends = " \(ending.dropLast().joined(separator: ", ")) and \(ending[ending.count - 1]) stop being shared on their own."
        }
        let target: String
        switch to {
        case .library: target = TreeModel.libraryFolder
        case .mine: target = TreeModel.myFilesFolder
        case .share(let space): target = "“\(space.name)”"
        case .nowhere: target = "“\(DocLinks.name(of: folder))”"
        }
        return ShareQuestion(
            title: "Move “\(entry.name)” to \(target)?",
            body: (sees + ends).trimmingCharacters(in: .whitespaces),
            button: "Move"
        )
    }

    /// What deleting something shared asks first. It is not a removal like
    /// any other: whoever can open the folder it sits in deletes it for
    /// everyone it is shared with — it is kept thirty days — and anyone
    /// else leaves it. `inside` names the folder being removed around it.
    /// The Mac's words (`deleteShare`, src/App.tsx) — change both.
    public static func deleteQuestion(_ space: SpaceStatus, inside: String? = nil, in status: CloudStatus) -> ShareQuestion {
        guard space.placed else {
            return ShareQuestion(title: "Leave “\(space.name)”?", body: ShareWords.leaving, button: "Leave")
        }
        return ShareQuestion(
            title: inside.map { "“\(space.name)” in “\($0)” is shared. Delete it for everyone?" } ?? "Delete “\(space.name)” for everyone?",
            body: ShareWords.deleting(space, in: status),
            button: "Delete for everyone"
        )
    }

    /// Why a row syncs nowhere: under Shared with me and shared by nobody,
    /// or anything else in no section. The Mac's `STRAY_LINE` and
    /// `UNSHARED_LINE` (src/Sidebar.tsx) — change both.
    public static func notSyncedLine(_ path: String) -> String {
        holds(TreeModel.sharedFolder, path)
            ? "Nobody shared this with you, so it stays on this iPhone — move it into Library or My files"
            : "In no section, so it stays on this iPhone — move it into Library or My files"
    }

    /// ONE-TIME, to be deleted with the engine's `from_library`
    /// (engine/src/cloud/layout.rs, whose `moved_rel` this mirrors, as does
    /// `fromLibraryLayout` in src/cloud.ts — change all three): where a path
    /// this iPhone stored under the layout before sharing in place is now.
    /// What was under `Private/` is under `My files/`, and what was under
    /// `Restricted/` is under `Shared with me/`.
    static func fromLibraryLayout(_ path: String) -> String {
        let top = path.prefix { $0 != "/" }
        let now: String
        switch top.lowercased() {
        case "private": now = TreeModel.myFilesFolder
        case "restricted": now = TreeModel.sharedFolder
        default: return path
        }
        return now + path.dropFirst(top.count)
    }

    private static func unique(_ ids: [String]) -> [String] {
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted }
    }
}

/// An "are you sure" about who can open something: its title, what it will
/// do, and the button that does it.
public struct ShareQuestion: Equatable, Sendable {
    public let title: String
    public let body: String
    public let button: String
}

/// Something shared that left this iPhone: it is no longer shared with this
/// person, or it was deleted — here or on another device. The engine has
/// already deleted its copy, so every screen inside it closes.
public struct ShareLeft: Equatable, Sendable {
    /// Where it was, workspace-relative: a folder, or a document without
    /// its extension.
    public let path: String
    /// Moves with each one that leaves, so one leaving twice is heard twice.
    public let count: Int

    /// Whether `path` was it — the folder, or a file of the document — or
    /// in it.
    public func holds(_ path: String) -> Bool {
        Sections.holds(self.path, path) || Sections.documentStem(path).lowercased() == self.path.lowercased()
    }
}

/// Something shared is somewhere else on this iPhone now, or called
/// something else: sync moved it where it sits, or renamed it as somebody
/// renamed it. What is open from where it was is where it is.
public struct SharesMoved: Equatable, Sendable {
    public let moves: [SpaceMove]
    /// Moves with each event, so the same move made twice is heard twice.
    public let count: Int

    /// Where `path` is now, or nil when it did not move.
    public func now(_ path: String) -> String? {
        let lower = path.lowercased()
        for move in moves {
            let from = move.from.lowercased()
            if lower == from { return move.to }
            if move.dir, lower.hasPrefix(from + "/") { return move.to + path.dropFirst(move.from.count) }
        }
        return nil
    }

    /// Where what a version store is called by is now: a folder as it
    /// moved, a shared document — its path without an extension — by any of
    /// its files.
    public func nowItem(_ item: String) -> String? {
        if let folder = now(item) { return folder }
        let lower = item.lowercased()
        return moves.first { !$0.dir && Sections.documentStem($0.from).lowercased() == lower }.map { Sections.documentStem($0.to) }
    }
}

/* ---------- Share ---------- */

/// What Share is opened on: a folder, or a document by the file it opens as.
public struct ShareTarget: Hashable, Identifiable, Sendable {
    /// Workspace-relative.
    public let path: String
    public let isFolder: Bool

    public init(path: String, isFolder: Bool) {
        self.path = path
        self.isFolder = isFolder
    }

    /// A row of the tree: a folder, or a document. No other file is shared.
    public init?(_ entry: FolderEntry) {
        switch entry {
        case .folder(let path): self.init(path: path, isFolder: true)
        case .document(let row): self.init(path: row.path, isFolder: false)
        case .file: return nil
        }
    }

    public var id: String { (isFolder ? "folder:" : "document:") + path }

    /// What a person calls it: a folder's name, a document's without its
    /// extension.
    public var name: String {
        DocLinks.name(of: isFolder ? path : Sections.documentStem(path))
    }
}

/// One person who can open something shared, and how.
public struct SharePerson: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let you: Bool
    /// It is in their My files, in the end.
    public let owner: Bool
    /// They open it through the folder it sits in, so nobody stops sharing
    /// it with them.
    public let through: Bool

    /// What the row says after the name.
    public var tags: [String] {
        [you ? "you" : nil, owner ? "owner" : nil, through ? "has the folder it is in" : nil].compactMap { $0 }
    }

    /// It is shared with them, and can stop being.
    public var direct: Bool { !owner && !through }
}

/// What the Share sheet says: the Mac's Share dialog, word for word
/// (src/ShareDialog.tsx) — change both.
public enum ShareWords {
    public static func title(_ name: String) -> String { "Share “\(name)”" }

    /// Before it is shared. `around` is where it sits: inside a shared
    /// folder, that folder's people can open it already.
    public static func unsharedHint(around: Place) -> String {
        let hint = "It stays where it is. The people you pick find it under Shared with me, and can read it, edit it and share it with others."
        if case .share(let space) = around { return hint + " Everyone who can open “\(space.name)” can open it already." }
        return hint
    }

    /// What is shared from inside a folder already stays its own.
    public static func insideHint(_ names: [String]) -> String {
        let quoted = names.map { "“\($0)”" }
        let listed = quoted.count <= 1 ? quoted.joined() : "\(quoted.dropLast().joined(separator: ", ")) and \(quoted[quoted.count - 1])"
        let one = names.count == 1
        return "\(listed) inside it \(one ? "is" : "are") shared already, and \(one ? "stays" : "stay") shared as \(one ? "it is" : "they are"). The people you pick will be able to open \(one ? "that" : "those") too."
    }

    public static func alone(in workspace: String) -> String {
        "Nobody else is in \(workspace) yet. Invite somebody from People, then share this with them."
    }

    /// Once it is shared. `what` is `folder` or `document`.
    public static func sharedHint(_ space: SpaceStatus, owner: String, what: String) -> String {
        let lead = space.placed
            ? "It stays where it is. The people it is shared with find it under Shared with me."
            : "\(owner) shared this \(what) with you. It sits in their files, so only they move it or delete it."
        return lead + " Everyone here can read it, edit it and share it with others."
    }

    public static func count(_ people: Int) -> String {
        "\(people) \(people == 1 ? "person" : "people") can open it"
    }

    public static func everyoneOn(in workspace: String) -> String {
        "Everyone in \(workspace) can open it already."
    }

    public static let stopping = "Their devices delete their copy of it."
    public static let leaving = "It is removed from this iPhone and your other devices. The others keep theirs."

    /// What deleting it for everyone does, naming how many lose it.
    public static func deleting(_ space: SpaceStatus, in status: CloudStatus) -> String {
        var seen = Set<String>()
        let others = (space.members + space.above).filter { $0 != status.meId && seen.insert($0).inserted }.count
        let people = others == 0 ? "" : " and from those of the \(others == 1 ? "other person" : "\(others) other people") who can open it"
        return "It is removed from your devices\(people). It stays in Recently deleted for 30 days, where it can be restored with its people and its history."
    }

    /// What the row of something shared says under its name: with how many
    /// people, or that it is somebody else's, shared with this person
    /// (`SharedMark`, src/Sidebar.tsx — change both).
    public static func mark(_ space: SpaceStatus) -> String {
        if !space.placed { return "Shared with you" }
        let count = space.members.count
        return count == 0 ? "Shared with nobody yet" : "Shared with \(count) \(count == 1 ? "person" : "people")"
    }
}

/// Share on a folder or a document: who can open it, and what is done about
/// that — sharing it with somebody, stopping, leaving it, deleting it for
/// everyone. One model, whether or not it is shared yet. What it shows is
/// read from the workspace's status, so a person added or taken off shows
/// as soon as the engine has it; names come from the People list.
@MainActor
@Observable
public final class ShareModel {
    public let workspace: Workspace
    public let target: ShareTarget
    /// Which share this is, once it is one: by id, so the sheet follows it
    /// through a rename and closes when it is gone.
    public private(set) var id: String?
    /// Everyone on the workspace, for names and for who it can be shared with.
    public private(set) var everyone: [MemberRecord]?
    public private(set) var busy = false
    public var problem: String?
    private var meId: String?
    /// The status has listed it as a share.
    private var listed: Bool

    public init(workspace: Workspace, target: ShareTarget) {
        self.workspace = workspace
        self.target = target
        let share = workspace.share(at: target.path, isFolder: target.isFolder)
        id = share?.id
        listed = share != nil
        meId = workspace.status?.meId
    }

    /// The share as the status lists it now: nil before it is one, and once
    /// it has left this iPhone.
    public var space: SpaceStatus? {
        id.flatMap { workspace.space(id: $0) }.flatMap { $0.deletedAt == nil ? $0 : nil }
    }

    /// It was a share and the status no longer lists it: it left this
    /// iPhone — left, deleted, or no longer shared with this person.
    public var gone: Bool { listed && space == nil && !busy }

    public var name: String { space?.name ?? target.name }
    public var title: String { ShareWords.title(name) }
    /// `folder` or `document`.
    public var what: String { target.isFolder ? "folder" : "document" }
    public var me: String? { meId ?? workspace.status?.meId }

    /// A person by name — or by id when the list cannot say.
    public func name(of memberId: String) -> String {
        if let found = everyone?.first(where: { $0.id == memberId }) { return found.name.isEmpty ? found.email : found.name }
        return memberId == me ? (workspace.status?.me ?? memberId) : memberId
    }

    /* ---------- Not shared yet ---------- */

    /// Everyone on the workspace but this person; nil until the domain said.
    public var others: [MemberRecord]? { everyone?.filter { $0.id != me } }

    public var unsharedHint: String {
        ShareWords.unsharedHint(around: workspace.place(of: DocLinks.directory(of: target.path)))
    }

    /// What is shared from inside the folder already, in words — nil when
    /// nothing is.
    public var insideHint: String? {
        guard target.isFolder, let status = workspace.status else { return nil }
        let names = status.spaces.filter { $0.kind != .private && $0.path.lowercased().hasPrefix(target.path.lowercased() + "/") }.map(\.name)
        return names.isEmpty ? nil : ShareWords.insideHint(names)
    }

    /* ---------- Shared ---------- */

    /// Everyone who can open it: its owner, whoever else has the folder it
    /// sits in, then the people it is shared with.
    public var people: [SharePerson] {
        guard let space else { return [] }
        let through = space.above.filter { $0 != space.owner }
        let direct = space.members.filter { $0 != space.owner && !through.contains($0) }
        var seen = Set<String>()
        return ([space.owner] + through + direct)
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .map { SharePerson(id: $0, name: name(of: $0), you: $0 == me, owner: $0 == space.owner, through: through.contains($0)) }
    }

    /// The people on the workspace who cannot open it yet.
    public var addable: [MemberRecord] {
        let on = Set(people.map(\.id))
        return (everyone ?? []).filter { !on.contains($0.id) }
    }

    public var sharedHint: String {
        guard let space else { return "" }
        return ShareWords.sharedHint(space, owner: name(of: space.owner), what: what)
    }

    /// It is shared with this person, who does not keep it: they may leave it.
    public var mayLeave: Bool {
        guard let space, let me else { return false }
        return space.members.contains(me) && !space.placed
    }

    /// This person can open the folder it sits in: they may delete it for
    /// everyone.
    public var mayDelete: Bool { space?.placed ?? false }

    /// What deleting it for everyone asks first, in the sheet's words: nil
    /// for whoever may not.
    public var deleteQuestion: ShareQuestion? {
        guard let space, space.placed, let status = workspace.status else { return nil }
        return ShareQuestion(
            title: "Delete “\(space.name)” for everyone?", body: ShareWords.deleting(space, in: status), button: "Delete the \(what)"
        )
    }

    /* ---------- Doing ---------- */

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
        await workspace.refresh()
    }

    /// Share it with `members`. It stays where it is; the engine makes it a
    /// section of its own in place.
    public func share(with members: [String]) async {
        await act {
            let made: SpaceStatus = try await Engine.shared.call("cloud_share", [
                "root": .string(workspace.root),
                "path": .string(workspace.files.absolute(target.path)),
                "members": .strings(members),
            ])
            id = made.id
            await workspace.refresh()
            listed = space != nil
        }
    }

    private func member(_ space: SpaceStatus, _ memberId: String, add: Bool) async throws {
        try await Engine.shared.run("cloud_share_member", [
            "root": .string(workspace.root), "id": .string(space.id), "memberId": .string(memberId), "add": .bool(add),
        ])
    }

    /// Share it with one more person.
    public func add(_ memberId: String) async {
        guard let space else { return }
        await act { try await member(space, memberId, add: true) }
    }

    /// Stop sharing it with somebody else: their devices delete their copy.
    public func stop(_ memberId: String) async {
        guard let space else { return }
        await act { try await member(space, memberId, add: false) }
    }

    /// Give it up, as this person may: leave it — it goes from their
    /// devices, and the others keep theirs — or, for whoever can open the
    /// folder it sits in, delete it for everyone it is shared with. A
    /// deleted share is kept thirty days, and restored from Recently deleted.
    public func giveUp() async {
        guard let space else { return }
        await act { try await workspace.giveUp(space) }
    }
}

extension Workspace {
    /// Give up something shared, as this person may: whoever can open the
    /// folder it sits in deletes it for everyone it is shared with, and
    /// anyone else leaves it. Its going from this iPhone is then their own
    /// doing, and no news to them — unless it did not go after all.
    public func giveUp(_ space: SpaceStatus) async throws {
        givingUp(space.path)
        do {
            if space.placed {
                try await Engine.shared.run("cloud_share_delete", ["root": .string(root), "id": .string(space.id)])
            } else if let me = status?.meId {
                try await Engine.shared.run("cloud_share_member", [
                    "root": .string(root), "id": .string(space.id), "memberId": .string(me), "add": .bool(false),
                ])
            } else {
                throw DoklinError("This iPhone does not know who you are here yet — try again in a moment.")
            }
        } catch {
            givingUp(space.path, false)
            throw error
        }
        changed([space.path])
    }

    /// Copy something shared with this person, which is not theirs to move,
    /// into their own files: an ordinary note or folder there, shared with
    /// nobody, under the first of its names that is free. Answers the copy.
    public func copyToMyFiles(_ entry: FolderEntry) async throws -> FolderEntry {
        guard let mine = myFiles else {
            throw DoklinError("Your My files is not on this iPhone yet — try again once it has synced.")
        }
        let (path, written) = try files.copy(entry, into: mine.path)
        await wrote(written)
        if case .folder = entry { return .folder(path) }
        return (try? files.list(mine.path))?.first { $0.path == path } ?? entry
    }
}

/* ---------- Deleted shares ---------- */

/// Something shared that was deleted for everyone and can still be brought
/// back, by whoever can open the folder it sat in: a row of Recently deleted.
public struct DeletedShare: Identifiable, Equatable, Sendable {
    public let space: SpaceStatus
    public let deletedAt: Int

    public var id: String { space.id }

    /// The deleted shares this person may restore, the last deleted first.
    public static func listed(in status: CloudStatus?) -> [DeletedShare] {
        (status?.spaces ?? [])
            .compactMap { space in space.placed ? space.deletedAt.map { DeletedShare(space: space, deletedAt: $0) } : nil }
            .sorted { $0.deletedAt > $1.deletedAt }
    }

    /// How long the domain keeps something shared that was deleted
    /// (`SHARE_KEPT_DAYS`, src/RecentlyDeleted.tsx; `DELETED_KEPT_MS`,
    /// cloud-worker/src/sweep.ts — change all three).
    static let keptDays = 30

    /// "shared folder · deleted 3 d ago · kept 27 more days": the Mac's line
    /// under a deleted share (src/RecentlyDeleted.tsx) — change both.
    public func words(now: Int = Clock.now) -> String {
        let left = max(1, Int((Double(Self.keptDays) - Double(now - deletedAt) / 86_400_000).rounded(.up)))
        return [
            "shared \(space.kind == .folder ? "folder" : "document")",
            "deleted \(Clock.ago(deletedAt, now: now))",
            "kept \(left) more \(left == 1 ? "day" : "days")",
        ].joined(separator: " · ")
    }

    /// What restoring one does, under the list of them: the Mac says it on
    /// its Restore button.
    public static let restoring = "Restored, it comes back for everyone it was shared with, with its history."

    /// What is said once one is back (the Mac's toast, src/App.tsx — change both).
    public var restored: String { "“\(space.name)” is back, for everyone it was shared with." }
}

extension Workspace {
    /// Bring a deleted share back, as it was: its files, its people, its
    /// history, its pages.
    public func restore(_ share: DeletedShare) async throws {
        try await Engine.shared.run("cloud_share_restore", ["root": .string(root), "id": .string(share.space.id)])
        await refresh()
    }
}

extension FolderModel {
    /// What is moved and removed like the rows beside it: anything but a
    /// section's own folder — and but something shared with this person,
    /// which sits where its owner keeps it (they copy it, or leave it).
    public func movable(_ entry: FolderEntry) -> Bool {
        !isSection(entry) && workspace.share(entry)?.placed != false
    }

    /// Something shared with this person that is not theirs to move, when
    /// they have a My files to copy it into.
    public func copiesToMyFiles(_ entry: FolderEntry) -> Bool {
        workspace.share(entry)?.placed == false && workspace.myFiles != nil && workspace.may("work")
    }

    /// The question a move of `entry` into `folder` asks first, when it
    /// changes who can open it.
    public func moveQuestion(_ entry: FolderEntry, into folder: String) -> ShareQuestion? {
        Sections.moveQuestion(entry, into: folder, in: workspace.status)
    }

    /// Where `entry` can be moved: a folder of a section, never the one it
    /// is in, itself or one inside it — and never straight under Shared
    /// with me, where nothing is put by hand.
    public func takes(_ entry: FolderEntry, in folder: String) -> Bool {
        if folder == DocLinks.directory(of: entry.path) { return false }
        if case .folder(let own) = entry, Sections.holds(own, folder) { return false }
        if folder.lowercased() == TreeModel.sharedFolder.lowercased() { return false }
        return workspace.place(of: folder) != .nowhere
    }
}

extension TreeSection {
    /// What an empty section says it is for, in the Mac sidebar's words
    /// (src/Sidebar.tsx — change both).
    public var emptyHint: String? {
        switch self {
        case .library: return "No documents yet. Make one with the plus above."
        case .mine: return "Only you can open what you put here, until you share it."
        case .shared: return "What other people share with you shows here."
        case .nowhere: return nil
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
