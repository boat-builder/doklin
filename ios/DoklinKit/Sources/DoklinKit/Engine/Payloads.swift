// What the engine answers and what its events carry, as Swift reads them.
// Mirrors engine/src/cloud/status.rs (and the records of remote.rs it
// nests) and engine/src/versions/status.rs, history.rs and workspace.rs,
// as src/cloud.ts and src/versions.ts do for the Mac — change all three.
// Only what the phone reads is here.
//
// Every key is always present in what the engine writes; an optional field
// is one the engine writes as null. Times are milliseconds since 1970.

import Foundation

/* ---------- The cloud: the status that is the whole model ---------- */

public enum CloudPhase: String, Decodable, Sendable {
    case idle
    case syncing
    case offline
    case paused
    case pendingDeletes = "pending-deletes"
    /// Many new documents appeared at once: they wait for a yes
    /// (`cloud_confirm_adds`); edits, moves and deletions go on.
    case pendingAdds = "pending-adds"
    case revoked
    case workerOutdated = "worker-outdated"
    /// Today's Cloudflare requests are used up: nothing is sent until the
    /// next UTC day. `error` says so in a sentence.
    case limited
    case error
}

/// One connected workspace, as the engine sees it now: `cloud-status`
/// carries every one of them on every change.
public struct CloudStatus: Decodable, Equatable, Sendable, Identifiable {
    /// The folder on this device, absolute.
    public let root: String
    public let domain: String
    public let endpoint: String
    public let wsId: String
    public let name: String
    public let phase: CloudPhase
    public let lastSyncMs: Int?
    public let error: String?
    public let pendingDeletes: Int
    /// New documents held until this person says to sync them.
    public let pendingAdds: Int
    /// How today's requests stand, and what that holds back.
    public let usage: CloudUsage
    /// Who this device works as here, in words.
    public let me: String
    /// The same person by member id; null until the domain has said.
    public let meId: String?
    /// What this device may do here (`work`, `people.invite`, …). Empty
    /// means not known yet, never "nothing".
    public let can: [String]
    /// The workspace's superadmin, by name — whom to ask for what only they
    /// can do. Null until the domain has said.
    public let superadmin: String?
    public let workerVersion: Int?
    public let `public`: [PublicPage]
    public let presence: [PresenceDevice]
    public let leases: [LeaseHolder]
    public let spaces: [SpaceStatus]

    public var id: String { root }

    /// Whether this device may do `action`. A status from before the domain
    /// answered knows nothing yet, and says yes: the engine refuses in words
    /// what the domain would.
    public func may(_ action: String) -> Bool {
        can.isEmpty || can.contains(action)
    }
}

/// How the engine paces this workspace today.
public enum UsageMode: String, Decodable, Sendable {
    case normal
    /// Big changes wait for the next UTC day; edits go on.
    case bulkWaits = "bulk-waits"
    /// Polls once a minute and sends no big changes; edits still go out.
    case slow
}

/// Whose spending put the workspace in its mode.
public enum UsageCause: String, Decodable, Sendable {
    /// This device's own allowance: it may lift the wait for today.
    case device
    /// Everyone's together: nobody can lift it.
    case fleet
}

/// The Cloudflare plan the domain's numbers come from.
public enum CloudPlan: String, Decodable, Sendable, CaseIterable {
    case free
    case paid
}

/// `CloudStatus.usage`: this device's requests today on the domain, and what
/// the day's limits hold back.
public struct CloudUsage: Decodable, Equatable, Sendable {
    public let mode: UsageMode
    public let cause: UsageCause?
    /// This device's requests today (UTC day) on this domain.
    public let today: Int
    /// Everyone's, as the domain last said; null when it could not.
    public let fleetToday: Int?
    /// The account's daily requests; null when there is no such limit.
    public let cap: Int?
    /// Null until the domain has said.
    public let plan: CloudPlan?
    /// The next 00:00 UTC, when the mode is not `normal` or the phase is
    /// `limited`.
    public let resumesAt: Int?
    /// Changes held back: uploads not sent and downloads owed.
    public let waiting: Int
    /// The cause is this device's own allowance and it was not lifted today.
    public let liftable: Bool
    /// This device's wait was lifted today (`cloud_lift_wait`).
    public let lifted: Bool
}

public enum SpaceKind: String, Decodable, Sendable {
    case restricted
    case `private`
}

