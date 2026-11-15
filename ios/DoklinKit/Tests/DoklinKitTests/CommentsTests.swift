// The comment code held to the cases the Mac's is held to:
// verify-harness/comments-fixture.json, which verify-harness/comments.test.mjs
// checks the TypeScript against. Same input, same bytes — the meta file is
// merged line by line with what Macs write.

import XCTest
@testable import DoklinKit

final class CommentsTests: XCTestCase {
    /// The fixture, read with the port's own reading of JSON.
    private static let fixture: JSValue = {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let url = repo.appendingPathComponent("verify-harness/comments-fixture.json")
        guard let text = try? String(contentsOf: url, encoding: .utf8), let value = JSValue.parse(text) else {
            fatalError("\(url.path) is missing, or is not JSON")
        }
        return value
    }()

    private func cases(_ key: String) -> [JSValue] {
        guard let all = Self.fixture[JSString(key)]?.array, !all.isEmpty else {
            XCTFail("the fixture has no \(key) cases")
            return []
        }
        return all
    }

    /// A string of the fixture to show, or to hand to what takes a Swift string.
    private func text(_ value: JSValue?) -> String? { value?.string?.string }

    /// A string of the fixture as JavaScript holds it, half a character and all.
    private func js(_ value: JSValue?) -> JSString? { value?.string }

    private func entry(_ value: JSValue) -> CommentEntry {
        var entry = CommentEntry(author: value["author"]?.string ?? "", at: value["at"]?.number ?? .nan, body: value["body"]?.string ?? "")
        entry.eid = value["eid"]
        return entry
    }

    private func entries(_ value: JSValue?) -> [CommentEntry] { value?.array?.map(entry) ?? [] }

    private func mthreads(_ value: JSValue?) -> [MdThread] {
        (value?.array ?? []).map { MdThread(id: $0["id"]?.string ?? "", comments: entries($0["comments"])) }
    }

    private func assertEntries(_ actual: [CommentEntry], _ expected: JSValue?, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let want = entries(expected)
        XCTAssertEqual(actual.map(\.author), want.map(\.author), what, file: file, line: line)
        XCTAssertEqual(actual.map(\.at), want.map(\.at), what, file: file, line: line)
        XCTAssertEqual(actual.map(\.body), want.map(\.body), what, file: file, line: line)
    }

    /* ---------- The pieces ---------- */

    func testNaming() {
        for c in cases("metaFile") {
            XCTAssertEqual(DocLinks.metaFile(of: text(c["path"])!), text(c["meta"]))
        }
    }

    func testSpans() {
        for c in cases("parseSpans") {
            let spans = js(c["spans"])!
            let want = c["parsed"]!
            switch CriticMarkup.parseSpans(spans) {
            case .ref(let id):
                XCTAssertEqual(text(want["kind"]), "ref", spans.string)
                XCTAssertEqual(id, text(want["id"]), spans.string)
            case .thread(let id, let comments):
                XCTAssertEqual(text(want["kind"]), "thread", spans.string)
                XCTAssertEqual(id, text(want["id"]), spans.string)
                assertEntries(comments, want["comments"], spans.string)
            }
        }
    }

    func testSanitizing() {
        for c in cases("sanitizeBody") { XCTAssertEqual(CriticMarkup.sanitizeBody(text(c["in"])!), text(c["out"])) }
        for c in cases("sanitizeAuthor") { XCTAssertEqual(CriticMarkup.sanitizeAuthor(text(c["in"])!), js(c["out"])) }
    }

    func testWritingAThread() {
        for c in cases("formatThreadSpans") {
            XCTAssertEqual(CriticMarkup.formatThreadSpans(id: text(c["id"])!, comments: entries(c["comments"])), js(c["out"]), text(c["id"])!)
        }
    }

    func testStripping() {
        for c in cases("stripComments") { XCTAssertEqual(CriticMarkup.stripComments(text(c["in"])!), text(c["out"])) }
    }

    func testDerivedIds() {
        for c in cases("deriveId") {
            XCTAssertEqual(MetaFile.deriveId(js(c["material"])!, Int(c["index"]?.number ?? -1)), text(c["id"]))
        }
    }

