// One document's comment threads, read off its files and changed the way
// the Mac and the worker change them: a new thread wraps words of the note
// in a bare marker and adds its record; a reply adds an entry to the
// record; removing a thread drops the record and unwraps its words. Pure —
// the files in, the files out; `CommentsModel` reads and writes them.
//
// The worker does the same for an agent (cloud-worker/src/agentComments.ts:
// `threadsOf`, `anchorProblem`, `placeForMarker`), and where a thread may
// sit is its rule, said here in sentences for a person — change both;
// verify-harness/comments-fixture.json holds the two to the same answers.

import Foundation

/// Which form of a document a thread is on.
public enum CommentVersion: String, Equatable, Sendable {
    case md
    case html
}

public struct CommentThread: Identifiable, Equatable, Sendable {
    /// Its id as it is shown and asked for. One holding half a character —
    /// only a hand edit makes one — reads here, and is answered on a Mac.
    public let id: String
    public let version: CommentVersion
    /// What it is on: the marked words; on a page, its words, or the start
    /// of the part it is on.
    public let on: String
    /// A markdown thread's line in the file, from 1, when it can be told.
    public let line: Int?
    /// An html thread's part, or the part its words are in.
    public let tag: String?
    /// What it was on is gone: its marker was taken out of the note, or the
    /// page's file has neither its words nor its part.
    public let orphaned: Bool
    public let comments: [CommentEntry]
}

/// When a comment was written, as the Mac's comments say it: "just now",
/// "5m ago", "3h ago", "2d ago", then the day.
public enum CommentTime {
    public static func words(_ at: Double, now: Double, calendar: Calendar = .current, locale: Locale = .current) -> String? {
        guard at != 0, !at.isNaN else { return nil }
        let delta = now - at
        if delta < 60_000 { return "just now" }
        if delta < 3_600_000 { return "\(Int(delta / 60_000))m ago" }
        if delta < 86_400_000 { return "\(Int(delta / 3_600_000))h ago" }
        if delta < 7 * 86_400_000 { return "\(Int(delta / 86_400_000))d ago" }
        let date = Date(timeIntervalSince1970: at / 1000)
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: Date(timeIntervalSince1970: now / 1000))
        let format = DateFormatter()
        format.calendar = calendar
        format.locale = locale
        format.timeZone = calendar.timeZone
        format.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "yMMMd")
        return format.string(from: date)
    }
}

/// Why a comment cannot go where it was asked to, in a sentence.
public enum CommentRefusal: Error, Equatable, Sendable {
    /// What words cannot carry a marker inside.
    public enum Closed: String, Equatable, Sendable {
        case frontmatter
        case codeBlock = "code block"
        case code
        case link
        case htmlTag = "html tag"
        case comment
        /// The words open a line with a heading's or a list's mark.
        case mark
    }

    case noWords
    case oneLine
    case formatting
    case missing(String)
    case inside(String, Closed)
    case many(String, Int)
    case nothingSaid
    case noMarkdown
    case gone

    public var message: String {
        switch self {
        case .noWords: return "Say which words the comment is on."
        case .oneLine: return "A comment sits on words within one paragraph — quote text from a single line."
        case .formatting: return "Quote plain words — without formatting marks such as **, backticks, links or table bars."
        case .missing(let on): return "“\(on)” is not in this note — quote the words exactly as they are written."
        case .inside(let on, let closed):
            switch closed {
            case .mark: return "“\(on)” opens a heading or a list item — quote the words after its mark."
            case .frontmatter: return "“\(on)” is only in the frontmatter at the top — a comment needs words in ordinary text."
            case .codeBlock: return "“\(on)” is only inside a code block — a comment needs words in ordinary text."
            case .code: return "“\(on)” is only inside code — a comment needs words in ordinary text."
            case .link: return "“\(on)” is only inside a link’s address — a comment needs words in ordinary text."
            case .htmlTag: return "“\(on)” is only inside an html tag — a comment needs words in ordinary text."
            case .comment: return "“\(on)” already has a comment — answer that one, or quote other words."
            }
        case .many(let on, let count): return "“\(on)” is in this note \(count) times — quote more of the sentence, so that it is there once."
        case .nothingSaid: return "A comment needs something to say."
        case .noMarkdown: return "A comment can only be started on a note’s markdown."
        case .gone: return "That thread is not on this document any more."
        }
    }
}

