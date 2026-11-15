// What the comment files need of JavaScript's own rules, so that this port
// writes the bytes the Mac writes: its strings (UTF-16 code units, half a
// character included), its whitespace, its `trim`, its string order, its
// number-to-text, and `JSON.parse` and `JSON.stringify` as V8 does them —
// object keys in their order, no spaces, `/` and non-ASCII left as they
// are, half a character written as `\udxxx`.

import Foundation

/// Text as JavaScript holds it: UTF-16 code units, any of them. That
/// includes half of a character — what `slice` leaves when it cuts between
/// the two halves, as the Mac does to an anchor's text at 120 units and to
/// an author's name at 80 — which JSON writes as `\udxxx` and reads back
/// whole. A Swift string cannot hold half a character and shows one as
/// U+FFFD, so whatever comes out of a meta file stays a `JSString` until it
/// is shown: written back, it must be the bytes it came as.
public struct JSString: Hashable, Sendable, ExpressibleByStringLiteral, CustomDebugStringConvertible {
    public var units: [UInt16]

    public init(_ text: String) { units = Array(text.utf16) }
    public init(units: [UInt16]) { self.units = units }
    public init<S: Sequence>(units: S) where S.Element == UInt16 { self.units = Array(units) }
    public init(stringLiteral value: String) { self.init(value) }

    /// The text to show, a lone half as U+FFFD. That is one code unit too,
    /// so an offset into this is the same offset into `units` — and no
    /// pattern of the port tells the two apart, as none names a half.
    public var string: String { String(decoding: units, as: UTF16.self) }

    public var isEmpty: Bool { units.isEmpty }
    public var debugDescription: String { string.debugDescription }

    /// The units an `NSRange` of `string` covers.
    subscript(range: NSRange) -> JSString { JSString(units: units[range.location..<(range.location + range.length)]) }

    static func + (a: JSString, b: JSString) -> JSString { JSString(units: a.units + b.units) }
}

enum JSText {
    /// `\s` and what `trim()` removes: the same set in JavaScript.
    static func isSpace(_ unit: UInt16) -> Bool {
        switch unit {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
        case 0x2000...0x200A: return true
        default: return false
        }
    }

    /// `\s` inside a pattern of `NSRegularExpression`, whose own `\s` is a
    /// different set.
    static let spaceClass = "\\t\\n\\x{0B}\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}"

    static func trim(_ text: JSString) -> JSString {
        let units = text.units
        var start = 0
        var end = units.count
        while start < end, isSpace(units[start]) { start += 1 }
        while end > start, isSpace(units[end - 1]) { end -= 1 }
        return start == 0 && end == units.count ? text : JSString(units: units[start..<end])
    }

    static func trim(_ text: String) -> String { trim(JSString(text)).string }

    /// `a < b` on strings.
    static func less(_ a: [UInt16], _ b: [UInt16]) -> Bool {
        a.lexicographicallyPrecedes(b)
    }

    /// A string as JavaScript tells two apart: by its code units. Swift's
    /// `==` takes `é` and `e` + U+0301 for one string; JavaScript does not.
    static func key(_ text: String) -> [UInt16] { Array(text.utf16) }

    /// `text.split("\n")`. Swift's own split reads `\r\n` as one character.
    static func lines(_ text: String) -> [String] {
        var out: [String] = []
        var line: [UInt16] = []
        for unit in text.utf16 {
            if unit == 0x0A {
                out.append(String(decoding: line, as: UTF16.self))
                line = []
            } else {
                line.append(unit)
            }
        }
        out.append(String(decoding: line, as: UTF16.self))
        return out
    }

    /// `text.replace(/target/g, replacement)` for a plain target, unit by unit.
    static func replacingAll(_ target: String, with replacement: String, in text: String) -> String {
        let units = Array(text.utf16)
        let want = Array(target.utf16)
        guard !want.isEmpty, units.count >= want.count else { return text }
        var out: [UInt16] = []
        var i = 0
        while i < units.count {
            if i + want.count <= units.count, Array(units[i..<(i + want.count)]) == want {
                out += replacement.utf16
                i += want.count
            } else {
                out.append(units[i])
                i += 1
            }
        }
        return String(decoding: out, as: UTF16.self)
    }

