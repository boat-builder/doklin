// Publishing: a note, a page or a folder given an address on the domain
// that anyone with the link can read. Nothing is pushed — the worker draws
// the page from the synced files when it is asked for — so publishing is an
// entry in the workspace's public map, which the engine queues and syncs
// like a file (`cloud_publish`, `cloud_unpublish`, `cloud_set_root`). What
// this device believes is public is `CloudStatus.public`; an owner can also
// ask the domain for every page, the ones in sections this person is not in
// included (`cloud_pages`), and take any of them down.
//
// The words are the Mac's (src/cloud.ts, LiveChip.tsx, PublishedPages.tsx).

import Foundation
import Observation

/// Where a document's own page stands.
public enum PageState: Equatable, Sendable {
    /// No page of its own.
    case unpublished
    /// Up to date.
    case live
    /// Changes from here are still on their way.
    case updating
    /// Sync has stopped short of the page, so it keeps what it had.
    case stale
    /// The page itself is down: the address answers Not found.
    case offline

    /// What the page is, in a word or two: the Mac's Live chip.
    public var label: String {
        switch self {
        case .unpublished: return "Publish"
        case .live: return "Live"
        case .updating: return "Updating"
        case .stale: return "Not updating"
        case .offline: return "Page offline"
        }
    }

    /// How a page in this state is, after the document's name.
    public var heading: String {
        switch self {
        case .unpublished: return "isn’t published"
        case .live: return "is live"
        case .updating: return "is updating"
        case .stale: return "isn’t updating"
        case .offline: return "is offline"
        }
    }
}

public enum Publishing {
    /// The address of a page of its own: its slug under the domain.
    public static func url(of page: PublicPage, in status: CloudStatus) -> String {
        "\(status.endpoint)/\(page.slug)"
    }

    /// The address of a note inside a published folder: the folder's slug,
    /// then the path inside it without the markdown extension, each part
    /// percent-encoded.
    public static func url(of rel: String, inside folder: PublicPage, in status: CloudStatus) -> String {
        let inner = folder.path.isEmpty ? rel : String(decoding: Array(rel.utf16).dropFirst(folder.path.utf16.count + 1), as: UTF16.self)
        let shown = MarkdownExtension.strip(inner)
        let encoded = shown.split(separator: "/", omittingEmptySubsequences: false).map { encodeURIComponent(String($0)) }
        return "\(status.endpoint)/\(folder.slug)/\(encoded.joined(separator: "/"))"
    }

    /// `encodeURIComponent`: everything but letters, digits and `-_.!~*'()`.
    static func encodeURIComponent(_ text: String) -> String {
        var allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
        allowed.insert(charactersIn: "-_.!~*'()")
        return text.addingPercentEncoding(withAllowedCharacters: allowed) ?? text
    }

    /// The page published for exactly this path, of this kind.
    public static func page(for rel: String, kind: PublicKind, in status: CloudStatus) -> PublicPage? {
        status.public.first { $0.kind == kind && $0.path == rel }
    }

    /// One way a file can be read on the web: its own page, or inside a
    /// published folder.
    public struct Place: Equatable, Sendable {
        public let page: PublicPage
        public let url: String
        public let nested: Bool
    }

    /// Everywhere a file is public: its own page first, then the folders
    /// that hold it, the closest first.
    public static func places(of rel: String, in status: CloudStatus) -> [Place] {
        var out: [Place] = []
        if let own = page(for: rel, kind: .file, in: status) { out.append(Place(page: own, url: url(of: own, in: status), nested: false)) }
        let folders = status.public
            .filter { $0.kind == .dir && ($0.path.isEmpty || rel.utf16.starts(with: ($0.path + "/").utf16)) }
            .sorted { $0.path.utf16.count > $1.path.utf16.count }
        for folder in folders { out.append(Place(page: folder, url: url(of: rel, inside: folder, in: status), nested: true)) }
        return out
    }

    /// Where a document's own page stands. `pending`: it changed here since
    /// the last sync.
    public static func state(of page: PublicPage?, in status: CloudStatus?, pending: Bool) -> PageState {
        guard let status, let page else { return .unpublished }
        if status.phase == .revoked || !page.alive { return .offline }
        if status.phase != .idle, status.phase != .syncing { return .stale }
        return pending ? .updating : .live
    }

