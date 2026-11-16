// What changed lately: every document of a workspace by when it last
// changed, newest first, with who changed it — a person, or whose agent —
// and whether it changed since this person last read it here. Read off the
// engine (`cloud_recent`), which reads the manifests it last applied, so it
// is there offline and costs the domain nothing.

import Foundation
import Observation

/* ---------- Who, in words ---------- */

/// The name a change is signed with, as a person reads it: a person is
/// their name, this person is "You", an agent is its person's first name and
/// the name its person gave it — "Maya’s Research agent".
public enum WhoWords {
    public static func isAgent(_ by: String) -> Bool { by.hasPrefix("a-") }

    /// `by` (a member id or an agent's) in words, read with the workspace's
    /// directory; `me` is who this device works as.
    public static func name(_ by: String, me: String?, people: [DirectoryPerson], workspace: String) -> String {
        if by.isEmpty || by == me { return "You" }
        let row = { (id: String) in people.first { $0.id == id } }
        guard isAgent(by) else {
            return row(by)?.name ?? "Someone no longer in \(workspace)"
        }
        guard let agent = row(by) else { return "An agent" }
        guard let personId = agent.person else { return agent.name }
        let agentName = agent.name.trimmingCharacters(in: .whitespaces)
        if personId == me {
            return agentName.isEmpty ? "Your agent" : "Your \(agentName)"
        }
        guard let person = row(personId) else { return agentName.isEmpty ? "An agent" : agentName }
        let first = firstName(person.name)
        // A name that says whose it is already — the Mac's terminal agent is
        // "<name>'s terminal (<Mac>)" — is shown as it stands.
        let lower = agentName.lowercased()
        if !first.isEmpty, lower.hasPrefix(first.lowercased()) || lower.hasPrefix(person.name.lowercased()) {
            return agentName
        }
        // Two people of one first name: the whole name, so it says whose.
        let shared = people.contains { $0.id != person.id && $0.person == nil && firstName($0.name).lowercased() == first.lowercased() }
        let owner = shared || first.isEmpty ? person.name : first
        return agentName.isEmpty ? "\(owner)’s agent" : "\(owner)’s \(agentName)"
    }

    static func firstName(_ name: String) -> String {
        String(name.trimmingCharacters(in: .whitespaces).split(separator: " ").first ?? "")
    }

    /// Up to two letters for a person's badge: "MC" for Maya Chen.
    public static func initials(_ name: String) -> String {
        let words = name.split(separator: " ").filter { $0.first?.isLetter == true }
        let letters = words.prefix(2).compactMap { $0.first }.map { String($0).uppercased() }
        return letters.joined()
    }
}

/* ---------- One row ---------- */

/// A document as Home lists it: its note and its page, together.
public struct RecentItem: Identifiable, Hashable, Sendable {
    /// What opens: the note, or the page when there is no note.
    public let path: String
    /// Its page beside the note.
    public let html: String?
    /// When its content last changed, ms.
    public let changed: Int
    /// Who changed it last: a member id, or an agent's.
    public let by: String
    /// That, in words.
    public let who: String
    public let byAgent: Bool
    public let byMe: Bool
    /// Nobody has changed it since it was made.
    public let created: Bool
    /// Changed since this person last read it here.
    public let unread: Bool
    /// Read here before, and changed since.
    public let changedSinceRead: Bool
    /// The last change was to its page, not its note.
    public let pageChanged: Bool
    /// The files it is, as the engine listed them.
    public let parts: [RecentFile]

    public var id: String { path.lowercased() }
    public var name: String { DocLinks.stem(of: DocLinks.name(of: path)) }
    public var folder: String { DocLinks.directory(of: path) }
    public var isPage: Bool { FileKind.of(path) == .html }

    /// "created", "edited", "edited the page".
    public var verb: String {
        if created { return "created" }
        return pageChanged && !isPage ? "edited the page" : "edited"
    }
}

/// Which changes Home shows.
public enum RecentFilter: String, CaseIterable, Sendable {
    case all, unread, agents, people

