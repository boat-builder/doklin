// Recent, what was read, the marks on a note, search and the tree: the parts
// of the screens that are not views, on folders of the tests' own — no
// engine, no worker.

import XCTest
@testable import DoklinKit

final class WhoTests: XCTestCase {
    private let people = [
        DirectoryPerson(id: "m-00000001", name: "Sherin Thomas", person: nil),
        DirectoryPerson(id: "m-00000002", name: "Maya Chen", person: nil),
        DirectoryPerson(id: "m-00000003", name: "Maya Ortiz", person: nil),
        DirectoryPerson(id: "m-00000004", name: "Tom Okafor", person: nil),
        DirectoryPerson(id: "a-00000001", name: "Planning agent", person: "m-00000004"),
        DirectoryPerson(id: "a-00000002", name: "grok bot", person: "m-00000002"),
        DirectoryPerson(id: "a-00000003", name: "Tom Okafor's terminal (MacBook Air)", person: "m-00000004"),
        DirectoryPerson(id: "a-00000004", name: "Research agent", person: "m-00000001"),
        DirectoryPerson(id: "a-00000005", name: "Old bot", person: nil),
        DirectoryPerson(id: "a-00000006", name: "Orphan", person: "m-0000dead"),
    ]

    private func who(_ by: String) -> String {
        WhoWords.name(by, me: "m-00000001", people: people, workspace: "Studio")
    }

    func testAPersonIsTheirNameAndThisPersonIsYou() {
        XCTAssertEqual(who("m-00000004"), "Tom Okafor")
        XCTAssertEqual(who("m-00000001"), "You")
        XCTAssertEqual(who(""), "You", "a change made here before the domain said who")
        XCTAssertEqual(who("m-0000dead"), "Someone no longer in Studio")
    }

    func testAnAgentIsItsPersonsAndTheNameTheyGaveIt() {
        XCTAssertEqual(who("a-00000001"), "Tom’s Planning agent")
        XCTAssertEqual(who("a-00000002"), "Maya Chen’s grok bot", "two Mayas: the whole name")
        XCTAssertEqual(who("a-00000003"), "Tom Okafor's terminal (MacBook Air)", "a name that says whose already")
        XCTAssertEqual(who("a-00000004"), "Your Research agent")
        XCTAssertEqual(who("a-00000005"), "Old bot", "a worker that does not say whose")
        XCTAssertEqual(who("a-00000006"), "Orphan")
        XCTAssertEqual(who("a-0000dead"), "An agent")
        XCTAssertTrue(WhoWords.isAgent("a-00000001"))
        XCTAssertEqual(WhoWords.initials("Maya Chen"), "MC")
    }
}

final class RecentTests: XCTestCase {
    private let people = [DirectoryPerson(id: "m-1", name: "Maya Chen", person: nil), DirectoryPerson(id: "a-1", name: "Research agent", person: "m-1")]

    private func file(_ path: String, _ mtime: Int, by: String = "a-1", rev: Int = 2, hash: String? = nil, id: String? = nil) -> RecentFile {
        RecentFile(path: path, fileId: id ?? "f-" + path, hash: hash ?? "h-\(path)-\(mtime)", mtime: mtime, by: by, rev: rev, section: nil)
    }

    func testANoteAndItsPageAreOneRowNewestFirst() {
        let recent = RecentFiles(files: [
            file("Plans/plan.html", 500, by: "m-1"),
            file("Plans/plan.md", 300),
            file("Notes/new.md", 400, rev: 1),
            file("Notes/new.meta.jsonl", 900),
            file("Pages/pricing.html", 100),
        ], people: people, me: "m-me")
        let items = RecentItem.items(recent, seen: nil, wsId: "w", workspace: "Studio")
        XCTAssertEqual(items.map(\.path), ["Plans/plan.md", "Notes/new.md", "Pages/pricing.html"])
        XCTAssertEqual(items[0].html, "Plans/plan.html")
        XCTAssertEqual(items[0].changed, 500)
        XCTAssertEqual(items[0].who, "Maya Chen")
        XCTAssertEqual(items[0].verb, "edited the page")
        XCTAssertEqual(items[1].verb, "created")
        XCTAssertEqual(items[1].who, "Maya’s Research agent")
        XCTAssertTrue(items[2].isPage)
        XCTAssertEqual(items[2].verb, "edited")
    }

