// The workspaces this device is logged in to, and the one being looked at.
//
// A login is the CLI's (cli/src/commands.rs, `login`): a code from the Mac
// app's Agents panel is traded for a token of this device's own, the token
// goes to the Keychain, and the device is from then on an agent of its
// person's — seeing what they see, doing what they ticked.

import Foundation
import Observation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// How far a screen has got with what it shows.
public enum LoadPhase: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)
}

/// Who can open what is at a path.
public enum Audience: Equatable, Sendable {
    /// Everyone in the workspace.
    case everyone
    /// Only this device's person: their Private.
    case onlyYou
    /// The people of one restricted folder, by its name.
    case folder(String)
    /// The folder that holds the restricted folders, which is nobody's itself.
    case folders
}

/// One workspace, logged in: its client, what this device may do there, and
/// the copies kept of what was read.
@MainActor
@Observable
public final class Session: Identifiable {
    public private(set) var account: Account
    public let client: DoklinClient
    /// Copies of what was read, for opening at once and reading offline.
    public let cache: DiskCache
    /// Text typed and not yet saved. Not a cache: nothing else has it.
    public let drafts: DiskCache
    public private(set) var me: Me?
    /// Set once the domain says this login is gone; the sentence says so.
    public private(set) var loggedOut: String?
    /// Counts the changes made from this device, so a listing knows to read again.
    public private(set) var changes = 0
    /// Counts the times the app came back to the front: what is on screen
    /// may have changed on a Mac meanwhile.
    public private(set) var wakes = 0

    @ObservationIgnored var onAccountChange: ((Account) -> Void)?

    public nonisolated var id: String { client.endpoint }

    init(account: Account, client: DoklinClient, cache: DiskCache, drafts: DiskCache) {
        self.account = account
        self.client = client
        self.cache = cache
        self.drafts = drafts
        self.me = cache.load(Me.self, for: "me")
    }

    public func may(_ scope: Scope) -> Bool {
        (me?.scopes ?? account.scopes).contains(scope.rawValue)
    }

    /// Who can open a path — read off the sections the domain lists for this
    /// person (`GET me`), so no folder's name is spelled here.
    public func audience(of path: String) -> Audience {
        let lower = path.lowercased()
        for mount in me?.sections ?? [] {
            let m = mount.lowercased()
            let restricted = mount.contains("/")
            if lower == m || lower.hasPrefix(m + "/") {
                return restricted ? .folder(DocLinks.name(of: mount)) : .onlyYou
            }
            if restricted, lower == DocLinks.directory(of: m) { return .folders }
        }
        return .everyone
    }

    /// Ask the domain who this device is there: its name, its permissions and
    /// its person's sections can all change from a Mac at any time.
    public func refresh() async {
        do {
            let me = try await client.me()
            self.me = me
            cache.store(me, for: "me")
            var next = account
            next.agent = me.agent.name
            next.scopes = me.scopes
            if let workspace = me.workspace { next.workspace = workspace.name }
            if next != account {
                account = next
                onAccountChange?(next)
            }
        } catch {
            _ = explain(error)
        }
    }

    /// Something changed from this device: listings read again.
    public func changed() {
        changes += 1
    }

    /// The app is in front again: whatever is shown reads again.
    public func woke() {
        wakes += 1
    }

    /// Moves whenever a listing should read again, for either reason.
    public var stamp: Int { changes + wakes }

    /// An error as the sentence to show — and, when it says this login is
    /// gone, the end of the session. Nil for a call that was only cancelled.
    @discardableResult
    public func explain(_ error: Error) -> String? {
        if error is CancellationError { return nil }
        guard let known = error as? DoklinError else { return error.localizedDescription }
        if known.kind == .loggedOut { loggedOut = known.message }
        return known.message
    }
}

@MainActor
@Observable
public final class AccountStore {
    public private(set) var accounts: [Account] = []
    /// The endpoint of the workspace being looked at.
    public private(set) var selected: String?

    @ObservationIgnored private let directory: URL
    @ObservationIgnored private let cacheDirectory: URL
    @ObservationIgnored private let secrets: SecretStore
    @ObservationIgnored private let clientName: String
    @ObservationIgnored private let urlSession: URLSession?
    @ObservationIgnored private var sessions: [String: Session] = [:]

    private struct File: Codable {
        var version = 1
        var accounts: [Account]
        var selected: String?
    }

