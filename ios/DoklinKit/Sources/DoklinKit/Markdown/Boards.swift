// Boards: a folder shown as columns, by one of the tag list's tags — the
// Mac's rules (src/boards.ts) and its order keys (src/rank.ts), ported.
//
// A file in the folder, `boards.json`, says how: by which tag, and in what
// order the cards sit. Each of the tag's values is a column, and every
// document directly in the folder is a card in the column of its value.
// Moving a card to another column sets the note's tag (Tags.swift); moving
// it up or down changes only `boards.json`.
//
//   {
//     "doklin": "boards",
//     "v": 1,
//     "tag": "Status",
//     "cards": {
//       "Fix the login.md": { "rank": "a0" },
//       "Write the docs.md": { "rank": "a0V" }
//     }
//   }
//
// Cards are keyed by file name, extension included; names and the tag match
// whatever their case. A card with no entry has no rank. Keys this app
// doesn't know are kept, at the top and in a card. A file without the
// header, with a `v` this app doesn't know, or that isn't JSON makes no
// board, and the app never rewrites it. The bytes are canonical
// (`serialize`): the same board is always the same file, so what this
// iPhone writes and what a Mac writes agree. Sync merges the file by its
// records (engine/src/boards.rs); nothing here merges.
//
// Held to verify-harness/boards-fixture.json with src/boards.ts, src/rank.ts
// and the engine's merge: change all three. JSON is read and written as
// JavaScript reads and writes it (`JSValue`, Comments/JSText.swift).

import Foundation

/// A card's record: its rank, and the keys a newer app wrote.
public struct BoardCard: Equatable, Sendable {
    public var rank: String?
    var extra: [JSString: JSValue]

    init(rank: String?, extra: [JSString: JSValue] = [:]) {
        self.rank = rank
        self.extra = extra
    }

    var hasRecord: Bool { rank != nil || !extra.isEmpty }
}

/// What `boards.json` holds, read.
public struct Board: Equatable, Sendable {
    /// The tag it is grouped by, as the list spelled it when it was picked.
    public var tag: String
    /// By file name, whatever its case.
    public var cards: [String: BoardCard]
    var extra: [JSString: JSValue]

    /// A board with no cards yet, grouped by `tag`.
    public init(tag: String) {
        self.tag = tag
        cards = [:]
        extra = [:]
    }
}

/// A note as a board sees it: its file name and its value for the board's
/// tag (nil: none, or an html-only document, which has no tags).
public struct BoardNote: Equatable, Sendable {
    public let name: String
    public let value: String?

    public init(name: String, value: String?) {
        self.name = name
        self.value = value
    }
}

/// A column: the value it is for (nil: the notes with none), whether that
/// value is one of the tag's, and its cards in order.
public struct BoardColumn: Equatable, Identifiable, Sendable {
    public let value: String?
    public let known: Bool
    public let cards: [String]

    /// "" for the notes with no value, else `=` and the value, whatever its case.
    public var id: String { value.map { "=" + $0.lowercased() } ?? "" }
}

public enum Boards {
    /// The file a board folder holds, found whatever its case.
    public static let file = "boards.json"
    /// The one version this app reads and writes.
    static let version = 1.0

    /// What reading a `boards.json` gives.
    public enum Read: Equatable, Sendable {
        case board(Board)
        /// Made by a newer app: shown as a folder, and never rewritten.
        case newer
        /// Not JSON, or not Doklin's: shown as a folder, and never rewritten.
        case unreadable
    }

    /// Whether `path` names a folder's `boards.json`.
    public static func isFile(_ path: String) -> Bool { DocLinks.name(of: path).lowercased() == file }

    /* ---------- Order ---------- */

    /// Code units in code-point order (`compareText`): the unit of a
    /// character past U+FFFF sorts after U+E000–U+FFFF.
    static func compare(_ a: [UInt16], _ b: [UInt16]) -> Int {
        func unit(_ c: UInt16) -> Int {
            let c = Int(c)
            return c >= 0xD800 && c <= 0xDFFF ? c + 0x2000 : c >= 0xE000 ? c - 0x800 : c
        }
        for (x, y) in zip(a, b) where x != y { return unit(x) - unit(y) }
        return a.count - b.count
    }