    /// `String(n)`: the shortest digits that read back as `n`, laid out the
    /// way ECMAScript's Number::toString lays them out.
    static func number(_ value: Double) -> String {
        if value.isNaN { return "NaN" }
        if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
        if value == 0 { return "0" }
        if value == value.rounded(), abs(value) < 9_007_199_254_740_992 { return String(Int64(value)) }
        let sign = value < 0 ? "-" : ""
        // Swift's own description has the same shortest digits; only the
        // layout differs.
        let described = abs(value).description
        let parts = described.split(separator: "e", maxSplits: 1)
        let mantissa = String(parts[0])
        let exponent = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
        let split = mantissa.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        let whole = String(split[0])
        let fraction = split.count > 1 ? String(split[1]) : ""
        var digits = Array(whole + fraction)
        var point = whole.count + exponent
        while digits.first == "0" {
            digits.removeFirst()
            point -= 1
        }
        while digits.last == "0" { digits.removeLast() }
        let k = digits.count
        let n = point
        let text = String(digits)
        if k <= n, n <= 21 { return sign + text + String(repeating: "0", count: n - k) }
        if 0 < n, n <= 21 { return sign + String(digits[0..<n]) + "." + String(digits[n...]) }
        if -6 < n, n <= 0 { return sign + "0." + String(repeating: "0", count: -n) + text }
        let e = n - 1
        let power = e < 0 ? "e-\(-e)" : "e+\(e)"
        if k == 1 { return sign + text + power }
        return sign + String(digits[0]) + "." + String(digits[1...]) + power
    }
}

/// A JSON value as JavaScript holds one: numbers are doubles, strings are
/// code units, and an object's keys keep the order JavaScript enumerates
/// them in.
indirect enum JSValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(JSString)
    case array([JSValue])
    case object([(JSString, JSValue)])

    static func == (a: JSValue, b: JSValue) -> Bool {
        switch (a, b) {
        case (.null, .null): return true
        case (.bool(let x), .bool(let y)): return x == y
        case (.number(let x), .number(let y)): return x == y
        case (.string(let x), .string(let y)): return x == y
        case (.array(let x), .array(let y)): return x == y
        case (.object(let x), .object(let y)):
            return x.count == y.count && zip(x, y).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        default: return false
        }
    }

    subscript(key: JSString) -> JSValue? {
        guard case .object(let fields) = self else { return nil }
        return fields.first { $0.0 == key }?.1
    }

    var string: JSString? {
        if case .string(let s) = self { return s }
        return nil
    }

    var number: Double? {
        if case .number(let n) = self { return n }
        return nil
    }

    var array: [JSValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    /// `typeof value === "object" && value !== null`, arrays included.
    var isObjectLike: Bool {
        switch self {
        case .object, .array: return true
        default: return false
        }
    }

    /* ---------- JSON.parse ---------- */

    /// `JSON.parse`, or nil where it throws.
    static func parse(_ text: String) -> JSValue? {
        var reader = JSONReader(Array(text.utf16))
        reader.skipSpace()
        guard let value = reader.value() else { return nil }
        reader.skipSpace()
        return reader.atEnd ? value : nil
    }

    /* ---------- JSON.stringify ---------- */

    var json: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return n.isFinite ? JSText.number(n) : "null"
        case .string(let s): return JSValue.quote(s)
        case .array(let items): return "[" + items.map(\.json).joined(separator: ",") + "]"
        case .object(let fields):
            return "{" + JSValue.enumerationOrder(fields).map { JSValue.quote($0.0) + ":" + $0.1.json }.joined(separator: ",") + "}"
        }
    }

    /// The keys that read as array indexes first, by number, then the rest
    /// as they were made — the order JavaScript lists an object's keys in.
    private static func enumerationOrder(_ fields: [(JSString, JSValue)]) -> [(JSString, JSValue)] {
        func index(_ key: JSString) -> UInt32? {
            guard let n = UInt32(key.string), n != UInt32.max, JSString(String(n)) == key else { return nil }
            return n
        }
        let indexed = fields.compactMap { field in index(field.0).map { ($0, field) } }.sorted { $0.0 < $1.0 }.map(\.1)
        return indexed + fields.filter { index($0.0) == nil }
    }

    /// A string as `JSON.stringify` writes it: the few escapes JSON needs,
    /// and half a character as `\udxxx` — anything else as it is.
    static func quote(_ s: JSString) -> String {
        var out: [UInt16] = [0x22]
        func escape(_ unit: UInt16) {
            let hex = Array(String(unit, radix: 16).utf16)
            out += Array("\\u".utf16) + Array(repeating: 0x30, count: 4 - hex.count) + hex
        }
        let units = s.units
        var i = 0
        while i < units.count {
            let unit = units[i]
            switch unit {
            case 0x22: out += Array("\\\"".utf16)
            case 0x5C: out += Array("\\\\".utf16)
            case 0x08: out += Array("\\b".utf16)
            case 0x0C: out += Array("\\f".utf16)
            case 0x0A: out += Array("\\n".utf16)
            case 0x0D: out += Array("\\r".utf16)
            case 0x09: out += Array("\\t".utf16)
            case 0xD800...0xDBFF where i + 1 < units.count && (0xDC00...0xDFFF).contains(units[i + 1]):
                out += [unit, units[i + 1]]
                i += 1
            case 0xD800...0xDFFF, 0..<0x20: escape(unit)
            default: out.append(unit)
            }
            i += 1
        }
        out.append(0x22)
        return String(decoding: out, as: UTF16.self)
    }
}

