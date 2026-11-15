// A comment in a note is a thread: the words it is on, wrapped in
// CriticMarkup, and a flat list of entries (the opening comment and its
// replies). On disk the words carry a bare marker — `{==words==}{>>#id<<}` —
// and the entries live in the note's `.meta.jsonl` (MetaFile.swift); the
// inline form, with every entry in the markdown, is what the Mac's editor
// speaks and what older notes still hold:
//
//   {==words==}{>>#c7k2x9 Sherin's Mac · 2026-07-14T09:12:33Z: This reads odd<<}{>>Aisha · 2026-07-14T10:01:05Z: agree<<}
//
// A port of src/criticMarkup.ts, rule for rule — change both. The shared
// cases in verify-harness/comments-fixture.json hold the two to the same
// bytes.

import Foundation

/// One entry of a thread. `author` "" and `at` 0 mean not known: a
/// hand-written comment, or one from before entries were signed.
public struct CommentEntry: Equatable, Sendable {
    public var author: String
    /// Milliseconds since 1970.
    public var at: Double
    public var body: String
    /// What older sidecars stamped an entry with. Nothing writes these any
    /// more; they are kept so such a thread still reads and writes back
    /// byte for byte.
    var eid: JSValue?
    var codeId: JSValue?
    var label: JSValue?

    public init(author: String, at: Double, body: String) {
        self.author = author
        self.at = at
        self.body = body
    }

    /// Who wrote it, in words: an unsigned entry is nobody's.
    public var authorWords: String { author.isEmpty ? "Unknown" : author }
}

/// What a marker's run of `{>>…<<}` spans means: a whole thread, or a
/// reference to a thread whose entries are elsewhere — further up the note,
/// or in its meta file.
public enum ParsedSpans: Equatable, Sendable {
    case thread(id: String?, comments: [CommentEntry])
    case ref(id: String)

    public var id: String? {
        switch self {
        case .thread(let id, _): return id
        case .ref(let id): return id
        }
    }
}

public enum CriticMarkup {
    /// One `{==words==}` followed straight away by one or more `{>>…<<}`.
    /// The words are never empty.
    static let blockPattern = try! NSRegularExpression(pattern: "\\{==([\\s\\S]+?)==\\}((?:\\{>>[\\s\\S]*?<<\\})+)")
    private static let spanPattern = try! NSRegularExpression(pattern: "\\{>>([\\s\\S]*?)<<\\}")
    /// `#id` alone, or `#id` and the first entry. `\z`: JavaScript's `$`
    /// without the m flag, which is not ICU's `$`.
    private static let idPattern = try! NSRegularExpression(pattern: "^#([a-z0-9]{4,16})(?:[ \\t\\n]+([\\s\\S]+))?\\z")

    /// A marker in a text, by UTF-16 offsets.
    struct Block {
        let range: NSRange
        let anchor: String
        let spans: String
    }

    static func blocks(in text: String) -> [Block] {
        let ns = text as NSString
        return blockPattern.matches(in: text, range: NSRange(location: 0, length: ns.length)).map {
            Block(range: $0.range, anchor: ns.substring(with: $0.range(at: 1)), spans: ns.substring(with: $0.range(at: 2)))
        }
    }

    /// `text` with every marker put through `change`, which answers what
    /// goes in its place — `String.replace` with a function.
    static func replacingBlocks(in text: String, _ change: (Block) -> String) -> String {
        let ns = text as NSString
        var out = ""
        var at = 0
        for block in blocks(in: text) {
            out += ns.substring(with: NSRange(location: at, length: block.range.location - at))
            out += change(block)
            at = block.range.location + block.range.length
        }
        return out + ns.substring(from: at)
    }

