// The few changes the phone makes to a note's source without the person
// typing them: ticking a checkbox, and choosing words for a comment to sit on.

import Foundation

/// A note's lines as everything here counts them: `\n` and `\r\n` both end one.
enum MarkdownLines {
    static func split(_ source: String) -> [Substring] {
        source.split(omittingEmptySubsequences: false) { $0 == "\n" || $0 == "\r\n" }
    }
}

public enum MarkdownEditing {
    /// The source with the task on `line` (0-based) ticked or unticked — or
    /// nil when that line holds no checkbox, which means the note changed
    /// under the reader and has to be read again.
    public static func togglingTask(in source: String, line: Int) -> String? {
        let lines = MarkdownLines.split(source)
        guard line >= 0, line < lines.count else { return nil }
        let text = lines[line]
        var i = text.startIndex
        func skipSpace() { while i < text.endIndex, text[i] == " " || text[i] == "\t" { i = text.index(after: i) } }
        // Any quote marks the list sits inside, then the list marker itself.
        skipSpace()
        while i < text.endIndex, text[i] == ">" {
            i = text.index(after: i)
            skipSpace()
        }
        guard i < text.endIndex else { return nil }
        if text[i] == "-" || text[i] == "*" || text[i] == "+" {
            i = text.index(after: i)
        } else if text[i].isASCII, text[i].isNumber {
            while i < text.endIndex, text[i].isASCII, text[i].isNumber { i = text.index(after: i) }
            guard i < text.endIndex, text[i] == "." || text[i] == ")" else { return nil }
            i = text.index(after: i)
        } else {
            return nil
        }
        let afterMarker = i
        skipSpace()
        guard i > afterMarker, text[i...].count >= 3, text[i] == "[" else { return nil }
        let box = text.index(after: i)
        guard text[text.index(after: box)] == "]" else { return nil }
        let ticked: String
        switch text[box] {
        case " ": ticked = "x"
        case "x", "X": ticked = " "
        default: return nil
        }
        // One character changes; every other byte of the note, line endings included, stays.
        var changed = source
        changed.replaceSubrange(box...box, with: ticked)
        return changed
    }

    /// Characters a comment's words may not hold: the worker writes a marker
    /// around them, and a marker cannot cross formatting (agentComments.ts,
    /// `anchorProblem`). Stricter than the worker on purpose — it refuses what
    /// this lets through, never the other way about.
    private static let formatting: Set<Character> = ["*", "`", "[", "]", "<", ">", "|", "\\", "{", "}", "~", "_", "(", ")", "#", "!"]

    /// Words on `line` (0-based) of `source` that a comment can be started
    /// on: plain text that occurs exactly once in the whole note. Nil when
    /// the line offers none — then the person quotes the words themselves.
    public static func commentAnchor(in source: String, line: Int) -> String? {
        let lines = MarkdownLines.split(source)
        guard line >= 0, line < lines.count else { return nil }
        var text = lines[line]
        // Past whatever opens the line: quote marks, a heading's #s, a list marker, a checkbox.
        func dropSpace() { text = text.drop { $0 == " " || $0 == "\t" } }
        dropSpace()
        while text.first == ">" {
            text = text.dropFirst()
            dropSpace()
        }
        if text.first == "#" {
            text = text.drop { $0 == "#" }
        } else if let c = text.first, c == "-" || c == "*" || c == "+", text.dropFirst().first == " " {
            text = text.dropFirst()
        } else if let c = text.first, c.isASCII, c.isNumber {
            let rest = text.drop { $0.isASCII && $0.isNumber }
            if let d = rest.first, d == "." || d == ")" { text = rest.dropFirst() }
        }
        dropSpace()
        if text.hasPrefix("[ ]") || text.hasPrefix("[x]") || text.hasPrefix("[X]") { text = text.dropFirst(3) }
        dropSpace()

        // The plain stretches of what is left, longest first.
        let stretches = text.split(whereSeparator: { formatting.contains($0) })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.contains("://") }
            .sorted { $0.count > $1.count }
        for stretch in stretches {
            let words = stretch.split(separator: " ", omittingEmptySubsequences: true)
            // As few words as are unique, starting from a handful.
            var count = min(words.count, 5)
            while count <= min(words.count, 14) {
                let candidate = words.prefix(count).joined(separator: " ")
                if candidate.count >= 3, occurrences(of: candidate, in: source) == 1 { return candidate }
                if count == words.count { break }
                count += 1
            }
        }
        return nil
    }

    static func occurrences(of needle: String, in haystack: String) -> Int {
        guard !needle.isEmpty else { return 0 }
        var count = 0
        var from = haystack.startIndex
        while let range = haystack.range(of: needle, range: from..<haystack.endIndex) {
            count += 1
            from = range.upperBound
        }
        return count
    }

    /// What a new note starts as: its name as a heading, the way the Mac app
    /// titles one.
    public static func newNote(named name: String) -> String {
        "# \(name)\n\n"
    }
}

