// A small, tolerant reading of an html page's markup — enough to say how
// much of a thread's place the page's file still has, with no browser to
// ask: what the page says, as one run of text, and its elements (their tag,
// their id, where their words are in that text). The Mac finds a thread's
// place in a real browser, in the page as drawn (src/htmlBridge.ts,
// "finding a place"); this reads the file as written, by the same rules —
// the page as one run of text, the three ways of looking for words, how a
// part's text agrees with an anchor's. What a page's own script builds is
// not in the file, so a thread this does not find on a page that runs
// script is one it cannot tell about, not one that is gone (`place`).
//
// A port of cloud-worker/src/htmlText.ts (`readPage`, `placeOf` and what
// they stand on), which reads a page for the worker, so that both say the
// same thread is gone. It works on UTF-16 code units, so that it cuts and
// compares as JavaScript does. The app's script, the worker's reading and
// this are held to verify-harness/comments-fixture.json (`pages`, `places`)
// — change all three.

import Foundation

struct HtmlElement: Equatable {
    let tag: String
    /// Its id, empty for none.
    let id: JSString
    /// The start of what it says, as an anchor keeps it: its words in the
    /// page's text, or a picture's alt text, else its file name. Cut
    /// through a character, as an anchor's own text is cut.
    var text: JSString = ""
    /// Where its words are in the page's text.
    var from = 0
    var to = 0
    /// Its ancestors' places in the list, outermost first — what makes one
    /// element "inside" another.
    let ancestors: [Int]
}

/// A page as read from its file.
struct HtmlPage: Equatable {
    /// What it says, as one run of text (htmlBridge.ts `buildModel`).
    let text: JSString
    /// Every element, in document order.
    let elements: [HtmlElement]
    /// It runs script, which may build more than the file has.
    let runsScript: Bool
}

/// How much of a thread's place a page's file has:
///   2  its words (as written, folded or close to them);
///   1  its part — an element with its tag whose text agrees with the
///      anchor's (equal, or one begins with the other), or, for a part with
///      no text, the element with its own id;
///   0  neither.
/// `known` is false for a 0 that says nothing: the anchor has nothing a file
/// can be checked by, or the page runs script, which may build what the
/// thread is on. A reader says a thread is gone only on a known 0.
struct FilePlace: Equatable {
    let level: Int
    let known: Bool
}

enum HtmlText {
    /// As much of an element's text as an anchor keeps (`ANCHOR_TEXT_LEN`,
    /// src/htmlComments.ts): the app's script, the worker and this cut to
    /// the same length — change all three.
    static let anchorLength = 120