    /// Why a page is in the state it is, in a sentence; nil for one that is
    /// simply live.
    public static func reason(_ state: PageState, in status: CloudStatus, now: Int) -> String? {
        switch state {
        case .unpublished, .live: return nil
        case .updating: return "Your latest changes appear once synced."
        case .offline:
            return status.phase == .revoked
                ? "\(status.domain) doesn’t accept this iPhone’s sign-in, so it can’t update the page."
                : "The page answers Not found until this note is synced."
        case .stale:
            switch status.phase {
            case .offline:
                let synced = status.lastSyncMs.map { "synced \(Clock.ago($0, now: now))" } ?? "not synced yet"
                return "Offline, so the page keeps what it had (\(synced))."
            case .paused: return "Sync is paused, so the page keeps what it had."
            case .pendingDeletes: return "Sync is holding a deletion for your go, and the page waits with it."
            case .workerOutdated: return "\(status.domain) needs a worker update before the page changes again."
            default: return "Sync stopped: \(status.error ?? "an error")."
            }
        }
    }


    /// What a page is called in a list: its title, else its file's or
    /// folder's name, else the workspace's.
    public static func name(of page: PublicPage, workspace: String) -> String {
        if let title = page.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        if page.kind == .dir { return page.path.isEmpty ? workspace : DocLinks.name(of: page.path) }
        return DocLinks.stem(of: DocLinks.name(of: page.path))
    }

    /// Who published it and when, for this device: "Published 3 min ago by
    /// you" — `me` is the person this device works as, so a page published
    /// from their other device reads as theirs too.
    public static func byline(of page: PublicPage, in status: CloudStatus, now: Int) -> String {
        let ago = Clock.ago(page.at, now: now)
        if !page.by.isEmpty, page.by != status.me { return "Published by \(page.by) · \(ago)" }
        return "Published \(ago) by you"
    }

    /// The sub-line of a page in Published pages.
    public static func detail(of page: PublicPage, now: Int) -> String {
        let parts = [page.path.isEmpty ? "the whole workspace" : page.path, "/\(page.slug)", page.by.isEmpty ? "someone" : page.by]
        return (parts + [Clock.ago(page.at, now: now)]).joined(separator: " · ")
    }

    /// What a typed address is sent as: trimmed and lowercased, as the
    /// engine reads it, or nil for a random one.
    public static func slug(typed: String) -> String? {
        let slug = typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return slug.isEmpty ? nil : slug
    }

    /* ---------- Addresses ---------- */

    /// What an address may be, and the ones the worker's own routes speak
    /// for: the rule src/cloud.ts, the engine (manifest.rs) and the worker
    /// (layout.ts) check — change all.
    private static let slugGrammar = try! NSRegularExpression(pattern: "\\A[a-z0-9][a-z0-9-]{2,63}\\z")
    static let reservedSlugs: Set<String> = ["api", "__web", "raw", "og.png", "robots.txt", "favicon.ico", "apple-touch-icon.png", "join"]

    /// Why a typed address cannot be one, in a sentence; nil when it can.
    /// The engine refuses the same, in its own words.
    public static func slugProblem(_ typed: String) -> String? {
        let slug = slug(typed: typed) ?? ""
        if slugGrammar.firstMatch(in: slug, range: NSRange(location: 0, length: (slug as NSString).length)) == nil {
            return "An address is 3 to 64 characters: lowercase letters, digits and dashes, starting with a letter or digit."
        }
        if reservedSlugs.contains(slug) { return "“\(slug)” is taken by the site itself." }
        return nil
    }

    /// An address to offer for a name: lowercase, a dash for anything else,
    /// never shorter than an address can be — src/cloud.ts `suggestSlug`,
    /// change both.
    public static func suggestSlug(_ name: String) -> String {
        var base = ""
        var dashed = false
        for scalar in name.lowercased().decomposedStringWithCompatibilityMapping.unicodeScalars {
            if ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) {
                base.unicodeScalars.append(scalar)
                dashed = false
            } else if !dashed {
                base += "-"
                dashed = true
            }
        }
        while base.hasPrefix("-") { base.removeFirst() }
        while base.hasSuffix("-") { base.removeLast() }
        base = String(base.prefix(64))
        let padded = base.count >= 3 ? base : base + (base.isEmpty ? "" : "-") + "notes"
        return reservedSlugs.contains(padded) ? padded + "-notes" : padded
    }
}