    /// The text of every `{>>…<<}` in a marker's spans.
    static func spans(_ raw: String) -> [String] {
        let ns = raw as NSString
        return spanPattern.matches(in: raw, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) }
    }

    public static func parseSpans(_ raw: String) -> ParsedSpans {
        let all = spans(raw)
        guard let first = all.first else { return .thread(id: nil, comments: []) }
        let ns = first as NSString
        if let match = idPattern.firstMatch(in: first, range: NSRange(location: 0, length: ns.length)) {
            let id = ns.substring(with: match.range(at: 1))
            let rest = match.range(at: 2).location == NSNotFound ? nil : ns.substring(with: match.range(at: 2))
            if rest == nil, all.count == 1 { return .ref(id: id) }
            let entries = (rest.map { [$0] } ?? []) + all.dropFirst()
            return .thread(id: id, comments: entries.map(parseEntry))
        }
        return .thread(id: nil, comments: all.map(parseEntry))
    }

    /// The id a marker's first span names, or nil for one that names none.
    public static func threadID(ofSpan span: String) -> String? {
        parseSpans("{>>\(span)<<}").id
    }

    /// `author · ISO time: body`, or the whole span as an unsigned body.
    static func parseEntry(_ raw: String) -> CommentEntry {
        guard let (author, time, body) = splitEntry(Array(raw.utf16)) else {
            return CommentEntry(author: "", at: 0, body: JSText.trim(raw))
        }
        return CommentEntry(author: author, at: ISOTime.parse(time) ?? 0, body: body)
    }

    /// The entry pattern, `/^([\s\S]{0,200}?) · (ISO): ([\s\S]*)$/`, by hand:
    /// JavaScript counts the author's 200 in UTF-16 code units. The author
    /// is the shortest that leaves a time after it, so a name holding " · "
    /// still reads.
    private static func splitEntry(_ units: [UInt16]) -> (String, [UInt16], String)? {
        let dot: [UInt16] = [0x20, 0xB7, 0x20]
        var k = 0
        while k <= 200, k + 3 <= units.count {
            if Array(units[k..<(k + 3)]) == dot, let end = ISOTime.scan(units, from: k + 3),
               end + 2 <= units.count, units[end] == 0x3A, units[end + 1] == 0x20
            {
                return (
                    String(decoding: units[0..<k], as: UTF16.self),
                    Array(units[(k + 3)..<end]),
                    String(decoding: units[(end + 2)...], as: UTF16.self)
                )
            }
            k += 1
        }
        return nil
    }

    /* ---------- Writing ---------- */

    private static let lineBreaks = try! NSRegularExpression(pattern: "[\(JSText.spaceClass)]*\\n[\(JSText.spaceClass)\\n]*")
    private static let spaceRuns = try! NSRegularExpression(pattern: "[\(JSText.spaceClass)]+")

    private static func replace(_ pattern: NSRegularExpression, in text: String, with template: String) -> String {
        pattern.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: (text as NSString).length), withTemplate: template)
    }

    /// What an entry's body may hold: it sits inside `{>>…<<}` in a
    /// paragraph, so no blank line and no closing delimiter.
    public static func sanitizeBody(_ body: String) -> String {
        JSText.trim(JSText.replacingAll("<<}", with: "<< }", in: replace(lineBreaks, in: body, with: " ")))
    }

    public static func sanitizeAuthor(_ author: String) -> String {
        let clean = JSText.trim(JSText.replacingAll("<<}", with: "<< }", in: replace(spaceRuns, in: author, with: " ")))
        let units = Array(clean.utf16)
        return units.count <= 80 ? clean : String(decoding: units[0..<80], as: UTF16.self)
    }

    static func formatEntry(_ entry: CommentEntry) -> String {
        let known = !(entry.at == 0 || entry.at.isNaN)
        if entry.author.isEmpty, !known { return entry.body }
        return "\(entry.author) · \(ISOTime.format(known ? entry.at : 0)): \(entry.body)"
    }

    /// A thread written whole on one run of its words: `{>>#id entry<<}{>>entry<<}…`.
    public static func formatThreadSpans(id: String, comments: [CommentEntry]) -> String {
        if comments.isEmpty { return "{>>#\(id)<<}" }
        return comments.enumerated().map { index, entry in
            index == 0 ? "{>>#\(id) \(formatEntry(entry))<<}" : "{>>\(formatEntry(entry))<<}"
        }.joined()
    }

    private static let anySpan = try! NSRegularExpression(pattern: "\\{>>[\\s\\S]*?<<\\}")
    private static let anyWords = try! NSRegularExpression(pattern: "\\{==([\\s\\S]*?)==\\}")

    /// A note without its comments: every `{>>…<<}` gone, every `{==…==}`
    /// its words. What a copy, a share or a public page holds.
    public static func stripComments(_ md: String) -> String {
        replace(anyWords, in: replace(anySpan, in: md, with: ""), with: "$1")
    }

    /// A new thread's id: six base-36 characters.
    public static func newThreadId<R: RandomNumberGenerator>(using random: inout R) -> String {
        let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        return String((0..<6).map { _ in alphabet[Int.random(in: 0..<36, using: &random)] })
    }
}