    func testWhatChangedSinceItWasReadIsUnreadAndYourOwnNeverIs() throws {
        let seen = SeenStore(file: nil, now: 200)
        let recent = RecentFiles(files: [
            file("read.md", 300, hash: "aaaa"),
            file("changed.md", 300, hash: "bbbb"),
            file("never.md", 300, hash: "cccc"),
            file("old.md", 100, hash: "dddd"),
            file("mine.md", 300, by: "m-me", hash: "eeee"),
        ], people: people, me: "m-me")
        seen.saw("w", [(SeenStore.key(fileId: "f-read.md", path: "read.md"), "aaaa"), (SeenStore.key(fileId: "f-changed.md", path: "changed.md"), "old")])
        let items = Dictionary(uniqueKeysWithValues: RecentItem.items(recent, seen: seen, wsId: "w", workspace: "Studio").map { ($0.path, $0) })
        XCTAssertEqual(items["read.md"]?.unread, false)
        XCTAssertEqual(items["changed.md"]?.unread, true)
        XCTAssertEqual(items["changed.md"]?.changedSinceRead, true)
        XCTAssertEqual(items["never.md"]?.unread, true, "never read, changed since this device started counting")
        XCTAssertEqual(items["never.md"]?.changedSinceRead, false)
        XCTAssertEqual(items["old.md"]?.unread, false, "changed before this device started counting")
        XCTAssertEqual(items["mine.md"]?.unread, false)
        XCTAssertEqual(items["mine.md"]?.who, "You")

        XCTAssertEqual(RecentFilter.agents.keeps(items["read.md"]!), true)
        XCTAssertEqual(RecentFilter.people.keeps(items["mine.md"]!), true)
        XCTAssertEqual(RecentFilter.unread.keeps(items["read.md"]!), false)
    }

    func testWhatWasReadIsKeptOnTheDevice() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("seen-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        let first = SeenStore(file: file, now: 1234)
        first.saw("w", [("f-1", "abcd")])
        let again = SeenStore(file: file, now: 9999)
        XCTAssertEqual(again.hash("w", "f-1"), "abcd")
        XCTAssertEqual(again.since, 1234, "since when stays what it was")
        again.forget("w")
        XCTAssertNil(SeenStore(file: file).hash("w", "f-1"))
        XCTAssertEqual(SeenStore.key(fileId: nil, path: "A/B.md"), "path:a/b.md")
    }

    func testARowSaysWhenAndTheFirstWords() {
        let dates = HistoryDates(now: Date(timeIntervalSince1970: 1_000_000), calendar: Calendar(identifier: .gregorian), locale: Locale(identifier: "en_GB"))
        let now = 1_000_000_000
        XCTAssertEqual(RecentWords.time(now - 20_000, now: now, dates: dates), "now")
        XCTAssertEqual(RecentWords.time(now - 12 * 60_000, now: now, dates: dates), "12m")
        XCTAssertEqual(RecentWords.time(now - 3 * 3_600_000, now: now, dates: dates), "3h")

        let note = "---\ntitle: x\n---\n# Interviews\n\nFive calls this week{>>c1<<}, all with teams.\n\nMore.\n"
        XCTAssertEqual(RecentWords.excerpt(ofNote: note), "Five calls this week, all with teams.")
        XCTAssertEqual(RecentWords.excerpt(ofNote: "# Only a title\n"), nil)
        XCTAssertEqual(RecentWords.excerpt(ofNote: "- [ ] First thing\n- [ ] Second\n"), "First thing")
        let page = "<html><head><title>T</title></head><body><h1>Pricing</h1><p class=\"lead\">Two plans, <b>monthly</b> &amp; yearly.</p></body></html>"
        XCTAssertEqual(RecentWords.excerpt(ofPage: page), "Two plans, monthly & yearly.")
        let long = String(repeating: "word ", count: 80)
        XCTAssertTrue(RecentWords.excerpt(ofNote: long, limit: 20)!.hasSuffix("…"))
    }
}

final class MarksTests: XCTestCase {
    func testFindMarksEveryPlaceInReadingOrder() {
        let document = MarkdownDocument.parse("# Ship it\n\nWe ship **on Friday**, then ship again.\n\n- ship the box\n\n| a | b |\n| - | - |\n| ship | x |\n")
        let found = Find.occurrences(of: "SHIP", in: document)
        XCTAssertEqual(found.count, 5)
        XCTAssertEqual(found.occurrences.map(\.top), [0, 1, 1, 2, 4].map { document.blocks[[0, 1, 1, 2, 3][[0, 1, 1, 2, 4].firstIndex(of: $0)!]].id })
        let paragraph = Find.container(document.blocks[1].id)
        XCTAssertEqual(found.marks(in: paragraph, current: 2).map(\.mark), [.found, .current])

        guard case .paragraph(let content) = document.blocks[1].block else { return XCTFail() }
        let marked = RunMarks.apply(content.runs, marks: found.marks(in: paragraph, current: 1))
        XCTAssertEqual(marked.filter { $0.mark != nil }.map(\.run.text), ["ship", "ship"])
        XCTAssertEqual(marked.map(\.run.text).joined(), RunMarks.text(content.runs), "nothing is lost")
        XCTAssertTrue(marked.contains { $0.run.text == "on Friday" && $0.run.bold }, "the styles stay")
        XCTAssertEqual(Find.block(atLine: 4, in: document), document.blocks[2].id)
    }