    /* ---------- The meta file ---------- */

    func testTheMetaFileReadsAndWritesAsTheMacDoes() {
        for c in cases("meta") {
            let about = text(c["about"]) ?? ""
            let parsed = MetaFile.parse(text(c["raw"])!)
            XCTAssertEqual(MetaFile.serialize(parsed), text(c["serialized"]), about)
            XCTAssertEqual(parsed.isEmpty, c["empty"] == .bool(true), about)
            XCTAssertEqual(MetaFile.serialize(MetaFile.parse(text(c["serialized"])!)), text(c["serialized"]), "again: \(about)")
        }
    }

    func testExpandAndExtract() {
        for c in cases("expand") {
            let md = js(c["md"])!
            let r = MetaFile.expand(md, mthreads(c["mthreads"]))
            XCTAssertEqual(r.md, js(c["out"]), md.string)
            XCTAssertEqual(r.orphanIds, c["orphanIds"]?.array?.compactMap(\.string), md.string)
        }
        for c in cases("extract") {
            let md = js(c["md"])!
            let r = MetaFile.extract(md)
            XCTAssertEqual(r.md, js(c["out"]), md.string)
            let want = mthreads(c["mthreads"])
            XCTAssertEqual(r.mthreads.map(\.id), want.map(\.id), md.string)
            for (got, expected) in zip(r.mthreads, c["mthreads"]?.array ?? []) { assertEntries(got.comments, expected["comments"], md.string) }
        }
    }

    func testMigration() {
        for c in cases("migrate") {
            let md = js(c["md"])
            let before = text(c["meta"]).map(MetaFile.parse) ?? EntityMeta()
            let r = MetaFile.migrate(md: md, meta: before)
            let what = md?.string ?? "no markdown"
            XCTAssertEqual(r.md, js(c["outMd"]), what)
            XCTAssertEqual(MetaFile.serialize(r.meta), text(c["outMeta"]), what)
            XCTAssertEqual(r.md != md, c["mdChanged"] == .bool(true), what)
            XCTAssertEqual(MetaFile.serialize(r.meta) != MetaFile.serialize(before), c["metaChanged"] == .bool(true), what)
            let again = MetaFile.migrate(md: r.md, meta: r.meta)
            XCTAssertEqual(again.md != r.md || MetaFile.serialize(again.meta) != MetaFile.serialize(r.meta), c["againChanged"] == .bool(true), what)
        }
    }

    /* ---------- A document's threads ---------- */

    func testThreads() {
        for c in cases("threads") {
            let about = text(c["about"]) ?? ""
            let threads = DocumentComments(md: text(c["md"]), meta: text(c["meta"]), html: text(c["html"])).threads
            let want = c["threads"]?.array ?? []
            XCTAssertEqual(threads.map(\.id), want.compactMap { text($0["id"]) }, about)
            for (got, expected) in zip(threads, want) {
                XCTAssertEqual(got.version.rawValue, text(expected["version"]), about)
                XCTAssertEqual(got.on, text(expected["on"]), about)
                XCTAssertEqual(got.line, expected["line"]?.number.map { Int($0) }, "\(about): line of \(got.id)")
                XCTAssertEqual(got.tag, text(expected["tag"]), about)
                XCTAssertEqual(got.orphaned, expected["orphaned"] == .bool(true), "\(about): \(got.id) orphaned")
                assertEntries(got.comments, expected["comments"], about)
            }
        }
    }

    /* ---------- What the phone does ---------- */

    private func kind(_ refusal: CommentRefusal) -> JSValue {
        switch refusal {
        case .noWords: return .object([("kind", .string("noWords"))])
        case .oneLine: return .object([("kind", .string("oneLine"))])
        case .formatting: return .object([("kind", .string("formatting"))])
        case .missing: return .object([("kind", .string("missing"))])
        case .inside(_, let why): return .object([("kind", .string("inside")), ("why", .string(JSString(why.rawValue)))])
        case .many(_, let count): return .object([("kind", .string("many")), ("count", .number(Double(count)))])
        case .nothingSaid: return .object([("kind", .string("nothingSaid"))])
        case .noMarkdown: return .object([("kind", .string("noMarkdown"))])
        case .gone: return .object([("kind", .string("gone"))])
        }
    }

