// Who is in a workspace and how they got in: its people and the codes
// waiting for them, and the devices signed in as each. All of it is asked of
// the domain, through the engine, every time a screen opens and after every
// change — never kept here, since a role is the person's and an owner can
// change it while this iPhone sleeps. The answer to "did that work" is the
// list read back, not the call.
//
// A code made here — an invite, a line for another device — lives in memory
// for the screen that shows it, once. The domain kept only its sha256, so
// nobody can read it back, this iPhone included.

import Foundation
import Observation

/// How long ago something was, and how long something has left, in the Mac's
/// words: `timeAgo` and `timeUntil` (src/cloud.ts) — change both.
public enum Clock {
    public static var now: Int { Int(Date().timeIntervalSince1970 * 1000) }

    /// "just now", "2 min ago", "3 h ago", "12 d ago".
    public static func ago(_ ms: Int, now: Int = Clock.now) -> String {
        let secs = max(0, Int((Double(now - ms) / 1000).rounded()))
        if secs < 45 { return "just now" }
        let mins = Int((Double(secs) / 60).rounded())
        if mins < 60 { return "\(mins) min ago" }
        let hours = Int((Double(mins) / 60).rounded())
        if hours < 24 { return "\(hours) h ago" }
        return "\(Int((Double(hours) / 24).rounded())) d ago"
    }

    /// "6 days", "3 h", "12 min", "any moment now".
    public static func left(_ ms: Int, now: Int = Clock.now) -> String {
        let secs = Int((Double(ms - now) / 1000).rounded())
        if secs < 60 { return "any moment now" }
        let mins = Int((Double(secs) / 60).rounded())
        if mins < 60 { return "\(mins) min" }
        let hours = Int((Double(mins) / 60).rounded())
        if hours < 36 { return "\(hours) h" }
        let days = Int((Double(hours) / 24).rounded())
        return "\(days) day\(days == 1 ? "" : "s")"
    }
}

/// How long an invite's code is good for. The engine clamps anything else.
public enum InviteDays {
    public static let choices = [1, 7, 30]
    public static let usual = 7

    public static func words(_ days: Int) -> String { "\(days) day\(days == 1 ? "" : "s")" }
}

extension People {
    /// Whether this person may do `action` here. The answer is the domain's,
    /// asked just now, so nothing is offered that it would refuse.
    public func may(_ action: String) -> Bool { can.contains(action) }

    public func isYou(_ member: MemberRecord) -> Bool { member.id == me }

    /// The devices signed in as a person, as far as this person may see.
    public func devices(of member: MemberRecord) -> [DeviceRecord] {
        devices.filter { $0.memberId == member.id }
    }

    /// This person's own devices.
    public var mine: [DeviceRecord] { devices.filter { $0.memberId == me } }

    /// The sign-in this iPhone syncs with: never offered for signing out —
    /// that would delete the copy in hand. Leaving the workspace is how.
    public func isThisDevice(_ device: DeviceRecord) -> Bool { device.id == tokenId }

    /// Whether a person's role or presence here can be changed from this
    /// device: nobody changes their own row, and nobody the creator's.
    public func changeable(_ member: MemberRecord) -> Bool {
        !isYou(member) && !member.creator && (may("people.roles") || may("people.remove"))
    }

    /// Whether a new code may be made for a person already listed. Once
    /// anybody has signed in as them, a code is theirs to make or the
    /// creator's; until then whoever may invite may replace it. The worker's
    /// `createInvite` (cloud-worker/src/api.ts) decides, and `mayInviteAgain`
    /// (src/cloud.ts) asks the same — change all three.
    public func mayInviteAgain(_ memberId: String) -> Bool {
        guard may("people.invite") else { return false }
        let person = members.first { $0.id == memberId }
        let signedIn = person.map { $0.creator || $0.lastSeenAt != nil } ?? false
        return !signedIn || creator || me == memberId
    }

    /// What a person's row says under their name: how they are here, and
    /// when they were last seen.
    public func summary(of member: MemberRecord, now: Int = Clock.now) -> String {
        let count = member.devices
        let devices = "\(count) device\(count == 1 ? "" : "s")"
        var words: String
        if member.creator {
            words = "Made this workspace, on a Mac that holds the domain’s own token and isn’t counted here."
            if count > 0 { words += " \(count) other device\(count == 1 ? "" : "s")." }
        } else if count == 0 {
            words = invites.contains { $0.memberId == member.id }
                ? "Invited — no device has traded the code in yet."
                : "No device signed in."
        } else {
            words = devices
        }
        if let seen = member.lastSeenAt { words += " · seen \(Clock.ago(seen, now: now))" }
        return words
    }

