// A note as blocks: headings, paragraphs, lists, tables, code. Read line by
// line, each block remembering the line of the source it began on — which is
// how a ticked checkbox finds its `[ ]` again (MarkdownEditing.swift).

import Foundation

public struct BlockNode: Equatable, Identifiable, Sendable {
    /// Its place in the document, counted in reading order: stable for one parse.
    public let id: Int
    /// The line of the source it starts on, 0-based.
    public let line: Int
    public let block: Block
}

public extension BlockNode {
    /// The block's words alone — what copying it puts on the clipboard.
    var plainText: String {
        func join(_ nodes: [BlockNode]) -> String { nodes.map(\.plainText).joined(separator: "\n") }
        switch block {
        case .heading(_, let content), .paragraph(let content): return content.plainText
        case .blockquote(let inner), .callout(_, let inner): return join(inner)
        case .list(let list):
            return list.items.enumerated().map { index, item in
                let mark = item.task.map { $0 ? "[x] " : "[ ] " } ?? ""
                return (list.ordered ? "\(list.start + index). " : "- ") + mark + join(item.blocks)
            }.joined(separator: "\n")
        case .code(_, let text), .html(let text): return text
        case .table(let table):
            return ([table.header] + table.rows).map { $0.map(\.plainText).joined(separator: "\t") }.joined(separator: "\n")
        case .image(_, let alt): return alt
        case .thematicBreak: return ""
        }
    }
}

public indirect enum Block: Equatable, Sendable {
    case heading(level: Int, content: [Inline])
    case paragraph([Inline])
    case blockquote([BlockNode])
    /// A top-level quote that opens with `[!NOTE]` (or one of four more): a
    /// callout, GitHub's alert. Its blocks are the quote's, the marker line gone.
    case callout(kind: CalloutKind, blocks: [BlockNode])
    case list(ListBlock)
    case code(language: String?, text: String)
    case table(TableBlock)
    case image(source: String, alt: String)
    case html(String)
    case thematicBreak
}

/// A callout's kind: GitHub's five alerts, as the Mac draws them
/// (src/calloutTypes.ts — change both).
public enum CalloutKind: String, CaseIterable, Equatable, Sendable {
    case note, tip, important, warning, caution

    /// What its title says.
    public var name: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }

    /// The kind a quote's first line names: `[!NOTE]` alone on the line, any
    /// case. Anything after the marker (a title) is not GitHub's syntax.
    public static func marker(_ line: Substring) -> CalloutKind? {
        var t = line
        while let c = t.last, c == " " || c == "\t" { t = t.dropLast() }
        guard t.hasPrefix("[!"), t.hasSuffix("]"), t.count > 3 else { return nil }
        return CalloutKind(rawValue: t.dropFirst(2).dropLast().lowercased())
    }
}

public struct ListBlock: Equatable, Sendable {
    public let ordered: Bool
    /// The number an ordered list starts at.
    public let start: Int
    /// No blank lines between its items.
    public let tight: Bool
    public let items: [ListItem]
}

public struct ListItem: Equatable, Identifiable, Sendable {
    /// The source line its marker is on, 0-based.
    public let line: Int
    /// nil for an ordinary item; whether the box is ticked for a task.
    public let task: Bool?
    public let blocks: [BlockNode]

    public var id: Int { line }
}

public struct TableBlock: Equatable, Sendable {
    public enum Alignment: Equatable, Sendable { case leading, center, trailing }

    public let alignments: [Alignment]
    public let header: [[Inline]]
    public let rows: [[[Inline]]]
}

/// A heading of a note, for its outline. `id` is its block's.
public struct Heading: Equatable, Identifiable, Sendable {
    public let id: Int
    public let level: Int
    public let title: String
}

public struct MarkdownDocument: Equatable, Sendable {
    /// The YAML block at the top, without its fences — shown as it is, never interpreted.
    public let frontmatter: String?
    public let blocks: [BlockNode]

    public static func parse(_ source: String) -> MarkdownDocument {
        var parser = BlockParser()
        return parser.document(source)
    }