public struct DocumentComments: Equatable, Sendable {
    /// The markdown as its file has it; nil for a page with none.
    public let disk: String?
    /// The page, when the document has one.
    public let html: String?
    /// The meta file's records as the file has them.
    private let read: EntityMeta
    /// The markdown with every marker bare: what a change starts from, and
    /// what is written back.
    public private(set) var md: JSString?
    public private(set) var meta: EntityMeta

    /// The document's files as they are: the markdown, the meta file's
    /// text (nil when there is none) and the page.
    public init(md: String?, meta: String?, html: String?) {
        disk = md
        self.html = html
        read = meta.map(MetaFile.parse) ?? EntityMeta()
        (self.md, self.meta) = MetaFile.roundTrip(md: md.map { JSString($0) }, meta: read)
    }

    /* ---------- Reading ---------- */

    /// Every thread: the markdown's in the order they are in the note, then
    /// those whose words are gone, then the page's.
    public var threads: [CommentThread] {
        var out: [CommentThread] = []
        if let disk {
            // Inline threads, bare markers and hand-written ones read alike:
            // entries put back, then taken out again, as the Mac's opening
            // and saving do.
            let text = JSString(disk)
            let expanded = MetaFile.expand(text, read.mthreads)
            let extracted = MetaFile.extract(expanded.md)
            var bodies: [JSString: [CommentEntry]] = [:]
            for thread in extracted.mthreads { bodies[thread.id] = thread.comments }
            let raw = CriticMarkup.blocks(in: text)
            let bare = CriticMarkup.blocks(in: extracted.md)
            var seen = Set<String>()
            for (i, block) in bare.enumerated() {
                guard let id = CriticMarkup.parseSpans(block.spans).id, !seen.contains(id), let comments = bodies[JSString(id)] else { continue }
                seen.insert(id)
                let line = raw.count == bare.count ? Self.line(in: disk, at: raw[i].range.location) : nil
                out.append(CommentThread(id: id, version: .md, on: block.anchor.string, line: line, tag: nil, orphaned: false, comments: comments))
            }
            let orphans = Set(expanded.orphanIds)
            for thread in read.mthreads where orphans.contains(thread.id) {
                out.append(CommentThread(id: thread.id.string, version: .md, on: "", line: nil, tag: nil, orphaned: true, comments: thread.comments))
            }
        } else {
            for thread in read.mthreads {
                out.append(CommentThread(id: thread.id.string, version: .md, on: "", line: nil, tag: nil, orphaned: true, comments: thread.comments))
            }
        }
        // A thread is gone when the file has neither its words nor its
        // part, and the file can say so (`HtmlText.place`): what a page's
        // script builds is not in it. With no page there is nothing it is on.
        let page = read.hthreads.isEmpty ? nil : html.map(HtmlText.page)
        for thread in read.hthreads {
            let anchor = thread.anchor
            let place = page.map { HtmlText.place(of: anchor, in: $0) } ?? FilePlace(level: 0, known: true)
            out.append(CommentThread(
                id: thread.id.string, version: .html, on: (anchor.quote.isEmpty ? anchor.text : anchor.quote).string, line: nil,
                tag: anchor.tag.string, orphaned: place.level == 0 && place.known, comments: thread.comments
            ))
        }
        return out
    }

    private static func line(in text: String, at index: Int) -> Int {
        1 + text.utf16.prefix(index).filter { $0 == 0x0A }.count
    }

    /* ---------- Changing ---------- */

    /// An id no thread of this document has, and that its markdown does not
    /// hold as `#id` anywhere.
    public func freshId<R: RandomNumberGenerator>(using random: inout R) -> String {
        let taken = Set(meta.mthreads.map(\.id) + meta.hthreads.map(\.id))
        let text = md?.string ?? ""
        while true {
            let id = CriticMarkup.newThreadId(using: &random)
            if !taken.contains(JSString(id)), !text.contains("#\(id)") { return id }
        }
    }

    /// An entry stamped to the second: the markdown form keeps no finer
    /// time, so a finer stamp would differ from its own round trip and every
    /// Mac would write the file again to say so.
    static func entry(author: String, at: Double, body: String) -> CommentEntry {
        CommentEntry(author: CriticMarkup.sanitizeAuthor(author), at: (at / 1000).rounded(.down) * 1000, body: JSString(body))
    }

