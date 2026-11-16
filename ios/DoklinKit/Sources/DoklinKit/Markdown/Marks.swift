// Marks laid over a note as it is read: the words a search found, and what
// changed since this person last read it. Both are worked out here, on the
// parsed note, and the reader only draws them: a stretch of a block's text,
// by character, gets a tint.
//
// A block's text is the text of its runs (`[Inline].runs`), joined: what
// the reader draws, so an offset here is an offset there. Each piece of
// text the reader draws on its own is a *container*, named by the block it
// is in (`Find.container`).

import Foundation

/// How a stretch of text is marked.
public enum RunMark: Equatable, Sendable {
    /// A word the search found.
    case found
    /// The one of those the find bar is on.
    case current
    /// Written since this person last read the note.
    case added
    /// Gone since then: put back, struck through.
    case removed
}

public struct MarkedRun: Equatable, Sendable {
    public let run: InlineRun
    public let mark: RunMark?
}

/// Words put back into a block where they were before they went.
public struct Removal: Equatable, Sendable {
    /// The character offset in the block's text now.
    public let at: Int
    public let text: String
}

public enum RunMarks {
    /// `runs` cut where `marks` begin and end (character offsets into their
    /// joined text), each stretch marked, with `removals` put back in.
    /// Marks do not overlap.
    public static func apply(_ runs: [InlineRun], marks: [(range: Range<Int>, mark: RunMark)], removals: [Removal] = []) -> [MarkedRun] {
        guard !marks.isEmpty || !removals.isEmpty else { return runs.map { MarkedRun(run: $0, mark: nil) } }
        var cuts = Set<Int>()
        for mark in marks {
            cuts.insert(mark.range.lowerBound)
            cuts.insert(mark.range.upperBound)
        }
        for removal in removals { cuts.insert(removal.at) }
        let markAt = { (offset: Int) in marks.first { $0.range.contains(offset) }?.mark }
        var pending = removals.sorted { $0.at < $1.at }
        var out: [MarkedRun] = []
        func putBack(upTo offset: Int, style: InlineRun?) {
            while let first = pending.first, first.at <= offset {
                var run = InlineRun(first.text)
                if let style {
                    run.bold = style.bold
                    run.italic = style.italic
                    run.code = style.code
                }
                out.append(MarkedRun(run: run, mark: .removed))
                pending.removeFirst()
            }
        }
        var offset = 0
        for run in runs {
            let characters = Array(run.text)
            var start = 0
            while start < characters.count {
                putBack(upTo: offset + start, style: run)
                var end = start + 1
                while end < characters.count, !cuts.contains(offset + end) { end += 1 }
                var piece = run
                piece.text = String(characters[start..<end])
                out.append(MarkedRun(run: piece, mark: markAt(offset + start)))
                start = end
            }
            offset += characters.count
        }
        putBack(upTo: Int.max, style: runs.last)
        return out
    }

    /// The text a block's runs draw.
    public static func text(_ runs: [InlineRun]) -> String {
        runs.map(\.text).joined()
    }

    /// Every place `query` is in `text`, ignoring case and accents, as
    /// character offsets.
    public static func ranges(of query: String, in text: String) -> [Range<Int>] {
        guard !query.isEmpty else { return [] }
        var out: [Range<Int>] = []
        var from = text.startIndex
        while from < text.endIndex,
              let found = text.range(of: query, options: [.caseInsensitive, .diacriticInsensitive], range: from..<text.endIndex) {
            guard !found.isEmpty else { break }
            let lower = text.distance(from: text.startIndex, to: found.lowerBound)
            out.append(lower..<(lower + text.distance(from: found.lowerBound, to: found.upperBound)))
            from = found.upperBound
        }
        return out
    }
}

/* ---------- Find ---------- */

/// The words a search found, in one note, in reading order.
public struct FindResult: Equatable, Sendable {
    public struct Occurrence: Equatable, Sendable {
        /// The piece of text it is in (`Find.container`).
        public let container: String
        public let range: Range<Int>
        /// The top-level block it is in: what the reader scrolls to.
        public let top: Int
    }

    public let query: String
    public let occurrences: [Occurrence]

    public var count: Int { occurrences.count }

    /// What to mark in one container, with the find bar on `current`.
    public func marks(in container: String, current: Int?) -> [(range: Range<Int>, mark: RunMark)] {
        occurrences.enumerated().compactMap { index, occurrence in
            occurrence.container == container ? (occurrence.range, index == current ? .current : .found) : nil
        }
    }
}

public enum Find {
    /// A heading's, a paragraph's or a code block's text, by its block's id.
    public static func container(_ block: Int) -> String { "\(block)" }

    /// A table cell's text: `row` -1 is the header.
    public static func container(table: Int, row: Int, column: Int) -> String { "\(table).\(row).\(column)" }