    /// Every heading in reading order, for an outline.
    public var headings: [Heading] {
        var out: [Heading] = []
        func walk(_ nodes: [BlockNode]) {
            for node in nodes {
                switch node.block {
                case .heading(let level, let content): out.append(Heading(id: node.id, level: level, title: content.plainText))
                case .blockquote(let inner), .callout(_, let inner): walk(inner)
                case .list(let list): list.items.forEach { walk($0.blocks) }
                default: break
                }
            }
        }
        walk(blocks)
        return out
    }

    /// The first heading, or nil: what to call a note that has one.
    public var title: String? { headings.first?.title }
}

/// A line of the source and where it was.
private struct Line {
    let number: Int
    var text: Substring

    var isBlank: Bool { text.allSatisfy { $0 == " " || $0 == "\t" } }

    /// Leading spaces, a tab counting to the next stop of four.
    var indent: Int {
        var n = 0
        for c in text {
            if c == " " { n += 1 } else if c == "\t" { n += 4 - n % 4 } else { break }
        }
        return n
    }

    /// The line with up to `count` columns of leading whitespace taken off.
    func dropping(_ count: Int) -> Line {
        var n = 0
        var rest = text
        while n < count, let c = rest.first, c == " " || c == "\t" {
            n += c == " " ? 1 : 4 - n % 4
            rest = rest.dropFirst()
        }
        return Line(number: number, text: rest)
    }

    var trimmed: Substring {
        var t = text
        while let c = t.first, c == " " || c == "\t" { t = t.dropFirst() }
        while let c = t.last, c == " " || c == "\t" { t = t.dropLast() }
        return t
    }
}

private struct BlockParser {
    var nextID = 0
    /// How deep `blocks` is: 1 for the note's own blocks. Only a top-level
    /// quote can be a callout, as GitHub has it.
    var nesting = 0

    mutating func node(_ line: Int, _ block: Block) -> BlockNode {
        defer { nextID += 1 }
        return BlockNode(id: nextID, line: line, block: block)
    }

    mutating func document(_ source: String) -> MarkdownDocument {
        var lines: [Line] = []
        for (n, raw) in MarkdownLines.split(source).enumerated() {
            lines.append(Line(number: n, text: raw))
        }
        var frontmatter: String?
        // `---` on the very first line opens it; `---` or `...` closes it.
        if let first = lines.first, first.trimmed == "---", first.indent == 0 {
            if let close = lines.dropFirst().firstIndex(where: { $0.indent == 0 && ($0.trimmed == "---" || $0.trimmed == "...") }) {
                frontmatter = lines[1..<close].map { String($0.text) }.joined(separator: "\n")
                lines = Array(lines[(close + 1)...])
            }
        }
        return MarkdownDocument(frontmatter: frontmatter, blocks: blocks(lines))
    }

    /* ---------- What a line starts ---------- */

    struct Fence {
        let char: Character
        let length: Int
        let indent: Int
        let info: String
    }

    func fence(_ line: Line) -> Fence? {
        guard line.indent <= 3 else { return nil }
        let t = line.trimmed
        guard let c = t.first, c == "`" || c == "~" else { return nil }
        let run = t.prefix { $0 == c }
        guard run.count >= 3 else { return nil }
        let info = t.dropFirst(run.count).trimmingCharacters(in: .whitespaces)
        if c == "`", info.contains("`") { return nil }
        return Fence(char: c, length: run.count, indent: line.indent, info: info)
    }

    func closes(_ line: Line, _ open: Fence) -> Bool {
        guard line.indent <= 3 else { return false }
        let t = line.trimmed
        return t.count >= open.length && t.allSatisfy { $0 == open.char }
    }

    func heading(_ line: Line) -> (level: Int, text: String)? {
        guard line.indent <= 3 else { return nil }
        let t = line.trimmed
        let hashes = t.prefix { $0 == "#" }
        guard (1...6).contains(hashes.count) else { return nil }
        let rest = t.dropFirst(hashes.count)
        guard rest.isEmpty || rest.first == " " || rest.first == "\t" else { return nil }
        var text = rest.trimmingCharacters(in: .whitespaces)
        // A closing run of #s is decoration.
        if let lastWord = text.split(separator: " ").last, lastWord.allSatisfy({ $0 == "#" }), text.count > lastWord.count || text == lastWord {
            text = String(text.dropLast(lastWord.count)).trimmingCharacters(in: .whitespaces)
        }
        return (hashes.count, text)
    }

