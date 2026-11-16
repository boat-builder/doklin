// Searching one workspace on this iPhone's copy: what it finds is what the
// Mac's `search_workspace` and the worker's search find (`WorkspaceFiles
// .search`) — documents by their names, and notes by their words. Here it
// is put in two groups, narrowed to notes, pages or one folder, and the
// last few searches are kept on the device.

import Foundation
import Observation

/// Where a search looks.
public enum SearchScope: Hashable, Sendable {
    case all
    case notes
    case pages
    /// One folder and what is under it, workspace-relative.
    case folder(String)

    public var label: String {
        switch self {
        case .all: return "All"
        case .notes: return "Notes"
        case .pages: return "Pages"
        case .folder(let path): return DocLinks.name(of: path)
        }
    }

    public func keeps(_ result: SearchResult) -> Bool {
        switch self {
        case .all: return true
        case .notes: return FileKind.of(result.path) == .markdown
        case .pages: return FileKind.of(result.path) == .html
        case .folder(let folder): return Sections.holds(folder, result.path)
        }
    }
}

/// One line a search found, cut to show the words around what was found.
public struct SearchSnippet: Equatable, Sendable {
    public let before: String
    public let match: String
    public let after: String

    /// `line` around the first place `query` is in it, at most about
    /// `width` characters, with an ellipsis where it was cut.
    public static func around(_ query: String, in line: String, width: Int = 90) -> SearchSnippet {
        let text = CriticMarkup.stripComments(line)
        guard let found = text.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) else {
            return SearchSnippet(before: String(text.prefix(width)), match: "", after: "")
        }
        let lead = max(0, (width - text.distance(from: found.lowerBound, to: found.upperBound)) / 3)
        var start = found.lowerBound
        var taken = 0
        while start > text.startIndex, taken < lead {
            start = text.index(before: start)
            taken += 1
        }
        // Start at a word, not inside one.
        if start > text.startIndex, let space = text[start..<found.lowerBound].firstIndex(of: " ") {
            start = text.index(after: space)
        }
        let rest = width - text.distance(from: start, to: found.upperBound)
        let end = text.index(found.upperBound, offsetBy: max(0, rest), limitedBy: text.endIndex) ?? text.endIndex
        return SearchSnippet(
            before: (start > text.startIndex ? "…" : "") + String(text[start..<found.lowerBound]),
            match: String(text[found]),
            after: String(text[found.upperBound..<end]) + (end < text.endIndex ? "…" : "")
        )
    }
}

/// A search of one workspace, on this iPhone's copy.
@MainActor
@Observable
public final class SearchModel {
    public let workspace: Workspace
    /// Everything found for the last query, before the scope narrows it.
    public private(set) var results: [SearchResult] = []
    public private(set) var phase: LoadPhase = .idle
    /// What was last searched for.
    public private(set) var query = ""
    public var scope: SearchScope = .all
    @ObservationIgnored private var asked = 0

    public init(workspace: Workspace) {
        self.workspace = workspace
    }

    private var shown: [SearchResult] { results.filter(scope.keeps) }

    /// Documents called something with the words in it: first.
    public var named: [SearchResult] {
        let wanted = query.lowercased()
        return shown.filter { $0.name.lowercased().contains(wanted) }
    }

    /// Notes with the words in their text, and not in their name.
    public var inText: [SearchResult] {
        let wanted = query.lowercased()
        return shown.filter { !$0.name.lowercased().contains(wanted) }
    }

    public var isEmpty: Bool { shown.isEmpty }

    /// Search for `text`; an empty one clears what was found.
    public func run(_ text: String) async {
        asked += 1
        let ticket = asked
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            results = []
            self.query = ""
            phase = .idle
            return
        }
        phase = .loading
        let files = workspace.files
        let found = await Task.detached(priority: .userInitiated) { files.search(query) }.value
        guard ticket == asked else { return }
        self.query = query
        results = found
        phase = .loaded
    }
}

/// The last few searches of a workspace, kept on this device.
public struct RecentSearches: Sendable {
    public static let kept = 8
    private let key: String
    private nonisolated(unsafe) let defaults: UserDefaults

    public init(wsId: String, defaults: UserDefaults = .standard) {
        key = "recent-searches-\(wsId)"
        self.defaults = defaults
    }

    public var all: [String] { defaults.stringArray(forKey: key) ?? [] }

    /// `query` was searched for: it goes to the top.
    public func add(_ query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var list = all.filter { $0.lowercased() != trimmed.lowercased() }
        list.insert(trimmed, at: 0)
        defaults.set(Array(list.prefix(Self.kept)), forKey: key)
    }

    public func clear() {
        defaults.removeObject(forKey: key)
    }
}
