// Tags: a note's choice tags, as lines of its frontmatter, and the
// workspace's one list of them, kept in a note of its own — the Mac's rules
// (src/tags.ts), ported.
//
// A note's tag is an unindented `key: value` line in its frontmatter block,
// `status: Doing`. The tag list says which keys are tags and which values
// each takes: `Library/Tags.md`, whose block holds one line per tag,
// `status: [Todo, Doing, Done]`. Its body says what the values mean.
//
// The writers hold a note to the list: the picker is the only way a person
// sets a tag. Readers are lenient: a value that isn't in the list is still
// the note's, shown marked and never dropped. Matching is case-insensitive
// everywhere, and what shows is the list's spelling.
//
// Held to verify-harness/tags-fixture.json with src/tags.ts and the Mac's
// search in Rust (src-tauri/src/tags.rs): change all three. The text is
// worked on as unicode scalars, which is what the TypeScript counts a
// character as where it counts them, and never splits `\r\n`.

import Foundation

/// A tag of the list: its name, and the values a note can have, in order.
public struct TagDef: Equatable, Hashable, Sendable {
    public var name: String
    public var values: [String]

    public init(name: String, values: [String]) {
        self.name = name
        self.values = values
    }
}

/// An unindented `key: …` line of a block. `value` is nil when the line
/// isn't a pair: an empty value, a list or map, a block scalar, or a line
/// an indented run belongs to.
public struct KeyedLine: Equatable, Sendable {
    public let key: String
    public let value: String?
}

/// A note's tag, spelled as the list spells it. `known`: the value is one of
/// the tag's; a value that isn't shows marked.
public struct NoteTag: Equatable, Hashable, Sendable {
    public let name: String
    public let value: String
    public let known: Bool
}

/// A search's tag token: notes whose tag holds `value`, or (nil) that have
/// the tag at all.
public struct TagFilter: Equatable, Hashable, Sendable {
    public let name: String
    public let value: String?

    public init(name: String, value: String?) {
        self.name = name
        self.value = value
    }
}

/// A note's frontmatter: the block at its very top, between two `---`
/// lines (src/frontmatter.ts). A file has one only when its first line is
/// `---` (trailing whitespace tolerated) and a later line is `---`.
public struct Frontmatter: Equatable, Sendable {
    /// The block, both fences and its final newline included — "" for none.
    public let head: String
    /// The lines between the fences, as the file has them.
    public let inner: String
    /// Everything after the block.
    public let body: String

    public static func split(_ text: String) -> Frontmatter {
        let s = Scalars(text)
        let none = Frontmatter(head: "", inner: "", body: text)
        guard let first = s.find("\n"), isFence(s.string(0, first)) else { return none }
        var at = first + 1
        while at <= s.count {
            let end = s.find("\n", from: at)
            let line = s.string(at, end ?? s.count)
            if isFence(line) {
                let close = end.map { $0 + 1 } ?? s.count
                // The lines without the newline before the closing fence.
                var innerEnd = at
                if innerEnd > first + 1, s[innerEnd - 1] == "\n" {
                    innerEnd -= 1
                    if innerEnd > first + 1, s[innerEnd - 1] == "\r" { innerEnd -= 1 }
                }
                return Frontmatter(head: s.string(0, close), inner: s.string(first + 1, innerEnd), body: s.string(close))
            }
            guard let end else { return none }
            at = end + 1
        }
        return none
    }

    private static func isFence(_ line: String) -> Bool {
        var scalars = Array(line.unicodeScalars)
        while let last = scalars.last, last == " " || last == "\t" || last == "\r" { scalars.removeLast() }
        return scalars == ["-", "-", "-"]
    }
}

public enum Tags {
    /// The tag list's file name, in Library. Found whatever its case.
    public static let note = "Tags.md"

    /// What a tag list made by *New tag* says under its block.
    public static let noteBody =
        "The workspace's tags. Each line at the top is a tag and the values a note can have. Say here what each value means, for the people and agents who set them.\n"

    public static let nameMax = 40
    public static let valueMax = 60

    static func same(_ a: String, _ b: String) -> Bool { a.lowercased() == b.lowercased() }

    /* ---------- The block, line by line ---------- */