    func isThematicBreak(_ line: Line) -> Bool {
        guard line.indent <= 3 else { return false }
        let marks = line.text.filter { $0 != " " && $0 != "\t" }
        guard marks.count >= 3, let c = marks.first, c == "-" || c == "*" || c == "_" else { return false }
        return marks.allSatisfy { $0 == c }
    }

    struct Marker {
        let ordered: Bool
        /// `-`, `*`, `+` for a bullet; `.` or `)` for a number.
        let kind: Character
        let number: Int
        /// Where the marker sits, how wide it is, and where the item's content starts.
        let indent: Int
        let width: Int
        let content: Int
        /// Nothing follows the marker on its line.
        let empty: Bool
    }

    func marker(_ line: Line) -> Marker? {
        let indent = line.indent
        let t = line.dropping(indent).text
        guard let first = t.first else { return nil }
        var width = 0
        var ordered = false
        var kind = first
        var number = 1
        if first == "-" || first == "*" || first == "+" {
            width = 1
        } else if first.isASCII, first.isNumber {
            let digits = t.prefix { $0.isASCII && $0.isNumber }
            guard digits.count <= 9, let delimiter = t.dropFirst(digits.count).first, delimiter == "." || delimiter == ")" else { return nil }
            width = digits.count + 1
            ordered = true
            kind = delimiter
            number = Int(digits) ?? 1
        } else {
            return nil
        }
        let after = t.dropFirst(width)
        if after.allSatisfy({ $0 == " " || $0 == "\t" }) {
            return Marker(ordered: ordered, kind: kind, number: number, indent: indent, width: width, content: indent + width + 1, empty: true)
        }
        guard after.first == " " || after.first == "\t" else { return nil }
        let spaces = Line(number: 0, text: after).indent
        // More than four spaces after the marker is one space and then code.
        return Marker(ordered: ordered, kind: kind, number: number, indent: indent, width: width, content: indent + width + (spaces > 4 ? 1 : spaces), empty: false)
    }

    func isQuote(_ line: Line) -> Bool { line.indent <= 3 && line.trimmed.first == ">" }

    func isHTMLStart(_ line: Line) -> Bool {
        guard line.indent <= 3 else { return false }
        let t = line.trimmed
        guard t.first == "<" else { return false }
        if t.hasPrefix("<!--") { return true }
        var name = t.dropFirst()
        if name.first == "/" { name = name.dropFirst() }
        let tag = name.prefix { $0.isLetter || $0.isNumber || $0 == "-" }.lowercased()
        return BlockParser.blockTags.contains(tag)
    }

    static let blockTags: Set<String> = [
        "address", "article", "aside", "blockquote", "details", "dialog", "div", "dl", "fieldset", "figcaption", "figure",
        "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "iframe", "img", "main", "nav", "ol", "p",
        "pre", "script", "section", "style", "summary", "svg", "table", "ul", "video", "audio", "picture", "center",
    ]

    /// `| --- | :-: |` — the row under a table's header.
    func tableAlignments(_ line: Line) -> [TableBlock.Alignment]? {
        let t = line.trimmed
        guard t.contains("-"), t.allSatisfy({ $0 == "|" || $0 == "-" || $0 == ":" || $0 == " " || $0 == "\t" }) else { return nil }
        var out: [TableBlock.Alignment] = []
        for cell in cells(String(t)) {
            let c = cell.trimmingCharacters(in: .whitespaces)
            guard c.contains("-"), !c.dropFirst().dropLast().contains(":") else { return nil }
            out.append(c.hasPrefix(":") && c.hasSuffix(":") ? .center : (c.hasSuffix(":") ? .trailing : .leading))
        }
        return out.isEmpty ? nil : out
    }

    /// A table row's cells: split at bars that are not escaped and not in code.
    func cells(_ row: String) -> [String] {
        var out: [String] = []
        var cell = ""
        var inCode = false
        var previous: Character?
        for c in row.trimmingCharacters(in: .whitespaces) {
            if c == "`" { inCode.toggle() }
            if c == "|" && !inCode && previous != "\\" {
                out.append(cell)
                cell = ""
            } else {
                if c == "|" && previous == "\\" { cell.removeLast() }
                cell.append(c)
            }
            previous = c
        }
        out.append(cell)
        // The bars at the two ends are optional, and bound no cell.
        if out.first?.trimmingCharacters(in: .whitespaces).isEmpty == true { out.removeFirst() }
        if out.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { out.removeLast() }
        return out
    }