/// A section only some people have: this person's Private, or a restricted
/// folder they are in.
public struct SpaceStatus: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: SpaceKind
    public let name: String
    /// Its folder, workspace-relative: `Private`, `Restricted/Finance`.
    public let path: String
    public let by: String
    /// Everyone in it, by member id.
    public let members: [String]
}

public enum PublicKind: String, Decodable, Sendable {
    case file
    case dir
}

/// A public address as this device believes it is.
public struct PublicPage: Decodable, Equatable, Sendable, Identifiable {
    public let slug: String
    public let kind: PublicKind
    /// Workspace-relative; `""` is the workspace itself, for a folder page.
    public let path: String
    public let title: String?
    public let desc: String?
    public let by: String
    public let at: Int
    /// False when its file is gone, or no synced file is under its folder.
    public let alive: Bool
    /// The page the domain's own address shows.
    public let root: Bool

    public var id: String { slug }
}

/// Another device here now.
public struct PresenceDevice: Decodable, Equatable, Sendable, Identifiable {
    public let deviceId: String
    public let memberId: String
    /// Who is here, in words: the person, or the device when it is yours.
    public let name: String
    public let device: String
    public let path: String?
    public let ts: Int

    public var id: String { deviceId }
}

/// A document another device holds: here it opens view-only.
public struct LeaseHolder: Decodable, Equatable, Sendable {
    /// Workspace-relative and lowercased.
    public let path: String
    public let deviceId: String
    public let memberId: String
    public let name: String
    public let device: String
    /// The holder is you, on another device.
    public let own: Bool
    public let until: Int
}

/// A workspace taken off this device: an owner took its access away, or it
/// was signed out from another device. `cloud-removed`, and `cloud_removed`.
public struct Removed: Decodable, Equatable, Sendable {
    public let root: String
    public let name: String
    public let domain: String
    /// False when the copy could not be deleted.
    public let deleted: Bool
    public let at: Int
}

/* ---------- Joining ---------- */

/// `cloud_parse_invite`: whatever of a line was found in what was pasted.
public struct Pasted: Decodable, Equatable, Sendable {
    public let endpoint: String?
    public let code: String?
}

/// `cloud_redeem`: this device's own sign-in, and who it is.
public struct Redeemed: Decodable, Sendable {
    public let endpoint: String
    public let token: String
    public let memberId: String
    public let email: String
    public let name: String
}

/* ---------- People, devices and agents ---------- */

/// `cloud_people`: everything the People and Devices screens show.
public struct People: Decodable, Equatable, Sendable {
    /// `superadmin`, `owner` or `member`.
    public let role: String
    /// Which of `members` is you.
    public let me: String
    public let can: [String]
    /// This device's own id.
    public let deviceId: String
    /// The row of `devices` that is this device's sign-in.
    public let tokenId: String
    public let members: [MemberRecord]
    public let invites: [InviteRecord]
    public let devices: [DeviceRecord]
}

public struct MemberRecord: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let email: String
    public let name: String
    /// `superadmin`, `owner` or `member`. The one superadmin nobody changes
    /// or removes.
    public let role: String
    public let createdAt: Int
    public let lastSeenAt: Int?
    public let devices: Int
}

public struct InviteRecord: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let memberId: String
    public let email: String
    public let name: String
    public let createdAt: Int
    public let expiresAt: Int
}

public struct DeviceRecord: Decodable, Equatable, Sendable, Identifiable {
    /// What `tokenId` names.
    public let id: String
    public let memberId: String
    public let email: String
    public let deviceId: String?
    public let deviceName: String?
    public let createdAt: Int
}

/// `cloud_invite`: the code, the one time it exists in the clear.
public struct Invited: Decodable, Sendable {
    public let code: String
    /// The line to send: `doklin-invite <address> <code>`.
    public let blob: String
    public let invite: InviteRecord
}

/// `cloud_link`: what *Copy link* puts on the clipboard — a link that opens
/// the file in Doklin for anybody who can see it — and who that is, as a
/// sentence. Mirrors `PageLinkCopy` (engine/src/cloud/status.rs ⇄
/// `CloudPageLink`, src/cloud.ts): change all three.
public struct PageLinkCopy: Decodable, Equatable, Sendable {
    public let url: String
    public let who: String
}

