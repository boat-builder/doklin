// Enough of an html page's markup to say whether a thread on it still has
// its element: every element, and what its text begins with. The Mac finds
// the element in a real browser (src/htmlBridge.ts); the worker, which has
// none, reads the markup this way (cloud-worker/src/htmlText.ts), and so
// does the phone — the same reading, so both say the same thread is gone.

import Foundation

struct HtmlElement: Equatable {
    let tag: String
    /// Its text, whitespace collapsed, trimmed, cut to what an anchor keeps.
    var text: String
}

enum HtmlText {
    /// As much of an element's text as an anchor keeps.
    static let anchorLength = 120

    private static let voidTags: Set<String> = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]
    private static let rawTextTags: Set<String> = ["script", "style", "textarea", "title"]
    private static let closesP: Set<String> = [
        "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figure", "footer", "form",
        "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
    ]
    private static let closedBy: [String: Set<String>] = [
        "li": ["li"],
        "dt": ["dt", "dd"],
        "dd": ["dt", "dd"],
        "tr": ["tr", "tbody", "tfoot"],
        "td": ["td", "th", "tr", "tbody", "tfoot"],
        "th": ["td", "th", "tr", "tbody", "tfoot"],
        "option": ["option", "optgroup"],
    ]
    private static let inlineTags: Set<String> = ["a", "b", "code", "em", "i", "s", "small", "span", "strong", "u"]
    private static let named: [String: String] = [
        "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": "\u{A0}", "ndash": "–", "mdash": "—", "hellip": "…",
        "lsquo": "‘", "rsquo": "’", "ldquo": "“", "rdquo": "”", "copy": "©", "reg": "®", "trade": "™", "middot": "·", "bull": "•",
    ]

    private static func isLetter(_ u: UInt16) -> Bool { (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A) }
    private static func isDigit(_ u: UInt16) -> Bool { u >= 0x30 && u <= 0x39 }
    private static func isHex(_ u: UInt16) -> Bool { isDigit(u) || (u >= 0x41 && u <= 0x46) || (u >= 0x61 && u <= 0x66) }
    private static func lower(_ u: UInt16) -> UInt16 { u >= 0x41 && u <= 0x5A ? u + 32 : u }

    /// The whitespace an element's text collapses: every control character
    /// and space, and JavaScript's `\s` beyond.
    private static func isSpace(_ u: UInt16) -> Bool { u <= 32 || u == 0xA0 || (u >= 0x1680 && JSText.isSpace(u)) }

    /// `&amp;`, `&#38;`, `&#x26;` and the few named ones pages use.
    static func decodeEntities(_ s: [UInt16]) -> [UInt16] {
        guard s.contains(0x26) else { return s }
        var out: [UInt16] = []
        var i = 0
        while i < s.count {
            guard s[i] == 0x26 else {
                out.append(s[i])
                i += 1
                continue
            }
            var j = i + 1
            var decoded: [UInt16]?
            if j < s.count, s[j] == 0x23 {
                j += 1
                let hex = j < s.count && (s[j] == 0x78 || s[j] == 0x58)
                if hex { j += 1 }
                let start = j
                while j < s.count, hex ? isHex(s[j]) : isDigit(s[j]) { j += 1 }
                if j > start, j < s.count, s[j] == 0x3B {
                    let digits = String(decoding: s[start..<j], as: UTF16.self)
                    if let code = Int(digits, radix: hex ? 16 : 10), code > 0, code <= 0x10FFFF {
                        // `String.fromCodePoint`, in code units.
                        decoded = code <= 0xFFFF
                            ? [UInt16(code)]
                            : [UInt16(0xD800 + ((code - 0x10000) >> 10)), UInt16(0xDC00 + ((code - 0x10000) & 0x3FF))]
                    }
                }
            } else if j < s.count, isLetter(s[j]) {
                while j < s.count, isLetter(s[j]) || isDigit(s[j]) { j += 1 }
                if j < s.count, s[j] == 0x3B {
                    let name = String(decoding: s[(i + 1)..<j].map(lower), as: UTF16.self)
                    decoded = named[name].map { Array($0.utf16) }
                }
            }
            if let decoded, j < s.count, s[j] == 0x3B {
                out += decoded
                i = j + 1
            } else if j < s.count, s[j] == 0x3B, j > i + 1 {
                // An entity of the right shape that names nothing: kept as typed.
                out += s[i...j]
                i = j + 1
            } else {
                out.append(s[i])
                i += 1
            }
        }
        return out
    }

    private static func indexOf(_ needle: [UInt16], in hay: [UInt16], from: Int, ignoringCase: Bool = false) -> Int? {
        guard !needle.isEmpty, hay.count >= needle.count else { return nil }
        var i = max(0, from)
        while i + needle.count <= hay.count {
            var k = 0
            while k < needle.count, (ignoringCase ? lower(hay[i + k]) : hay[i + k]) == needle[k] { k += 1 }
            if k == needle.count { return i }
            i += 1
        }
        return nil
    }

    /// Read the markup once: each element opened and closed, each run of text.
    private static func walk(_ html: [UInt16], open: (String) -> Void, close: (String) -> Void, text: ([UInt16]) -> Void) {
        let n = html.count
        var i = 0
        let lt: [UInt16] = [0x3C]
        while i < n {
            guard let at = indexOf(lt, in: html, from: i) else {
                text(decodeEntities(Array(html[i...])))
                break
            }
            if at > i { text(decodeEntities(Array(html[i..<at]))) }
            if at + 4 <= n, Array(html[at..<(at + 4)]) == Array("<!--".utf16) {
                i = indexOf(Array("-->".utf16), in: html, from: at + 4).map { $0 + 3 } ?? n
                continue
            }
            let next = at + 1 < n ? html[at + 1] : 0
            if next == 0x21 || next == 0x3F {
                i = indexOf(Array(">".utf16), in: html, from: at).map { $0 + 1 } ?? n
                continue
            }
            // `<` or `</`, then a name, all inside the next 64 code units.
            let window = min(n, at + 64)
            var j = at + 1
            let closing = j < window && html[j] == 0x2F
            if closing { j += 1 }
            guard j < window, isLetter(html[j]) else {
                text(lt)
                i = at + 1
                continue
            }
            let nameStart = j
            while j < window, isLetter(html[j]) || isDigit(html[j]) || html[j] == 0x3A || html[j] == 0x2D { j += 1 }
            let tag = String(decoding: html[nameStart..<j].map(lower), as: UTF16.self)
            // The end of the tag: the first `>` outside a quoted value.
            var quote: UInt16 = 0
            while j < n {
                let c = html[j]
                if quote != 0 {
                    if c == quote { quote = 0 }
                } else if c == 0x22 || c == 0x27 {
                    quote = c
                } else if c == 0x3E {
                    break
                }
                j += 1
            }
            let selfClosed = j >= 1 && html[j - 1] == 0x2F
            i = j < n ? j + 1 : n
            if closing {
                close(tag)
                continue
            }
            open(tag)
            if voidTags.contains(tag) || selfClosed {
                close(tag)
            } else if rawTextTags.contains(tag) {
                let stop = indexOf(Array("</\(tag)".utf16), in: html, from: i, ignoringCase: true) ?? n
                text(Array(html[i..<stop]))
                i = stop
            }
        }
    }

    /// Every element of the page, in order, with the start of its text.
    static func elements(_ html: String) -> [HtmlElement] {
        struct Open {
            let index: Int
            let tag: String
            var text: [UInt16] = []
            var space = false
            var full = false
        }
        var out: [HtmlElement] = []
        var stack: [Open] = []
        func done(_ open: Open) {
            var text = open.text
            while let last = text.last, JSText.isSpace(last) { text.removeLast() }
            out[open.index].text = String(decoding: text.prefix(anchorLength), as: UTF16.self)
        }
        func close(to depth: Int) {
            while stack.count > depth { done(stack.removeLast()) }
        }
        walk(
            Array(html.utf16),
            open: { tag in
                // The nearest open element this one closes, as a browser
                // closes it, past inline wrappers and paragraphs only.
                var d = stack.count - 1
                while d >= 0 {
                    let o = stack[d]
                    if (o.tag == "p" && closesP.contains(tag)) || closedBy[o.tag]?.contains(tag) == true {
                        close(to: d)
                        break
                    }
                    if o.tag != "p", !inlineTags.contains(o.tag) { break }
                    d -= 1
                }
                out.append(HtmlElement(tag: tag, text: ""))
                stack.append(Open(index: out.count - 1, tag: tag))
            },
            close: { tag in
                if let d = stack.lastIndex(where: { $0.tag == tag }) { close(to: d) }
            },
            text: { chunk in
                // Every open element's text grows by the run: `textContent`,
                // collapsed as it goes, stopped past what an anchor keeps.
                for k in stack.indices where !stack[k].full {
                    for c in chunk {
                        if isSpace(c) {
                            stack[k].space = !stack[k].text.isEmpty
                        } else {
                            if stack[k].space { stack[k].text.append(0x20) }
                            stack[k].space = false
                            stack[k].text.append(c)
                        }
                        if stack[k].text.count > anchorLength {
                            stack[k].full = true
                            break
                        }
                    }
                }
            }
        )
        close(to: 0)
        return out
    }

    /// Whether an anchor still finds an element: the same tag, and one's
    /// text the start of the other's. An anchor with no text cannot be
    /// checked without a browser, so it counts as found.
    static func resolves(_ anchor: HtmlAnchor, in elements: [HtmlElement]) -> Bool {
        if anchor.text.isEmpty { return true }
        let want = Array(anchor.text.utf16)
        return elements.contains { element in
            guard JSText.key(element.tag) == JSText.key(anchor.tag), !element.text.isEmpty else { return false }
            let have = Array(element.text.utf16)
            return have.starts(with: want) || want.starts(with: have)
        }
    }
}