    /// Start a thread on `words` of the note, saying `body`.
    public mutating func start(on words: String, body: String, author: String, at: Double, id: String) throws {
        guard let md else { throw CommentRefusal.noMarkdown }
        let said = CriticMarkup.sanitizeBody(body)
        guard !said.isEmpty else { throw CommentRefusal.nothingSaid }
        let on = JSText.trim(words)
        if let problem = Placing.problem(on) { throw problem }
        let index = try Placing.place(on, in: md.string)
        let marked = Array("{==\(on)==}{>>#\(id)<<}".utf16)
        self.md = JSString(units: md.units[0..<index] + marked + md.units[(index + on.utf16.count)...])
        meta.mthreads.append(MdThread(id: JSString(id), comments: [Self.entry(author: author, at: at, body: said)]))
    }

    /// Answer a thread. The markdown does not change.
    public mutating func reply(to id: String, body: String, author: String, at: Double) throws {
        let said = CriticMarkup.sanitizeBody(body)
        guard !said.isEmpty else { throw CommentRefusal.nothingSaid }
        let entry = Self.entry(author: author, at: at, body: said)
        let key = JSString(id)
        if let index = meta.mthreads.firstIndex(where: { $0.id == key }) {
            meta.mthreads[index].comments.append(entry)
        } else if let index = meta.hthreads.firstIndex(where: { $0.id == key }) {
            meta.hthreads[index].comments.append(entry)
        } else {
            throw CommentRefusal.gone
        }
    }

    /// Take a reply out of a thread: `entry`, as it was shown at `index`.
    /// The files are read again for every change and sync may have moved
    /// the thread on since, so the entry is found by who wrote it and when —
    /// the one at `index` when that is still it — and a reply that is gone
    /// is not looked for elsewhere. The first entry is the thread itself,
    /// which `remove` takes.
    public mutating func deleteReply(of id: String, entry: CommentEntry, at index: Int) throws {
        func drop(from comments: inout [CommentEntry]) throws {
            let wanted = entry.identity
            let matching = comments.indices.dropFirst().filter { comments[$0].identity == wanted }
            guard let at = matching.contains(index) ? index : matching.first else { throw CommentRefusal.gone }
            comments.remove(at: at)
        }
        let key = JSString(id)
        if let t = meta.mthreads.firstIndex(where: { $0.id == key }) {
            try drop(from: &meta.mthreads[t].comments)
        } else if let t = meta.hthreads.firstIndex(where: { $0.id == key }) {
            try drop(from: &meta.hthreads[t].comments)
        } else {
            throw CommentRefusal.gone
        }
    }

    /// Remove a thread: its record goes, and its marker with it — the words
    /// it was on stay.
    public mutating func remove(_ id: String) throws {
        let key = JSString(id)
        if meta.mthreads.contains(where: { $0.id == key }) {
            meta.mthreads.removeAll { $0.id == key }
            md = md.map { md in
                CriticMarkup.replacingBlocks(in: md) { block in
                    CriticMarkup.parseSpans(block.spans).id == id ? block.anchor : block.whole
                }
            }
        } else if meta.hthreads.contains(where: { $0.id == key }) {
            meta.hthreads.removeAll { $0.id == key }
        } else {
            throw CommentRefusal.gone
        }
    }

    /// What the meta file should now say, or nil when there should be none:
    /// a file is never made for nothing, and once made it is emptied, not
    /// deleted, as the Mac keeps it.
    public func metaText(fileExists: Bool) -> String? {
        meta.isEmpty && !fileExists ? nil : MetaFile.serialize(meta)
    }
}

/// Where in a note new words can carry a marker: the worker's rule for an
/// agent's comment (agentComments.ts `anchorProblem`, `closedRanges`,
/// `placeForMarker`), word for word — change both.
enum Placing {
    private static let formatting: Set<UInt16> = Set("*`[]<>|\\{}".utf16)
    private static let edgeBefore: Set<UInt16> = Set("(".utf16)
    private static let edgeAfter: Set<UInt16> = Set(").,;:!?".utf16)

