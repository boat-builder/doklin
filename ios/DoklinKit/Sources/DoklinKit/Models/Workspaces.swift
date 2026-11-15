// This device's workspaces: what the engine says about them, kept current
// by its events, and the few things done to them as a whole — join, leave,
// sync. The phone is a device of its person's, like a Mac: it holds every
// workspace it joined as files of its own (`Workspace`), and the engine keeps
// them in step in the background.

import Foundation
import Observation

/// Something sync said that a person should read once.
public struct Notice: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public let root: String
    public let text: String
    /// A workspace-relative file it is about, to open from the notice.
    public let path: String?
}

@MainActor
@Observable
public final class Workspaces {
    /// Every connected workspace, as the engine last said.
    public private(set) var statuses: [CloudStatus] = []
    /// Every version store, as the engine last said.
    public private(set) var versions: [VersionsStatus] = []
    /// The root of the workspace being looked at.
    public private(set) var selected: String?
    /// Set once the engine has answered for the first time.
    public private(set) var ready = false
    /// Why the engine could not start, as a sentence. Nothing works then.
    public private(set) var failure: String?
    /// A join's download, while one runs.
    public private(set) var joining: CloudProgress?
    /// What sync said that a person should see; the view shows the first.
    public private(set) var notices: [Notice] = []
    /// A workspace taken off this device, until the person has read so.
    public private(set) var removed: Removed?

    @ObservationIgnored private var open: [String: Workspace] = [:]
    @ObservationIgnored private let remembered: UserDefaults
    /// A workspace just joined, whose status the engine has not sent yet.
    @ObservationIgnored private var arriving: String?
    /// A sign-in a line bought whose download has not finished: the line's
    /// code works once, so trying again downloads with this rather than
    /// asking for a new line. Held in memory only.
    @ObservationIgnored private var bought: (endpoint: String, code: String, redeemed: Redeemed)?
    @ObservationIgnored private var starting = false
    /// Restricted folders this person is giving up here, as `<root>/<path>`
    /// lowercased: when one goes, that is no news to them.
    @ObservationIgnored private var givenUp: Set<String> = []

    public init(remembered: UserDefaults = .standard) {
        self.remembered = remembered
    }

    /* ---------- Starting ---------- */

    /// Start the engine and listen to it, once: a second call changes nothing.
    public func start(_ setup: EngineSetup) {
        guard !starting else { return }
        starting = true
        let events = Engine.shared.events()
        Task { [weak self] in
            for await event in events {
                self?.hear(event)
            }
        }
        do {
            try Engine.shared.start(setup)
        } catch {
            failure = (error as? DoklinError)?.message ?? error.localizedDescription
            ready = true
            return
        }
        Task {
            await refresh()
            // Every connected workspace has a history of its own here.
            try? await Engine.shared.run("versions_reconcile")
            ready = true
        }
    }

    /// Ask the engine for its whole model again.
    public func refresh() async {
        if let all: [CloudStatus] = try? await Engine.shared.call("cloud_status") { take(all) }
        if let all: [VersionsStatus] = try? await Engine.shared.call("versions_status") { versions = all }
    }

    private func take(_ all: [CloudStatus]) {
        statuses = all
        if let selected, let status = all.first(where: { $0.root == selected }) {
            // By id, not by path: iOS moves the app's folder between launches.
            remembered.set(status.wsId, forKey: Self.selectedKey)
            if arriving == selected { arriving = nil }
            return
        }
        if let selected, selected == arriving { return }
        let wanted = remembered.string(forKey: Self.selectedKey)
        selected = (all.first { $0.wsId == wanted } ?? all.first)?.root
    }

    private static let selectedKey = "selected-workspace"

    /* ---------- Looking at one ---------- */

    public func status(_ root: String) -> CloudStatus? {
        statuses.first { $0.root == root }
    }

    /// The workspace at `root`, made on first use.
    public func workspace(_ root: String) -> Workspace {
        if let made = open[root] { return made }
        let made = Workspace(root: root, device: self)
        open[root] = made
        return made
    }

    /// The workspace being looked at.
    public var current: Workspace? { selected.map(workspace) }

    public func select(_ root: String) {
        selected = root
        if let status = status(root) { remembered.set(status.wsId, forKey: Self.selectedKey) }
    }

    /// The version store a path is kept in: the deepest whose root holds it.
    public func store(holding absolute: String) -> VersionsStatus? {
        versions
            .filter { absolute == $0.root || absolute.hasPrefix($0.root + "/") }
            .max { $0.root.count < $1.root.count }
    }

    /* ---------- Joining and leaving ---------- */