    public var label: String {
        switch self {
        case .all: return "All"
        case .unread: return "Unread"
        case .agents: return "Agents"
        case .people: return "People"
        }
    }

    public func keeps(_ item: RecentItem) -> Bool {
        switch self {
        case .all: return true
        case .unread: return item.unread
        case .agents: return item.byAgent
        case .people: return !item.byAgent
        }
    }
}

extension RecentItem {
    /// The engine's files as documents: a note and its page are one row,
    /// as a folder lists them, newest first.
    public static func items(
        _ recent: RecentFiles, seen: SeenStore?, wsId: String, workspace: String
    ) -> [RecentItem] {
        var groups: [String: [RecentFile]] = [:]
        var order: [String] = []
        for file in recent.files {
            let kind = FileKind.of(file.path)
            guard kind == .markdown || kind == .html else { continue }
            let key = (DocLinks.directory(of: file.path) + "/" + DocLinks.stem(of: DocLinks.name(of: file.path))).lowercased()
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(file)
        }
        let since = seen?.since ?? 0
        return order.compactMap { key -> RecentItem? in
            guard let parts = groups[key], let newest = parts.max(by: { $0.mtime < $1.mtime }) else { return nil }
            let notes = parts.filter { FileKind.of($0.path) == .markdown }
                .sorted { a, b in
                    let (aMd, bMd) = (a.path.lowercased().hasSuffix(".md"), b.path.lowercased().hasSuffix(".md"))
                    return aMd != bMd ? aMd : a.path < b.path
                }
            let page = parts.first { FileKind.of($0.path) == .html }
            let opens = notes.first?.path ?? page?.path ?? newest.path
            let byMe = newest.by.isEmpty || newest.by == recent.me
            var unread = false
            var readBefore = false
            for part in parts {
                guard let hash = part.hash, part.by != recent.me else { continue }
                let shown = seen?.hash(wsId, SeenStore.key(fileId: part.fileId, path: part.path))
                if let shown {
                    readBefore = true
                    if shown != hash { unread = true }
                } else if part.mtime > since {
                    unread = true
                }
            }
            return RecentItem(
                path: opens,
                html: notes.isEmpty ? nil : page?.path,
                changed: newest.mtime,
                by: newest.by,
                who: WhoWords.name(newest.by, me: recent.me, people: recent.people, workspace: workspace),
                byAgent: WhoWords.isAgent(newest.by),
                byMe: byMe,
                created: (newest.rev == 1 && newest.hash != nil) || newest.fileId == nil,
                unread: unread && !byMe,
                changedSinceRead: unread && readBefore && !byMe,
                pageChanged: FileKind.of(newest.path) == .html,
                parts: parts
            )
        }
        .sorted { $0.changed != $1.changed ? $0.changed > $1.changed : $0.path < $1.path }
    }
}

/* ---------- Words ---------- */

public enum RecentWords {
    /// How long ago, as a row says it: `now`, `12m`, `3h` today; the time of
    /// day before that, the row's day being its heading.
    public static func time(_ ms: Int, now: Int = Clock.now, dates: HistoryDates = HistoryDates()) -> String {
        let minutes = max(0, (now - ms) / 60_000)
        if dates.day(ms) == "Today" {
            if minutes < 1 { return "now" }
            if minutes < 60 { return "\(minutes)m" }
            return "\(minutes / 60)h"
        }
        return dates.time(ms)
    }

    /// The first words of a note, as a row shows them under its name: the
    /// first paragraph, past the frontmatter and the title, without comment
    /// marks.
    public static func excerpt(ofNote source: String, limit: Int = 160) -> String? {
        let document = MarkdownDocument.parse(String(source.prefix(6000)))
        func first(_ nodes: [BlockNode]) -> String? {
            for node in nodes {
                switch node.block {
                case .paragraph(let content):
                    let text = CriticMarkup.stripComments(content.plainText).trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty { return text }
                case .list(let list):
                    if let text = first(list.items.flatMap(\.blocks)) { return text }
                case .blockquote(let inner):
                    if let text = first(inner) { return text }
                default:
                    continue
                }
            }
            return nil
        }
        return first(document.blocks).map { cut($0, limit) }
    }

