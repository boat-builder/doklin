// The text inside a block: emphasis, code, links, and the comment markers a
// Doklin document carries (`{==words==}{>>#id<<}`, src/criticMarkup.ts).
//
// This is a reader, not an editor: it has to show any note legibly, never
// write one back. So where CommonMark has a corner this does not know, the
// characters come out as they were typed.

import Foundation

public indirect enum Inline: Equatable, Sendable {
    case text(String)
    case code(String)
    case emphasis([Inline])
    case strong([Inline])
    case strikethrough([Inline])
    case link(destination: String, children: [Inline])
    /// A link to a document this person can't open here: deleted, in a
    /// section they are not in, or never there (`DocLinks.resolving`).
    case closedLink([Inline])
    case image(source: String, alt: String)
    /// Words a comment thread is on. `thread` is nil for a marker with no id.
    case highlight(thread: String?, children: [Inline])
    case lineBreak
}

/// A stretch of text in one style — what a view turns into attributed text.
public struct InlineRun: Equatable, Sendable {
    public var text: String
    public var bold = false
    public var italic = false
    public var code = false
    public var strike = false
    public var link: String?
    /// In a link that opens nothing here (`Inline.closedLink`).
    public var closed = false
    /// Carries a comment thread's highlight.
    public var highlighted = false
    public var thread: String?

    public init(_ text: String) { self.text = text }

    fileprivate func sameStyle(as other: InlineRun) -> Bool {
        bold == other.bold && italic == other.italic && code == other.code && strike == other.strike
            && link == other.link && closed == other.closed && highlighted == other.highlighted && thread == other.thread
    }
}

public extension Array where Element == Inline {
    /// The words alone, as a heading's outline entry or a search would want them.
    var plainText: String {
        map { node -> String in
            switch node {
            case .text(let s), .code(let s): return s
            case .emphasis(let c), .strong(let c), .strikethrough(let c): return c.plainText
            case .link(_, let c), .highlight(_, let c), .closedLink(let c): return c.plainText
            case .image(_, let alt): return alt
            case .lineBreak: return " "
            }
        }.joined()
    }

    /// The same content as a flat list of styled runs, neighbours of one style merged.
    var runs: [InlineRun] {
        var out: [InlineRun] = []
        func add(_ run: InlineRun) {
            guard !run.text.isEmpty else { return }
            if let last = out.last, last.sameStyle(as: run) { out[out.count - 1].text += run.text } else { out.append(run) }
        }
        func walk(_ nodes: [Inline], _ style: InlineRun) {
            for node in nodes {
                var next = style
                switch node {
                case .text(let s):
                    next.text = s
                    add(next)
                case .code(let s):
                    next.text = s
                    next.code = true
                    add(next)
                case .emphasis(let c):
                    next.italic = true
                    walk(c, next)
                case .strong(let c):
                    next.bold = true
                    walk(c, next)
                case .strikethrough(let c):
                    next.strike = true
                    walk(c, next)
                case .link(let destination, let c):
                    next.link = destination
                    walk(c, next)
                case .closedLink(let c):
                    next.closed = true
                    walk(c, next)
                case .highlight(let thread, let c):
                    next.highlighted = true
                    next.thread = thread
                    walk(c, next)
                case .image(let source, let alt):
                    // A picture in a line of text reads as its caption, and opens.
                    next.text = alt.isEmpty ? "image" : alt
                    next.link = next.link ?? source
                    add(next)
                case .lineBreak:
                    next.text = "\n"
                    add(next)
                }
            }
        }
        walk(self, InlineRun(""))
        return out
    }

    /// Every thread id that marks words here, in reading order.
    var threads: [String] {
        flatMap { node -> [String] in
            switch node {
            case .highlight(let thread, let c): return (thread.map { [$0] } ?? []) + c.threads
            case .emphasis(let c), .strong(let c), .strikethrough(let c), .link(_, let c), .closedLink(let c): return c.threads
            default: return []
            }
        }
    }
}

public enum InlineParser {
    public static func parse(_ source: String) -> [Inline] {
        var parser = Scanner(Array(source))
        return parser.run()
    }

    /// A node on the way to being an inline: text, something finished, or a
    /// run of `*`, `_` or `~` that may yet open or close emphasis.
    private enum Piece {
        case node(Inline)
        case delimiter(char: Character, count: Int, canOpen: Bool, canClose: Bool)
    }

    private struct Scanner {
        let chars: [Character]
        var i = 0
        var pieces: [Piece] = []
        var text = ""

        init(_ chars: [Character]) { self.chars = chars }

