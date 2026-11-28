// The tag rules held to the cases the Mac's are held to:
// verify-harness/tags-fixture.json, which verify-harness/tags.test.mjs
// checks src/tags.ts against — same text in, same bytes out — and what holds
// for every case: a tag set and then cleared leaves the file as it was. The
// list's changes are the engine's, which EngineLiveTests drives.

import XCTest
@testable import DoklinKit

final class TagsTests: XCTestCase {
    private static let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()

    private static let fixture: [String: Any] = {
        let url = repo.appendingPathComponent("verify-harness/tags-fixture.json")
        guard let data = try? Data(contentsOf: url),
              let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? [String: Any]
        else { fatalError("\(url.path) is missing, or is not JSON") }
        return value
    }()

    private func cases(_ key: String) -> [[String: Any]] {
        guard let all = Self.fixture[key] as? [[String: Any]], !all.isEmpty else {
            XCTFail("the fixture has no \(key) cases")
            return []
        }
        return all
    }

    private func string(_ value: Any?) -> String? { value as? String }

    private func def(_ value: [String: Any]) -> TagDef {
        TagDef(name: value["name"] as! String, values: value["values"] as! [String], desc: value["desc"] as? String)
    }

    private func defs(_ value: Any?) -> [TagDef] { (value as? [[String: Any]] ?? []).map(def) }

    private func filters(_ value: Any?) -> [TagFilter] {
        (value as? [[String: Any]] ?? []).map { TagFilter(name: $0["name"] as! String, value: $0["value"] as? String) }
    }

    func testKeyedLines() {
        for c in cases("lines") {
            let text = string(c["text"])!
            let want = (c["lines"] as! [[String: Any]]).map { KeyedLine(key: $0["key"] as! String, value: $0["value"] as? String) }
            XCTAssertEqual(Tags.keyedLines(text), want, "lines of \(text.debugDescription)")
        }
    }

    func testMatches() {
        for c in cases("match") {
            let text = string(c["text"])!
            XCTAssertEqual(Tags.matches(text, filters(c["filters"])), c["matches"] as? Bool, "match \(c["filters"] ?? "") in \(text.debugDescription)")
        }
    }

    func testANotesTags() {
        for c in cases("tags") {
            let text = string(c["text"])!
            let list = defs(c["list"])
            let want = (c["tags"] as! [[String: Any]]).map {
                NoteTag(name: $0["name"] as! String, value: $0["value"] as! String, known: $0["known"] as! Bool)
            }
            XCTAssertEqual(Tags.noteTags(text, list: list), want, "tags of \(text.debugDescription)")
            XCTAssertEqual(Tags.hasOtherFrontmatter(text, list: list), c["other"] as? Bool, "other frontmatter in \(text.debugDescription)")
        }
    }

    func testWritingATag() {
        for c in cases("write") {
            let text = string(c["text"])!
            let tag = (c["tag"] as? [String: Any]).map { (name: $0["name"] as! String, value: $0["value"] as! String) }
            let got = Tags.writeTag(text, at: string(c["at"])!, tag: tag)
            XCTAssertEqual(got, string(c["out"]), "write \(c["at"] ?? "") = \(String(describing: tag)) in \(text.debugDescription)")
            // The body is never touched.
            XCTAssertTrue(Frontmatter.split(got).body.hasSuffix(Frontmatter.split(text).body), "body kept: \(text.debugDescription)")
        }
    }

    func testQuoting() {
        for c in cases("quote") {
            let value = string(c["value"])!
            let line = string(c["line"])!
            XCTAssertEqual(Tags.quoteValue(value), line, "quote \(value.debugDescription)")
            // What is written reads back as the value.
            XCTAssertEqual(Tags.keyedLines("---\nk: \(line)\n---\n"), [KeyedLine(key: "k", value: value)], "read back \(line)")
        }
    }