private enum MarkdownExtension {
    static let pattern = try! NSRegularExpression(pattern: "\\.(md|markdown|mdown|mkd)\\z", options: .caseInsensitive)

    static func strip(_ path: String) -> String {
        pattern.stringByReplacingMatches(in: path, range: NSRange(location: 0, length: (path as NSString).length), withTemplate: "")
    }
}

/* ---------- Asking the engine ---------- */

extension Workspace {
    /// Publish a note, a page or a folder (`""` is the whole workspace).
    /// `slug` nil keeps its address, or picks a random one for a new page;
    /// a page already public at another address moves to this one. Works
    /// offline: the engine sends it with the next sync. Answers the address's
    /// slug.
    @discardableResult
    public func publish(_ path: String, slug: String?, title: String? = nil, desc: String? = nil) async throws -> String {
        try await Engine.shared.call(
            "cloud_publish",
            ["path": .string(files.absolute(path)), "slug": .optional(slug), "title": .optional(title), "desc": .optional(desc)]
        )
    }

    /// Stop a page: its address stops working.
    public func unpublish(_ slug: String) async throws {
        try await Engine.shared.run("cloud_unpublish", ["root": .string(root), "slug": .string(slug)])
    }

    /// Make a page the one the domain's own address shows, or with nil have none.
    public func useAsHomePage(_ slug: String?) async throws {
        try await Engine.shared.run("cloud_set_root", ["root": .string(root), "slug": .optional(slug)])
    }

    /// Whether this device's person may publish here: anyone who may work.
    public var mayPublish: Bool { may("work") }

    /// Whether a file changed on this iPhone since the last sync — so its
    /// page has yet to catch up.
    public func changedSinceSync(_ path: String) -> Bool {
        guard let modified = (try? FileManager.default.attributesOfItem(atPath: files.absolute(path)))?[.modificationDate] as? Date
        else { return false }
        return Int(modified.timeIntervalSince1970 * 1000) > (status?.lastSyncMs ?? 0)
    }

    /// How many notes a folder page would show: every note under the folder.
    public func notes(under dir: String) -> Int {
        var count = 0
        let walker = FileManager.default.enumerator(at: files.url(dir), includingPropertiesForKeys: [.isRegularFileKey])
        while let item = walker?.nextObject() as? URL {
            if isHiddenOrIgnored(item.lastPathComponent) {
                walker?.skipDescendants()
                continue
            }
            if FileKind.of(item.lastPathComponent) == .markdown { count += 1 }
        }
        return count
    }
}

/// Every page on the domain, for whoever may see them all: an owner sees
/// what was published from sections they are not in, and can take it down.
@MainActor
@Observable
public final class EveryPageModel {
    public let workspace: Workspace
    /// The pages from sections this person is not in.
    public private(set) var elsewhere: [EveryPage] = []
    public private(set) var truncated = false
    /// Why the domain could not be asked, in its words.
    public private(set) var problem: String?

    public init(workspace: Workspace) {
        self.workspace = workspace
    }

    /// Whether this person may see every page: known to, not merely not
    /// yet known not to — the domain refuses anyone else.
    public var seesAll: Bool { workspace.status?.can.contains("pages.manage") == true }

    public func load() async {
        guard seesAll else { return }
        do {
            let every: EveryPages = try await Engine.shared.call("cloud_pages", ["root": .string(workspace.root)])
            let mine = Set(workspace.status?.public.map(\.slug) ?? [])
            elsewhere = every.pages.filter { !$0.shared && !mine.contains($0.slug) }
            truncated = every.truncated
            problem = nil
        } catch {
            problem = (error as? DoklinError)?.message ?? error.localizedDescription
        }
    }

    /// Take a page down from the domain, wherever it was published from.
    public func takeDown(_ slug: String) async throws {
        try await Engine.shared.run("cloud_page_take_down", ["root": .string(workspace.root), "slug": .string(slug)])
        await load()
    }

    public func url(of page: EveryPage) -> String {
        "\(workspace.status?.endpoint ?? "")/\(page.slug)"
    }
}
