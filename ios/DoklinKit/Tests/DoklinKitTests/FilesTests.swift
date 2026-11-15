// The workspace's files as the screens see them, on a folder of the test's
// own: no engine, no worker.

import XCTest
@testable import DoklinKit

final class FilesTests: XCTestCase {
    private var root: URL!
    private var files: WorkspaceFiles!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("doklin-files-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        files = WorkspaceFiles(root: root)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func put(_ path: String, _ text: String = "x") throws {
        try files.write(path, Data(text.utf8))
    }

    func testAFolderListsAsTheMacsSidebarDoes() throws {
        try put("Ideas.md", "# Ideas\n")
        try put("plan.md")
        try put("plan.html", "<h1>Plan</h1>")
        try put("plan.meta.jsonl", "{\"doklin\":\"meta\",\"v\":1}\n")
        try put("Page.html")
        try put("pic.png")
        try put(".hidden.md")
        try put("node_modules/a.js")
        try put("b Folder/note.md")
        try put("a Folder/note.md")

        let entries = try files.list("")
        XCTAssertEqual(entries.map(\.path), [
            "a Folder", "b Folder",
            "Ideas.md", "Page.html", "plan.md",
            "pic.png",
        ])
        guard case .document(let plan) = entries[4] else { return XCTFail("\(entries)") }
        XCTAssertEqual(plan.html, "plan.html")
        XCTAssertEqual(entries[4].name, "plan")
        guard case .document(let page) = entries[3] else { return XCTFail("\(entries)") }
        XCTAssertTrue(page.isHTML)
        XCTAssertNil(page.html)
    }

    func testANewNoteNeverTakesANameInUse() throws {
        try put("Notes/Plan.md")
        XCTAssertThrowsError(try files.createNote(in: "Notes", named: "plan")) { error in
            XCTAssertEqual((error as? DoklinError)?.message, "A note named “plan” is already here.")
        }
        XCTAssertThrowsError(try files.createNote(in: "Notes", named: ".secret"))
        XCTAssertThrowsError(try files.createNote(in: "Notes", named: "a/b"))
        let made = try files.createNote(in: "Notes", named: "Groceries.md")
        XCTAssertEqual(made, "Notes/Groceries.md")
        XCTAssertEqual(try files.text(made), "# Groceries\n\n")
    }

    func testRenamingADocumentTakesItsPageAndCommentsAlong() throws {
        try put("Projects/plan.md", "# Plan\n")
        try put("Projects/plan.html")
        try put("Projects/plan.meta.jsonl")
        let entry = try XCTUnwrap(try files.list("Projects").first)
        let (path, changed) = try files.rename(entry, to: "Roadmap")
        XCTAssertEqual(path, "Projects/Roadmap.md")
        XCTAssertEqual(Set(changed), [
            "Projects/plan.md", "Projects/Roadmap.md",
            "Projects/plan.html", "Projects/Roadmap.html",
            "Projects/plan.meta.jsonl", "Projects/Roadmap.meta.jsonl",
        ])
        XCTAssertEqual(try files.list("Projects").map(\.path), ["Projects/Roadmap.md"])
        XCTAssertTrue(files.exists("Projects/Roadmap.meta.jsonl"))

        // A change of case alone is a rename too.
        let renamed = try XCTUnwrap(try files.list("Projects").first)
        _ = try files.rename(renamed, to: "roadmap")
        XCTAssertEqual(try files.list("Projects").map(\.path), ["Projects/roadmap.md"])
    }

    func testAMoveRefusesToWriteOverAndAFolderCannotGoIntoItself() throws {
        try put("a.md")
        try put("Archive/a.md")
        let note = try XCTUnwrap(try files.list("").first { $0.path == "a.md" })
        XCTAssertThrowsError(try files.move(note, into: "Archive"))
        XCTAssertEqual(try files.text("a.md"), "x")

        try put("Archive/Old/b.md")
        XCTAssertThrowsError(try files.move(.folder("Archive"), into: "Archive/Old"))
        let (path, _) = try files.move(.folder("Archive/Old"), into: "")
        XCTAssertEqual(path, "Old")
        XCTAssertTrue(files.exists("Old/b.md"))
    }