/// `JSON.parse` over UTF-16 code units, which is what it reads.
private struct JSONReader {
    let units: [UInt16]
    var i = 0

    init(_ units: [UInt16]) { self.units = units }

    var atEnd: Bool { i >= units.count }

    mutating func skipSpace() {
        while i < units.count, [0x20, 0x09, 0x0A, 0x0D].contains(units[i]) { i += 1 }
    }

    mutating func literal(_ word: String, _ value: JSValue) -> JSValue? {
        let want = Array(word.utf16)
        guard i + want.count <= units.count, Array(units[i..<(i + want.count)]) == want else { return nil }
        i += want.count
        return value
    }

    mutating func value() -> JSValue? {
        guard i < units.count else { return nil }
        switch units[i] {
        case 0x7B: return object()
        case 0x5B: return array()
        case 0x22: return string().map(JSValue.string)
        case 0x74: return literal("true", .bool(true))
        case 0x66: return literal("false", .bool(false))
        case 0x6E: return literal("null", .null)
        default: return number()
        }
    }

    mutating func object() -> JSValue? {
        i += 1
        var fields: [(JSString, JSValue)] = []
        skipSpace()
        if i < units.count, units[i] == 0x7D {
            i += 1
            return .object(fields)
        }
        while true {
            skipSpace()
            guard i < units.count, units[i] == 0x22, let key = string() else { return nil }
            skipSpace()
            guard i < units.count, units[i] == 0x3A else { return nil }
            i += 1
            skipSpace()
            guard let value = value() else { return nil }
            // A key given twice keeps its first place and its last value.
            if let at = fields.firstIndex(where: { $0.0 == key }) { fields[at].1 = value } else { fields.append((key, value)) }
            skipSpace()
            guard i < units.count else { return nil }
            if units[i] == 0x2C {
                i += 1
                continue
            }
            guard units[i] == 0x7D else { return nil }
            i += 1
            return .object(fields)
        }
    }

    mutating func array() -> JSValue? {
        i += 1
        var items: [JSValue] = []
        skipSpace()
        if i < units.count, units[i] == 0x5D {
            i += 1
            return .array(items)
        }
        while true {
            skipSpace()
            guard let value = value() else { return nil }
            items.append(value)
            skipSpace()
            guard i < units.count else { return nil }
            if units[i] == 0x2C {
                i += 1
                continue
            }
            guard units[i] == 0x5D else { return nil }
            i += 1
            return .array(items)
        }
    }

    /// A string's code units, `\udxxx` read as the half it is.
    mutating func string() -> JSString? {
        i += 1
        var out: [UInt16] = []
        while i < units.count {
            let c = units[i]
            if c == 0x22 {
                i += 1
                return JSString(units: out)
            }
            if c < 0x20 { return nil }
            if c != 0x5C {
                out.append(c)
                i += 1
                continue
            }
            guard i + 1 < units.count else { return nil }
            let escaped = units[i + 1]
            i += 2
            switch escaped {
            case 0x22: out.append(0x22)
            case 0x5C: out.append(0x5C)
            case 0x2F: out.append(0x2F)
            case 0x62: out.append(0x08)
            case 0x66: out.append(0x0C)
            case 0x6E: out.append(0x0A)
            case 0x72: out.append(0x0D)
            case 0x74: out.append(0x09)
            case 0x75:
                guard i + 4 <= units.count,
                      let code = UInt16(String(decoding: units[i..<(i + 4)], as: UTF16.self), radix: 16)
                else { return nil }
                out.append(code)
                i += 4
            default: return nil
            }
        }
        return nil
    }

    mutating func number() -> JSValue? {
        let start = i
        func digit(_ at: Int) -> Bool { at < units.count && units[at] >= 0x30 && units[at] <= 0x39 }
        if i < units.count, units[i] == 0x2D { i += 1 }
        guard digit(i) else { return nil }
        if units[i] == 0x30 {
            i += 1
        } else {
            while digit(i) { i += 1 }
        }
        if i < units.count, units[i] == 0x2E {
            i += 1
            guard digit(i) else { return nil }
            while digit(i) { i += 1 }
        }
        if i < units.count, units[i] == 0x65 || units[i] == 0x45 {
            i += 1
            if i < units.count, units[i] == 0x2B || units[i] == 0x2D { i += 1 }
            guard digit(i) else { return nil }
            while digit(i) { i += 1 }
        }
        return Double(String(decoding: units[start..<i], as: UTF16.self)).map(JSValue.number)
    }
}