    /// Why these words cannot carry a comment, whatever the note says.
    static func problem(_ on: String) -> CommentRefusal? {
        let units = Array(on.utf16)
        if units.isEmpty { return .noWords }
        if units.contains(0x0D) || units.contains(0x0A) { return .oneLine }
        if units.contains(where: formatting.contains) || zip(units, units.dropFirst()).contains(where: { $0 == 0x7E && $1 == 0x7E }) {
            return .formatting
        }
        // An underscore at a word's edge is emphasis to markdown.
        for (i, unit) in units.enumerated() where unit == 0x5F {
            let before = i == 0 || JSText.isSpace(units[i - 1]) || edgeBefore.contains(units[i - 1])
            let after = i == units.count - 1 || JSText.isSpace(units[i + 1]) || edgeAfter.contains(units[i + 1])
            if before || after { return .formatting }
        }
        return nil
    }

    private static func pattern(_ source: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
        try! NSRegularExpression(pattern: source, options: options)
    }

    private static let space = "[\(JSText.spaceClass)]"
    private static let frontmatter = pattern("\\A---\\r?\\n[\\s\\S]*?\\r?\\n(?:---|\\.\\.\\.)[ \\t]*(?:\\r?\\n|\\z)")
    private static let closedKinds: [(NSRegularExpression, CommentRefusal.Closed)] = [
        // A fence with no end runs to the end of the note: `\z`, not `$`,
        // which is the end of any line here.
        (pattern("^ {0,3}(`{3,}|~{3,})[^\\n]*\\n[\\s\\S]*?(?:\\n {0,3}\\1[`~]*[ \\t]*(?=\\n|$)|\\z)", .anchorsMatchLines), .codeBlock),
        (pattern("`[^`\\n]+`"), .code),
        (pattern("\\]\\([^)\\n]*\\)"), .link),
        (pattern("<[^>\\n]+>"), .htmlTag),
        (pattern("https?://[^\(JSText.spaceClass))>\\]]+"), .link),
        (pattern("\\{==[\\s\\S]+?==\\}(?:\\{>>[\\s\\S]*?<<\\})*"), .comment),
        (pattern("\\{>>[\\s\\S]*?<<\\}"), .comment),
    ]
    private static let blockMark = pattern("\\A(?:#{1,6}\(space)|[-+]\(space)|[0-9]+[.)]\(space)|>|={3,}|-{3,})")

    /// Stretches of the note no marker may be written into.
    static func closedRanges(_ md: String) -> [(range: Range<Int>, why: CommentRefusal.Closed)] {
        let whole = NSRange(location: 0, length: (md as NSString).length)
        var out: [(Range<Int>, CommentRefusal.Closed)] = []
        if let front = frontmatter.firstMatch(in: md, range: whole) {
            out.append((front.range.location..<(front.range.location + front.range.length), .frontmatter))
        }
        for (regex, why) in closedKinds {
            for match in regex.matches(in: md, range: whole) {
                out.append((match.range.location..<(match.range.location + match.range.length), why))
            }
        }
        return out
    }

    /// Where `on` goes: the one place it is in the note outside anything a
    /// marker would break.
    static func place(_ on: String, in md: String) throws -> Int {
        let text = Array(md.utf16)
        let want = Array(on.utf16)
        let closed = closedRanges(md)
        var found: [(index: Int, inside: CommentRefusal.Closed?)] = []
        var i = 0
        while i + want.count <= text.count {
            guard Array(text[i..<(i + want.count)]) == want else {
                i += 1
                continue
            }
            var lineStart = i
            while lineStart > 0, text[lineStart - 1] != 0x0A { lineStart -= 1 }
            let blocker = closed.first { i < $0.range.upperBound && i + want.count > $0.range.lowerBound }
            let lead = String(decoding: text[lineStart..<i], as: UTF16.self)
            let opensLine = JSText.trim(lead).isEmpty
                && blockMark.firstMatch(in: on, range: NSRange(location: 0, length: want.count)) != nil
            found.append((i, blocker?.why ?? (opensLine ? .mark : nil)))
            i += want.count
        }
        let open = found.filter { $0.inside == nil }
        if open.count == 1 { return open[0].index }
        if found.isEmpty { throw CommentRefusal.missing(on) }
        if open.isEmpty, let first = found[0].inside { throw CommentRefusal.inside(on, first) }
        throw CommentRefusal.many(on, open.count)
    }
}