    /// Every place `query` is in what the note shows.
    public static func occurrences(of query: String, in document: MarkdownDocument) -> FindResult {
        let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
        var out: [FindResult.Occurrence] = []
        func add(_ container: String, _ text: String, top: Int) {
            for range in RunMarks.ranges(of: wanted, in: text) {
                out.append(FindResult.Occurrence(container: container, range: range, top: top))
            }
        }
        func walk(_ node: BlockNode, top: Int) {
            switch node.block {
            case .heading(_, let content), .paragraph(let content):
                add(container(node.id), RunMarks.text(content.runs), top: top)
            case .code(_, let text):
                add(container(node.id), text, top: top)
            case .blockquote(let inner):
                inner.forEach { walk($0, top: top) }
            case .list(let list):
                list.items.forEach { $0.blocks.forEach { walk($0, top: top) } }
            case .table(let table):
                for (column, cell) in table.header.enumerated() {
                    add(container(table: node.id, row: -1, column: column), RunMarks.text(cell.runs), top: top)
                }
                for (row, cells) in table.rows.enumerated() {
                    for (column, cell) in cells.enumerated() {
                        add(container(table: node.id, row: row, column: column), RunMarks.text(cell.runs), top: top)
                    }
                }
            case .image, .html, .thematicBreak:
                break
            }
        }
        if !wanted.isEmpty {
            for node in document.blocks { walk(node, top: node.id) }
        }
        return FindResult(query: wanted, occurrences: out)
    }

    /// The top-level block the source line `line` (0-based) is in: where a
    /// search hit is when the words are not in what the note shows (they
    /// span its markup).
    public static func block(atLine line: Int, in document: MarkdownDocument) -> Int? {
        document.blocks.last { $0.line <= line }?.id
    }
}

/* ---------- What changed since it was read ---------- */