    /// The name a person goes by here.
    public func name(of memberId: String) -> String? {
        members.first { $0.id == memberId }.map { $0.name.isEmpty ? $0.email : $0.name }
    }
}

extension DeviceRecord {
    /// What the device called itself, when it said anything.
    public var named: String? { deviceName?.isEmpty == false ? deviceName : nil }

    /// Its name on a row, as on a Mac.
    public var label: String { named ?? "A device" }

    /// What signing it out asks. It is never this iPhone, which is not
    /// offered, so one with no name is "that device".
    public var signOutTitle: String { "Sign out \(named ?? "that device")?" }
}

/// The People and Devices screens: one `cloud_people` answer, the changes
/// made to it, and the code a change minted, while it is on screen.
@MainActor
@Observable
public final class PeopleModel {
    public let workspace: Workspace
    public private(set) var people: People?
    public private(set) var phase: LoadPhase = .idle
    /// A change is on its way to the domain.
    public private(set) var busy = false
    /// Why the last change did not happen, in the engine's words.
    public var problem: String?
    /// The code an invite just made — shown once, then never again.
    public var invited: Invited?
    /// A code for another device of this person's — shown once.
    public var deviceCode: DeviceCode?

    public init(workspace: Workspace) {
        self.workspace = workspace
    }

    private var root: JSONValue { .string(workspace.root) }

    /// Ask the domain who is here, and what this person may do about it.
    public func load() async {
        if people == nil { phase = .loading }
        do {
            people = try await Engine.shared.call("cloud_people", ["root": root])
            phase = .loaded
        } catch {
            let message = (error as? DoklinError)?.message ?? error.localizedDescription
            if people == nil { phase = .failed(message) } else { problem = message }
        }
    }

    /// Do something to the domain, then read the list back. True when it
    /// was done.
    @discardableResult
    private func act(_ change: () async throws -> Void) async -> Bool {
        busy = true
        problem = nil
        defer { busy = false }
        do {
            try await change()
        } catch {
            problem = (error as? DoklinError)?.message ?? error.localizedDescription
            return false
        }
        await load()
        return true
    }

    /// Invite somebody by their email: the code that lets them in, made
    /// once. True when it was.
    public func invite(email: String, name: String, days: Int) async -> Bool {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return await act {
            invited = try await Engine.shared.call("cloud_invite", [
                "root": root,
                "email": .string(email.trimmingCharacters(in: .whitespacesAndNewlines)),
                "name": .optional(name.isEmpty ? nil : name),
                "days": .int(days),
            ])
            deviceCode = nil
        }
    }

    /// Stop a code nobody has used yet. Their row stays: they are invited to nothing.
    public func withdraw(_ invite: InviteRecord) async {
        await act { try await Engine.shared.run("cloud_withdraw_invite", ["root": root, "inviteId": .string(invite.id)]) }
        if invited?.invite.id == invite.id { invited = nil }
    }

    /// Make an owner a member, or a member an owner.
    public func flipRole(of member: MemberRecord) async {
        let role = member.role == "owner" ? "member" : "owner"
        await act {
            try await Engine.shared.run("cloud_set_role", ["root": root, "memberId": .string(member.id), "role": .string(role)])
        }
    }

    /// Take a person's access away: every device of theirs deletes its copy.
    public func remove(_ member: MemberRecord) async {
        await act { try await Engine.shared.run("cloud_revoke_person", ["root": root, "memberId": .string(member.id)]) }
    }

    /// Sign a device out: it stops syncing and deletes its copy.
    public func signOut(_ device: DeviceRecord) async {
        await act { try await Engine.shared.run("cloud_revoke_device", ["root": root, "tokenId": .string(device.id)]) }
    }

    /// A code another device of this person's joins with. Making another
    /// stops this one.
    public func addDevice() async {
        await act {
            deviceCode = try await Engine.shared.call("cloud_device_code", ["root": root])
            invited = nil
        }
    }
}