        mutating func flush() {
            if !text.isEmpty {
                pieces.append(.node(.text(text)))
                text = ""
            }
        }

        func at(_ index: Int) -> Character? { index >= 0 && index < chars.count ? chars[index] : nil }

        func starts(_ prefix: String, at index: Int) -> Bool {
            var j = index
            for ch in prefix {
                guard at(j) == ch else { return false }
                j += 1
            }
            return true
        }

        func find(_ needle: String, from index: Int) -> Int? {
            let n = needle.count
            guard n > 0, index <= chars.count - n else { return nil }
            var j = index
            while j <= chars.count - n {
                if starts(needle, at: j) { return j }
                j += 1
            }
            return nil
        }

        mutating func run() -> [Inline] {
            while i < chars.count {
                let c = chars[i]
                switch c {
                case "\\": escape()
                case "`": codeSpan()
                case "{": critic()
                case "!": image()
                case "[": link()
                case "<": angle()
                case "*", "_": delimiterRun(c)
                case "~": tilde()
                case "\n": newline()
                default:
                    if (c == "h" || c == "w"), bareLink() { continue }
                    text.append(c)
                    i += 1
                }
            }
            flush()
            return InlineParser.resolve(pieces)
        }

        mutating func escape() {
            if let next = at(i + 1) {
                if next == "\n" {
                    flush()
                    pieces.append(.node(.lineBreak))
                    i += 2
                    skipIndent()
                    return
                }
                if next.isASCII, next.isPunctuation || next.isSymbol {
                    text.append(next)
                    i += 2
                    return
                }
            }
            text.append("\\")
            i += 1
        }

        mutating func skipIndent() {
            while let c = at(i), c == " " || c == "\t" { i += 1 }
        }

        mutating func newline() {
            // Two spaces before the end of a line break it; anything else is a space.
            var trailing = 0
            while text.hasSuffix(" ") {
                text.removeLast()
                trailing += 1
            }
            flush()
            pieces.append(.node(trailing >= 2 ? .lineBreak : .text(" ")))
            i += 1
            skipIndent()
        }

        mutating func codeSpan() {
            var n = 0
            while at(i + n) == "`" { n += 1 }
            // The closing run is one of exactly the same length.
            var j = i + n
            while j < chars.count {
                guard chars[j] == "`" else {
                    j += 1
                    continue
                }
                var m = 0
                while at(j + m) == "`" { m += 1 }
                if m == n {
                    var body = String(chars[(i + n)..<j]).replacingOccurrences(of: "\n", with: " ")
                    if body.count >= 2, body.hasPrefix(" "), body.hasSuffix(" "), body.contains(where: { $0 != " " }) {
                        body = String(body.dropFirst().dropLast())
                    }
                    flush()
                    pieces.append(.node(.code(body)))
                    i = j + m
                    return
                }
                j += m
            }
            text.append(String(repeating: "`", count: n))
            i += n
        }

        /// `{==words==}{>>#id …<<}` is words under a comment thread. A stray
        /// half is cleaned the way the app cleans a copy (`stripComments`): a
        /// comment with no words is dropped, words with no comment are shown bare.
        mutating func critic() {
            if starts("{==", at: i), let close = find("==}", from: i + 3), close > i + 3 {
                let words = String(chars[(i + 3)..<close])
                var j = close + 3
                var first: String?
                var spans = 0
                while starts("{>>", at: j), let end = find("<<}", from: j + 3) {
                    if first == nil { first = String(chars[(j + 3)..<end]) }
                    spans += 1
                    j = end + 3
                }
                flush()
                let children = InlineParser.parse(words)
                if spans > 0 {
                    pieces.append(.node(.highlight(thread: CriticMarkup.threadID(ofSpan: first ?? ""), children: children)))
                } else {
                    for child in children { pieces.append(.node(child)) }
                }
                i = j
                return
            }
            if starts("{>>", at: i), let end = find("<<}", from: i + 3) {
                i = end + 3
                return
            }
            text.append("{")
            i += 1
        }

        /// The index of the `]` that closes the `[` at `open`, minding nested
        /// brackets, escapes and code.
        func closingBracket(from open: Int) -> Int? {
            var depth = 0
            var j = open
            while j < chars.count {
                switch chars[j] {
                case "\\": j += 1
                case "`":
                    var n = 0
                    while at(j + n) == "`" { n += 1 }
                    if let end = find(String(repeating: "`", count: n), from: j + n) { j = end + n - 1 } else { j += n - 1 }
                case "[": depth += 1
                case "]":
                    depth -= 1
                    if depth == 0 { return j }
                case "\n":
                    if at(j + 1) == "\n" { return nil }
                default: break
                }
                j += 1
            }
            return nil
        }

