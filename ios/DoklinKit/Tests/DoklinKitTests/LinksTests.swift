// Which tapped links are links to a page — the ones the app follows itself
// rather than handing to a browser. What a link names is the engine's to
// read (engine/src/cloud/link.rs); these hold only its address and scheme.
//
// And links from a note to other documents, held to the cases the Mac's are
// (verify-harness/links-fixture.json, which verify-harness/doclinks.test.mjs
// checks the TypeScript against): the key a link's record is filed under,
// the path between two notes, and what a link opens and shows.

import XCTest
@testable import DoklinKit

final class LinksTests: XCTestCase {
    private func url(_ text: String) throws -> URL {
        try XCTUnwrap(URL(string: text))
    }

    private struct Fixture: Decodable {
        struct Key: Decodable { let href: String; let key: String? }
        struct Between: Decodable { let from: String; let to: String; let path: String }
        struct Record: Decodable { let id: String; let file: String }
        struct Resolve: Decodable {
            let about: String
            let note: String
            let records: [Record]
            let href: String
            let words: String
            let by: String?
            let opens: String?
            let shown: String
        }
        let key: [Key]
        let relativePath: [Between]
        let documents: [WorkspaceDocument]
        let resolve: [Resolve]
    }

    private static let fixture: Fixture = {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let url = repo.appendingPathComponent("verify-harness/links-fixture.json")
        guard let data = try? Data(contentsOf: url), let fixture = try? JSONDecoder().decode(Fixture.self, from: data) else {
            fatalError("\(url.path) is missing, or is not the fixture")
        }
        return fixture
    }()

    private func records(_ list: [Fixture.Record]) -> [LinkRecord] {
        list.map { LinkRecord(id: JSString($0.id), file: JSString($0.file)) }
    }

    func testALinksRecordIsFiledUnderItsDestinationAsTheMacFilesIt() {
        for c in Self.fixture.key {
            XCTAssertEqual(DocLinks.key(of: c.href), c.key, c.href)
        }
        for c in Self.fixture.relativePath {
            XCTAssertEqual(DocLinks.relativePath(from: c.from, to: c.to), c.path, "\(c.from) → \(c.to)")
            XCTAssertEqual(DocLinks.keyTarget(c.path, from: c.from), c.to, "and back")
        }
    }

    func testALinkOpensAndShowsWhatItDoesOnTheMac() {
        let index = DocumentIndex(Self.fixture.documents)
        for c in Self.fixture.resolve {
            let resolved = DocLinks.resolve(c.href, from: c.note, records: records(c.records), in: index)
            let by: String? = switch resolved {
            case .record?: "record"
            case .path?: "path"
            case nil: nil
            }
            XCTAssertEqual(by, c.by, c.about)
            XCTAssertEqual(resolved?.document?.path, c.opens, c.about)
            XCTAssertEqual(resolved.map { DocLinks.shownWords(c.words, $0) } ?? c.words, c.shown, c.about)
        }
    }

    /// The reader shows a note with each link resolved: a renamed document's
    /// named link in its name now and leading where it is, the author's
    /// words kept, and a link whose file can't be opened closed.
    func testTheReaderShowsEachLinkWhereItsFileIsNow() {
        let index = DocumentIndex(Self.fixture.documents)
        let note = "Library/Roadmap/q1.md"
        let source = """
        See [launch-plan](../GTM/launch-plan.md#friday), [the *plan*](plan.md) and [new](new.md).

        - [board-plan](../Board/board-plan.md)
        """
        let filed = records([
            .init(id: "../GTM/launch-plan.md", file: "f-launch"),
            .init(id: "plan.md", file: "f-gone"),
            .init(id: "../Board/board-plan.md", file: "f-board"),
        ])
        let shown = DocLinks.resolving(MarkdownDocument.parse(source), in: note, records: filed, documents: index)
        guard case .paragraph(let words)? = shown.blocks.first?.block else { return XCTFail("a paragraph") }
        XCTAssertEqual(words, [
            .text("See "),
            .link(destination: "../GTM/launch-plan-v2.md#friday", children: [.text("launch-plan-v2")]),
            .text(", "),
            .closedLink([.text("the "), .emphasis([.text("plan")])]),
            .text(" and "),
            .link(destination: "new.md", children: [.text("new")]),
            .text("."),
        ])
        XCTAssertEqual(words.runs.first { $0.closed }?.text, "the ", "a closed link's words, as saved")
        XCTAssertNil(words.runs.first { $0.closed }?.link)
        guard case .list(let list)? = shown.blocks.last?.block, case .paragraph(let item)? = list.items.first?.blocks.first?.block else {
            return XCTFail("a list")
        }
        XCTAssertEqual(item, [.link(destination: "../../Restricted/Board/board-plan.md", children: [.text("board-plan")])])
        let none = DocLinks.resolving(MarkdownDocument.parse(source), in: note, records: [], documents: index)
        XCTAssertEqual(none, MarkdownDocument.parse(source), "no records: the note as written")
    }

    func testALinkToAPageIsTheAppsOwn() throws {
        let sent = "https://doklin.cc/open#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f"
        XCTAssertTrue(Workspaces.isPageLink(try url(sent)))
        XCTAssertTrue(Workspaces.isPageLink(try url(sent.replacingOccurrences(of: "/open#", with: "/open/#"))))
        XCTAssertTrue(Workspaces.isPageLink(try url(sent.replacingOccurrences(of: "https://doklin.cc", with: "http://DOKLIN.cc"))))
        XCTAssertTrue(Workspaces.isPageLink(try url("doklin://open#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f")))
    }

    func testEverythingElseGoesToTheBrowser() throws {
        for text in [
            "https://doklin.cc/",
            "https://doklin.cc/#agents",
            "https://doklin.cc/open",
            "https://doklin.cc/opener#d=x",
            "https://notes.example.com/open#d=x",
            "https://notes.example.com/roadmap",
            "mailto:team@example.com",
        ] {
            XCTAssertFalse(Workspaces.isPageLink(try url(text)), text)
        }
    }

    /// A save's sidecar: while its text is written, the records of both
    /// texts; once it is down, the new text's alone; the rest kept as it is.
    func testASaveWritesTheRecordsOfBothTextsFirstAndThenTheNewOnes() {
        let disk = """
        {"doklin":"meta","v":1}
        {"t":"link","id":"a.md","file":"f-a"}
        {"t":"tcols","id":"x","cols":[100]}

        """
        let (during, then) = MetaFile.withLinks(disk, [LinkRecord(id: "b.md", file: "f-b")])
        let first = MetaFile.parse(during ?? "")
        let last = MetaFile.parse(then ?? "")
        XCTAssertEqual(Set(first.links.map(\.id.string)), ["a.md", "b.md"])
        XCTAssertEqual(last.links.map(\.id.string), ["b.md"])
        XCTAssertTrue((then ?? "").contains(#"{"t":"tcols","id":"x","cols":[100]}"#))

        // Nothing changes: nothing is written.
        let same = MetaFile.withLinks(disk, [LinkRecord(id: "a.md", file: "f-a")])
        XCTAssertNil(same.whileWriting)
        XCTAssertNil(same.then)
        // No sidecar and no records: none is made.
        let none = MetaFile.withLinks(nil, [])
        XCTAssertNil(none.whileWriting)
        XCTAssertNil(none.then)
    }
}