    func testNamesAndValues() {
        for c in cases("names") {
            XCTAssertEqual(Tags.nameProblem(string(c["name"])!, list: []) == nil, c["ok"] as? Bool, "name \(c["name"] ?? "")")
        }
        for c in cases("values") {
            XCTAssertEqual(Tags.valueProblem(string(c["value"])!, others: []) == nil, c["ok"] as? Bool, "value \(c["value"] ?? "")")
        }
        // Taken, said as sentences.
        let list = [TagDef(name: "Status", values: ["Todo"])]
        XCTAssertEqual(Tags.nameProblem("status", list: list), "There's already a tag called Status.")
        XCTAssertNil(Tags.nameProblem("status", list: list, except: "STATUS"))
        XCTAssertEqual(Tags.valueProblem("todo", others: ["Todo"]), "Todo is there twice.")
    }

    func testATagAsTyped() {
        for c in cases("defs") {
            let typed = def(c["def"] as! [String: Any])
            XCTAssertEqual(Tags.tagProblem(typed, list: defs(c["list"]), except: string(c["except"])), string(c["problem"]), "def \(typed) beside \(c["list"] ?? "")")
        }
    }

    /// The limits are src/tags.ts's, which the engine reads too.
    func testTheLimitsAreTheMacs() throws {
        let source = try String(contentsOf: Self.repo.appendingPathComponent("src/tags.ts"), encoding: .utf8)
        func limit(_ name: String) -> Int? {
            guard let line = source.split(separator: "\n").first(where: { $0.hasPrefix("export const \(name) = ") }) else { return nil }
            return Int(line.dropFirst("export const \(name) = ".count).prefix { $0.isNumber })
        }
        XCTAssertEqual(limit("NAME_MAX"), Tags.nameMax)
        XCTAssertEqual(limit("VALUE_MAX"), Tags.valueMax)
    }

    func testSearchQuery() {
        for c in cases("query") {
            let q = string(c["q"])!
            let got = Tags.searchQuery(q, list: defs(c["list"]))
            XCTAssertEqual(got.text, string(c["text"]), "query text of \(q.debugDescription)")
            XCTAssertEqual(got.tags, filters(c["tags"]), "query tags of \(q.debugDescription)")
        }
    }

    /// A tag a note didn't have, set and then cleared: the file as it was.
    /// (A block that was empty goes with the tag: a block left with no lines
    /// does.)
    func testASetThenAClearLeavesTheFileAsItWas() {
        let texts = cases("lines").map { string($0["text"])! } + cases("write").map { string($0["text"])! } + ["", "Body", "Body\r\n"]
        for text in texts {
            if Tags.keyedLines(text).contains(where: { $0.key.lowercased() == "zone" }) { continue }
            let head = Frontmatter.split(text)
            if !head.head.isEmpty && head.inner.isEmpty { continue }
            let set = Tags.writeTag(text, at: "Zone", tag: (name: "Zone", value: "North: east"))
            XCTAssertEqual(
                Tags.noteTags(set, list: [TagDef(name: "zone", values: ["North: east"])]),
                [NoteTag(name: "zone", value: "North: east", known: true)],
                "set reads back in \(text.debugDescription)"
            )
            XCTAssertEqual(Tags.writeTag(set, at: "zone", tag: nil), text, "set then clear in \(text.debugDescription)")
        }
    }

    func testFrontmatterIsSplitAsTheMacSplitsIt() {
        XCTAssertEqual(Frontmatter.split("---\na: b\n---\nBody"), Frontmatter(head: "---\na: b\n---\n", inner: "a: b", body: "Body"))
        XCTAssertEqual(Frontmatter.split("---  \r\na: b\r\n--- \r\n"), Frontmatter(head: "---  \r\na: b\r\n--- \r\n", inner: "a: b", body: ""))
        XCTAssertEqual(Frontmatter.split("---\n---\nBody").inner, "")
        XCTAssertEqual(Frontmatter.split("---\na: b\n---").head, "---\na: b\n---")
        // A rule that only starts the note, and one that isn't the first line.
        XCTAssertEqual(Frontmatter.split("---\nNo end.\n").head, "")
        XCTAssertEqual(Frontmatter.split("Text\n---\na\n---\n").head, "")
    }
}