        /// `(destination "title")` starting at `open`; the destination and
        /// the index after the `)`.
        func destination(from open: Int) -> (String, Int)? {
            guard at(open) == "(" else { return nil }
            var j = open + 1
            while let c = at(j), c == " " || c == "\n" { j += 1 }
            var dest = ""
            if at(j) == "<" {
                j += 1
                while let c = at(j), c != ">" {
                    if c == "\n" { return nil }
                    dest.append(c)
                    j += 1
                }
                guard at(j) == ">" else { return nil }
                j += 1
            } else {
                var depth = 0
                while let c = at(j) {
                    if c == "\\", let next = at(j + 1), next.isASCII, next.isPunctuation || next.isSymbol {
                        dest.append(next)
                        j += 2
                        continue
                    }
                    if c == " " || c == "\n" { break }
                    if c == "(" { depth += 1 }
                    if c == ")" {
                        if depth == 0 { break }
                        depth -= 1
                    }
                    dest.append(c)
                    j += 1
                }
            }
            while let c = at(j), c == " " || c == "\n" { j += 1 }
            // A title is read past, not kept: nothing here shows one.
            if let quote = at(j), quote == "\"" || quote == "'" || quote == "(" {
                let close: Character = quote == "(" ? ")" : quote
                var k = j + 1
                while let c = at(k), c != close {
                    if c == "\\" { k += 1 }
                    k += 1
                }
                guard at(k) == close else { return nil }
                j = k + 1
                while let c = at(j), c == " " || c == "\n" { j += 1 }
            }
            guard at(j) == ")" else { return nil }
            return (dest, j + 1)
        }

        mutating func link() {
            if let close = closingBracket(from: i), let (dest, after) = destination(from: close + 1) {
                let inner = String(chars[(i + 1)..<close])
                flush()
                pieces.append(.node(.link(destination: dest, children: InlineParser.parse(inner))))
                i = after
                return
            }
            text.append("[")
            i += 1
        }

        mutating func image() {
            if at(i + 1) == "[", let close = closingBracket(from: i + 1), let (dest, after) = destination(from: close + 1) {
                let alt = InlineParser.parse(String(chars[(i + 2)..<close])).plainText
                flush()
                pieces.append(.node(.image(source: dest, alt: alt)))
                i = after
                return
            }
            text.append("!")
            i += 1
        }

        mutating func angle() {
            guard let close = find(">", from: i + 1) else {
                text.append("<")
                i += 1
                return
            }
            let inner = String(chars[(i + 1)..<close])
            let lower = inner.lowercased()
            // <https://…> and <someone@example.com>
            if !inner.contains(where: { $0.isWhitespace }) {
                if lower.hasPrefix("http://") || lower.hasPrefix("https://") || lower.hasPrefix("mailto:") {
                    flush()
                    pieces.append(.node(.link(destination: inner, children: [.text(inner)])))
                    i = close + 1
                    return
                }
                if inner.contains("@"), inner.contains("."), !inner.contains("/"), inner.first?.isLetter == true || inner.first?.isNumber == true {
                    flush()
                    pieces.append(.node(.link(destination: "mailto:\(inner)", children: [.text(inner)])))
                    i = close + 1
                    return
                }
            }
            if lower == "br" || lower == "br/" || lower == "br /" {
                flush()
                pieces.append(.node(.lineBreak))
                i = close + 1
                return
            }
            // Any other tag, or an html comment: left out, its content kept.
            var name = Substring(inner)
            if name.hasPrefix("/") { name = name.dropFirst() }
            let isTag = inner.hasPrefix("!--") || (name.first?.isLetter == true && !inner.contains("\n\n"))
            if isTag {
                i = close + 1
                return
            }
            text.append("<")
            i += 1
        }

        /// A web address written bare, the way GitHub links one.
        mutating func bareLink() -> Bool {
            let isStart = text.isEmpty ? (pieces.isEmpty || !lastIsWord) : !(text.last!.isLetter || text.last!.isNumber)
            guard isStart else { return false }
            let www = starts("www.", at: i)
            guard www || starts("http://", at: i) || starts("https://", at: i) else { return false }
            var j = i
            while let c = at(j), !c.isWhitespace, c != "<", c != "`" { j += 1 }
            // Punctuation that ends a sentence is not part of the address.
            while j > i, let last = at(j - 1), ".,;:!?'\"*_~".contains(last) { j -= 1 }
            while j > i, at(j - 1) == ")" {
                let slice = chars[i..<j]
                if slice.filter({ $0 == ")" }).count > slice.filter({ $0 == "(" }).count { j -= 1 } else { break }
            }
            let address = String(chars[i..<j])
            let minimum = www ? 6 : (address.hasPrefix("https") ? 9 : 8)
            guard address.count >= minimum, address.contains(".") || address.contains("localhost") else { return false }
            flush()
            pieces.append(.node(.link(destination: www ? "https://\(address)" : address, children: [.text(address)])))
            i = j
            return true
        }