    static func compare(_ a: String, _ b: String) -> Int { compare(Array(a.utf16), Array(b.utf16)) }

    /// File names in a board's order: whatever their case, then exactly.
    static func compareNames(_ a: String, _ b: String) -> Int {
        let folded = compare(a.lowercased(), b.lowercased())
        return folded != 0 ? folded : compare(a, b)
    }

    private static func before(_ a: String, _ b: String) -> Bool { compare(a, b) < 0 }
    private static func beforeByName(_ a: String, _ b: String) -> Bool { compareNames(a, b) < 0 }

    /* ---------- The file ---------- */

    /// Read a `boards.json`. Lenient inside a readable file: a `tag` that
    /// isn't text reads as none, a card that isn't a record is skipped, a
    /// rank that isn't text reads as none, and of two keys for one card in
    /// different cases the first in code-point order is kept.
    public static func parse(_ text: String) -> Read {
        guard let value = JSValue.parse(text), case .object(let fields) = value,
              value["doklin"] == .string("boards"), let v = value["v"]?.number
        else { return .unreadable }
        guard v == version else { return v.isFinite && v == v.rounded(.towardZero) && v > version ? .newer : .unreadable }
        var board = Board(tag: value["tag"]?.string?.string ?? "")
        let known: Set<JSString> = ["doklin", "v", "tag", "cards"]
        for (key, item) in fields where !known.contains(key) { board.extra[key] = item }
        if case .object(let records)? = value["cards"] {
            var seen = Set<String>()
            for (key, record) in records.sorted(by: { compare($0.0.units, $1.0.units) < 0 }) {
                let name = key.string
                guard !name.isEmpty, case .object(let parts) = record, seen.insert(name.lowercased()).inserted else { continue }
                var card = BoardCard(rank: record["rank"]?.string?.string)
                for (part, item) in parts where part != "rank" { card.extra[part] = item }
                board.cards[name] = card
            }
        }
        return .board(board)
    }

    /// A value as one line of canonical JSON: an object's keys in
    /// code-point order, nothing between tokens.
    static func canonical(_ value: JSValue) -> String {
        switch value {
        case .array(let items):
            return "[" + items.map(canonical).joined(separator: ",") + "]"
        case .object(let fields):
            let sorted = fields.sorted { compare($0.0.units, $1.0.units) < 0 }
            return "{" + sorted.map { JSValue.quote($0.0) + ":" + canonical($0.1) }.joined(separator: ",") + "}"
        default:
            return value.json
        }
    }

    private static func quote(_ text: String) -> String { JSValue.quote(JSString(text)) }

    private static func sortedKeys(_ extra: [JSString: JSValue]) -> [JSString] {
        extra.keys.sorted { compare($0.units, $1.units) < 0 }
    }

    /// A card's record as its line holds it: `rank`, then the other keys in
    /// code-point order.
    private static func cardJSON(_ card: BoardCard) -> String {
        var parts: [String] = []
        if let rank = card.rank { parts.append("\"rank\": " + quote(rank)) }
        for key in sortedKeys(card.extra) { parts.append(JSValue.quote(key) + ": " + canonical(card.extra[key]!)) }
        return "{ " + parts.joined(separator: ", ") + " }"
    }

    /// The file's bytes: the header, `tag`, `cards` (one per line, in
    /// code-point order of their names), then the keys a newer app wrote,
    /// in code-point order; two-space indent and a final newline. A card
    /// with nothing in its record is left out.
    public static func serialize(_ board: Board) -> String {
        var lines = ["  \"doklin\": \"boards\"", "  \"v\": 1", "  \"tag\": " + quote(board.tag)]
        let names = board.cards.filter { $0.value.hasRecord }.keys.sorted(by: before)
        lines.append(
            names.isEmpty
                ? "  \"cards\": {}"
                : "  \"cards\": {\n" + names.map { "    " + quote($0) + ": " + cardJSON(board.cards[$0]!) }.joined(separator: ",\n") + "\n  }"
        )
        for key in sortedKeys(board.extra) { lines.append("  " + JSValue.quote(key) + ": " + canonical(board.extra[key]!)) }
        return "{\n" + lines.joined(separator: ",\n") + "\n}\n"
    }