    private struct Entry {
        let key: String
        let value: String?
        /// What follows the key's colon, trimmed.
        let rest: String
        /// An indented run belongs to the line.
        let run: Bool
        /// Where the line starts, and where its run ends (after its
        /// newline): what a write replaces.
        let from: Int
        let end: Int
    }

    private struct Line {
        let from: Int
        let end: Int
        let text: String
    }

    private struct Block {
        /// Where the lines inside the fences start, and where the closing
        /// fence does.
        let start: Int
        let close: Int
        /// Where the block ends: the body starts here.
        let headEnd: Int
        /// The block's own line ending: its first line's.
        let eol: String
        let entries: [Entry]
        let lines: [Line]
    }

    private static func blockOf(_ s: Scalars) -> Block? {
        let head = Scalars(Frontmatter.split(s.text).head)
        guard head.count > 0, let firstNl = head.find("\n") else { return nil }
        let start = firstNl + 1
        let last = head.last == "\n" ? head.count - 1 : head.count
        let close = (head.findBackward("\n", through: last - 1) ?? -1) + 1
        let eol = firstNl > 0 && head[firstNl - 1] == "\r" ? "\r\n" : "\n"
        var lines: [Line] = []
        var at = start
        while at < close {
            let nl = s.find("\n", from: at) ?? s.count
            let textEnd = nl > at && s[nl - 1] == "\r" ? nl - 1 : nl
            lines.append(Line(from: at, end: nl + 1, text: s.string(at, textEnd)))
            at = nl + 1
        }
        let indented = { (t: String) in t.hasPrefix(" ") || t.hasPrefix("\t") }
        let blank = { (t: String) in jsTrim(t).isEmpty }
        var entries: [Entry] = []
        var i = 0
        while i < lines.count {
            defer { i += 1 }
            guard let keyed = keyedLine(lines[i].text) else { continue }
            // The run that belongs to it: the indented lines after it, with
            // any blank lines between them, up to the last indented one.
            var runEnd = i
            var j = i + 1
            while j < lines.count {
                if indented(lines[j].text) && !blank(lines[j].text) {
                    runEnd = j
                } else if !blank(lines[j].text) {
                    break
                }
                j += 1
            }
            entries.append(Entry(
                key: keyed.key, value: runEnd > i ? nil : keyed.value, rest: keyed.rest, run: runEnd > i,
                from: lines[i].from, end: lines[runEnd].end
            ))
            i = runEnd
        }
        return Block(start: start, close: close, headEnd: head.count, eol: eol, entries: entries, lines: lines)
    }

    /// A line's key and value: the text before the first `:` that a space,
    /// a tab or the line's end follows, and the scalar after it.
    private static func keyedLine(_ line: String) -> (key: String, value: String?, rest: String)? {
        let s = Scalars(line)
        guard let first = s.first, !isSpace(first), first != "#", first != "-" else { return nil }
        var at = 0
        while let colon = s.find(":", from: at) {
            let next = colon + 1 < s.count ? s[colon + 1] : nil
            if next == nil || next == " " || next == "\t" {
                let key = jsTrimEnd(s.string(0, colon))
                guard !key.isEmpty else { return nil }
                let rest = jsTrim(s.string(colon + 1))
                return (key, scalarOf(rest), rest)
            }
            at = colon + 1
        }
        return nil
    }

    /// What may follow a quoted value or a list: nothing, or a comment.
    private static func trailerOk(_ rest: String) -> Bool {
        if jsTrim(rest).isEmpty { return true }
        let s = Scalars(rest)
        var i = 0
        while i < s.count, isSpace(s[i]) { i += 1 }
        return i > 0 && i < s.count && s[i] == "#"
    }

    /// A double-quoted value at the start of `s`, with where it ends. Its
    /// escapes are `\"` and `\\`; any other makes it not a value.
    private static func doubleQuoted(_ s: Scalars, from: Int) -> (value: String, end: Int)? {
        var value = String.UnicodeScalarView()
        var i = from + 1
        while i < s.count {
            let c = s[i]
            if c == "\"" { return (String(value), i + 1) }
            if c == "\\" {
                guard i + 1 < s.count, s[i + 1] == "\"" || s[i + 1] == "\\" else { return nil }
                value.append(s[i + 1])
                i += 2
            } else {
                value.append(c)
                i += 1
            }
        }
        return nil
    }