    func testOperations() throws {
        for c in cases("operations") {
            let about = text(c["about"]) ?? ""
            let raw = text(c["meta"])
            var document = DocumentComments(md: text(c["md"]), meta: raw, html: nil)
            let op = c["do"]!
            do {
                if let start = op["start"] {
                    try document.start(
                        on: text(start["on"])!, body: text(start["body"])!, author: text(start["author"])!,
                        at: start["at"]!.number!, id: text(start["id"])!
                    )
                } else if let reply = op["reply"] {
                    try document.reply(to: text(reply["id"])!, body: text(reply["body"])!, author: text(reply["author"])!, at: reply["at"]!.number!)
                } else if let remove = op["remove"] {
                    try document.remove(text(remove["id"])!)
                } else if let delete = op["deleteReply"] {
                    try document.deleteReply(of: text(delete["id"])!, entry: entry(delete["entry"]!), at: Int(delete["index"]!.number!))
                } else {
                    XCTFail("\(about): an operation the test does not know")
                }
                XCTAssertNil(c["refusal"], "\(about): done, where the Mac refuses")
                XCTAssertEqual(document.md, js(c["outMd"]), about)
                XCTAssertEqual(document.metaText(fileExists: raw != nil), text(c["outMeta"]), about)
            } catch let refusal as CommentRefusal {
                XCTAssertEqual(kind(refusal), c["refusal"], "\(about): \(refusal.message)")
            }
        }
    }

    /// SplitMix64: the same draws on every run.
    private struct Seeded: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    func testAFreshIdIsNoneTaken() throws {
        var probe = Seeded(state: 7)
        let first = CriticMarkup.newThreadId(using: &probe)
        let second = CriticMarkup.newThreadId(using: &probe)
        // The first draw is named in the text; the second is a thread already.
        let meta = "{\"t\":\"hthread\",\"id\":\"\(second)\",\"anchor\":{\"path\":\"\",\"tag\":\"p\",\"text\":\"x\"},\"comments\":[]}\n"
        let document = DocumentComments(md: "see #\(first) here\n", meta: meta, html: nil)
        var random = Seeded(state: 7)
        let id = document.freshId(using: &random)
        XCTAssertFalse([first, second].contains(id))
        XCTAssertEqual(id.count, 6)
        XCTAssertTrue(id.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber) })
    }

    /// Patterns run over the Swift string of a `JSString` and cut its code
    /// units at the offsets they find: a half shown as U+FFFD must keep
    /// its place, and come back out whole.
    func testHalfACharacterKeepsItsPlace() {
        let half = JSString(units: [0x61, 0xD83D, 0x62, 0xDE00, 0xD83D, 0xDE00])
        XCTAssertEqual(half.string.utf16.count, half.units.count)
        XCTAssertEqual(JSValue.string(half).json, "\"a\\ud83db\\ude00😀\"")
        XCTAssertEqual(JSValue.parse("\"a\\uD83Db\\ude00\\ud83d\\ude00\""), .string(half))
        let md = JSString("{==w==}{>>#abcd ") + JSString(units: [0xD83D]) + " · 1970-01-01T00:00:01Z: x<<}"
        XCTAssertEqual(CriticMarkup.blocks(in: md).first?.spans, JSString("{>>#abcd ") + JSString(units: [0xD83D]) + " · 1970-01-01T00:00:01Z: x<<}")
    }

    func testEveryRefusalIsASentence() {
        let all: [CommentRefusal] = [
            .noWords, .oneLine, .formatting, .missing("x"), .many("x", 2), .nothingSaid, .noMarkdown, .gone,
        ] + [CommentRefusal.Closed.frontmatter, .codeBlock, .code, .link, .htmlTag, .comment, .mark].map { .inside("x", $0) }
        for refusal in all {
            XCTAssertTrue(refusal.message.first?.isUppercase == true || refusal.message.hasPrefix("“"), refusal.message)
            XCTAssertTrue(refusal.message.hasSuffix("."), refusal.message)
        }
    }
}