/// Where a link written in a note leads — the Mac app's rule (src/docLinks.ts)
/// with a workspace's paths in place of a disk's.
public enum LinkTarget: Equatable, Sendable {
    /// Another document or file of the workspace, by its path.
    case document(String)
    /// A heading of this document.
    case heading(String)
    /// Anything with a scheme: the system opens it.
    case external(String)
    /// A path that leads out of the workspace, or nowhere.
    case nowhere
}

public enum DocLinks {
    /// Fold `.` and `..` out of a path; nil when it climbs out of the workspace.
    static func normalize(_ path: String) -> String? {
        var out: [Substring] = []
        for segment in path.split(separator: "/", omittingEmptySubsequences: true) {
            if segment == "." { continue }
            if segment == ".." {
                guard !out.isEmpty else { return nil }
                out.removeLast()
                continue
            }
            out.append(segment)
        }
        return out.joined(separator: "/")
    }

    /// The folder a path is in; `""` for something at the top.
    public static func directory(of path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return "" }
        return String(path[..<slash])
    }

    /// The last segment of a path.
    public static func name(of path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return path }
        return String(path[path.index(after: slash)...])
    }

    /// Resolve `href`, written in the file at `file` (`Projects/plan.md`).
    public static func target(of href: String, from file: String) -> LinkTarget {
        var raw = href.trimmingCharacters(in: .whitespaces)
        if raw.hasPrefix("#") {
            let fragment = String(raw.dropFirst())
            return .heading(fragment.removingPercentEncoding ?? fragment)
        }
        // A scheme: not a path. (One letter and a colon would be a drive, not a scheme.)
        if let colon = raw.firstIndex(of: ":") {
            let scheme = raw[..<colon]
            if scheme.count > 1, scheme.first?.isLetter == true, scheme.allSatisfy({ $0.isLetter || $0.isNumber || "+.-".contains($0) }) {
                return .external(raw)
            }
        }
        if raw.hasPrefix("//") { return .external("https:\(raw)") }
        raw = String(raw.prefix { $0 != "#" && $0 != "?" })
        guard !raw.isEmpty else { return .nowhere }
        raw = raw.removingPercentEncoding ?? raw
        // A path from the root of a disk is a place on somebody's Mac.
        if raw.hasPrefix("/") { return .nowhere }
        let folder = directory(of: file)
        guard let path = normalize(folder.isEmpty ? raw : "\(folder)/\(raw)"), !path.isEmpty else { return .nowhere }
        return .document(path)
    }

    /// A heading's words as a `#fragment` names them: lowercased, spaces to
    /// dashes, punctuation dropped — GitHub's rule, which the Mac app accepts.
    public static func slug(_ title: String) -> String {
        var out = ""
        for c in title.lowercased() {
            if c.isLetter || c.isNumber || c == "-" || c == "_" { out.append(c) } else if c == " " { out.append("-") }
        }
        return out
    }
}