    func testRemovedWordsArePutBackWhereTheyWere() {
        let runs = [InlineRun("We open on 2 December.")]
        let marked = RunMarks.apply(runs, marks: [(11..<21, .added)], removals: [Removal(at: 11, text: "25 November ")])
        XCTAssertEqual(marked.map(\.run.text), ["We open on ", "25 November ", "2 December", "."])
        XCTAssertEqual(marked.map(\.mark), [nil, .removed, .added, nil])
    }

    func testWhatChangedSinceItWasReadIsMarkedBlockByBlock() {
        let old = MarkdownDocument.parse("""
        # Beta launch plan

        We open the beta to the first 40 teams on 25 November, so support is staffed first.

        ## Before launch

        - [x] Pricing page live
        - [ ] Support inbox staffed
        - [ ] Status page linked from the app

        An old paragraph nobody needs.

        ## Who owns what

        Maya: the emails.
        """)
        let new = MarkdownDocument.parse("""
        # Beta launch plan

        We open the beta to the first 40 teams on 2 December, so support is staffed first.

        ## Before launch

        - [x] Pricing page live
        - [ ] Support inbox staffed, two people per shift
        - [ ] Status page linked from the app

        ## Who owns what

        Maya: the emails.

        A new closing line.
        """)
        let marks = ChangeMarks.between(old, new)
        XCTAssertEqual(marks.count, 4, "a paragraph, an item, a removal and an insertion")
        let paragraph = new.blocks[1]
        XCTAssertEqual(marks.blocks[paragraph.id], .changed)
        let words = marks.words[Find.container(paragraph.id)]
        guard case .paragraph(let content) = paragraph.block else { return XCTFail() }
        let text = RunMarks.text(content.runs)
        XCTAssertEqual(words?.added.map { String(Array(text)[$0]) }, ["2 December,"])
        XCTAssertEqual(words?.removed.map(\.text), ["25 November, "])
        guard case .list(let list) = new.blocks[3].block else { return XCTFail() }
        XCTAssertEqual(marks.items[list.items[1].line], .changed)
        XCTAssertNil(marks.items[list.items[0].line])
        XCTAssertEqual(marks.removedBefore[new.blocks[4].id], ["An old paragraph nobody needs."])
        XCTAssertEqual(marks.blocks[new.blocks.last!.id], .inserted)
        XCTAssertNil(marks.blocks[new.blocks[0].id], "the title did not change")
        XCTAssertEqual(marks.stops, [paragraph.id, new.blocks[3].id, new.blocks[4].id, new.blocks.last!.id])
        XCTAssertTrue(ChangeMarks.between(new, new).isEmpty)
    }
}

final class SearchModelTests: XCTestCase {
    func testAHitShowsTheWordsAroundIt() {
        let line = "Before launch we need the support inbox staffed with two people per shift, every day of the week."
        let snippet = SearchSnippet.around("inbox", in: line, width: 40)
        XCTAssertEqual(snippet.match, "inbox")
        XCTAssertTrue(snippet.before.hasPrefix("…"))
        XCTAssertTrue(snippet.after.hasSuffix("…"))
        XCTAssertFalse(snippet.before.dropFirst().hasPrefix(" "))
        XCTAssertEqual(SearchSnippet.around("x", in: "short").before, "short")
    }

    func testScopesNarrowWhatWasFound() {
        let note = SearchResult(path: "Plans/plan.md", hits: [])
        let page = SearchResult(path: "Pages/pricing.html", hits: [])
        XCTAssertTrue(SearchScope.notes.keeps(note))
        XCTAssertFalse(SearchScope.notes.keeps(page))
        XCTAssertTrue(SearchScope.pages.keeps(page))
        XCTAssertTrue(SearchScope.folder("Plans").keeps(note))
        XCTAssertFalse(SearchScope.folder("Plans").keeps(page))
        XCTAssertEqual(SearchScope.folder("Team/Plans").label, "Plans")
    }

    func testTheLastSearchesAreKept() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "search-\(UUID().uuidString)"))
        let recents = RecentSearches(wsId: "w", defaults: defaults)
        for query in ["one", "two", "One ", " "] { recents.add(query) }
        XCTAssertEqual(recents.all, ["One", "two"])
        for n in 0..<20 { recents.add("q\(n)") }
        XCTAssertEqual(recents.all.count, RecentSearches.kept)
        recents.clear()
        XCTAssertEqual(recents.all, [])
    }
}