    /* ---------- Cards ---------- */

    /// The key `name`'s card has on `board`, whatever its case.
    static func cardKey(_ board: Board, _ name: String) -> String? {
        if board.cards[name] != nil { return name }
        let lower = name.lowercased()
        return board.cards.keys.first { $0.lowercased() == lower }
    }

    /// `name`'s rank on `board`, when it has one that is a rank.
    public static func rank(of name: String, on board: Board) -> String? {
        guard let key = cardKey(board, name), let rank = board.cards[key]?.rank, Rank.isRank(rank) else { return nil }
        return rank
    }

    /// `names` in the order a column shows them: ranked cards by rank (two
    /// with one rank by name), then cards with no rank by name.
    public static func order(_ names: [String], on board: Board) -> [String] {
        let ranks = Dictionary(names.map { ($0, rank(of: $0, on: board)) }, uniquingKeysWith: { first, _ in first })
        let ranked = names.filter { ranks[$0]! != nil }.sorted { a, b in
            let byRank = compare(ranks[a]!!, ranks[b]!!)
            return byRank != 0 ? byRank < 0 : beforeByName(a, b)
        }
        return ranked + names.filter { ranks[$0]! == nil }.sorted(by: beforeByName)
    }

    /// The board's columns: the notes with no value for the tag, then one
    /// per value of `def` in the list's order, then one per value a note has
    /// that the list lacks (marked, never dropped), in code-point order
    /// whatever their case. Values match whatever their case; a listed one
    /// shows as the list spells it, an unlisted one as the first card in
    /// name order spells it.
    public static func columns(_ board: Board, def: TagDef, notes: [BoardNote]) -> [BoardColumn] {
        var none: [String] = []
        var listed = def.values.map { (value: $0, names: [String]()) }
        var others: [String: (value: String, names: [String])] = [:]
        for note in notes.sorted(by: { beforeByName($0.name, $1.name) }) {
            guard let value = note.value, !value.isEmpty else {
                none.append(note.name)
                continue
            }
            let lower = value.lowercased()
            if let at = listed.firstIndex(where: { $0.value.lowercased() == lower }) {
                listed[at].names.append(note.name)
            } else {
                others[lower, default: (value, [])].names.append(note.name)
            }
        }
        return [BoardColumn(value: nil, known: true, cards: order(none, on: board))]
            + listed.map { BoardColumn(value: $0.value, known: true, cards: order($0.names, on: board)) }
            + others.sorted { before($0.key, $1.key) }.map { BoardColumn(value: $0.value.value, known: false, cards: order($0.value.names, on: board)) }
    }

    /// Set `name`'s rank, keyed by `name` as spelled now (a key in another
    /// case goes).
    private static func setRank(_ board: inout Board, _ name: String, _ rank: String) {
        let key = cardKey(board, name)
        let extra = key.flatMap { board.cards[$0]?.extra } ?? [:]
        if let key { board.cards[key] = nil }
        board.cards[name] = BoardCard(rank: rank, extra: extra)
    }

    /// The board once `card` is dropped at `index` in a column that shows
    /// `column` (its cards in order, without `card`). The column's cards
    /// with no rank are ranked first, after its ranked ones and in the order
    /// shown, so what was seen is what stays; then `card` gets a rank
    /// between its new neighbours. "+ New" drops at the column's end.
    public static func drop(_ card: String, at index: Int, in column: [String], on board: Board) -> Board {
        var next = board
        let lower = card.lowercased()
        let others = column.filter { $0.lowercased() != lower }
        let at = max(0, min(index, others.count))
        let unranked = others.filter { rank(of: $0, on: next) == nil }
        if !unranked.isEmpty {
            let last = others.last { rank(of: $0, on: next) != nil }.flatMap { rank(of: $0, on: next) }
            for (name, key) in zip(unranked, Rank.between(last, nil, count: unranked.count)) { setRank(&next, name, key) }
        }
        let after = at < others.count ? rank(of: others[at], on: next) : nil
        let before = at > 0 ? rank(of: others[at - 1], on: next) : nil
        setRank(&next, card, Rank.between(before, after))
        return next
    }