    /// A single-quoted value at the start of `s`: `''` is a quote.
    private static func singleQuoted(_ s: Scalars, from: Int) -> (value: String, end: Int)? {
        var value = String.UnicodeScalarView()
        var i = from + 1
        while i < s.count {
            if s[i] != "'" {
                value.append(s[i])
                i += 1
            } else if i + 1 < s.count, s[i + 1] == "'" {
                value.append("'")
                i += 2
            } else {
                return (String(value), i + 1)
            }
        }
        return nil
    }

    private static func quoted(_ s: Scalars, from: Int) -> (value: String, end: Int)? {
        s[from] == "\"" ? doubleQuoted(s, from: from) : singleQuoted(s, from: from)
    }

    /// One scalar, or nil: empty, a list or map, a block scalar, or YAML's
    /// anchors, aliases, tags and reserved marks. A bare value ends at a `#`
    /// that a space comes before, as a YAML comment does.
    private static func scalarOf(_ rest: String) -> String? {
        let s = Scalars(rest)
        guard let first = s.first else { return nil }
        if first == "\"" || first == "'" {
            guard let q = quoted(s, from: 0), trailerOk(s.string(q.end)) else { return nil }
            return q.value
        }
        if "[{|>&*!%@`".unicodeScalars.contains(first) { return nil }
        // The comment: from the run of spaces and tabs before the first `#`
        // that one comes before.
        var cut = s.count
        var i = 1
        while i < s.count {
            if s[i] == "#", s[i - 1] == " " || s[i - 1] == "\t" {
                var from = i - 1
                while from > 0, s[from - 1] == " " || s[from - 1] == "\t" { from -= 1 }
                cut = from
                break
            }
            i += 1
        }
        let bare = jsTrimEnd(s.string(0, cut))
        return bare.isEmpty ? nil : bare
    }

    /// The unindented `key: …` lines of a note's block, in order. A note with
    /// no block has none.
    public static func keyedLines(_ text: String) -> [KeyedLine] {
        (blockOf(Scalars(text))?.entries ?? []).map { KeyedLine(key: $0.key, value: $0.value) }
    }

    /* ---------- A note's tags ---------- */

    /// The note's tags, in the list's order. A tag's line is the first line
    /// keyed by its name; one that isn't a pair gives the note no value.
    public static func noteTags(_ text: String, list: [TagDef]) -> [NoteTag] {
        let lines = keyedLines(text)
        return list.compactMap { def in
            guard let line = lines.first(where: { same($0.key, def.name) }), let value = line.value else { return nil }
            let known = def.values.first { same($0, value) }
            return NoteTag(name: def.name, value: known ?? value, known: known != nil)
        }
    }

    /// Whether the block holds anything besides the note's tags: what the
    /// *Frontmatter* disclosure is shown for.
    public static func hasOtherFrontmatter(_ text: String, list: [TagDef]) -> Bool {
        guard let block = blockOf(Scalars(text)) else { return false }
        var tagLines = Set<Int>()
        for def in list {
            if let entry = block.entries.first(where: { same($0.key, def.name) }), entry.value != nil { tagLines.insert(entry.from) }
        }
        return block.lines.contains { !tagLines.contains($0.from) && !jsTrim($0.text).isEmpty }
    }