@MainActor
final class TreeTests: XCTestCase {
    /// A workspace's folder in its sections, with a stray at the top and its
    /// marker, and a way to clean it up.
    private func workspace() throws -> (URL, UserDefaults) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("doklin-tree-\(UUID().uuidString)")
        for path in [
            "Library/Product/Plans/beta.md", "Library/Product/roadmap.md", "Library/Team/handbook.md", "Library/welcome.md",
            "Shared with me/Finance/budget.md", "My files/diary.md", "Scratch/loose.md", ".doklin/cloud.json",
        ] {
            let url = root.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("# x\n".utf8).write(to: url)
        }
        return (root, try XCTUnwrap(UserDefaults(suiteName: "tree-\(UUID().uuidString)")))
    }

    func testTheTreeOpensInPlaceAndRemembersWhatWasOpen() async throws {
        let (root, defaults) = try workspace()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = Workspaces(remembered: defaults).workspace(root.path)
        let tree = TreeModel(workspace: workspace, defaults: defaults)
        tree.load()
        // The three headings as the Mac's sidebar has them, each its
        // folder's insides; what is in none after them.
        XCTAssertEqual(tree.groups.map(\.section), [.library, .mine, .shared, .nowhere])
        XCTAssertEqual(tree.groups.map(\.folder), ["Library", "My files", "Shared with me", ""])
        XCTAssertEqual(tree.groups[0].rows.map(\.entry.path), ["Library/Product", "Library/Team", "Library/welcome.md"])
        XCTAssertEqual(tree.groups[1].rows.map(\.entry.path), ["My files/diary.md"])
        XCTAssertEqual(tree.groups[2].rows.map(\.entry.path), ["Shared with me/Finance"])
        XCTAssertEqual(tree.groups[3].rows.map(\.entry.path), ["Scratch"])

        tree.toggle("Library/Product")
        XCTAssertEqual(tree.groups[0].rows.map(\.entry.path), [
            "Library/Product", "Library/Product/Plans", "Library/Product/roadmap.md", "Library/Team", "Library/welcome.md",
        ])
        XCTAssertEqual(tree.groups[0].rows.map(\.depth), [0, 1, 1, 0, 0])
        XCTAssertTrue(tree.groups[0].rows[0].open)

        let again = TreeModel(workspace: workspace, defaults: defaults)
        again.load()
        XCTAssertTrue(again.isOpen("library/product"), "what was open is kept")
        again.toggle("Library/Product")
        XCTAssertEqual(again.groups[0].rows.count, 3)

        again.reveal("Library/Product/Plans/beta.md")
        XCTAssertTrue(again.groups[0].rows.contains { $0.entry.path == "Library/Product/Plans/beta.md" })
    }

    func testTheThreeHeadingsAreThereEvenWhenTheirFoldersAreNotAndStraysOnlyWhenThereAreAny() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("doklin-tree-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("my files"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "tree-\(UUID().uuidString)"))
        let tree = TreeModel(workspace: Workspaces(remembered: defaults).workspace(root.path), defaults: defaults)
        tree.load()
        XCTAssertEqual(tree.groups.map(\.section), [.library, .mine, .shared])
        XCTAssertEqual(tree.groups.map(\.folder), ["Library", "my files", "Shared with me"], "a folder as the disk spells it, else as doklin does")
        XCTAssertEqual(tree.groups.map(\.rows), [[], [], []])
        XCTAssertEqual(tree.groups.map(\.section.emptyHint), [
            "No documents yet. Make one with the plus above.",
            "Only you can open what you put here, until you share it.",
            "What other people share with you shows here.",
        ])
    }

    func testTheFilterNarrowsTheTreeToNamesAndTheirFolders() async throws {
        let (root, defaults) = try workspace()
        defer { try? FileManager.default.removeItem(at: root) }
        let tree = TreeModel(workspace: Workspaces(remembered: defaults).workspace(root.path), defaults: defaults)
        tree.filter = "BETA"
        XCTAssertEqual(tree.groups.map(\.section), [.library])
        XCTAssertEqual(tree.groups[0].rows.map(\.entry.path), ["Library/Product", "Library/Product/Plans", "Library/Product/Plans/beta.md"])
        XCTAssertFalse(tree.isOpen("Library/Product"), "a filter opens nothing for good")
        tree.filter = "budget"
        XCTAssertEqual(tree.groups.map(\.section), [.shared])
        tree.filter = "loose"
        XCTAssertEqual(tree.groups.map(\.section), [.nowhere])
        XCTAssertEqual(tree.groups[0].rows.map(\.entry.path), ["Scratch", "Scratch/loose.md"])
        tree.filter = ""
        XCTAssertEqual(tree.groups.count, 4)
    }
}