    func testRemovingADocumentTakesWhatIsItsAlong() throws {
        try put("plan.md")
        try put("plan.html")
        try put("plan.meta.jsonl")
        try put("other.md")
        let plan = try XCTUnwrap(try files.list("").first { $0.path == "plan.md" })
        XCTAssertEqual(Set(try files.remove(plan)), ["plan.md", "plan.html", "plan.meta.jsonl"])
        XCTAssertEqual(try files.list("").map(\.path), ["other.md"])
    }

    func testSearchFindsLinesOfNotesOnly() throws {
        try put("a.md", "# A\n\nThe boat is blue.\r\nAnother line.\n")
        try put("b.html", "<p>the boat</p>")
        try put("Deep/c.md", "nothing here\nBOATS galore\n")
        let found = files.search("boat")
        XCTAssertEqual(found.map(\.path), ["a.md", "Deep/c.md"])
        XCTAssertEqual(found[0].hits, [SearchHit(line: 2, preview: "The boat is blue.")])
        XCTAssertEqual(found[1].hits.map(\.line), [1])
        XCTAssertTrue(files.search("   ").isEmpty)
    }

    func testANotesCommentFileIsBesideItUnderItsStem() {
        XCTAssertEqual(DocLinks.metaFile(of: "Projects/plan.md"), "Projects/plan.meta.jsonl")
        XCTAssertEqual(DocLinks.metaFile(of: "page.html"), "page.meta.jsonl")
        XCTAssertEqual(DocLinks.stem(of: "notes.MARKDOWN"), "notes")
        XCTAssertEqual(DocLinks.stem(of: "photo.png"), "photo.png")
        XCTAssertEqual(DocLinks.stem(of: ".md"), ".md")
    }
}

/// Who sees what, read off the sections the engine lists.
final class AudienceTests: XCTestCase {
    /// A status as the engine writes one, with these sections.
    private func status(sections: Bool, spaces: String) throws -> CloudStatus {
        let json = """
        {"root":"/w","domain":"d","endpoint":"https://d","wsId":"w-1","name":"Notes","phase":"idle",
         "lastSyncMs":1,"error":null,"pendingDeletes":0,"me":"Ada","meId":"m-1","can":[],"workerVersion":17,
         "public":[],"presence":[],"leases":[],"sections":\(sections),"spaces":\(spaces)}
        """
        return try JSONDecoder().decode(CloudStatus.self, from: Data(json.utf8))
    }

    func testSectionsSayWhoCanOpenAPath() throws {
        let spaces = """
        [{"id":"s-p","kind":"private","name":"Private","path":"Private","by":"Ada","members":["m-1"]},
         {"id":"s-f","kind":"restricted","name":"Finance","path":"Restricted/Finance","by":"Ada","members":["m-1","m-2"]}]
        """
        let s = try status(sections: true, spaces: spaces)
        XCTAssertEqual(Audience.of("Projects/plan.md", in: s), .everyone)
        XCTAssertEqual(Audience.of("private/diary.md", in: s), .onlyYou)
        XCTAssertEqual(Audience.of("Restricted/Finance/q3.md", in: s), .folder("Finance"))
        XCTAssertEqual(Audience.of("Restricted", in: s), .folders)
        XCTAssertEqual(Audience.of("Restricted/Loose", in: s), .nowhere)
        // A workspace not in sections has shared folders by those names.
        XCTAssertEqual(Audience.of("Private/diary.md", in: try status(sections: false, spaces: "[]")), .everyone)
        XCTAssertEqual(Audience.of("anything", in: nil), .everyone)
    }

    func testAStatusFromBeforeTheDomainAnsweredMayEverything() throws {
        let s = try status(sections: false, spaces: "[]")
        XCTAssertTrue(s.may("people.invite"))
    }
}