    /// A value as a line holds it: bare, unless YAML would read it otherwise
    /// (Obsidian and other tools read the same text Doklin does).
    public static func quoteValue(_ value: String) -> String {
        let scalars = Array(value.unicodeScalars)
        let special = ":#,[]{}\"'".unicodeScalars
        let leading = "-?!&*|>%@` ".unicodeScalars
        let words: Set<String> = ["true", "false", "yes", "no", "null", "~"]
        let plain = !scalars.contains { special.contains($0) }
            && !(scalars.first.map { leading.contains($0) } ?? false)
            && !words.contains(value.lowercased())
        if plain { return value }
        return "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// Put `line` where the line keyed `at` is (its indented run with it), or
    /// after the line keyed `after`, or at the end of the block, or in a new
    /// block at the top; nil removes the line, and a block left with no
    /// lines goes, fences and all. Nothing else in the file changes.
    private static func writeLine(_ text: String, at: String, line: String?, after: String? = nil) -> String {
        let s = Scalars(text)
        guard let block = blockOf(s) else {
            guard let line else { return text }
            let firstNl = s.find("\n")
            let eol = firstNl.map { $0 > 0 && s[$0 - 1] == "\r" } == true ? "\r\n" : "\n"
            return "---" + eol + line + eol + "---" + eol + text
        }
        if let found = block.entries.first(where: { same($0.key, at) }) {
            if let line { return s.string(0, found.from) + line + block.eol + s.string(found.end) }
            // The block goes when this was its last line, unless the body
            // would then read as a block of its own (a rule at its top, and
            // another).
            let emptied = found.from == block.start && found.end == block.close
            let body = s.string(block.headEnd)
            if emptied && Frontmatter.split(body).head.isEmpty { return body }
            return s.string(0, found.from) + s.string(found.end)
        }
        guard let line else { return text }
        let anchor = after.flatMap { name in block.entries.first { same($0.key, name) } }
        let place = anchor?.end ?? block.close
        return s.string(0, place) + line + block.eol + s.string(place)
    }

    /// Set a note's tag: the line keyed `at` (the tag's name, or its old name
    /// in a rename) becomes `tag`, spelled as the caller gives it. Nil clears
    /// it. A set followed by a clear gives back the original bytes.
    public static func writeTag(_ text: String, at: String, tag: (name: String, value: String)?) -> String {
        writeLine(text, at: at, line: tag.map { "\($0.name): \(quoteValue($0.value))" })
    }

    /* ---------- The tag list ---------- */

    /// A flow list, `[a, "b, c", 'd']`, and what follows it; nil when it
    /// isn't one.
    private static func flowList(_ rest: String) -> [String]? {
        let s = Scalars(rest)
        guard s.first == "[" else { return nil }
        var out: [String] = []
        var i = 1
        func skip() {
            while i < s.count, s[i] == " " || s[i] == "\t" { i += 1 }
        }
        func closes() -> [String]? { trailerOk(s.string(i + 1)) ? out : nil }
        skip()
        if i < s.count, s[i] == "]" { return closes() }
        while true {
            skip()
            if i < s.count, s[i] == "\"" || s[i] == "'" {
                guard let q = quoted(s, from: i) else { return nil }
                out.append(q.value)
                i = q.end
            } else {
                var j = i
                while j < s.count, s[j] != ",", s[j] != "]" { j += 1 }
                let bare = jsTrim(s.string(i, j))
                guard !bare.isEmpty, !looksLikeYAML(bare) else { return nil }
                out.append(bare)
                i = j
            }
            skip()
            if i < s.count, s[i] == "," {
                i += 1
                skip()
                // A trailing comma is allowed, as YAML allows it.
                if i < s.count, s[i] == "]" { return closes() }
                continue
            }
            if i < s.count, s[i] == "]" { return closes() }
            return nil
        }
    }

    /// A bare value of a flow list that YAML would read as something else.
    private static func looksLikeYAML(_ bare: String) -> Bool {
        let s = Array(bare.unicodeScalars)
        if s.contains(where: { "[{}\"'".unicodeScalars.contains($0) }) { return true }
        if s.indices.contains(where: { $0 + 1 < s.count && isSpace(s[$0]) && s[$0 + 1] == "#" }) { return true }
        return s.first.map { "&*!|>%@`".unicodeScalars.contains($0) } ?? false
    }

    /// The workspace's tags from its list's text, in order. A line that
    /// doesn't parse is skipped (it stays on disk), and so is a second line
    /// for a name already listed. No note, or no lines: no tags.
    public static func parseList(_ text: String) -> [TagDef] {
        var out: [TagDef] = []
        for entry in blockOf(Scalars(text))?.entries ?? [] {
            guard let values = entry.run ? nil : flowList(entry.rest), !values.isEmpty, nameProblem(entry.key, list: out) == nil else { continue }
            if values.indices.contains(where: { valueProblem(values[$0], others: Array(values[..<$0])) != nil }) { continue }
            out.append(TagDef(name: entry.key, values: values))
        }
        return out
    }

    /// Whether the list's block holds lines that aren't tags it lists.
    public static func otherListLines(_ text: String) -> Bool {
        guard let block = blockOf(Scalars(text)) else { return false }
        return block.lines.filter { !jsTrim($0.text).isEmpty }.count > parseList(text).count
    }

    /// A tag's line in the list.
    public static func tagLine(_ def: TagDef) -> String {
        "\(def.name): [\(def.values.map(quoteValue).joined(separator: ", "))]"
    }

    /// Put a tag in the list: the line keyed `at` becomes `def`'s, or `def`
    /// is added (after the line keyed `after`, else at the end); nil removes
    /// the line keyed `at`. A list with no note yet starts as `noteBody`
    /// under its block.
    public static func writeList(_ text: String, at: String, def: TagDef?, after: String? = nil) -> String {
        let base = text.isEmpty && def != nil ? noteBody : text
        return writeLine(base, at: at, line: def.map(tagLine), after: after)
    }

    /* ---------- Names and values ---------- */

    private static func letterOrDigit(_ c: Unicode.Scalar) -> Bool {
        switch c.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber:
            return true
        default:
            return false
        }
    }

