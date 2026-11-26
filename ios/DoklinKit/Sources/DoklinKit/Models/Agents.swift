// A person's agents: bots that work with the workspace from another
// computer through the `doklin` command line, with no copy of the folder.
// An agent sees what its person sees; the boxes ticked for it are what it
// may do there. Everybody adds, changes, logs in and removes their own; an
// owner is also shown everyone else's, to log out or remove and nothing
// more — a login code for somebody's agent would be a way in as them.
//
// As with people, every list is asked of the domain and read again after a
// change, and a login code made here is held only while it is on screen.

import Foundation
import Observation

/// What an agent may do, in the order the boxes are shown. Reading is not a
/// choice: an agent that cannot read can do nothing else.
public enum AgentScope: String, CaseIterable, Identifiable, Sendable {
    case read, comment, edit, publish

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .read: return "Read"
        case .comment: return "Comment"
        case .edit: return "Edit"
        case .publish: return "Publish"
        }
    }

    public var what: String {
        switch self {
        case .read: return "list, read and search documents, and read their comments"
        case .comment: return "start, answer and remove comment threads"
        case .edit: return "write, move and remove documents and files"
        case .publish: return "make anything it can open public, and stop publishing"
        }
    }

    /// What a new agent starts with. Publishing is off until its person says
    /// so: an agent cannot be asked to confirm, so the box is the whole gate.
    public static let usual: Set<AgentScope> = [.read, .comment, .edit]

    /// The scopes in the order the engine keeps them, read always among them.
    public static func ordered(_ picked: Set<AgentScope>) -> [String] {
        allCases.filter { $0 == .read || picked.contains($0) }.map(\.rawValue)
    }
}

extension AgentRecord {
    public var picked: Set<AgentScope> { Set(scopes.compactMap(AgentScope.init(rawValue:))) }
    public var canPublish: Bool { scopes.contains(AgentScope.publish.rawValue) }

    /// "read · comment · edit".
    public var scopeWords: String {
        AgentScope.allCases.filter { scopes.contains($0.rawValue) }.map { $0.label.lowercased() }.joined(separator: " · ")
    }

    /// Where it is logged in and when it last did something.
    public func summary(now: Int = Clock.now) -> String {
        var words = machines.isEmpty
            ? "Not logged in anywhere"
            : "Logged in on \(machines.count) machine\(machines.count == 1 ? "" : "s")"
        if let used = lastUsedAt { words += " · last used \(Clock.ago(used, now: now))" }
        if mine, let code, code.expiresAt > now {
            words += " · a login code is waiting, for \(Clock.left(code.expiresAt, now: now)) more"
        }
        return words
    }
}

/// What a person hands an agent to log it in — pasted into its chat, or read
/// by whoever sets its machine up: what Doklin is, the command that installs
/// `doklin`, the login line, and where its work goes when nobody says.
/// `buildAgentLoginPrompt` (src/cloudPrompts.ts) writes the same — change both.
public enum AgentPrompt {
    public static let installLine = "curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/install-doklin.sh | sh"

    public static func login(domain: String, line: String, expiresAt: Int) -> String {
        // UTC and spelled out: the reader is on another machine, in no known zone.
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        let expires = formatter.string(from: Date(timeIntervalSince1970: Double(expiresAt) / 1000)) + " UTC"
        return """
        Doklin is a workspace of markdown and HTML documents. Its command line, `doklin`, lets you read, write, search, comment on and publish them over the network, with no copy of the folder.

        The first command below installs `doklin` (skip it if it is already installed). The second logs you in: \(domain) is the workspace's address, and the code after it works once and expires at \(expires).

        \(installLine)
        \(line)

        You see what the person who gave you this sees. Every path starts with its section: `Library/` is what everyone sees, `My files/` is theirs, `Shared with me/` is what others shared with them. Put anything new under `My files/` unless they tell you where it goes, and put a path with a space in quotes.

        Then run `doklin help agent` to see what you can do.
        """
    }
}

/// A login just made for an agent: shown once.
public struct AgentLoginShown: Identifiable, Sendable {
    public let name: String
    public let login: AgentLogin

    public var id: String { login.code }
}

/// The Agents screen: this person's agents (and, for an owner, everyone
/// else's), the changes made to them, and a login while it is on screen.
@MainActor
@Observable
public final class AgentsModel {
    public let workspace: Workspace
    public private(set) var agents: [AgentRecord]?
    /// Everyone on the workspace, for whose somebody else's agent is.
    public private(set) var people: People?
    public private(set) var phase: LoadPhase = .idle
    public private(set) var busy = false
    public var problem: String?
    /// A login code just made — shown once, then never again.
    public var login: AgentLoginShown?

    public init(workspace: Workspace) {
        self.workspace = workspace
    }

    private var root: JSONValue { .string(workspace.root) }

    public var mine: [AgentRecord] { agents?.filter(\.mine) ?? [] }

    /// Everyone else's agents, for an owner; nobody else is shown them.
    public var others: [AgentRecord] {
        guard people?.may("agents.manage") == true else { return [] }
        return agents?.filter { !$0.mine } ?? []
    }

    /// Whose an agent is, in words.
    public func whose(_ agent: AgentRecord) -> String {
        people?.name(of: agent.memberId) ?? "somebody"
    }

    public func load() async {
        if agents == nil { phase = .loading }
        do {
            async let listed: [AgentRecord] = Engine.shared.call("cloud_agents", ["root": root])
            async let everyone: People = Engine.shared.call("cloud_people", ["root": root])
            agents = try await listed
            people = try? await everyone
            phase = .loaded
        } catch {
            let message = (error as? DoklinError)?.message ?? error.localizedDescription
            if agents == nil { phase = .failed(message) } else { problem = message }
        }
    }

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

    /// Add an agent of this person's own, and make its first login. True
    /// when it was added.
    public func add(name: String, scopes: Set<AgentScope>) async -> Bool {
        await act {
            let added: AgentAdded = try await Engine.shared.call("cloud_agent_add", [
                "root": root,
                "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
                "scopes": .strings(AgentScope.ordered(scopes)),
            ])
            login = AgentLoginShown(name: added.agent.name, login: added.login)
        }
    }

    /// Rename an agent, or change what it may do: it hears on its next command.
    public func update(_ agent: AgentRecord, name: String, scopes: Set<AgentScope>) async -> Bool {
        await act {
            try await Engine.shared.run("cloud_agent_update", [
                "root": root,
                "agentId": .string(agent.id),
                "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
                "scopes": .strings(AgentScope.ordered(scopes)),
            ])
        }
    }

    /// A new login code, for another machine or a lost one. The last one
    /// stops working.
    public func newLogin(for agent: AgentRecord) async {
        await act {
            let made: AgentLogin = try await Engine.shared.call("cloud_agent_code", ["root": root, "agentId": .string(agent.id)])
            login = AgentLoginShown(name: agent.name, login: made)
        }
    }

    /// Every machine it is logged in on is refused from its next command.
    public func remove(_ agent: AgentRecord) async {
        await act { try await Engine.shared.run("cloud_agent_remove", ["root": root, "agentId": .string(agent.id)]) }
    }

    public func logOut(_ agent: AgentRecord, from machine: AgentMachine) async {
        await act {
            try await Engine.shared.run(
                "cloud_agent_revoke_machine", ["root": root, "agentId": .string(agent.id), "tokenId": .string(machine.id)]
            )
        }
    }
}