        var lastIsWord: Bool {
            if case .node(.text(let s))? = pieces.last, let c = s.last { return c.isLetter || c.isNumber }
            return false
        }

        mutating func tilde() {
            var n = 0
            while at(i + n) == "~" { n += 1 }
            guard n == 2 else {
                text.append(String(repeating: "~", count: n))
                i += n
                return
            }
            pushDelimiter("~", count: n)
        }

        mutating func delimiterRun(_ c: Character) {
            var n = 0
            while at(i + n) == c { n += 1 }
            pushDelimiter(c, count: n)
        }

        mutating func pushDelimiter(_ c: Character, count n: Int) {
            let before = at(i - 1)
            let after = at(i + n)
            let spaceBefore = before == nil || before!.isWhitespace
            let spaceAfter = after == nil || after!.isWhitespace
            let punctBefore = before.map { $0.isPunctuation || $0.isSymbol } ?? false
            let punctAfter = after.map { $0.isPunctuation || $0.isSymbol } ?? false
            let left = !spaceAfter && (!punctAfter || spaceBefore || punctBefore)
            let right = !spaceBefore && (!punctBefore || spaceAfter || punctAfter)
            let canOpen: Bool
            let canClose: Bool
            if c == "_" {
                // An underscore inside a word is part of the word.
                canOpen = left && (!right || punctBefore)
                canClose = right && (!left || punctAfter)
            } else {
                canOpen = left
                canClose = right
            }
            flush()
            pieces.append(.delimiter(char: c, count: n, canOpen: canOpen, canClose: canClose))
            i += n
        }
    }

    /// Pair the delimiter runs up into emphasis, the way CommonMark does:
    /// each closer takes the nearest opener of its own character.
    private static func resolve(_ input: [Piece]) -> [Inline] {
        var pieces = input
        var index = 0
        while index < pieces.count {
            guard case .delimiter(let char, let count, let closerOpens, true) = pieces[index] else {
                index += 1
                continue
            }
            // The nearest opener of this character, looking back.
            var opener: Int?
            var k = index - 1
            while k >= 0 {
                if case .delimiter(let c, let n, true, let openerCloses) = pieces[k], c == char {
                    // A run that could do both must not pair across a length
                    // that is a multiple of three, unless both are.
                    let oddMatch = (closerOpens || openerCloses) && (n + count) % 3 == 0 && !(n % 3 == 0 && count % 3 == 0)
                    if !oddMatch || char == "~" {
                        opener = k
                        break
                    }
                }
                k -= 1
            }
            guard let open = opener, case .delimiter(_, let openCount, let openerOpens, let openerCloses) = pieces[open] else {
                index += 1
                continue
            }
            let use = char == "~" ? 2 : (count >= 2 && openCount >= 2 ? 2 : 1)
            let inner = flatten(Array(pieces[(open + 1)..<index]))
            let wrapped: Inline = char == "~" ? .strikethrough(inner) : (use == 2 ? .strong(inner) : .emphasis(inner))
            var replacement: [Piece] = []
            if openCount - use > 0 {
                replacement.append(.delimiter(char: char, count: openCount - use, canOpen: openerOpens, canClose: openerCloses))
            }
            replacement.append(.node(wrapped))
            let closerLeft = count - use
            if closerLeft > 0 {
                replacement.append(.delimiter(char: char, count: closerLeft, canOpen: closerOpens, canClose: true))
            }
            pieces.replaceSubrange(open...index, with: replacement)
            // Go on from the closer's remainder, if it has one, else from what follows.
            index = open + replacement.count - (closerLeft > 0 ? 1 : 0)
        }
        return flatten(pieces)
    }

    /// Whatever was not paired is the characters it was typed as.
    private static func flatten(_ pieces: [Piece]) -> [Inline] {
        var out: [Inline] = []
        for piece in pieces {
            let node: Inline
            switch piece {
            case .node(let n): node = n
            case .delimiter(let char, let count, _, _): node = .text(String(repeating: String(char), count: count))
            }
            if case .text(let s) = node, case .text(let previous)? = out.last {
                out[out.count - 1] = .text(previous + s)
            } else {
                out.append(node)
            }
        }
        return out
    }
}