    /// The first words of a page: its first paragraph's text.
    public static func excerpt(ofPage html: String, limit: Int = 160) -> String? {
        let head = String(html.prefix(20_000))
        var rest = head[...]
        if let body = head.range(of: "<body", options: .caseInsensitive) { rest = head[body.lowerBound...] }
        while let open = rest.range(of: "<p", options: .caseInsensitive) {
            let after = rest[open.upperBound...]
            guard let next = after.first, next == ">" || next == " " || next == "\t" || next == "\n",
                  let start = after.firstIndex(of: ">"),
                  let close = after.range(of: "</p>", options: .caseInsensitive)
            else {
                rest = after
                continue
            }
            let inner = String(after[after.index(after: start)..<close.lowerBound])
            let text = plain(inner)
            if !text.isEmpty { return cut(text, limit) }
            rest = after[close.upperBound...]
        }
        return nil
    }

    private static func plain(_ html: String) -> String {
        var out = ""
        var inTag = false
        for character in html {
            if character == "<" { inTag = true } else if character == ">" { inTag = false } else if !inTag { out.append(character) }
        }
        let entities = ["&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " ", "&rsquo;": "’", "&lsquo;": "‘", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…"]
        for (entity, character) in entities { out = out.replacingOccurrences(of: entity, with: character) }
        return out.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    private static func cut(_ text: String, _ limit: Int) -> String {
        guard text.count > limit else { return text }
        let head = text.prefix(limit)
        let words = head.split(separator: " ").dropLast()
        return (words.isEmpty ? String(head) : words.joined(separator: " ")) + "…"
    }
}

/* ---------- Home ---------- */

/// Home's list: what changed in one workspace, filtered, in days.
@MainActor
@Observable
public final class RecentModel {
    public let workspace: Workspace
    public var filter: RecentFilter = .all
    public private(set) var phase: LoadPhase = .idle
    /// A row's first words, by path, read once.
    public private(set) var excerpts: [String: String] = [:]

    public init(workspace: Workspace) {
        self.workspace = workspace
    }

    public var all: [RecentItem] { workspace.recentItems }
    public var items: [RecentItem] { all.filter(filter.keeps) }
    public var unreadCount: Int { all.filter(\.unread).count }

    /// The rows in days: Today, Yesterday, then each day before.
    public func days(dates: HistoryDates = HistoryDates()) -> [(label: String, items: [RecentItem])] {
        var out: [(label: String, items: [RecentItem])] = []
        for item in items {
            let label = dates.day(item.changed)
            if out.last?.label == label {
                out[out.count - 1].items.append(item)
            } else {
                out.append((label, [item]))
            }
        }
        return out
    }

    public func load() async {
        if workspace.recent == nil { phase = .loading }
        do {
            try await workspace.loadRecent()
            phase = .loaded
        } catch {
            phase = workspace.recent == nil ? .failed((error as? DoklinError)?.message ?? error.localizedDescription) : .loaded
        }
        readExcerpts()
    }

    /// The first words of the rows shown, read off this device's copy; what
    /// changed is read again.
    private func readExcerpts() {
        let files = workspace.files
        for item in all.prefix(80) {
            let key = "\(item.path)\u{0}\(item.changed)"
            guard excerpts[key] == nil else { continue }
            let words: String?
            if item.isPage {
                words = (try? files.text(item.path)).flatMap { RecentWords.excerpt(ofPage: $0) }
            } else {
                words = (try? files.text(item.path)).flatMap { RecentWords.excerpt(ofNote: $0) }
            }
            excerpts[key] = words ?? ""
        }
    }

    public func excerpt(_ item: RecentItem) -> String? {
        let words = excerpts["\(item.path)\u{0}\(item.changed)"]
        return words?.isEmpty == false ? words : nil
    }
}