    /// `directory` holds the list of workspaces and unsaved drafts;
    /// `cacheDirectory` holds copies the system may clear.
    public init(directory: URL, cacheDirectory: URL, secrets: SecretStore, clientName: String, urlSession: URLSession? = nil) {
        self.directory = directory
        self.cacheDirectory = cacheDirectory
        self.secrets = secrets
        self.clientName = clientName
        self.urlSession = urlSession
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(File.self, from: data) {
            // A workspace whose token is gone (a restored backup carries none) is not logged in.
            accounts = saved.accounts.filter { secrets.secret(for: $0.endpoint) != nil }
            selected = accounts.contains { $0.endpoint == saved.selected } ? saved.selected : accounts.first?.endpoint
        }
    }

    private var file: URL { directory.appendingPathComponent("workspaces.json") }

    private func save() {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(File(accounts: accounts, selected: selected)) {
            try? data.write(to: file, options: .atomic)
        }
    }

    /// The session of the workspace being looked at, made on first use.
    public var current: Session? {
        guard let endpoint = selected, let account = accounts.first(where: { $0.endpoint == endpoint }) else { return nil }
        if let session = sessions[endpoint] { return session }
        guard let token = secrets.secret(for: endpoint) else { return nil }
        let session = Session(
            account: account,
            client: DoklinClient(endpoint: endpoint, token: token, clientName: clientName, session: urlSession),
            cache: DiskCache(directory: cacheDirectory.appendingPathComponent(account.folderName)),
            drafts: DiskCache(directory: directory.appendingPathComponent("drafts").appendingPathComponent(account.folderName))
        )
        session.onAccountChange = { [weak self] account in self?.update(account) }
        sessions[endpoint] = session
        return session
    }

    private func update(_ account: Account) {
        guard let i = accounts.firstIndex(where: { $0.endpoint == account.endpoint }) else { return }
        accounts[i] = account
        save()
    }

    public func select(_ account: Account) {
        guard accounts.contains(where: { $0.endpoint == account.endpoint }) else { return }
        selected = account.endpoint
        save()
    }

    /// Log this device in with a line from the Mac app. `host` is what the
    /// Mac's Agents panel lists this device as.
    @discardableResult
    public func signIn(address: String, code: String, host: String) async throws -> Account {
        let endpoint = try Endpoint.normalize(address)
        let typed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else {
            throw DoklinError(.refused, "Enter the login code from Doklin on your Mac.")
        }
        let answer = try await DoklinClient.login(endpoint: endpoint, code: typed, host: host, clientName: clientName, session: urlSession)
        let before = secrets.secret(for: endpoint)
        try secrets.setSecret(answer.token, for: endpoint)
        let account = Account(
            endpoint: endpoint,
            workspace: answer.workspace?.name ?? Endpoint.domain(of: endpoint),
            agent: answer.agent.name,
            scopes: answer.scopes
        )
        accounts.removeAll { $0.endpoint == endpoint }
        accounts.append(account)
        sessions[endpoint] = nil
        selected = endpoint
        save()
        // The login this one replaces is no use to anybody now: let it go, so
        // its person's list shows one device and not two. Best effort.
        if let before, before != answer.token {
            let old = DoklinClient(endpoint: endpoint, token: before, clientName: clientName, session: urlSession)
            Task { try? await old.logout() }
        }
        return account
    }

    /// Log out: the domain forgets this device's token, and the device
    /// forgets the workspace. The second happens whatever the first did.
    public func signOut(_ account: Account) async {
        if let token = secrets.secret(for: account.endpoint) {
            let client = DoklinClient(endpoint: account.endpoint, token: token, clientName: clientName, session: urlSession)
            try? await client.logout()
        }
        forget(account)
    }

    /// Drop a workspace from this device without asking the domain: its
    /// login is already gone there.
    public func forget(_ account: Account) {
        try? secrets.setSecret(nil, for: account.endpoint)
        if let session = sessions.removeValue(forKey: account.endpoint) {
            session.cache.removeAll()
            session.drafts.removeAll()
        } else {
            DiskCache(directory: cacheDirectory.appendingPathComponent(account.folderName)).removeAll()
            DiskCache(directory: directory.appendingPathComponent("drafts").appendingPathComponent(account.folderName)).removeAll()
        }
        accounts.removeAll { $0.endpoint == account.endpoint }
        if selected == account.endpoint { selected = accounts.first?.endpoint }
        save()
    }
}