/// `cloud_recent`: a workspace's documents by when their content last
/// changed, newest first, across its sections — what Home lists — with the
/// directory their `by`s are read with. Mirrors `RecentFiles`
/// (engine/src/cloud/status.rs ⇄ `CloudRecentFiles`, src/cloud.ts): change
/// all three.
public struct RecentFiles: Decodable, Equatable, Sendable {
    public let files: [RecentFile]
    /// People, then agents, each agent with whose it is.
    public let people: [DirectoryPerson]
    /// Who this device works as, by member id; null until the domain has said.
    public let me: String?

    public init(files: [RecentFile], people: [DirectoryPerson], me: String?) {
        self.files = files
        self.people = people
        self.me = me
    }
}

public struct RecentFile: Decodable, Equatable, Sendable {
    /// Workspace-relative.
    public let path: String
    /// Null for a file made here that no manifest carries yet.
    public let fileId: String?
    /// The manifest's content address: the first 16 hex of the sha256, so a
    /// prefix of a version's hash. Null for a change not synced yet.
    public let hash: String?
    /// When its content last changed, ms. A move is not a change.
    public let mtime: Int
    /// A member id (`m-…`) or an agent's (`a-…`); empty when this device's
    /// own change was made before the domain said who it is.
    public let by: String
    /// 1: made and never changed — or moved in from another section, which
    /// is a new file there. 0: not synced yet.
    public let rev: Int
    /// The space it is in; null for the shared workspace.
    public let section: String?

    public init(path: String, fileId: String?, hash: String?, mtime: Int, by: String, rev: Int, section: String?) {
        self.path = path
        self.fileId = fileId
        self.hash = hash
        self.mtime = mtime
        self.by = by
        self.rev = rev
        self.section = section
    }
}

/// One row of the workspace's directory.
public struct DirectoryPerson: Decodable, Equatable, Sendable {
    public let id: String
    public let name: String
    /// For an agent, whose it is (a member id).
    public let person: String?

    public init(id: String, name: String, person: String?) {
        self.id = id
        self.name = name
        self.person = person
    }
}

/// `cloud_device_code`: a code for another device of yours.
public struct DeviceCode: Decodable, Equatable, Sendable {
    public let code: String
    /// The line to paste on the other device.
    public let blob: String
    public let expiresAt: Int
}

public struct AgentRecord: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    /// From `read`, `comment`, `edit`, `publish`.
    public let scopes: [String]
    public let createdAt: Int
    public let lastUsedAt: Int?
    /// Whose it is: one of the workspace's people.
    public let memberId: String
    public let mine: Bool
    public let machines: [AgentMachine]
    public let code: AgentCode?
}

/// A machine an agent is logged in on.
public struct AgentMachine: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let host: String
    public let createdAt: Int
}

/// A login code waiting to be used.
public struct AgentCode: Decodable, Equatable, Sendable {
    public let id: String
    public let createdAt: Int
    public let expiresAt: Int
}

/// A login for an agent, the one time its code is in the clear.
public struct AgentLogin: Decodable, Equatable, Sendable {
    /// `doklin login <address> <code>`.
    public let line: String
    public let code: String
    public let expiresAt: Int
}

public struct AgentAdded: Decodable, Sendable {
    public let agent: AgentRecord
    public let login: AgentLogin
}

/* ---------- Pages ---------- */

/// `cloud_pages`: every public address of the domain this person may see.
public struct EveryPages: Decodable, Equatable, Sendable {
    public let pages: [EveryPage]
    public let truncated: Bool
}

public struct EveryPage: Decodable, Equatable, Sendable, Identifiable {
    public let slug: String
    public let kind: PublicKind
    public let title: String
    public let by: String
    public let at: Int
    /// In the shared workspace, rather than a section.
    public let shared: Bool

    public var id: String { slug }
}

/* ---------- Cloud events beside the status ---------- */

/// `cloud-applied`: sync wrote these files (workspace-relative).
public struct CloudApplied: Decodable, Sendable {
    public let root: String
    public let paths: [String]
}

/// `cloud-conflict`: both sides changed a file; theirs is beside it.
public struct CloudConflict: Decodable, Sendable {
    public let root: String
    public let path: String
    public let by: String
    public let conflictPath: String
}

/// `cloud-pending-deletes`: a deletion large enough to wait for a yes.
public struct CloudPendingDeletes: Decodable, Sendable {
    public let root: String
    public let count: Int
    public let total: Int
    public let paths: [String]
}