    /// Why `name` can't be a tag's name in `list` (a sentence), or nil.
    /// `except` is the tag being renamed, whose own name doesn't count.
    public static func nameProblem(_ name: String, list: [TagDef], except: String? = nil) -> String? {
        let s = Array(name.unicodeScalars)
        if s.isEmpty { return "A tag needs a name." }
        if s.count > nameMax { return "A tag's name can be \(nameMax) characters at most." }
        let shaped = letterOrDigit(s[0]) && s.allSatisfy { letterOrDigit($0) || $0 == " " || $0 == "_" || $0 == "-" } && s.last != " "
        if !shaped {
            return "A tag's name holds letters, digits, spaces, _ and -, and starts and ends with a letter or a digit."
        }
        let renamed = { (def: TagDef) in except.map { same(def.name, $0) } ?? false }
        if let taken = list.first(where: { same($0.name, name) && !renamed($0) }) {
            return "There's already a tag called \(taken.name)."
        }
        return nil
    }

    /// Why `value` can't be a value beside `others` (a sentence), or nil.
    public static func valueProblem(_ value: String, others: [String]) -> String? {
        let s = Array(value.unicodeScalars)
        if s.isEmpty { return "A value can't be empty." }
        if s.count > valueMax { return "A value can be \(valueMax) characters at most." }
        if s.contains(where: { $0.value <= 0x1F || $0.value == 0x7F }) { return "A value is one line of text." }
        if value != jsTrim(value) { return "A value can't start or end with a space." }
        if let twin = others.first(where: { same($0, value) }) { return "\(twin) is there twice." }
        return nil
    }

    /// The first thing wrong with a tag as typed (src/TagDialogs.tsx's
    /// `tagProblem`), or nil.
    public static func tagProblem(name: String, values: [String], list: [TagDef], except: String? = nil) -> String? {
        if let named = nameProblem(name, list: list, except: except) { return named }
        if values.isEmpty { return "A tag needs at least one value." }
        for i in values.indices {
            if let wrong = valueProblem(values[i], others: Array(values[..<i])) { return wrong }
        }
        return nil
    }

    /* ---------- Search ---------- */

    /// A search box's text, split into the words a search looks for and its
    /// tag tokens: `name:value`, either side in double quotes when it holds
    /// a space (`status:"In progress"`). Only a listed tag's name makes a
    /// token; any other `x:y` is text. Values are spelled as the list spells
    /// them. With no token, the text is the query as typed.
    public static func searchQuery(_ q: String, list: [TagDef]) -> (text: String, tags: [TagFilter]) {
        let s = Scalars(q)
        var words: [String] = []
        var i = 0
        while i < s.count {
            if isSpace(s[i]) {
                i += 1
                continue
            }
            var j = i
            while j < s.count, !isSpace(s[j]) {
                if s[j] == "\"" {
                    j = s.find("\"", from: j + 1).map { $0 + 1 } ?? s.count
                } else {
                    j += 1
                }
            }
            words.append(s.string(i, j))
            i = j
        }
        var tags: [TagFilter] = []
        var text: [String] = []
        for word in words {
            guard let found = token(word), let def = list.first(where: { same($0.name, found.name) }) else {
                text.append(word)
                continue
            }
            let value = jsTrim(found.value)
            tags.append(TagFilter(name: def.name, value: def.values.first { same($0, value) } ?? value))
        }
        return tags.isEmpty ? (jsTrim(q), tags) : (text.joined(separator: " "), tags)
    }