    /// The board once `from` is renamed `to` in the folder: its card keeps
    /// its record.
    public static func rename(_ from: String, to: String, on board: Board) -> Board {
        guard let key = cardKey(board, from) else { return board }
        var next = board
        let card = next.cards.removeValue(forKey: key)
        if let clash = cardKey(next, to) { next.cards[clash] = nil }
        next.cards[to] = card
        return next
    }

    /// The board without the cards whose file isn't in the folder any more:
    /// `names` is every file directly in it. Every write prunes.
    public static func prune(_ board: Board, to names: [String]) -> Board {
        let here = Set(names.map { $0.lowercased() })
        var next = board
        next.cards = next.cards.filter { here.contains($0.key.lowercased()) }
        return next
    }

    /// The board grouped by `tag` instead: ranks stay.
    public static func regroup(_ board: Board, by tag: String) -> Board {
        var next = board
        next.tag = tag
        return next
    }
}

/// Fractional order keys (src/rank.ts): a card's place in its column, as a
/// short string that sorts as text.
///
///   a0  <  a0V  <  a1  <  a2
///
/// Putting a card between two others writes one key and leaves every other
/// card's as it was, so two people's drags merge record by record. The
/// layout is the well-known order key: an integer part whose first
/// character says its own length (`a`–`z` positive, `A`–`Z` negative), then
/// an optional fraction. Keys are ASCII, worked on as bytes.
enum Rank {
    private struct Invalid: Error {}

    private static let digits = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".utf8)
    private static let smallestInt = Array(("A" + String(repeating: "0", count: 26)).utf8)
    /// The first key in an empty column.
    static let first = "a0"

    private static let a = UInt8(ascii: "a"), z = UInt8(ascii: "z"), A = UInt8(ascii: "A"), Z = UInt8(ascii: "Z")
    private static let zero = UInt8(ascii: "0")

    private static func less(_ x: [UInt8], _ y: [UInt8]) -> Bool { x.lexicographicallyPrecedes(y) }
    private static func digit(_ c: UInt8) -> Int { digits.firstIndex(of: c) ?? -1 }

    private static func integerLength(_ head: UInt8?) throws -> Int {
        guard let head else { throw Invalid() }
        if head >= a && head <= z { return Int(head - a) + 2 }
        if head >= A && head <= Z { return Int(Z - head) + 2 }
        throw Invalid()
    }

    private static func integerPart(_ key: [UInt8]) throws -> [UInt8] {
        let length = try integerLength(key.first)
        guard length <= key.count else { throw Invalid() }
        return Array(key[0..<length])
    }

    private static func validateInteger(_ int: [UInt8]) throws {
        guard int.count == (try integerLength(int.first)) else { throw Invalid() }
    }

    private static func validate(_ key: [UInt8]) throws {
        guard key != smallestInt else { throw Invalid() }
        let int = try integerPart(key)
        try validateInteger(int)
        guard key.dropFirst().allSatisfy({ digits.contains($0) }) else { throw Invalid() }
        if key.count > int.count, key.last == zero { throw Invalid() }
    }

    private static func increment(_ x: [UInt8]) throws -> [UInt8]? {
        try validateInteger(x)
        let head = x[0]
        var digs = Array(x.dropFirst())
        var carry = true
        var i = digs.count - 1
        while carry, i >= 0 {
            let d = digit(digs[i]) + 1
            if d == digits.count {
                digs[i] = digits[0]
            } else {
                digs[i] = digits[d]
                carry = false
            }
            i -= 1
        }
        if !carry { return [head] + digs }
        if head == Z { return [a, digits[0]] }
        // The very top: callers fall back to a fraction.
        if head == z { return nil }
        let next = head + 1
        if next > a { digs.append(digits[0]) } else { digs.removeLast() }
        return [next] + digs
    }