    /// Whether a line would end the paragraph before it.
    func interrupts(_ line: Line) -> Bool {
        if line.isBlank || fence(line) != nil || heading(line) != nil || isQuote(line) || isThematicBreak(line) || isHTMLStart(line) { return true }
        if let m = marker(line), !m.empty, !m.ordered || m.number == 1 { return true }
        return false
    }

    /* ---------- Blocks ---------- */

    mutating func blocks(_ lines: [Line]) -> [BlockNode] {
        nesting += 1
        defer { nesting -= 1 }
        var out: [BlockNode] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.isBlank {
                i += 1
                continue
            }

            if let open = fence(line) {
                var body: [String] = []
                i += 1
                while i < lines.count, !closes(lines[i], open) {
                    body.append(String(lines[i].dropping(open.indent).text))
                    i += 1
                }
                i += 1
                let language = open.info.split(separator: " ").first.map(String.init)
                out.append(node(line.number, .code(language: language, text: body.joined(separator: "\n"))))
                continue
            }

            if line.indent >= 4 {
                var body: [String] = []
                while i < lines.count, lines[i].indent >= 4 || lines[i].isBlank {
                    body.append(String(lines[i].dropping(4).text))
                    i += 1
                }
                while body.last?.isEmpty == true { body.removeLast() }
                out.append(node(line.number, .code(language: nil, text: body.joined(separator: "\n"))))
                continue
            }

            if let h = heading(line) {
                out.append(node(line.number, .heading(level: h.level, content: InlineParser.parse(h.text))))
                i += 1
                continue
            }

            if isThematicBreak(line) {
                out.append(node(line.number, .thematicBreak))
                i += 1
                continue
            }

            if isQuote(line) {
                var inner: [Line] = []
                while i < lines.count {
                    let l = lines[i]
                    if isQuote(l) {
                        var rest = l.dropping(l.indent).text.dropFirst()
                        if rest.first == " " { rest = rest.dropFirst() }
                        inner.append(Line(number: l.number, text: rest))
                    } else if !interrupts(l), let last = inner.last, !last.isBlank {
                        // A paragraph inside the quote runs on without its `>`.
                        inner.append(l)
                    } else {
                        break
                    }
                    i += 1
                }
                let number = line.number
                if nesting == 1, let first = inner.first, let kind = CalloutKind.marker(first.text) {
                    let body = blocks(Array(inner.dropFirst()))
                    out.append(node(number, .callout(kind: kind, blocks: body)))
                    continue
                }
                let quoted = blocks(inner)
                out.append(node(number, .blockquote(quoted)))
                continue
            }

            if let first = marker(line) {
                let (list, next) = parseList(lines, from: i, first)
                out.append(node(line.number, .list(list)))
                i = next
                continue
            }

            if line.text.contains("|"), i + 1 < lines.count, let alignments = tableAlignments(lines[i + 1]) {
                let header = cells(String(line.text))
                if header.count == alignments.count {
                    var rows: [[[Inline]]] = []
                    i += 2
                    while i < lines.count, !lines[i].isBlank, lines[i].text.contains("|"), !interruptsTable(lines[i]) {
                        var row = cells(String(lines[i].text)).map { InlineParser.parse($0.trimmingCharacters(in: .whitespaces)) }
                        // A row is as wide as its header: short ones are padded, long ones cut.
                        while row.count < alignments.count { row.append([]) }
                        rows.append(Array(row.prefix(alignments.count)))
                        i += 1
                    }
                    let head = header.map { InlineParser.parse($0.trimmingCharacters(in: .whitespaces)) }
                    out.append(node(line.number, .table(TableBlock(alignments: alignments, header: head, rows: rows))))
                    continue
                }
            }

            if isHTMLStart(line) {
                var body: [String] = []
                let comment = line.trimmed.hasPrefix("<!--")
                while i < lines.count {
                    let l = lines[i]
                    if !comment, l.isBlank { break }
                    body.append(String(l.text))
                    i += 1
                    if comment, l.text.contains("-->") { break }
                }
                // An html comment is a note to whoever edits the source, not to the reader.
                if !comment { out.append(node(line.number, .html(body.joined(separator: "\n")))) }
                continue
            }

            // A paragraph: every line until a blank one or the start of something else.
            var text: [Substring] = [line.trimmedLeading]
            i += 1
            var setext: Int?
            while i < lines.count {
                let l = lines[i]
                if l.indent <= 3, let level = setextLevel(l) {
                    setext = level
                    i += 1
                    break
                }
                if interrupts(l) { break }
                text.append(l.trimmedLeading)
                i += 1
            }
            let content = InlineParser.parse(text.joined(separator: "\n"))
            if let level = setext {
                out.append(node(line.number, .heading(level: level, content: content)))
            } else if content.count == 1, case .image(let source, let alt) = content[0] {
                out.append(node(line.number, .image(source: source, alt: alt)))
            } else {
                out.append(node(line.number, .paragraph(content)))
            }
        }
        return out
    }

    func interruptsTable(_ line: Line) -> Bool {
        fence(line) != nil || heading(line) != nil || isQuote(line)
    }

    /// `===` under a paragraph makes it a first-level heading, `---` a second.
    func setextLevel(_ line: Line) -> Int? {
        let t = line.trimmed
        guard let c = t.first, c == "=" || c == "-", t.allSatisfy({ $0 == c }) else { return nil }
        return c == "=" ? 1 : 2
    }

    /// The list that starts at `lines[start]`, and the index after it.
    mutating func parseList(_ lines: [Line], from start: Int, _ first: Marker) -> (ListBlock, Int) {
        var items: [ListItem] = []
        var tight = true
        var i = start
        var current: Marker? = first
        while let m = current, i < lines.count {
            let head = lines[i]
            var body: [Line] = []
            if !m.empty {
                // The marker comes off, then the space between it and the words.
                let afterMarker = Line(number: head.number, text: head.dropping(m.indent).text.dropFirst(m.width))
                body.append(afterMarker.dropping(m.content - m.indent - m.width))
            }
            i += 1
            var blankRun = 0
            var sawBlankInside = false
            while i < lines.count {
                let l = lines[i]
                if l.isBlank {
                    blankRun += 1
                    i += 1
                    continue
                }
                if l.indent >= m.content {
                    if blankRun > 0 {
                        body.append(contentsOf: Array(repeating: Line(number: l.number, text: ""), count: blankRun))
                        sawBlankInside = true
                    }
                    blankRun = 0
                    body.append(l.dropping(m.content))
                    i += 1
                    continue
                }
                // Less indented than the item's content: its paragraph running
                // on lazily, a sibling, or the end of the list.
                if blankRun == 0, marker(l) == nil, !interrupts(l), let last = body.last, !last.isBlank {
                    body.append(Line(number: l.number, text: l.trimmedLeading))
                    i += 1
                    continue
                }
                break
            }

            var task: Bool?
            if let firstLine = body.first {
                let t = firstLine.text
                if t.hasPrefix("[ ]") || t.hasPrefix("[x]") || t.hasPrefix("[X]") {
                    let rest = t.dropFirst(3)
                    if rest.isEmpty || rest.first == " " || rest.first == "\t" {
                        task = !t.hasPrefix("[ ]")
                        body[0] = Line(number: firstLine.number, text: rest.drop { $0 == " " || $0 == "\t" })
                    }
                }
            }
            let inner = blocks(body)
            items.append(ListItem(line: head.number, task: task, blocks: inner))
            if sawBlankInside { tight = false }

            // Another item of this list, or something else?
            current = nil
            if i < lines.count, let next = marker(lines[i]), next.ordered == first.ordered, next.kind == first.kind,
               next.indent < m.content, next.indent >= first.indent, next.indent <= first.indent + 3,
               !isThematicBreak(lines[i]) {
                current = next
                if blankRun > 0 { tight = false }
            }
        }
        return (ListBlock(ordered: first.ordered, start: first.number, tight: tight, items: items), i)
    }
}

private extension Line {
    var trimmedLeading: Substring {
        var t = text
        while let c = t.first, c == " " || c == "\t" { t = t.dropFirst() }
        return t
    }
}