/// `cloud-pending-adds`: so many new documents that they wait for a yes.
public struct CloudPendingAdds: Decodable, Equatable, Sendable {
    public let root: String
    public let count: Int
    /// Where they are, workspace-relative, most first, at most 5.
    public let folders: [AddedFolder]
}

public struct AddedFolder: Decodable, Equatable, Sendable {
    /// Workspace-relative; `""` is the workspace itself.
    public let path: String
    public let count: Int
}

/// `cloud-space-left`: a restricted folder left this device.
public struct CloudSpaceLeft: Decodable, Sendable {
    public let root: String
    public let name: String
    public let path: String
}

/// `cloud-progress`: a join's download, file by file.
public struct CloudProgress: Decodable, Sendable {
    public let root: String
    public let kind: String
    public let done: Int
    public let total: Int
}

/// `cloud-address-taken`: a page asked for an address another has.
public struct CloudAddressTaken: Decodable, Sendable {
    public let root: String
    public let slug: String
    public let path: String
}

/* ---------- Versions ---------- */

public enum VersionsPhase: String, Decodable, Sendable {
    case idle
    case capturing
    case tooLarge = "too-large"
    case disabled
    case error
}

/// One version store: the workspace's, or a section's.
public struct VersionsStatus: Decodable, Equatable, Sendable, Identifiable {
    public let root: String
    public let key: String
    public let phase: VersionsPhase
    public let error: String?
    public let snapshots: Int
    public let oldestMs: Int?
    public let newestMs: Int?
    public let lastCaptureMs: Int?
    public let horizonDays: Int?

    public var id: String { key }
}

/// `versions_history`: every version of one document, newest first.
public struct FileHistory: Decodable, Equatable, Sendable {
    /// The store the document is in: what reading, comparing and restoring
    /// one of these names.
    public let root: String
    public let currentHash: String?
    public let versions: [FileVersion]
}

public struct FileVersion: Decodable, Equatable, Sendable, Identifiable {
    public let ts: Int
    public let hash: String
    public let size: Int
    /// The device that kept it.
    public let by: String
    public let reason: String
    public let label: String?
    public let pinned: Bool
    public let restoredFrom: Int?
    /// Store-relative, as it was called then.
    public let path: String
    /// `local` (this device's store) or `cloud` (another device's, mirrored).
    public let source: String
    public let current: Bool

    public var id: String { "\(ts)-\(hash)" }
}

/// `versions_snapshots`: one moment of the whole folder.
public struct SnapshotMeta: Decodable, Equatable, Sendable, Identifiable {
    public let ts: Int
    public let reason: String
    public let files: Int
    public let bytes: Int
    public let pinned: Bool
    public let label: String?
    public let restoredFrom: Int?
    /// What changed against the moment before; null on the oldest.
    public let delta: SnapshotDelta?

    public var id: Int { ts }
}

public struct SnapshotDelta: Decodable, Equatable, Sendable {
    public let added: Int
    public let removed: Int
    public let changed: Int
}

/// `versions_snapshot_diff`: how a moment and the folder now disagree.
/// Paths are store-relative.
public struct SnapshotDiff: Decodable, Equatable, Sendable {
    public let changed: [ChangedFile]
    /// Here now and not then: a restore removes these.
    public let added: [String]
    /// There then and not now: a restore brings these back.
    public let missing: [String]
}

public struct ChangedFile: Decodable, Equatable, Sendable {
    public let path: String
    public let thenHash: String
    public let nowHash: String
}

/// `versions_deleted`: a file that was in the folder and is not now.
public struct DeletedFile: Decodable, Equatable, Sendable, Identifiable {
    /// Store-relative.
    public let path: String
    public let lastSeenMs: Int
    public let hash: String
    public let size: Int

    public var id: String { path }
}

/// `versions_restore_file`: how to undo the restore just made.
public struct RestoreOutcome: Decodable, Equatable, Sendable {
    public let preRestoreTs: Int?
    public let preRestoreHash: String?
    public let ts: Int?
}

/// `versions_restore_snapshot`.
public struct RestoreReport: Decodable, Equatable, Sendable {
    public let written: Int
    /// Removed outright: a phone has no trash.
    public let trashed: Int
    public let preRestoreTs: Int?
}

/// `versions-applied`: a restore wrote these files (absolute paths).
public struct VersionsApplied: Decodable, Sendable {
    public let root: String
    public let paths: [String]
}