    private static func decrement(_ x: [UInt8]) throws -> [UInt8]? {
        try validateInteger(x)
        let head = x[0]
        var digs = Array(x.dropFirst())
        var borrow = true
        var i = digs.count - 1
        while borrow, i >= 0 {
            let d = digit(digs[i]) - 1
            if d == -1 {
                digs[i] = digits[digits.count - 1]
            } else {
                digs[i] = digits[d]
                borrow = false
            }
            i -= 1
        }
        if !borrow { return [head] + digs }
        if head == a { return [Z, digits[digits.count - 1]] }
        // The very bottom.
        if head == A { return nil }
        let prev = head - 1
        if prev < Z { digs.append(digits[digits.count - 1]) } else { digs.removeLast() }
        return [prev] + digs
    }

    /// A fraction strictly between `x` and `y` (nil: no upper bound), never
    /// ending in a zero digit.
    private static func midpoint(_ x: [UInt8], _ y: [UInt8]?) throws -> [UInt8] {
        if let y, !less(x, y) { throw Invalid() }
        if x.last == zero || y?.last == zero { throw Invalid() }
        if let y {
            var n = 0
            while n < y.count, (n < x.count ? x[n] : zero) == y[n] { n += 1 }
            if n > 0 { return Array(y[0..<n]) + (try midpoint(Array(x.dropFirst(n)), Array(y.dropFirst(n)))) }
        }
        let digitX = x.isEmpty ? 0 : digit(x[0])
        let digitY = y.map { $0.isEmpty ? -1 : digit($0[0]) } ?? digits.count
        if digitY - digitX > 1 { return [digits[(digitX + digitY + 1) / 2]] }
        if let y, y.count > 1 { return [y[0]] }
        guard digitX >= 0 else { throw Invalid() }
        return [digits[digitX]] + (try midpoint(Array(x.dropFirst()), nil))
    }

    /// A key strictly between `x` and `y`; nil on either side is that end.
    /// Throws on a malformed key, or `x >= y`.
    private static func key(_ x: [UInt8]?, _ y: [UInt8]?) throws -> [UInt8] {
        if let x { try validate(x) }
        if let y { try validate(y) }
        if let x, let y, !less(x, y) { throw Invalid() }
        guard let x else {
            guard let y else { return Array(first.utf8) }
            let intY = try integerPart(y)
            let fracY = Array(y.dropFirst(intY.count))
            if intY == smallestInt { return intY + (try midpoint([], fracY)) }
            if less(intY, y) { return intY }
            guard let dec = try decrement(intY) else { throw Invalid() }
            return dec
        }
        let intX = try integerPart(x)
        let fracX = Array(x.dropFirst(intX.count))
        guard let y else { return try increment(intX) ?? (intX + (try midpoint(fracX, nil))) }
        let intY = try integerPart(y)
        let fracY = Array(y.dropFirst(intY.count))
        if intX == intY { return intX + (try midpoint(fracX, fracY)) }
        guard let inc = try increment(intX) else { throw Invalid() }
        if less(inc, y) { return inc }
        return intX + (try midpoint(fracX, nil))
    }

    /// The rank to give something dropped between `x` and `y`, whatever the
    /// file holds: a side that isn't a rank counts as an open end, and a
    /// pair out of order drops its upper end.
    static func between(_ x: String?, _ y: String?) -> String {
        let lo = x.map { Array($0.utf8) }.flatMap { (try? validate($0)) != nil ? $0 : nil }
        var hi = y.map { Array($0.utf8) }.flatMap { (try? validate($0)) != nil ? $0 : nil }
        if let lo, let h = hi, !less(lo, h) { hi = nil }
        let made = (try? key(lo, hi)) ?? (try? key(lo, nil))
        return made.map { String(decoding: $0, as: UTF8.self) } ?? first
    }

    /// `count` keys in order, after `x` and before `y`.
    static func between(_ x: String?, _ y: String?, count: Int) -> [String] {
        if count <= 0 { return [] }
        if count == 1 { return [between(x, y)] }
        let mid = between(x, y)
        let half = count >> 1
        return between(x, mid, count: half) + [mid] + between(mid, y, count: count - half - 1)
    }

    /// Whether `key` is a well-formed order key.
    static func isRank(_ key: String?) -> Bool {
        guard let key, !key.isEmpty else { return false }
        return (try? validate(Array(key.utf8))) != nil
    }
}