    /// Join a workspace with the line from another device — `Add a device`
    /// on a Mac — or from an invite: the code becomes this iPhone's own
    /// sign-in and the whole workspace comes down. Answers its folder.
    @discardableResult
    public func join(pasted text: String) async throws -> String {
        let pasted: Pasted = try await Engine.shared.call("cloud_parse_invite", ["text": .string(text)])
        guard let endpoint = pasted.endpoint, let code = pasted.code else {
            throw DoklinError(
                pasted.endpoint == nil && pasted.code == nil
                    ? "That is not a line from Doklin. On a Mac that has the workspace, open its menu, choose Devices… → Add a device, and paste the line it shows."
                    : "That line is cut short — it needs both the address and the code. Copy the whole line again."
            )
        }
        let redeemed: Redeemed
        if let held = bought, held.endpoint == endpoint, held.code == code {
            redeemed = held.redeemed
        } else {
            redeemed = try await Engine.shared.call("cloud_redeem", ["endpoint": .string(endpoint), "code": .string(code)])
            bought = (endpoint, code, redeemed)
        }
        joining = CloudProgress(root: "", kind: "download", done: 0, total: 0)
        defer { joining = nil }
        let root: String
        do {
            root = try await Engine.shared.call(
                "cloud_join", ["endpoint": .string(redeemed.endpoint), "token": .string(redeemed.token)]
            )
        } catch let error as DoklinError {
            throw DoklinError("\(error.message) The line is still good on this iPhone: choose Join again to retry.")
        }
        bought = nil
        arriving = root
        select(root)
        try? await Engine.shared.run("versions_reconcile")
        await refresh()
        return root
    }

    /// Whether everything written on this iPhone in a workspace has reached
    /// its domain: sync now, and wait a little for the pass to finish.
    public func synced(_ root: String, within seconds: Double = 10) async -> Bool {
        let started = Int(Date().timeIntervalSince1970 * 1000)
        await syncNow(root)
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            await refresh()
            guard let status = status(root) else { return false }
            if status.phase == .idle, (status.lastSyncMs ?? 0) >= started { return true }
            if status.phase != .syncing, status.phase != .idle { return false }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return false
    }

    /// Sign this iPhone out of a workspace and delete its copy here — with
    /// whatever of it had not synced yet. Nothing changes for anybody else,
    /// and nothing is deleted in the cloud. False when the copy could not be
    /// deleted, though the sign-in is gone either way.
    @discardableResult
    public func leave(_ root: String) async throws -> Bool {
        let deleted = try await Engine.shared.call("cloud_leave", ["root": .string(root)], as: Bool.self)
        open[root] = nil
        if selected == root { selected = nil }
        try? await Engine.shared.run("versions_reconcile")
        await refresh()
        return deleted
    }

    /* ---------- Sync ---------- */

    public func syncNow(_ root: String) async {
        try? await Engine.shared.run("cloud_sync_now", ["root": .string(root)])
    }

    /// The app is about to stop running: keep what is pending and send it,
    /// within `seconds` — iOS gives an app leaving the screen about thirty.
    public func settle(within seconds: Double) async {
        let started = Int(Date().timeIntervalSince1970 * 1000)
        try? await Engine.shared.run("versions_flush", ["ms": 2000])
        for status in statuses { await syncNow(status.root) }
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            await refresh()
            let busy = statuses.contains { $0.phase == .syncing || ($0.phase == .idle && ($0.lastSyncMs ?? 0) < started) }
            if !busy { return }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
    }

    /// The app is in front again: whatever changed meanwhile comes now.
    public func woke() async {
        for status in statuses { await syncNow(status.root) }
    }

    /* ---------- What the engine says ---------- */

    private func hear(_ event: EngineEvent) {
        switch event.name {
        case "cloud-status":
            if let all = event.decode([CloudStatus].self) { take(all) }
        case "versions-status":
            if let all = event.decode([VersionsStatus].self) { versions = all }
        case "cloud-applied":
            if let applied = event.decode(CloudApplied.self) { open[applied.root]?.changed(applied.paths) }
        case "versions-applied":
            if let applied = event.decode(VersionsApplied.self) {
                for workspace in open.values {
                    let mine = applied.paths.compactMap { workspace.relative($0) }
                    if !mine.isEmpty { workspace.changed(mine) }
                }
            }
        case "cloud-progress":
            if let progress = event.decode(CloudProgress.self), joining != nil { joining = progress }
        case "cloud-conflict":
            if let conflict = event.decode(CloudConflict.self) {
                say(conflict.root, "\(conflict.by) and this iPhone both changed \(DocLinks.name(of: conflict.path)) — both versions are kept, the other one beside it.", path: conflict.conflictPath)
            }
        case "cloud-space-left":
            if let left = event.decode(CloudSpaceLeft.self) {
                open[left.root]?.lost(left.path)
                if givenUp.remove("\(left.root)/\(left.path)".lowercased()) == nil {
                    say(left.root, "“\(left.name)” is no longer on this iPhone — you were taken out of it, or it was deleted.", path: nil)
                }
            }
        case "cloud-address-taken":
            if let taken = event.decode(CloudAddressTaken.self) {
                say(taken.root, "The address “\(taken.slug)” is already taken on this domain, so \(DocLinks.name(of: taken.path)) was not published.", path: nil)
            }
        case "cloud-removed":
            if let gone = event.decode(Removed.self) {
                removed = gone
                open[gone.root] = nil
            }
        default:
            break
        }
    }

