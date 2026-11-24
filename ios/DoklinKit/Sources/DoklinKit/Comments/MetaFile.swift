// A document's meta file, `<stem>.meta.jsonl`, beside its markdown and its
// html: a header line, then one record per line —
//
//   {"t":"mthread","id",…,"comments"}            a markdown thread's entries;
//                                                its marker is in the markdown
//   {"t":"hthread","id","anchor","comments"}     an html thread, wholly here
//   {"t":"tcols","id","cols"}                    a table's column widths
//   {"t":"link","id","file"}                     the file a link to another
//                                                document means, by the
//                                                link's destination
//   anything else                                kept as it is
//
// One record a line, sorted, keys in a fixed order: two devices holding the
// same records write the same bytes, and sync merges the file by its
// records (engine/src/sidecar.rs) — which is why what a record says is kept
// as `JSString`s. A port of src/metaFile.ts — change both;
// verify-harness/comments-fixture.json holds them to it.

import Foundation

public struct MdThread: Equatable, Sendable {
    public var id: JSString
    public var comments: [CommentEntry]
}

/// How an html thread finds its element again: a path of selectors from
/// the top, and the element's tag and the start of its text for when the
/// page was made again and the path no longer leads there.
public struct HtmlAnchor: Equatable, Sendable {
    public var path: JSString
    public var tag: JSString
    public var text: JSString
}

public struct HtmlThread: Equatable, Sendable {
    public var id: JSString
    public var anchor: HtmlAnchor
    public var comments: [CommentEntry]
}

/// A table's column widths, kept for the Mac; the phone only carries them.
struct TableCols: Equatable, Sendable {
    var id: JSString
    var cols: [Double]
}

/// The file a link to another document means: `id` is the link's
/// destination as the note writes it (`DocLinks.key`), `file` the file's id.
public struct LinkRecord: Equatable, Sendable {
    public var id: JSString
    public var file: JSString

    public init(id: JSString, file: JSString) {
        self.id = id
        self.file = file
    }
}

/// A record of a kind this version does not know, kept line for line.
struct ForeignRecord: Equatable, Sendable {
    var t: JSString
    var sortId: JSString
    var raw: String
}

public struct EntityMeta: Equatable, Sendable {
    public var mthreads: [MdThread] = []
    public var hthreads: [HtmlThread] = []
    var tcols: [TableCols] = []
    public var links: [LinkRecord] = []
    var foreign: [ForeignRecord] = []

    public init() {}

    /// Nothing worth a file.
    public var isEmpty: Bool { mthreads.isEmpty && hthreads.isEmpty && tcols.isEmpty && links.isEmpty && foreign.isEmpty }
}

public enum MetaFile {
    static let header = "{\"doklin\":\"meta\",\"v\":1}"

    private static let markdownExtension = try! NSRegularExpression(pattern: "\\.(md|markdown|mdown|mkd)\\z", options: .caseInsensitive)
    private static let htmlExtension = try! NSRegularExpression(pattern: "\\.html\\z", options: .caseInsensitive)