    /// A word that is `name:value`, either side in double quotes:
    /// `/^(?:"([^"]+)"|([^\s:"]+)):(?:"([^"]+)"|([^\s"]+))$/`.
    private static func token(_ word: String) -> (name: String, value: String)? {
        let s = Scalars(word)
        var at: Int
        let name: String
        if s.first == "\"" {
            guard let close = s.find("\"", from: 1), close > 1 else { return nil }
            name = s.string(1, close)
            at = close + 1
        } else {
            at = 0
            while at < s.count, !isSpace(s[at]), s[at] != ":", s[at] != "\"" { at += 1 }
            guard at > 0 else { return nil }
            name = s.string(0, at)
        }
        guard at < s.count, s[at] == ":" else { return nil }
        at += 1
        if at < s.count, s[at] == "\"" {
            guard let close = s.find("\"", from: at + 1), close > at + 1, close == s.count - 1 else { return nil }
            return (name, s.string(at + 1, close))
        }
        guard at < s.count, !(at..<s.count).contains(where: { isSpace(s[$0]) || s[$0] == "\"" }) else { return nil }
        return (name, s.string(at))
    }

    /// Whether a note's text has the tags a search asks for.
    public static func matches(_ text: String, _ filters: [TagFilter]) -> Bool {
        if filters.isEmpty { return true }
        let lines = keyedLines(text)
        return filters.allSatisfy { filter in
            guard let line = lines.first(where: { same($0.key, filter.name) }), let value = line.value else { return false }
            return filter.value.map { same(value, $0) } ?? true
        }
    }
}

/* ---------- JavaScript's whitespace, and text as scalars ---------- */

/// What JavaScript's `\s` and `trim` take for a space.
private func isSpace(_ c: Unicode.Scalar) -> Bool {
    c == "\u{FEFF}" || (c.properties.isWhitespace && c != "\u{85}")
}

private func jsTrimEnd(_ s: String) -> String {
    let scalars = Array(s.unicodeScalars)
    var end = scalars.count
    while end > 0, isSpace(scalars[end - 1]) { end -= 1 }
    return end == scalars.count ? s : String(String.UnicodeScalarView(scalars[..<end]))
}

private func jsTrim(_ s: String) -> String {
    let scalars = Array(s.unicodeScalars)
    var start = 0
    var end = scalars.count
    while start < end, isSpace(scalars[start]) { start += 1 }
    while end > start, isSpace(scalars[end - 1]) { end -= 1 }
    return start == 0 && end == scalars.count ? s : String(String.UnicodeScalarView(scalars[start..<end]))
}

/// A text as its unicode scalars, read and cut by offset.
private struct Scalars {
    let text: String
    private let scalars: [Unicode.Scalar]

    init(_ text: String) {
        self.text = text
        scalars = Array(text.unicodeScalars)
    }

    var count: Int { scalars.count }
    var first: Unicode.Scalar? { scalars.first }
    var last: Unicode.Scalar? { scalars.last }
    subscript(_ i: Int) -> Unicode.Scalar { scalars[i] }

    func find(_ c: Unicode.Scalar, from: Int = 0) -> Int? {
        var i = from
        while i < scalars.count {
            if scalars[i] == c { return i }
            i += 1
        }
        return nil
    }

    /// The last `c` at or before `through`.
    func findBackward(_ c: Unicode.Scalar, through: Int) -> Int? {
        var i = min(through, scalars.count - 1)
        while i >= 0 {
            if scalars[i] == c { return i }
            i -= 1
        }
        return nil
    }

    func string(_ from: Int, _ to: Int? = nil) -> String {
        let end = min(to ?? scalars.count, scalars.count)
        guard from < end else { return "" }
        return String(String.UnicodeScalarView(scalars[from..<end]))
    }
}