    private static let voidTags: Set<String> = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]
    /// Elements whose content is text up to their own closing tag, whatever it looks like.
    private static let rawTextTags: Set<String> = ["script", "style", "textarea", "title"]
    /// Elements nobody reads: nothing inside one is a part of the page.
    private static let unseenTags: Set<String> = ["script", "style", "template", "noscript", "head", "title"]
    /// What the page as one run of text leaves out (htmlBridge.ts `SKIP`,
    /// and the head, which is not the page's body).
    private static let notText: Set<String> = ["script", "style", "noscript", "template", "textarea", "title", "desc", "head"]
    /// Words in a line, never a block of their own (htmlBridge.ts `INLINE`).
    private static let inLine: Set<String> = [
        "a", "abbr", "b", "bdi", "bdo", "big", "cite", "code", "del", "dfn", "em", "font", "i", "ins", "kbd", "label", "mark", "q", "s", "samp",
        "small", "span", "strike", "strong", "sub", "sup", "time", "tt", "u", "var", "wbr",
    ]
    /// Opening one of these closes an open <p>, as a browser does.
    private static let closesP: Set<String> = [
        "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figure", "footer", "form",
        "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
    ]
    /// An open element of the left kind is closed by opening one of the right.
    private static let closedBy: [String: Set<String>] = [
        "li": ["li"],
        "dt": ["dt", "dd"],
        "dd": ["dt", "dd"],
        "tr": ["tr", "tbody", "tfoot"],
        "td": ["td", "th", "tr", "tbody", "tfoot"],
        "th": ["td", "th", "tr", "tbody", "tfoot"],
        "option": ["option", "optgroup"],
    ]
    /// Wrappers an implied close reaches through.
    private static let inlineTags: Set<String> = ["a", "b", "code", "em", "i", "s", "small", "span", "strong", "u"]
    /// Elements a comment is never on: the page's frame, and what nobody
    /// sees. An anchor's tag is whatever its record says, so these are
    /// compared as it is: by code unit.
    private static let notAnchors = Set(unseenTags.union(["html", "head", "body", "meta", "link", "base"]).map { JSString($0) })
    private static let named: [String: String] = [
        "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": "\u{A0}", "ndash": "–", "mdash": "—", "hellip": "…",
        "lsquo": "‘", "rsquo": "’", "ldquo": "“", "rdquo": "”", "copy": "©", "reg": "®", "trade": "™", "middot": "·", "bull": "•",
    ]

    private static func isLetter(_ u: UInt16) -> Bool { (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A) }
    private static func isDigit(_ u: UInt16) -> Bool { u >= 0x30 && u <= 0x39 }
    private static func isHex(_ u: UInt16) -> Bool { isDigit(u) || (u >= 0x41 && u <= 0x46) || (u >= 0x61 && u <= 0x66) }
    private static func lower(_ u: UInt16) -> UInt16 { u >= 0x41 && u <= 0x5A ? u + 32 : u }

    /// The whitespace between a tag's attributes: every control character
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

    /// One attribute of a tag as written (`attrs`), entities decoded; nil
    /// when it has none by that name. The first of two wins, as in a
    /// browser. A name as written is lowered as far as ASCII goes, which is
    /// as far as any name asked for here does.
    static func attr(_ name: String, in attrs: [UInt16]) -> [UInt16]? {
        let want = Array(name.utf16)
        let n = attrs.count
        var i = 0
        while i < n {
            while i < n, isSpace(attrs[i]) || attrs[i] == 0x2F { i += 1 }
            let start = i
            while i < n, !isSpace(attrs[i]), attrs[i] != 0x3D, attrs[i] != 0x2F, attrs[i] != 0x3E { i += 1 }
            if i == start {
                // A stray `=` or `>`.
                i += 1
                continue
            }
            let key = attrs[start..<i].map(lower)
            while i < n, isSpace(attrs[i]) { i += 1 }
            var value: ArraySlice<UInt16> = []
            if i < n, attrs[i] == 0x3D {
                i += 1
                while i < n, isSpace(attrs[i]) { i += 1 }
                if i < n, attrs[i] == 0x22 || attrs[i] == 0x27 {
                    let end = indexOf([attrs[i]], in: attrs, from: i + 1)
                    value = attrs[(i + 1)..<(end ?? n)]
                    i = end.map { $0 + 1 } ?? n
                } else {
                    let from = i
                    while i < n, !isSpace(attrs[i]), attrs[i] != 0x3E { i += 1 }
                    value = attrs[from..<i]
                }
            }
            if key == want { return decodeEntities(Array(value)) }
        }
        return nil
    }

    /// Read the markup once: each element opened — with everything between
    /// its name and its end, as written — and closed, each run of text.
    private static func walk(_ html: [UInt16], open: (String, [UInt16]) -> Void, close: (String) -> Void, text: ([UInt16]) -> Void) {
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
            let nameEnd = j
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
            let attrs = Array(html[nameEnd..<j])
            i = j < n ? j + 1 : n
            if closing {
                close(tag)
                continue
            }
            open(tag, attrs)
            if voidTags.contains(tag) || selfClosed {
                close(tag)
            } else if rawTextTags.contains(tag) {
                let stop = indexOf(Array("</\(tag)".utf16), in: html, from: i, ignoringCase: true) ?? n
                text(Array(html[i..<stop]))
                i = stop
            }
        }
    }

    /// Whitespace collapsed and trimmed — how an anchor's text is compared.
    private static func normalize(_ s: [UInt16]) -> [UInt16] {
        var out: [UInt16] = []
        var space = false
        for u in s {
            if JSText.isSpace(u) {
                space = !out.isEmpty
            } else {
                if space { out.append(0x20) }
                space = false
                out.append(u)
            }
        }
        return out
    }

    /// What a picture is called: its alt text, else its file name
    /// (htmlBridge.ts `pictureText`). One held in the page itself, as a
    /// `data:` address, has no name.
    static func pictureText(_ attrs: [UInt16]) -> [UInt16] {
        let alt = normalize(attr("alt", in: attrs) ?? [])
        if !alt.isEmpty { return Array(alt.prefix(anchorLength)) }
        let src = attr("src", in: attrs) ?? []
        if src.drop(while: JSText.isSpace).prefix(5).map(lower) == Array("data:".utf16) { return [] }
        let path = src.prefix { $0 != 0x23 }.prefix { $0 != 0x3F }
        let name = path.lastIndex(of: 0x2F).map { path[($0 + 1)...] } ?? path
        return Array(normalize(Array(name)).prefix(anchorLength))
    }

    /// A script the browser would run: no type, a module, or a JavaScript
    /// type. The type is lowered as far as ASCII goes: nothing else lowers
    /// to a letter of these words.
    private static func runs(_ attrs: [UInt16]) -> Bool {
        let type = JSText.trim(JSString(units: attr("type", in: attrs) ?? [])).units.map(lower)
        return type.isEmpty || type == Array("module".utf16)
            || indexOf(Array("javascript".utf16), in: type, from: 0) != nil
            || indexOf(Array("ecmascript".utf16), in: type, from: 0) != nil
    }

    /// The page as the app's script reads it (htmlBridge.ts `buildModel`),
    /// from the file: its text as one run — every stretch of whitespace one
    /// space, a space between two blocks or across a <br>, nothing of what
    /// nobody reads — and every element with where its words are in that
    /// run.
    static func page(_ html: String) -> HtmlPage {
        struct Open {
            let index: Int
            let tag: String
        }
        var elements: [HtmlElement] = []
        var pictures: [Int: [UInt16]] = [:]
        var stack: [Open] = []
        var text: [UInt16] = []
        var lastSpace = true
        var boundary = false
        var previousBlock: Int?
        // How many open elements are ones nobody reads.
        var unread = 0
        var runsScript = false
        // Elements whose words begin, or end, where the next text does.
        var begins: [Int] = []
        var ends: [Int] = []
        func settle() {
            for i in begins { elements[i].from = text.count }
            for i in ends { elements[i].to = text.count }
            begins = []
            ends = []
        }
        func close(to depth: Int) {
            while stack.count > depth {
                let o = stack.removeLast()
                if notText.contains(o.tag) { unread -= 1 }
                ends.append(o.index)
            }
        }
        walk(
            Array(html.utf16),
            open: { tag, attrs in
                // The nearest open element this tag closes, as a browser
                // would close it — provided only inline wrappers and
                // paragraphs sit inside it. An <li> opened inside a nested
                // list closes nothing above that list.
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
                if tag == "br", unread == 0 { boundary = true }
                if tag == "script", runs(attrs) { runsScript = true }
                let index = elements.count
                elements.append(HtmlElement(tag: tag, id: JSString(units: attr("id", in: attrs) ?? []), ancestors: stack.map(\.index)))
                if tag == "img" { pictures[index] = pictureText(attrs) }
                begins.append(index)
                stack.append(Open(index: index, tag: tag))
                if notText.contains(tag) { unread += 1 }
            },
            close: { tag in
                if let d = stack.lastIndex(where: { $0.tag == tag }) { close(to: d) }
            },
            text: { chunk in
                if unread > 0 || chunk.isEmpty { return }
                // Words in two blocks, or either side of a line break, are
                // apart even where the markup puts no space between them.
                let block = stack.last { !inLine.contains($0.tag) }?.index ?? -1
                if (boundary || (previousBlock != nil && block != previousBlock)) && !lastSpace {
                    text.append(0x20)
                    lastSpace = true
                }
                boundary = false
                previousBlock = block
                settle()
                for u in chunk {
                    switch u {
                    // Marks nobody sees: zero-width ones and the soft hyphen.
                    case 0x200B, 0x200C, 0x200D, 0xFEFF, 0xAD:
                        continue
                    case 0x20, 0xA0, 0x09...0x0D, 0x202F, 0x2009:
                        if !lastSpace {
                            text.append(0x20)
                            lastSpace = true
                        }
                    default:
                        text.append(u)
                        lastSpace = false
                    }
                }
            }
        )
        close(to: 0)
        settle()
        for i in elements.indices {
            if let picture = pictures[i] {
                elements[i].text = JSString(units: picture)
                continue
            }
            // Its words without the space either side of them: a space is
            // the only whitespace the run has.
            var words = text[elements[i].from..<elements[i].to]
            while words.first == 0x20 { words.removeFirst() }
            while words.last == 0x20 { words.removeLast() }
            elements[i].text = JSString(units: words.prefix(anchorLength))
        }
        return HtmlPage(text: JSString(units: text), elements: elements, runsScript: runsScript)
    }

    /* ---------- Looking for words (htmlBridge.ts "finding words") ---------- */

    /// One code unit in lower case, where that is one code unit too:
    /// `toLowerCase()` of a string of one. Half a character has no case.
    private static func lowered(_ u: UInt16) -> UInt16 {
        if u < 0x80 { return lower(u) }
        guard let scalar = Unicode.Scalar(u) else { return u }
        let mapped = Array(scalar.properties.lowercaseMapping.utf16)
        return mapped.count == 1 ? mapped[0] : u
    }

    /// The same text with case and typographic marks folded, a code unit
    /// for a code unit: curly quotes and primes straight, every dash a
    /// hyphen.
    static func fold(_ text: [UInt16]) -> [UInt16] {
        text.map { u in
            switch u {
            case 0x2018, 0x2019, 0x2032: return 0x27
            case 0x201C, 0x201D, 0x2033: return 0x22
            case 0x2010...0x2015: return 0x2D
            default: return lowered(u)
            }
        }
    }

    /// Whether a run within `allowed` edits of the pattern is in the
    /// sequence: Sellers' algorithm, with a free start.
    private static func hasClose<T: Equatable>(_ pattern: [T], in sequence: [T], allowed: Int) -> Bool {
        let n = pattern.count
        var distance = Array(0...n)
        for item in sequence {
            var diagonal = distance[0]
            distance[0] = 0
            for j in 1..<(n + 1) {
                let up = distance[j]
                distance[j] = min(diagonal + (pattern[j - 1] == item ? 0 : 1), up + 1, distance[j - 1] + 1)
                diagonal = up
            }
            if distance[n] <= allowed { return true }
        }
        return false
    }

    /// Whether a page's text has words close to the quote, both folded: for
    /// four words or more, up to a third of them changed; for 6 to 80 code
    /// units, up to 30% of them; otherwise nothing is close enough to say
    /// (htmlBridge.ts `findClose`).
    private static func hasCloseWords(_ page: [UInt16], _ wanted: [UInt16]) -> Bool {
        let words = wanted.split(separator: 0x20, omittingEmptySubsequences: false)
        if words.count >= 4 {
            let tokens = Array(page.split(separator: 0x20).prefix(30000))
            if words.count > 300 || tokens.isEmpty { return false }
            return hasClose(words, in: tokens, allowed: Int((Double(words.count) * 0.34).rounded(.down)))
        }
        if wanted.count < 6 || wanted.count > 80 || page.count > 200_000 { return false }
        return hasClose(wanted, in: page, allowed: max(1, Int((Double(wanted.count) * 0.3).rounded(.down))))
    }

    /// Whether a page's text has the words: as written, folded, or close to them.
    static func hasWords(_ text: [UInt16], _ quote: [UInt16]) -> Bool {
        if quote.isEmpty { return false }
        if indexOf(quote, in: text, from: 0) != nil { return true }
        let page = fold(text)
        let wanted = fold(quote)
        return indexOf(wanted, in: page, from: 0) != nil || hasCloseWords(page, wanted)
    }

    /* ---------- A thread's place in the file ---------- */

    /// How much of a thread's place the page's file has (`FilePlace`).
    static func place(of anchor: HtmlAnchor, in page: HtmlPage) -> FilePlace {
        if !anchor.quote.isEmpty, hasWords(page.text.units, anchor.quote.units) { return FilePlace(level: 2, known: true) }
        let ownId = anchor.ids.first ?? ""
        let part = !anchor.tag.isEmpty && !notAnchors.contains(anchor.tag) && page.elements.contains { el in
            if JSString(el.tag) != anchor.tag || el.ancestors.contains(where: { unseenTags.contains(page.elements[$0].tag) }) { return false }
            if anchor.text.isEmpty { return el.text.isEmpty && !ownId.isEmpty && el.id == ownId }
            return !el.text.isEmpty && (el.text.units.starts(with: anchor.text.units) || anchor.text.units.starts(with: el.text.units))
        }
        if part { return FilePlace(level: 1, known: true) }
        let nothingToGoBy = anchor.quote.isEmpty && anchor.text.isEmpty && ownId.isEmpty
        return FilePlace(level: 0, known: !nothingToGoBy && !page.runsScript)
    }
}
