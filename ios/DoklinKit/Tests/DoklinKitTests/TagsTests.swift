// The tag rules held to the cases the Mac's are held to:
// verify-harness/tags-fixture.json, which verify-harness/tags.test.mjs
// checks src/tags.ts against — same text in, same bytes out — and what holds
// for every case: a tag set and then cleared leaves the file as it was.

import XCTest
@testable import DoklinKit

final class TagsTests: XCTestCase {
    private static let fixture: [String: Any] = {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
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

    private func defs(_ value: Any?) -> [TagDef] {
        (value as? [[String: Any]] ?? []).map { TagDef(name: $0["name"] as! String, values: $0["values"] as! [String]) }
    }

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
            XCTAssertEqual(Tags.parseList("---\nk: [\(line)]\n---\n"), [TagDef(name: "k", values: [value])], "list read back \(line)")
        }
    }

    func testTheList() {
        for c in cases("list") {
            let text = string(c["text"])!
            XCTAssertEqual(Tags.parseList(text), defs(c["tags"]), "list of \(text.debugDescription)")
        }
    }

    func testWritingTheList() {
        for c in cases("writeList") {
            let text = string(c["text"])!
            let def = (c["def"] as? [String: Any]).map { TagDef(name: $0["name"] as! String, values: $0["values"] as! [String]) }
            let got = Tags.writeList(text, at: string(c["at"])!, def: def, after: string(c["after"]))
            XCTAssertEqual(got, string(c["out"]), "list write \(c["at"] ?? "") in \(text.debugDescription)")
            if let def {
                XCTAssertEqual(Tags.parseList(got).first { $0.name == def.name }, def, "list reads back \(def)")
            }
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
        XCTAssertEqual(Tags.tagProblem(name: "Size", values: [], list: list), "A tag needs at least one value.")
        XCTAssertNil(Tags.tagProblem(name: "Size", values: ["S", "M"], list: list))
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

/// Tags on this iPhone's files (Tagging.swift): the list read from its note,
/// a note's tag set through its save, a tag made, a rename carried into
/// every note that has it, and the search's tags.
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

    private let list = "---\nstatus: [Todo, Doing, Done]\npriority: [p1, p2]\n---\nWhat they mean.\n"

    func testTheListIsReadFromItsNoteInLibraryWhateverItsCase() async throws {
        XCTAssertEqual(workspace.tagList, TagList(path: "Library/Tags.md", exists: false, tags: []))
        try put("Library/tags.md", list)
        await workspace.wrote(["Library/tags.md"])
        XCTAssertEqual(workspace.tagList.path, "Library/tags.md")
        XCTAssertEqual(workspace.tagList.tags.map(\.name), ["status", "priority"])
        XCTAssertTrue(workspace.tagList.isNote("Library/TAGS.md"))
        // Read again whenever files change, sync's writes too.
        try put("Library/tags.md", "---\nstatus: [Todo]\n---\n")
        await workspace.wrote(["Library/tags.md"])
        XCTAssertEqual(workspace.tagList.tags, [TagDef(name: "status", values: ["Todo"])])
    }

    func testATagIsSetAndClearedThroughTheNotesSaveAndOnWhatSyncWroteMeanwhile() async throws {
        try put("Library/Tags.md", list)
        await workspace.wrote(["Library/Tags.md"])
        try put("Library/plan.md", "# Plan\n")
        let note = DocumentModel(workspace: workspace, path: "Library/plan.md")
        note.load()
        XCTAssertEqual(note.tags, [])

        await note.setTag("status", to: "Doing")
        XCTAssertEqual(try text("Library/plan.md"), "---\nstatus: Doing\n---\n# Plan\n")
        XCTAssertEqual(note.tags, [NoteTag(name: "status", value: "Doing", known: true)])
        XCTAssertNil(note.otherFrontmatter, "a block of tags alone has no disclosure")

        // Another device's edit lands before the reader read it again: the
        // tag goes on what is there now.
        try put("Library/plan.md", "---\nstatus: Doing\nowner: Ada\n---\n# Plan\n\nFrom the Mac.\n")
        await note.setTag("priority", to: "p1")
        XCTAssertEqual(try text("Library/plan.md"), "---\nstatus: Doing\nowner: Ada\npriority: p1\n---\n# Plan\n\nFrom the Mac.\n")
        XCTAssertNil(note.problem)
        XCTAssertEqual(note.otherFrontmatter, "status: Doing\nowner: Ada\npriority: p1")

        await note.setTag("status", to: nil)
        await note.setTag("priority", to: nil)
        XCTAssertEqual(try text("Library/plan.md"), "---\nowner: Ada\n---\n# Plan\n\nFrom the Mac.\n")

        // The list's own note has no tags of its own: it shows as the list.
        let listNote = DocumentModel(workspace: workspace, path: "Library/Tags.md")
        listNote.load()
        XCTAssertTrue(listNote.isTagList)
        XCTAssertEqual(listNote.tags, [])
        XCTAssertNil(listNote.otherFrontmatter)
    }

    func testANewTagMakesTheListWhenThereIsNoneAndGivesTheNoteItsValue() async throws {
        try put("Library/plan.md", "Body\n")
        let failed = await workspace.createTag(TagDef(name: "Size", values: ["S", "M"]), value: "M", on: "Library/plan.md")
        XCTAssertNil(failed)
        XCTAssertEqual(try text("Library/Tags.md"), "---\nSize: [S, M]\n---\n" + Tags.noteBody)
        XCTAssertEqual(workspace.tagList.tags, [TagDef(name: "Size", values: ["S", "M"])])
        XCTAssertEqual(try text("Library/plan.md"), "---\nSize: M\n---\nBody\n")

        let deleted = await workspace.deleteTag("size")
        XCTAssertNil(deleted)
        XCTAssertEqual(try text("Library/Tags.md"), Tags.noteBody, "the list goes, its note stays")
        XCTAssertEqual(try text("Library/plan.md"), "---\nSize: M\n---\nBody\n", "a note keeps its line")
    }

    func testARenameRewritesEveryNoteThatHasItAndThenTheList() async throws {
        try put("Library/Tags.md", list)
        try put("Library/a.md", "---\nstatus: doing\n---\nA\n")
        try put("Library/Deep/b.md", "---\nStatus: Doing\npriority: p1\n---\nB\n")
        try put("Private/c.md", "---\nstatus: Done\n---\nC\n")
        try put("Elsewhere/d.md", "---\nstatus: Doing\n---\nIn no section.\n")
        await workspace.wrote(["Library/Tags.md"])

        // A value renamed: the notes that have it, and no other.
        let edit = TagEdit(
            from: "status", def: TagDef(name: "status", values: ["Todo", "In progress", "Done"]),
            renames: [TagEdit.Rename(from: "Doing", to: "In progress")]
        )
        let beside = await workspace.saveTagEdit(edit)
        XCTAssertNil(beside)
        XCTAssertEqual(try text("Library/Tags.md"), "---\nstatus: [Todo, Doing, In progress, Done]\npriority: [p1, p2]\n---\nWhat they mean.\n", "both, while the notes change")
        var counted: [Int] = []
        let done = await workspace.renameInNotes(edit) { counted.append($0) }
        XCTAssertEqual(done, TagRenamed(changed: 2, failed: [], listLeft: nil))
        XCTAssertEqual(done.words, "2 notes changed to match.")
        XCTAssertEqual(counted.last, 2)
        XCTAssertEqual(try text("Library/a.md"), "---\nstatus: In progress\n---\nA\n", "spelled as the list spells the tag")
        XCTAssertEqual(try text("Library/Deep/b.md"), "---\nstatus: In progress\npriority: p1\n---\nB\n")
        XCTAssertEqual(try text("Private/c.md"), "---\nstatus: Done\n---\nC\n")
        XCTAssertEqual(try text("Elsewhere/d.md"), "---\nstatus: Doing\n---\nIn no section.\n", "nothing outside the sections")
        XCTAssertEqual(try text("Library/Tags.md"), "---\nstatus: [Todo, In progress, Done]\npriority: [p1, p2]\n---\nWhat they mean.\n")

        // The tag renamed: every note that has it, whatever its value.
        let named = TagEdit(from: "status", def: TagDef(name: "State", values: ["Todo", "In progress", "Done"]), renames: [])
        let listed = await workspace.saveTagEdit(named)
        XCTAssertNil(listed)
        XCTAssertEqual(
            try text("Library/Tags.md"),
            "---\nstatus: [Todo, In progress, Done]\nState: [Todo, In progress, Done]\npriority: [p1, p2]\n---\nWhat they mean.\n"
        )
        let renamed = await workspace.renameInNotes(named) { _ in }
        XCTAssertEqual(renamed.changed, 3)
        XCTAssertEqual(try text("Library/a.md"), "---\nState: In progress\n---\nA\n")
        XCTAssertEqual(try text("Private/c.md"), "---\nState: Done\n---\nC\n")
        XCTAssertEqual(try text("Library/Tags.md"), "---\nState: [Todo, In progress, Done]\npriority: [p1, p2]\n---\nWhat they mean.\n")
        XCTAssertEqual(workspace.tagList.tags.map(\.name), ["State", "priority"])

        // An edit that renames nothing is the list's line alone.
        let reordered = TagEdit(from: "State", def: TagDef(name: "State", values: ["Done", "Todo"]), renames: [])
        XCTAssertFalse(reordered.rewritesNotes)
        let reorder = await workspace.saveTagEdit(reordered)
        XCTAssertNil(reorder)
        XCTAssertEqual(try text("Library/Tags.md"), "---\nState: [Done, Todo]\npriority: [p1, p2]\n---\nWhat they mean.\n")
        XCTAssertEqual(try text("Library/a.md"), "---\nState: In progress\n---\nA\n", "a removed value stays on its notes")
    }

    func testASearchsTagsNarrowItAndTagsAloneListEveryNoteByName() async throws {
        try put("Library/Tags.md", list)
        try put("Library/a.md", "---\nstatus: Doing\n---\nThe heron.\n")
        try put("Library/b.md", "---\nstatus: Done\n---\nThe heron.\n")
        try put("Library/heron.md", "---\nstatus: doing\n---\nNo words.\n")
        try put("Library/c.md", "The heron, untagged.\n")
        try put("Library/page.html", "<p>status: Doing</p>")
        await workspace.wrote(["Library/Tags.md"])
        let files = workspace.files

        let doing = [TagFilter(name: "status", value: "Doing")]
        XCTAssertEqual(files.search("", in: ["Library"], tags: doing).map(\.path), ["Library/a.md", "Library/heron.md"])
        XCTAssertTrue(files.search("", in: ["Library"], tags: doing).allSatisfy(\.hits.isEmpty))
        XCTAssertEqual(files.search("heron", in: ["Library"], tags: doing).map(\.path), ["Library/heron.md", "Library/a.md"])
        XCTAssertEqual(files.search("", in: ["Library"], tags: [TagFilter(name: "status", value: nil)]).count, 3)
        XCTAssertEqual(files.search("", in: ["Library"]), [], "no words and no tags is no search")

        let search = SearchModel(workspace: workspace)
        await search.run("status:doing")
        XCTAssertTrue(search.onlyTags)
        XCTAssertEqual(search.tags, doing, "spelled as the list spells it")
        XCTAssertEqual(search.tagged.map(\.name), ["a", "heron"])
        XCTAssertEqual(search.named, [])
        await search.run("heron status:Doing")
        XCTAssertFalse(search.onlyTags)
        XCTAssertEqual(search.named.map(\.name), ["heron"])
        XCTAssertEqual(search.inText.map(\.name), ["a"])
        await search.run("owner:Ada")
        XCTAssertEqual(search.query, "owner:Ada", "a name the list doesn't have is words")
    }
}