/// What changed in a note between the version this person last read and
/// now, block by block, as marks on the note now.
public struct ChangeMarks: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case inserted
        case changed
    }

    /// Top-level blocks that are new or changed, by id.
    public var blocks: [Int: Kind] = [:]
    /// List items that are new or changed, by their line.
    public var items: [Int: Kind] = [:]
    /// Inside a changed paragraph or heading: the words written since, and
    /// those gone, by container.
    public var words: [String: Words] = [:]
    /// Blocks gone, by the block now in their place (by id): their text.
    public var removedBefore: [Int: [String]] = [:]
    /// Blocks gone from the end.
    public var removedAtEnd: [String] = []
    /// Each change in reading order, as the top-level block it is in.
    public var stops: [Int] = []

    public struct Words: Equatable, Sendable {
        public var added: [Range<Int>] = []
        public var removed: [Removal] = []

        public var marks: [(range: Range<Int>, mark: RunMark)] { added.map { ($0, .added) } }
    }

    public var count: Int { stops.count }
    public var isEmpty: Bool { stops.isEmpty }

    /// One block or list item, as compared.
    private struct Unit {
        enum Shape: Equatable { case words, item, other }
        let top: Int
        let item: Int?
        let shape: Shape
        let key: String
        /// What it says, as a removed block is shown.
        let shown: String
        /// The container whose words are compared, with its runs.
        let container: String?
        let runs: [InlineRun]
    }

    private static func units(_ document: MarkdownDocument) -> [Unit] {
        var out: [Unit] = []
        for node in document.blocks {
            switch node.block {
            case .heading(let level, let content):
                out.append(Unit(top: node.id, item: nil, shape: .words, key: "h\(level) " + RunMarks.text(content.runs), shown: content.plainText, container: Find.container(node.id), runs: content.runs))
            case .paragraph(let content):
                out.append(Unit(top: node.id, item: nil, shape: .words, key: "p " + RunMarks.text(content.runs), shown: content.plainText, container: Find.container(node.id), runs: content.runs))
            case .list(let list):
                for item in list.items {
                    let mark = item.task.map { $0 ? "[x] " : "[ ] " } ?? ""
                    let text = item.blocks.map(\.plainText).joined(separator: "\n")
                    var container: String?
                    var runs: [InlineRun] = []
                    if let first = item.blocks.first, case .paragraph(let content) = first.block {
                        container = Find.container(first.id)
                        runs = content.runs
                    }
                    out.append(Unit(top: node.id, item: item.line, shape: .item, key: "li " + mark + text, shown: text, container: container, runs: runs))
                }
            default:
                out.append(Unit(top: node.id, item: nil, shape: .other, key: "\(node.block)", shown: node.plainText, container: nil, runs: []))
            }
        }
        return out
    }

    /// Compare what was read with what is there now.
    public static func between(_ old: MarkdownDocument, _ new: MarkdownDocument) -> ChangeMarks {
        let before = units(old)
        let now = units(new)
        var marks = ChangeMarks()
        guard before.count * now.count <= 4_000_000 else { return marks }
        let pairs = lcs(before.map(\.key), now.map(\.key))
        var oldIndex = 0
        var newIndex = 0
        func gap(_ oldEnd: Int, _ newEnd: Int) {
            let gone = Array(before[oldIndex..<oldEnd])
            let came = Array(now[newIndex..<newEnd])
            var paired = 0
            while paired < gone.count, paired < came.count, gone[paired].shape == came[paired].shape {
                marks.mark(came[paired], .changed, against: gone[paired])
                paired += 1
            }
            for unit in came.dropFirst(paired) { marks.mark(unit, .inserted, against: nil) }
            let removed = gone.dropFirst(paired).map { String($0.shown.prefix(300)) }
            if !removed.isEmpty {
                if newEnd < now.count {
                    marks.removedBefore[now[newEnd].top, default: []] += removed
                    marks.stops.append(now[newEnd].top)
                } else {
                    marks.removedAtEnd += removed
                    if let last = now.last { marks.stops.append(last.top) }
                }
            }
        }
        for (o, n) in pairs {
            gap(o, n)
            oldIndex = o + 1
            newIndex = n + 1
        }
        gap(before.count, now.count)
        return marks
    }

    private mutating func mark(_ unit: Unit, _ kind: Kind, against old: Unit?) {
        if let item = unit.item {
            items[item] = kind
        } else {
            blocks[unit.top] = kind
        }
        stops.append(unit.top)
        guard kind == .changed, let old, let container = unit.container, !unit.runs.isEmpty, !old.runs.isEmpty else { return }
        if let words = Self.words(from: RunMarks.text(old.runs), to: RunMarks.text(unit.runs)) {
            self.words[container] = words
        }
    }

    /// Word by word: what was written since, as ranges of `new`, and what
    /// went, as removals — or nil when so much changed that marking words
    /// would say less than the bar does.
    static func words(from old: String, to new: String) -> Words? {
        let a = tokens(old)
        let b = tokens(new)
        guard a.count * b.count <= 250_000 else { return nil }
        let kept = lcs(a.map(\.text), b.map(\.text))
        let keptNew = Set(kept.map(\.1))
        let keptOld = Set(kept.map(\.0))
        let words = { (list: [Token]) in list.filter { !$0.isSpace }.count }
        let changedNew = b.enumerated().filter { !keptNew.contains($0.offset) && !$0.element.isSpace }.count
        guard words(b) > 0, Double(changedNew) / Double(words(b)) <= 0.6 else { return nil }
        var out = Words()
        // A space between two changed words is part of the change, kept or not.
        let pairsByOld = Dictionary(uniqueKeysWithValues: kept.map { ($0.0, $0.1) })
        // Added: runs of new words not kept, with the spaces between them.
        var index = 0
        while index < b.count {
            guard !keptNew.contains(index), !b[index].isSpace else {
                index += 1
                continue
            }
            var end = index
            var next = index + 1
            while next < b.count, b[next].isSpace || !keptNew.contains(next) {
                if !b[next].isSpace { end = next }
                next += 1
            }
            out.added.append(b[index].start..<(b[end].start + b[end].text.count))
            index = end + 1
        }
        // Removed: runs of old words not kept, put back in front of the word
        // that now follows the last one kept before them.
        var oldAt = 0
        var position = 0
        while oldAt < a.count {
            if a[oldAt].isSpace || keptOld.contains(oldAt) {
                if let n = pairsByOld[oldAt] { position = b[n].start + b[n].text.count }
                oldAt += 1
                continue
            }
            var last = oldAt
            var next = oldAt + 1
            while next < a.count, a[next].isSpace || !keptOld.contains(next) {
                if !a[next].isSpace { last = next }
                next += 1
            }
            let gone = a[oldAt...last].map(\.text).joined()
            oldAt = last + 1
            let at = b.first { $0.start >= position && !$0.isSpace }?.start ?? position
            out.removed.append(Removal(at: at, text: gone + " "))
        }
        return out.added.isEmpty && out.removed.isEmpty ? nil : out
    }

    private struct Token {
        let text: String
        let start: Int
        var isSpace: Bool { text.allSatisfy(\.isWhitespace) }
    }

    private static func tokens(_ text: String) -> [Token] {
        var out: [Token] = []
        var current = ""
        var start = 0
        var offset = 0
        var space: Bool?
        for character in text {
            let isSpace = character.isWhitespace
            if space != nil, isSpace != space {
                out.append(Token(text: current, start: start))
                current = ""
                start = offset
            }
            current.append(character)
            space = isSpace
            offset += 1
        }
        if !current.isEmpty { out.append(Token(text: current, start: start)) }
        return out
    }

    /// The longest common subsequence of two lists, as index pairs in order.
    static func lcs(_ a: [String], _ b: [String]) -> [(Int, Int)] {
        let n = a.count
        let m = b.count
        guard n > 0, m > 0 else { return [] }
        var table = [[Int]](repeating: [Int](repeating: 0, count: m + 1), count: n + 1)
        for i in stride(from: n - 1, through: 0, by: -1) {
            for j in stride(from: m - 1, through: 0, by: -1) {
                table[i][j] = a[i] == b[j] ? table[i + 1][j + 1] + 1 : max(table[i + 1][j], table[i][j + 1])
            }
        }
        var out: [(Int, Int)] = []
        var i = 0
        var j = 0
        while i < n, j < m {
            if a[i] == b[j] {
                out.append((i, j))
                i += 1
                j += 1
            } else if table[i + 1][j] >= table[i][j + 1] {
                i += 1
            } else {
                j += 1
            }
        }
        return out
    }
}