    private func say(_ root: String, _ text: String, path: String?) {
        notices.append(Notice(root: root, text: text, path: path))
    }

    /// This person is giving up the restricted folder at `path` (or, with
    /// `false`, is not after all).
    func givingUp(_ root: String, _ path: String, _ giving: Bool) {
        let key = "\(root)/\(path)".lowercased()
        if giving { givenUp.insert(key) } else { givenUp.remove(key) }
    }

    public func dismiss(_ notice: Notice) {
        notices.removeAll { $0.id == notice.id }
    }

    public func dismissRemoved() {
        removed = nil
    }

    /// Where a join has got to, in words.
    public var joiningWords: String? {
        guard let joining else { return nil }
        if joining.total == 0 { return "Joining…" }
        return "Downloading \(joining.done) of \(joining.total) files…"
    }
}

/// One workspace this device holds: its folder, what the engine says about
/// it, and a count that moves whenever its files change under the screens.
@MainActor
@Observable
public final class Workspace: Identifiable {
    /// Its folder on this device, absolute.
    public let root: String
    public let files: WorkspaceFiles
    @ObservationIgnored private weak var device: Workspaces?
    /// Moves whenever files here changed — written by sync, by a restore, or
    /// from this device — so a screen showing one reads it again.
    public private(set) var changes = 0
    /// The workspace-relative paths of the last change.
    public private(set) var lastChanged: Set<String> = []
    /// The last restricted folder to leave this iPhone: the screens inside
    /// it close when it moves.
    public private(set) var left: FolderLeft?

    public nonisolated var id: String { root }

    init(root: String, device: Workspaces) {
        self.root = root
        self.files = WorkspaceFiles(root: URL(fileURLWithPath: root))
        self.device = device
    }

    public var status: CloudStatus? { device?.status(root) }
    public var name: String { status?.name ?? DocLinks.name(of: root) }
    public var domain: String { status?.domain ?? "" }

    /// Whether this device may do `action` here, in the worker's words.
    public func may(_ action: String) -> Bool { status?.may(action) ?? true }

    /// Sync now rather than at the next poll.
    public func syncNow() async {
        try? await Engine.shared.run("cloud_sync_now", ["root": .string(root)])
    }

    /// This person is leaving or deleting the restricted folder at `path`.
    func givingUp(_ path: String, _ giving: Bool = true) {
        device?.givingUp(root, path, giving)
    }

    func changed(_ paths: [String]) {
        lastChanged = Set(paths.map { $0.lowercased() })
        changes += 1
    }

    /// The restricted folder at `folder` left this iPhone, its copy already
    /// deleted by the engine.
    func lost(_ folder: String) {
        left = FolderLeft(path: folder, count: (left?.count ?? 0) + 1)
        changed([folder])
    }

    /// A change made from this device: the engine hears of it, and so does
    /// every screen of this workspace.
    public func wrote(_ paths: [String]) async {
        for path in paths {
            try? await Engine.shared.run("touched", ["path": .string(files.absolute(path))])
        }
        changed(paths)
    }

    /// `absolute` as a path of this workspace, or nil when it is not in it.
    public func relative(_ absolute: String) -> String? {
        if absolute == root { return "" }
        guard absolute.hasPrefix(root + "/") else { return nil }
        return String(absolute.dropFirst(root.count + 1))
    }

    /// Who can open what is at a path.
    public func audience(of path: String) -> Audience {
        Audience.of(path, in: status)
    }

    /// The other device that holds a document, when one does.
    public func lease(of path: String) -> LeaseHolder? {
        let key = path.lowercased()
        return status?.leases.first { $0.path == key }
    }

    /// The public pages of a document or folder.
    public func pages(of path: String) -> [PublicPage] {
        status?.public.filter { $0.path == path } ?? []
    }
}

/// Who can open what is at a path, read off the sections the engine lists.
public enum Audience: Equatable, Sendable {
    /// Everyone in the workspace.
    case everyone
    /// Only this person: their Private.
    case onlyYou
    /// The people of one restricted folder, by its name.
    case folder(String)
    /// The folder that holds the restricted folders, which is nobody's itself.
    case folders
    /// Under a section's name but in no section: it stays on this iPhone.
    case nowhere

    public static func of(_ path: String, in status: CloudStatus?) -> Audience {
        guard let status, status.sections else { return .everyone }
        let under = { (folder: String) in Sections.holds(folder, path) }
        for space in status.spaces where under(space.path) {
            return space.kind == .private ? .onlyYou : .folder(space.name)
        }
        if path.lowercased() == "restricted" { return .folders }
        if under("restricted") || under("private") { return .nowhere }
        return .everyone
    }
}
