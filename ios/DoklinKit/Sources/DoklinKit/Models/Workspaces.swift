// This device's workspaces: what the engine says about them, kept current
// by its events, and the few things done to them as a whole — join, leave,
// sync. The phone is a device of its person's, like a Mac: it holds every
// workspace it joined as files of its own (`Workspace`), and the engine keeps
// them in step in the background.

import Foundation
import Observation

/// A page a followed link asked to see: the screens of its workspace open it.
public struct Opening: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public let root: String
    /// Workspace-relative.
    public let path: String
}

/// A followed link whose page is not on this device yet: its workspace's
/// screens show it on its way, and it opens by itself when sync brings it —
/// or, after a while, says why it can't.
public struct Arriving: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public let root: String
    public let url: URL
    public let started: Date
    /// Why it never came, as a sentence, once the wait is over.
    public var problem: String?
}

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
    /// The page a followed link asked to see, until its workspace has opened it.
    public private(set) var opening: Opening?
    /// Why a followed link opened nothing, as a sentence — when there is no
    /// workspace on this device to show it in.
    public private(set) var linkProblem: String?
    /// A followed link whose page is still on its way here.
    public private(set) var arrivingPage: Arriving?
    /// What this person has read on this device (Home's dots).
    public private(set) var seen: SeenStore?
    /// What a person calls this device in a sentence: `iPhone`, `iPad`
    /// (`EngineSetup.deviceKind`).
    public private(set) var kind = "iPhone"
    /// The last question about many new documents, by workspace root, until
    /// it is answered. Shown only while the workspace's phase asks it.
    public private(set) var adds: [String: CloudPendingAdds] = [:]

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
    /// Whether the app is on screen: the workspace selected then is the one
    /// the engine polls for most often.
    @ObservationIgnored private var onScreen = true
    /// What the engine was last told about that, so it is told once.
    @ObservationIgnored private var told: (folder: String?, focused: Bool)?

    public init(remembered: UserDefaults = .standard, seen: SeenStore? = nil) {
        self.remembered = remembered
        self.seen = seen
    }

    /// How long a followed link waits for its page to arrive.
    public nonisolated static let arrivalWait: TimeInterval = 30

    /* ---------- Starting ---------- */

    /// Start the engine and listen to it, once: a second call changes nothing.
    public func start(_ setup: EngineSetup) {
        guard !starting else { return }
        starting = true
        kind = setup.deviceKind
        if seen == nil { seen = SeenStore(file: setup.dataDirectory.appendingPathComponent("seen.json")) }
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
            await focus()
        }
    }

    /// Ask the engine for its whole model again.
    public func refresh() async {
        if let all: [CloudStatus] = try? await Engine.shared.call("cloud_status") { take(all) }
        if let all: [VersionsStatus] = try? await Engine.shared.call("versions_status") { versions = all }
    }

    private func take(_ all: [CloudStatus]) {
        for status in all { movedIntoLibrary(status) }
        statuses = all
        defer { Task { await focus() } }
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

    /// One-time stored-data migration. The engine moves each workspace's
    /// folder into the Library layout as it starts, before any screen
    /// (engine/src/cloud/layout.rs); the paths this iPhone keeps of one —
    /// what was open in its tree, what was read before it had a file id —
    /// move with it, once, when its marker first says it has moved.
    private func movedIntoLibrary(_ status: CloudStatus) {
        var done = Set(remembered.stringArray(forKey: Self.movedKey) ?? [])
        guard !done.contains(status.wsId), Self.inLibraryLayout(status.root) else { return }
        TreeModel.moveIntoLibrary(status.wsId, in: remembered)
        seen?.moveIntoLibrary(status.wsId)
        done.insert(status.wsId)
        remembered.set(done.sorted(), forKey: Self.movedKey)
    }

    /// The workspaces whose kept paths `movedIntoLibrary` has moved, by id.
    private static let movedKey = "moved-into-library"

    /// Whether the workspace at `root` has moved into the Library layout:
    /// its marker (`<root>/.doklin/cloud.json`, engine/src/cloud/config.rs)
    /// says `"layout": "library"`.
    nonisolated static func inLibraryLayout(_ root: String) -> Bool {
        let marker = URL(fileURLWithPath: root).appendingPathComponent(".doklin/cloud.json")
        guard let data = try? Data(contentsOf: marker),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return json["layout"] as? String == "library"
    }

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
        Task { await focus() }
    }

    /// The version store a path is kept in: the deepest whose root holds it.
    public func store(holding absolute: String) -> VersionsStatus? {
        versions
            .filter { absolute == $0.root || absolute.hasPrefix($0.root + "/") }
            .max { $0.root.count < $1.root.count }
    }

    /* ---------- Links ---------- */

    /// A link to a page (engine/src/cloud/link.rs), handed to the app by iOS
    /// — straight from doklin.cc, or by the page there as `doklin://open#…`.
    /// Its workspace is shown and opens the page (`opening`), or the person
    /// is told why it can't be (`linkProblem`). A link that launched the app
    /// waits for the engine first.
    ///
    /// A page another device made a moment ago may not be here yet: then its
    /// workspace shows it on its way (`arriving`) and it is asked for again
    /// as sync goes on, for `arrivalWait`, before the engine's sentence says
    /// why not — which never tells a deleted page from one in a folder this
    /// person is not in: a link is an address, never access.
    public func follow(_ url: URL) async {
        for _ in 0..<100 where !ready {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        let target: PageLinkTarget
        do {
            target = try await Engine.shared.call("cloud_link_target", ["url": .string(url.absoluteString)])
        } catch {
            linkProblem = (error as? DoklinError)?.message ?? error.localizedDescription
            return
        }
        guard let root = target.root else {
            linkProblem = LinkWords.notJoined(domain: target.domain, kind: kind)
            return
        }
        select(root)
        let waiting = Arriving(root: root, url: url, started: Date())
        arrivingPage = waiting
        if await arrive() { return }
        Task { [weak self] in
            while let self, self.arrivingPage?.id == waiting.id, self.arrivingPage?.problem == nil {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                guard self.arrivingPage?.id == waiting.id else { return }
                if await self.arrive() { return }
                if Date().timeIntervalSince(waiting.started) >= Self.arrivalWait {
                    self.arrivingPage?.problem = self.arrivalProblem ?? LinkWords.neverCame
                    return
                }
            }
        }
    }

    /// The engine's last word on the page being waited for.
    @ObservationIgnored private var arrivalProblem: String?

    /// Ask for the page being waited for once more: true once it is here and
    /// its workspace has been told to open it.
    @discardableResult
    private func arrive() async -> Bool {
        guard let waiting = arrivingPage, waiting.problem == nil else { return false }
        do {
            let absolute: String = try await Engine.shared.call("cloud_follow_link", ["url": .string(waiting.url.absoluteString)])
            let holder = { self.statuses.first { absolute.hasPrefix($0.root + "/") } }
            if holder() == nil { await refresh() }
            guard arrivingPage?.id == waiting.id, let status = holder() else { return false }
            arrivingPage = nil
            arrivalProblem = nil
            select(status.root)
            opening = Opening(root: status.root, path: String(absolute.dropFirst(status.root.count + 1)))
            return true
        } catch {
            arrivalProblem = (error as? DoklinError)?.message ?? error.localizedDescription
            return false
        }
    }

    /// The page being waited for is not wanted any more.
    public func dismissArriving() {
        arrivingPage = nil
        arrivalProblem = nil
    }

    /// Whether `url` is a link to a page, which the app follows rather than
    /// a browser: the address and the scheme of engine/src/cloud/link.rs
    /// (`PAGE`, `SCHEME`: change both). The engine reads the rest.
    public nonisolated static func isPageLink(_ url: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "https", "http":
            return url.host?.lowercased() == "doklin.cc" && ["/open", "/open/"].contains(url.path) && url.fragment != nil
        case "doklin":
            return url.host == "open"
        default:
            return false
        }
    }

    /// The workspace opened the page a link asked for.
    public func opened(_ done: Opening) {
        if opening == done { opening = nil }
    }

    public func dismissLinkProblem() {
        linkProblem = nil
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
        let wsId = status(root)?.wsId
        let deleted = try await Engine.shared.call("cloud_leave", ["root": .string(root)], as: Bool.self)
        if let wsId {
            // Nothing of what was read, opened or searched for here stays.
            seen?.forget(wsId)
            TreeModel.forget(wsId, in: remembered)
            RecentSearches.forget(wsId, in: remembered)
        }
        open[root] = nil
        if selected == root { selected = nil }
        try? await Engine.shared.run("versions_reconcile")
        await refresh()
        await focus()
        return deleted
    }

    /* ---------- Sync ---------- */

    public func syncNow(_ root: String) async {
        try? await Engine.shared.run("cloud_sync_now", ["root": .string(root)])
    }

    /// The app is about to stop running: keep what is pending and send it,
    /// within `seconds` — iOS gives an app leaving the screen about thirty.
    public func settle(within seconds: Double) async {
        onScreen = false
        await focus()
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
        onScreen = true
        await focus()
        for status in statuses { await syncNow(status.root) }
    }

    /// Tell the engine whether the workspace on screen has a person looking
    /// at it — it polls that one often, and the rest seldom. The phone has
    /// one window, `main`; on screen means the app is active.
    private func focus() async {
        guard ready else { return }
        let now = (folder: selected, focused: onScreen)
        if let told, told.folder == now.folder, told.focused == now.focused { return }
        told = now
        do {
            try await Engine.shared.run(
                "cloud_set_focus", ["window": "main", "folder": .optional(now.folder), "focused": .bool(now.focused)]
            )
        } catch {
            told = nil
        }
    }

    /* ---------- What the engine says ---------- */

    private func hear(_ event: EngineEvent) {
        switch event.name {
        case "cloud-status":
            if let all = event.decode([CloudStatus].self) { take(all) }
        case "versions-status":
            if let all = event.decode([VersionsStatus].self) { versions = all }
        case "cloud-applied":
            if let applied = event.decode(CloudApplied.self) {
                open[applied.root]?.changed(applied.paths)
                // What sync just brought may be the page a link is waiting for.
                if arrivingPage?.root == applied.root { Task { await arrive() } }
            }
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
        case "cloud-pending-adds":
            if let asked = event.decode(CloudPendingAdds.self) { adds[asked.root] = asked }
        case "cloud-removed":
            if let gone = event.decode(Removed.self) {
                removed = gone
                open[gone.root] = nil
                if arrivingPage?.root == gone.root { dismissArriving() }
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

    /// The question about many new documents in `root` was answered.
    func answered(_ root: String) {
        adds[root] = nil
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
    /// What changed lately, as the engine last said (`cloud_recent`).
    public private(set) var recent: RecentFiles?
    /// Moves whenever something is marked read here, so the dots follow.
    public private(set) var reads = 0

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

    /* ---------- What changed, and what was read ---------- */

    /// Ask the engine what changed lately.
    public func loadRecent() async throws {
        recent = try await Engine.shared.call("cloud_recent", ["root": .string(root), "limit": 400])
    }

    /// Every document by when it last changed, newest first — Home's rows.
    public var recentItems: [RecentItem] {
        _ = reads
        guard let recent else { return [] }
        return RecentItem.items(recent, seen: device?.seen, wsId: status?.wsId ?? root, workspace: name)
    }

    /// The row of the document at `path` (its note or its page).
    public func recentItem(_ path: String) -> RecentItem? {
        let key = path.lowercased()
        return recentItems.first { $0.id == key || $0.html?.lowercased() == key }
    }

    /// What this person last read of the file at `path` here — its content
    /// address then — and what it holds now, as the engine last said.
    public func lastRead(_ path: String) -> (seen: String?, now: RecentFile?) {
        let file = recent?.files.first { $0.path.lowercased() == path.lowercased() }
        let key = SeenStore.key(fileId: file?.fileId, path: path)
        return (device?.seen?.hash(status?.wsId ?? root, key), file)
    }

    /// The document at `path` was shown: what its files hold now is what
    /// this person has read. Asks the engine first, so it is what is here.
    public func markRead(_ path: String) async {
        try? await loadRecent()
        guard let item = recentItem(path) else { return }
        let entries = item.parts.compactMap { part in
            part.hash.map { (key: SeenStore.key(fileId: part.fileId, path: part.path), hash: $0) }
        }
        guard !entries.isEmpty else { return }
        device?.seen?.saw(status?.wsId ?? root, entries)
        reads += 1
    }

    /// Sync now rather than at the next poll.
    public func syncNow() async {
        try? await Engine.shared.run("cloud_sync_now", ["root": .string(root)])
    }

    /// Where the many new documents of the last question here appeared,
    /// until it is answered.
    public var adds: CloudPendingAdds? { device?.adds[root] }

    /// Answer it: sync them, or leave them on this device until it asks
    /// again.
    public func confirmAdds(sync: Bool) async throws {
        try await Engine.shared.run("cloud_confirm_adds", ["root": .string(root), "sync": .bool(sync)])
        device?.answered(root)
        await device?.refresh()
    }

    /// Send this device's held-back big changes now rather than at the next
    /// UTC day: for today, and only when `usage.liftable`.
    public func liftWait() async throws {
        try await Engine.shared.run("cloud_lift_wait", ["root": .string(root)])
        await device?.refresh()
    }

    /// The domain's Cloudflare plan, which every limit is derived from: the
    /// superadmin's to change (`workspace.manage`).
    public func setPlan(_ plan: CloudPlan) async throws {
        try await Engine.shared.run("cloud_set_plan", ["root": .string(root), "plan": .string(plan.rawValue)])
        await device?.refresh()
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

    /// *Copy link* on the file at `path` (workspace-relative): the link
    /// that opens it in Doklin for anybody who can see it, and who that is.
    /// A file made a moment ago is synced first, so this can take a beat.
    public func link(to path: String) async throws -> PageLinkCopy {
        try await Engine.shared.call("cloud_link", ["path": .string(files.absolute(path))])
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

/// Who can open what is at a path, read off the sections the engine lists,
/// as the Mac's `placeOf` (src/cloud.ts) reads it.
public enum Audience: Equatable, Sendable {
    /// Everyone in the workspace: what is in Library.
    case everyone
    /// Only this person: their Private.
    case onlyYou
    /// The people of one restricted folder, by its name.
    case folder(String)
    /// The folder that holds the restricted folders, which is nobody's itself.
    case folders
    /// In no section — the top of the workspace and anything else there, a
    /// folder with a section's name at the top of Library, or a folder under
    /// `Restricted/` that is not a restricted folder: it stays on this iPhone.
    case nowhere

    public static func of(_ path: String, in status: CloudStatus?) -> Audience {
        guard let status else { return .everyone }
        let under = { (folder: String) in Sections.holds(folder, path) }
        for space in status.spaces where under(space.path) {
            return space.kind == .private ? .onlyYou : .folder(space.name)
        }
        if path.lowercased() == TreeModel.restrictedFolder.lowercased() { return .folders }
        guard under(TreeModel.libraryFolder) else { return .nowhere }
        // Library never holds anything under a section's name at its own
        // top: the shared section skips them, as the engine's `reserved_top`
        // does.
        let inside = path.split(separator: "/").dropFirst().first.map(String.init)
        return inside.map(TreeModel.isSectionName) == true ? .nowhere : .everyone
    }
}

/// What a followed link says when it opens nothing.
public enum LinkWords {
    /// The link's workspace is not on this device: how to get it here.
    public static func notJoined(domain: String, kind: String) -> String {
        "That page is in \(domain), which this \(kind) hasn't joined. To join it, choose Join another workspace and paste the line from a device that has it: on a Mac, open the workspace’s menu and choose Devices… → Add a device."
    }

    /// The page never came, and the engine had nothing to say about why.
    public static let neverCame = "That page didn't arrive. It may have been deleted, or moved where you can't see it."
}