/// A note's tag on this iPhone's files (Tagging.swift), set through the
/// note's save, and the search's tags. The list is the engine's, so what
/// needs one is in EngineLiveTests.
@MainActor
final class TaggingTests: XCTestCase {
    private var root: URL!
    private var workspace: Workspace!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("doklin-tags-\(UUID().uuidString)")
        for folder in ["Library", "Private", "Elsewhere"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(folder), withIntermediateDirectories: true)
        }
        let device = Workspaces(remembered: UserDefaults(suiteName: "doklin-test-\(UUID().uuidString)")!)
        workspace = device.workspace(root.path)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func put(_ path: String, _ text: String) throws {
        try FileManager.default.createDirectory(at: workspace.files.url(DocLinks.directory(of: path)), withIntermediateDirectories: true)
        try workspace.files.write(path, Data(text.utf8))
    }

    private func text(_ path: String) throws -> String { try workspace.files.text(path) }

    func testATagIsSetAndClearedThroughTheNotesSaveAndOnWhatSyncWroteMeanwhile() async throws {
        XCTAssertEqual(workspace.tagList, [], "no list before the engine has said")
        try put("Library/plan.md", "# Plan\n")
        let note = DocumentModel(workspace: workspace, path: "Library/plan.md")
        note.load()

        await note.setTag("status", to: "Doing")
        XCTAssertEqual(try text("Library/plan.md"), "---\nstatus: Doing\n---\n# Plan\n")

        // Another device's edit lands before the reader read it again: the
        // tag goes on what is there now.
        try put("Library/plan.md", "---\nstatus: Doing\nowner: Ada\n---\n# Plan\n\nFrom the Mac.\n")
        await note.setTag("priority", to: "p1")
        XCTAssertEqual(try text("Library/plan.md"), "---\nstatus: Doing\nowner: Ada\npriority: p1\n---\n# Plan\n\nFrom the Mac.\n")
        XCTAssertNil(note.problem)

        await note.setTag("status", to: nil)
        await note.setTag("priority", to: nil)
        XCTAssertEqual(try text("Library/plan.md"), "---\nowner: Ada\n---\n# Plan\n\nFrom the Mac.\n")
    }

    func testASearchsTagsNarrowIt() async throws {
        try put("Library/a.md", "---\nstatus: Doing\n---\nThe heron.\n")
        try put("Library/b.md", "---\nstatus: Done\n---\nThe heron.\n")
        try put("Library/heron.md", "---\nstatus: doing\n---\nNo words.\n")
        try put("Library/c.md", "The heron, untagged.\n")
        try put("Library/page.html", "<p>status: Doing</p>")
        let files = workspace.files

        let doing = [TagFilter(name: "status", value: "Doing")]
        XCTAssertEqual(files.search("", in: ["Library"], tags: doing).map(\.path), ["Library/a.md", "Library/heron.md"])
        XCTAssertTrue(files.search("", in: ["Library"], tags: doing).allSatisfy(\.hits.isEmpty))
        XCTAssertEqual(files.search("heron", in: ["Library"], tags: doing).map(\.path), ["Library/heron.md", "Library/a.md"])
        XCTAssertEqual(files.search("", in: ["Library"], tags: [TagFilter(name: "status", value: nil)]).count, 3)
        XCTAssertEqual(files.search("", in: ["Library"]), [], "no words and no tags is no search")

        let search = SearchModel(workspace: workspace)
        await search.run("owner:Ada")
        XCTAssertEqual(search.query, "owner:Ada", "a name the list doesn't have is words")
    }
}