    /// A document's path without its markdown extension, then without its
    /// html one: the stem its files share, and its meta file's name
    /// (`DocLinks.metaFile`).
    static func stem(of path: String) -> String {
        func strip(_ pattern: NSRegularExpression, _ text: String) -> String {
            pattern.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: (text as NSString).length), withTemplate: "")
        }
        return strip(htmlExtension, strip(markdownExtension, path))
    }

    /* ---------- Reading and writing ---------- */

    private static func entry(_ value: JSValue) -> CommentEntry? {
        guard case .object = value, let author = value["author"]?.string, let at = value["at"]?.number, let body = value["body"]?.string
        else { return nil }
        return CommentEntry(author: author, at: at, body: body)
    }

    private static func entries(_ value: JSValue?) -> [CommentEntry]? {
        guard let items = value?.array else { return nil }
        let read = items.compactMap(entry)
        return read.count == items.count ? read : nil
    }

    /// Every record the file holds. A line that is not one — a conflict
    /// marker, a hand edit — is passed over, never the end of the rest; a
    /// record given twice is the first valid one.
    public static func parse(_ raw: String) -> EntityMeta {
        var meta = EntityMeta()
        var seen = Set<JSString>()
        for line in JSText.lines(raw) {
            let trimmed = JSText.trim(line)
            guard !trimmed.isEmpty, let value = JSValue.parse(trimmed), value.isObjectLike else { continue }
            if value["doklin"]?.string != nil { continue }
            guard let t = value["t"]?.string, !t.isEmpty else { continue }
            let id = value["id"]?.string ?? ""
            let key = t + " " + id
            if seen.contains(key) { continue }
            switch t.string {
            case "mthread":
                guard !id.isEmpty, let comments = entries(value["comments"]) else { continue }
                seen.insert(key)
                meta.mthreads.append(MdThread(id: id, comments: comments))
            case "hthread":
                guard !id.isEmpty, let anchor = value["anchor"], case .object = anchor,
                      let path = anchor["path"]?.string, let tag = anchor["tag"]?.string, let text = anchor["text"]?.string,
                      let comments = entries(value["comments"])
                else { continue }
                seen.insert(key)
                meta.hthreads.append(HtmlThread(id: id, anchor: HtmlAnchor(path: path, tag: tag, text: text), comments: comments))
            case "tcols":
                guard !id.isEmpty, let items = value["cols"]?.array, !items.isEmpty else { continue }
                let cols = items.compactMap(\.number).filter { $0.isFinite && $0 >= 0 }
                guard cols.count == items.count else { continue }
                seen.insert(key)
                meta.tcols.append(TableCols(id: id, cols: cols.map { $0.rounded(.toNearestOrAwayFromZero) }))
            case "link":
                guard !id.isEmpty, let file = value["file"]?.string, !file.isEmpty else { continue }
                seen.insert(key)
                meta.links.append(LinkRecord(id: id, file: file))
            default:
                seen.insert(key)
                meta.foreign.append(ForeignRecord(t: t, sortId: id, raw: trimmed))
            }
        }
        return meta
    }

    private static func json(_ entry: CommentEntry) -> JSValue {
        .object([("author", .string(entry.author)), ("at", .number(entry.at)), ("body", .string(entry.body))])
    }

    /// The file's bytes for these records: the same records, in any order,
    /// always the same bytes.
    public static func serialize(_ meta: EntityMeta) -> String {
        var rows: [(key: JSString, line: String)] = []
        for thread in meta.hthreads {
            let anchor = JSValue.object([("path", .string(thread.anchor.path)), ("tag", .string(thread.anchor.tag)), ("text", .string(thread.anchor.text))])
            let line = JSValue.object([
                ("t", .string("hthread")), ("id", .string(thread.id)), ("anchor", anchor), ("comments", .array(thread.comments.map(json))),
            ]).json
            rows.append(("hthread " + thread.id, line))
        }
        for thread in meta.mthreads {
            let line = JSValue.object([("t", .string("mthread")), ("id", .string(thread.id)), ("comments", .array(thread.comments.map(json)))]).json
            rows.append(("mthread " + thread.id, line))
        }
        for table in meta.tcols {
            let line = JSValue.object([("t", .string("tcols")), ("id", .string(table.id)), ("cols", .array(table.cols.map(JSValue.number)))]).json
            rows.append(("tcols " + table.id, line))
        }
        for link in meta.links {
            let line = JSValue.object([("t", .string("link")), ("id", .string(link.id)), ("file", .string(link.file))]).json
            rows.append(("link " + link.id, line))
        }
        for record in meta.foreign {
            rows.append((record.t + " " + record.sortId + " " + JSString(record.raw), record.raw))
        }
        let sorted = rows.enumerated().sorted { a, b in
            if JSText.less(a.element.key.units, b.element.key.units) { return true }
            if JSText.less(b.element.key.units, a.element.key.units) { return false }
            return a.offset < b.offset
        }
        return ([header] + sorted.map(\.element.line)).joined(separator: "\n") + "\n"
    }

    /* ---------- The markdown and its records ---------- */

    private static func union(_ a: [CommentEntry], _ b: [CommentEntry]) -> [CommentEntry] {
        let have = Set(a.map(\.identity))
        let extra = b.enumerated().filter { !have.contains($0.element.identity) }
            .sorted { $0.element.at == $1.element.at ? $0.offset < $1.offset : $0.element.at < $1.element.at }
            .map(\.element)
        return a + extra
    }

    /// FNV-1a over UTF-16 code units, 32 bits.
    private static func fnv1a(_ units: [UInt16], seed: UInt32) -> UInt32 {
        var hash = seed
        for unit in units {
            hash ^= UInt32(unit)
            hash = hash &* 0x0100_0193
        }
        return hash
    }

    /// An id made from what a thread is, so two devices give the same
    /// thread the same id; `index` keeps two identical threads apart.
    public static func deriveId(_ material: JSString, _ index: Int) -> String {
        let units = Array("\(index) ".utf16) + material.units
        let id = String(fnv1a(units, seed: 0x811C_9DC5), radix: 36) + String(fnv1a(units, seed: 0x0123_4567), radix: 36)
        return String((id + "000000").prefix(8))
    }

    /// The markdown as the Mac's editor reads it: each thread's entries put
    /// back on the first run of its words. A marker whose id has no record
    /// stays as it is; a record with no marker is an orphan, kept.
    public static func expand(_ md: JSString, _ mthreads: [MdThread]) -> (md: JSString, orphanIds: [JSString]) {
        var bodies: [JSString: [CommentEntry]] = [:]
        // `new Map(…)`: a later record of one id replaces an earlier one.
        for thread in mthreads { bodies[thread.id] = thread.comments }
        var rooted = Set<JSString>()
        let out = CriticMarkup.replacingBlocks(in: md) { block in
            switch CriticMarkup.parseSpans(block.spans) {
            case .ref(let id):
                let key = JSString(id)
                if !rooted.contains(key), let meta = bodies[key], !meta.isEmpty {
                    rooted.insert(key)
                    return "{==" + block.anchor + "==}" + CriticMarkup.formatThreadSpans(id: id, comments: meta)
                }
                return block.whole
            case .thread(let id?, let comments):
                let key = JSString(id)
                if rooted.contains(key) { return block.whole }
                rooted.insert(key)
                if let meta = bodies[key], !meta.isEmpty {
                    return "{==" + block.anchor + "==}" + CriticMarkup.formatThreadSpans(id: id, comments: union(comments, meta))
                }
                return block.whole
            case .thread(nil, _):
                return block.whole
            }
        }
        return (out, mthreads.filter { !rooted.contains($0.id) }.map(\.id))
    }

    /// Every thread id a marker in the markdown names.
    public static func markerIds(_ md: JSString) -> Set<String> {
        Set(CriticMarkup.blocks(in: md).compactMap { CriticMarkup.parseSpans($0.spans).id })
    }

    /// The markdown as it goes on disk: every marker bare, each thread's
    /// entries out into a record — the first run's, when a thread's words
    /// span blocks. A thread with no id gets one made from what it is.
    public static func extract(_ fullMd: JSString) -> (md: JSString, mthreads: [MdThread]) {
        var reserved = markerIds(fullMd)
        var records: [MdThread] = []
        var seen = Set<String>()
        var made = 0
        let md = CriticMarkup.replacingBlocks(in: fullMd) { block in
            let parsed = CriticMarkup.parseSpans(block.spans)
            guard case .thread(let named, let comments) = parsed else { return block.whole }
            var id = named ?? ""
            if named == nil {
                repeat {
                    id = deriveId(block.anchor + " " + block.spans, made)
                    made += 1
                } while reserved.contains(id)
                reserved.insert(id)
            }
            if !seen.contains(id) {
                seen.insert(id)
                if !comments.isEmpty { records.append(MdThread(id: JSString(id), comments: comments)) }
            }
            return "{==" + block.anchor + JSString("==}{>>#\(id)<<}")
        }
        return (md, records)
    }

    /// A document's files as the Mac's opening (`expand`) and saving
    /// (`extract`) leave them: bare markers in the markdown, every entry in
    /// a record, and the records whose markers are gone kept. Running it
    /// again changes nothing. `md` nil is a page with no markdown, whose
    /// records are left alone.
    /// What a save that changes a note's links writes to its sidecar, as it
    /// is on disk (`onDisk`, nil: it has none): first what it holds while
    /// the text is written (the new records and the old ones the new drop),
    /// then, once the text is down, the new records alone. Everything else
    /// in it is kept as it is. Nil where nothing is to be written. The
    /// Mac's save does the same (`sidecarWhileWriting`, src/metaFile.ts).
    public static func withLinks(_ onDisk: String?, _ links: [LinkRecord]) -> (whileWriting: String?, then: String?) {
        let meta = onDisk.map(parse) ?? EntityMeta()
        if onDisk == nil, links.isEmpty { return (nil, nil) }
        var next = meta
        next.links = links
        var both = next
        let kept = Set(links.map(\.id))
        both.links += meta.links.filter { !kept.contains($0.id) }
        let during = serialize(both)
        let after = serialize(next)
        return (during == onDisk ? nil : during, after == during ? nil : after)
    }

    static func roundTrip(md: JSString?, meta: EntityMeta) -> (md: JSString?, meta: EntityMeta) {
        guard let md else { return (nil, meta) }
        let expanded = expand(md, meta.mthreads)
        let extracted = extract(expanded.md)
        let orphans = Set(expanded.orphanIds)
        var out = meta
        out.mthreads = extracted.mthreads + meta.mthreads.filter { orphans.contains($0.id) }
        return (extracted.md, out)
    }
}

extension CommentEntry {
    /// Which entry this is, whatever its body says now: who wrote it and
    /// when — the same entry in two copies of a thread, and in two readings
    /// of one file.
    var identity: [UInt16] { author.units + Array("|\(JSText.number(at))".utf16) }
}