/// The times an entry is stamped with, as `Date.parse` reads them and
/// `toISOString` writes them, to the second.
enum ISOTime {
    /// Where `YYYY-MM-DDTHH:mm[:ss[.s{1,3}]]Z` starting at `from` ends, or nil.
    static func scan(_ u: [UInt16], from: Int) -> Int? {
        func digits(_ at: Int, _ n: Int) -> Bool {
            at + n <= u.count && u[at..<(at + n)].allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
        }
        func char(_ at: Int, _ c: UInt16) -> Bool { at < u.count && u[at] == c }
        var i = from
        guard digits(i, 4), char(i + 4, 0x2D), digits(i + 5, 2), char(i + 7, 0x2D), digits(i + 8, 2),
              char(i + 10, 0x54), digits(i + 11, 2), char(i + 13, 0x3A), digits(i + 14, 2)
        else { return nil }
        i += 16
        if char(i, 0x3A), digits(i + 1, 2) {
            i += 3
            if char(i, 0x2E), digits(i + 1, 1) {
                var n = 1
                while n < 3, digits(i + 1 + n, 1) { n += 1 }
                i += 1 + n
            }
        }
        return char(i, 0x5A) ? i + 1 : nil
    }

    /// `Date.parse` of a time `scan` found, as V8 reads it: a day past the
    /// month's end rolls over, 24:00 is the next midnight, anything else out
    /// of range is no time at all.
    static func parse(_ u: [UInt16]) -> Double? {
        func number(_ from: Int, _ count: Int) -> Int { Int(String(decoding: u[from..<(from + count)], as: UTF16.self)) ?? 0 }
        guard u.count >= 17 else { return nil }
        let year = number(0, 4), month = number(5, 2), day = number(8, 2), hour = number(11, 2), minute = number(14, 2)
        var second = 0
        var milli = 0
        if u.count > 17, u[16] == 0x3A {
            second = number(17, 2)
            if u.count > 20, u[19] == 0x2E {
                let fraction = String(decoding: u[20..<(u.count - 1)], as: UTF16.self)
                milli = Int(fraction.padding(toLength: 3, withPad: "0", startingAt: 0)) ?? 0
            }
        }
        guard (1...12).contains(month), (1...31).contains(day), (0...24).contains(hour), (0...59).contains(minute), (0...59).contains(second)
        else { return nil }
        if hour == 24, minute != 0 || second != 0 || milli != 0 { return nil }
        let days = daysFromCivil(year: year, month: month, day: 1) + Int64(day - 1)
        let seconds = days * 86_400 + Int64(hour * 3600 + minute * 60 + second)
        return Double(seconds * 1000 + Int64(milli))
    }

    /// `new Date(ms).toISOString()` without its milliseconds.
    static func format(_ ms: Double) -> String {
        // Past ±8.64e15 a JavaScript Date is no date at all; never trap here.
        let whole = Int64(min(max(ms, -8.64e15), 8.64e15).rounded(.towardZero))
        var days = whole / 86_400_000
        var rest = whole % 86_400_000
        if rest < 0 {
            rest += 86_400_000
            days -= 1
        }
        let (year, month, day) = civilFromDays(days)
        let seconds = rest / 1000
        func two(_ n: Int64) -> String { n < 10 ? "0\(n)" : "\(n)" }
        let yearText: String
        if (0...9999).contains(year) {
            let digits = String(year)
            yearText = String(repeating: "0", count: 4 - digits.count) + digits
        } else {
            let digits = String(abs(year))
            yearText = (year < 0 ? "-" : "+") + String(repeating: "0", count: max(0, 6 - digits.count)) + digits
        }
        return "\(yearText)-\(two(Int64(month)))-\(two(Int64(day)))T\(two(seconds / 3600)):\(two(seconds / 60 % 60)):\(two(seconds % 60))Z"
    }

    /// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
    static func daysFromCivil(year: Int, month: Int, day: Int) -> Int64 {
        let y = Int64(month <= 2 ? year - 1 : year)
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let m = Int64(month)
        let doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + Int64(day) - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    static func civilFromDays(_ days: Int64) -> (Int64, Int, Int) {
        let z = days + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let day = Int(doy - (153 * mp + 2) / 5 + 1)
        let month = Int(mp < 10 ? mp + 3 : mp - 9)
        return (yoe + era * 400 + (month <= 2 ? 1 : 0), month, day)
    }
}
