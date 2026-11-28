// The board rules held to the cases the Mac's are held to:
// verify-harness/boards-fixture.json, which verify-harness/boards.test.mjs
// checks src/boards.ts and src/rank.ts against, and the engine's merge too —
// plus what holds for every case: canonical bytes read back to themselves,
// and a drop leaves the column in the order it showed. Merging is the
// engine's, so the `merge` cases aren't read here.

import XCTest
@testable import DoklinKit

final class BoardsTests: XCTestCase {
    private static let fixture: JSValue = {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let url = repo.appendingPathComponent("verify-harness/boards-fixture.json")
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

    private func text(_ c: JSValue, _ key: String) -> String? { c[JSString(key)]?.string?.string }
    private func texts(_ c: JSValue, _ key: String) -> [String] { (c[JSString(key)]?.array ?? []).compactMap { $0.string?.string } }

    private func board(_ c: JSValue, _ key: String = "board", file: StaticString = #filePath, line: UInt = #line) -> Board {
        guard let source = text(c, key), case .board(let board) = Boards.parse(source) else {
            XCTFail("not a board: \(text(c, key) ?? "")", file: file, line: line)
            return Board(tag: "")
        }
        return board
    }

    /// A board as the fixture writes one, `{tag, cards: {name: {rank, extra}}, extra}`.
    private func shape(_ board: Board) -> String {
        let cards = board.cards.map { name, card in
            (JSString(name), JSValue.object([
                ("rank", card.rank.map { .string(JSString($0)) } ?? .null),
                ("extra", .object(card.extra.map { ($0.key, $0.value) })),
            ]))
        }
        return Boards.canonical(.object([
            ("tag", .string(JSString(board.tag))),
            ("cards", .object(cards)),
            ("extra", .object(board.extra.map { ($0.key, $0.value) })),
        ]))
    }

    func testRanksBetweenTwo() {
        for c in cases("rank") {
            XCTAssertEqual(Rank.between(text(c, "a"), text(c, "b")), text(c, "out"), "rank between \(text(c, "a") ?? "nil") and \(text(c, "b") ?? "nil")")
        }
    }

    func testSeveralRanks() {
        for c in cases("ranks") {
            let count = Int(c["n"]?.number ?? 0)
            let got = Rank.between(text(c, "a"), text(c, "b"), count: count)
            XCTAssertEqual(got, texts(c, "out"), "\(count) ranks between \(text(c, "a") ?? "nil") and \(text(c, "b") ?? "nil")")
            XCTAssertEqual(got.sorted(), got, "ranks come in order")
        }
    }

    func testReading() {
        for c in cases("parse") {
            let source = text(c, "text")!
            let got: String
            switch Boards.parse(source) {
            case .board(let board): got = shape(board)
            case .newer: got = "\"newer\""
            case .unreadable: got = "null"
            }
            XCTAssertEqual(got, Boards.canonical(c["board"] ?? .null), "read \(source.debugDescription)")
        }
    }

    func testCanonicalBytes() {
        for c in cases("canonical") {
            let source = text(c, "text")!
            let want = text(c, "out")
            if case .board(let board) = Boards.parse(source) {
                XCTAssertEqual(Boards.serialize(board), want, "canonical \(source.debugDescription)")
            } else {
                XCTAssertNil(want, "no board in \(source.debugDescription)")
            }
            if let want, case .board(let again) = Boards.parse(want) {
                XCTAssertEqual(Boards.serialize(again), want, "canonical bytes read back to themselves: \(want.debugDescription)")
            }
        }
    }

    func testColumns() {
        for c in cases("columns") {
            let def = c["def"]!
            let tag = TagDef(name: text(def, "name")!, values: texts(def, "values"))
            let notes = (c["notes"]?.array ?? []).map { BoardNote(name: text($0, "name")!, value: text($0, "value")) }
            let want = (c["columns"]?.array ?? []).map {
                BoardColumn(value: text($0, "value"), known: $0["known"] == .bool(true), cards: texts($0, "cards"))
            }
            XCTAssertEqual(Boards.columns(board(c), def: tag, notes: notes), want, "columns of \(text(c, "board") ?? "")")
        }
    }

    func testDrops() {
        for c in cases("drop") {
            let column = texts(c, "column")
            let index = Int(c["index"]?.number ?? 0)
            let card = text(c, "card")!
            let got = Boards.drop(card, at: index, in: column, on: board(c))
            XCTAssertEqual(Boards.serialize(got), text(c, "out"), "drop \(card) at \(index) in \(column)")
            // What was seen is what stays: the column's cards keep their
            // order, and the card sits where it was dropped.
            let others = column.filter { $0.lowercased() != card.lowercased() }
            let at = min(index, others.count)
            let want = Array(others[..<at]) + [card] + Array(others[at...])
            XCTAssertEqual(Boards.order(want, on: got), want, "the column shows what was dropped: \(want)")
        }
    }

    func testRenames() {
        for c in cases("rename") {
            let from = text(c, "from")!, to = text(c, "to")!
            XCTAssertEqual(Boards.serialize(Boards.rename(from, to: to, on: board(c))), text(c, "out"), "rename \(from) to \(to)")
        }
    }

    func testPrunes() {
        for c in cases("prune") {
            let names = texts(c, "names")
            XCTAssertEqual(Boards.serialize(Boards.prune(board(c), to: names)), text(c, "out"), "prune to \(names)")
        }
    }

    func testTheFileIsFoundWhateverItsCase() {
        XCTAssertTrue(Boards.isFile("Projects/Launch/Boards.JSON"))
        XCTAssertFalse(Boards.isFile("Projects/boards.json.md"))
    }
}

/// A board on this iPhone's files (Models/Board.swift): its folder read as
/// cards, a card moved (its note, then the file), "+ New", a rename that
/// keeps a card's place, a tag's rename, and a write made on what sync
/// wrote meanwhile.
@MainActor
final class BoardModelTests: XCTestCase {
    private var root: URL!
    private var device: Workspaces!
    private var workspace: Workspace!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("doklin-boards-\(UUID().uuidString)")
        for folder in ["Library/Sprint/Sub", "My files"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(folder), withIntermediateDirectories: true)
        }
        device = Workspaces(remembered: UserDefaults(suiteName: "doklin-test-\(UUID().uuidString)")!)
        try listing([TagDef(name: "Status", values: ["Todo", "Doing", "Done"]), TagDef(name: "Size", values: ["S", "M"])])
        workspace = device.workspace(root.path)
        try put("Library/Sprint/a.md", "---\nstatus: doing\nsize: m\n---\nA\n")
        try put("Library/Sprint/b.md", "B\n")
        try put("Library/Sprint/Page.html", "<p>A page</p>")
        try put("Library/Sprint/Sub/c.md", "---\nStatus: Todo\n---\nIn a subfolder.\n")
    }

    /// The engine's word on this workspace, holding `tags` as its list.
    private func listing(_ tags: [TagDef]) throws {
        let list = String(decoding: try JSONEncoder().encode(tags), as: UTF8.self)
        let json = """
        {"root":\(String(decoding: try JSONEncoder().encode(root.path), as: UTF8.self)),"domain":"d","endpoint":"https://d","wsId":"w-1","name":"Team","phase":"idle",
         "lastSyncMs":1,"error":null,"pendingDeletes":0,"pendingAdds":0,
         "usage":{"mode":"normal","cause":null,"today":0,"fleetToday":null,"cap":null,"plan":null,"resumesAt":null,"waiting":0,"liftable":false,"lifted":false},
         "me":"Ada","meId":"m-1","can":[],"workerVersion":37,"public":[],"tags":\(list),"presence":[],"leases":[],"spaces":[]}
        """
        device.take([try JSONDecoder().decode(CloudStatus.self, from: Data(json.utf8))])
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func put(_ path: String, _ text: String) throws {
        try workspace.files.write(path, Data(text.utf8))
    }

    private func text(_ path: String) throws -> String { try workspace.files.text(path) }

    private func file(_ cards: [(String, String)], tag: String = "Status") -> String {
        var board = Board(tag: tag)
        for (name, rank) in cards { board.cards[name] = BoardCard(rank: rank) }
        return Boards.serialize(board)
    }

    private func shown(_ model: BoardModel) -> [String] {
        model.columns.map { "\($0.value ?? "-"): \($0.cards.joined(separator: ", "))" }
    }

    func testShowAsBoardMakesTheFileAndTheFolderReadsAsCards() async throws {
        let made = await workspace.showAsBoard("Library/Sprint", by: "Status")
        XCTAssertNil(made)
        XCTAssertEqual(try text("Library/Sprint/boards.json"), file([]))
        XCTAssertFalse(try workspace.files.list("Library/Sprint").contains { $0.name == "boards.json" }, "the file is never a row")
        XCTAssertTrue(workspace.files.isBoard("Library/Sprint"))

        let model = BoardModel(workspace: workspace, dir: "Library/Sprint")
        await model.reload()
        XCTAssertEqual(model.state, .shown)
        XCTAssertEqual(shown(model), ["-: b.md, Page.html", "Todo: ", "Doing: a.md", "Done: "], "a subfolder's notes are not cards")
        XCTAssertEqual(model.noValue, "No Status")
        XCTAssertEqual(model.chips("a.md"), [NoteTag(name: "Size", value: "M", known: true)])
        XCTAssertNotNil(model.fixed("Page.html"), "an html document can't change columns")
        XCTAssertFalse(model.takes("Page.html", in: model.columns[1]))
        XCTAssertTrue(model.takes("Page.html", in: model.columns[0]), "but it can be reordered in its own")

        let tree = TreeModel(workspace: workspace, defaults: UserDefaults(suiteName: "doklin-test-\(UUID().uuidString)")!)
        tree.load()
        XCTAssertEqual(tree.groups.first?.rows.first { $0.entry.name == "Sprint" }?.board, true)

        await model.showAsFolder()
        XCTAssertEqual(model.state, .noFile)
        XCTAssertFalse(workspace.files.isBoard("Library/Sprint"))
    }

    func testAMoveWritesTheNoteThenTheBoard() async throws {
        try put("Library/Sprint/boards.json", file([("a.md", "a0")]))
        let model = BoardModel(workspace: workspace, dir: "Library/Sprint")
        await model.reload()

        // To another column: the note's tag, as the list spells it, then a rank.
        await model.move("b.md", to: model.columns[2], at: 0)
        XCTAssertNil(model.problem)
        XCTAssertEqual(try text("Library/Sprint/b.md"), "---\nStatus: Doing\n---\nB\n")
        XCTAssertEqual(try text("Library/Sprint/boards.json"), file([("a.md", "a0"), ("b.md", "Zz")]))
        XCTAssertEqual(shown(model), ["-: Page.html", "Todo: ", "Doing: b.md, a.md", "Done: "])

        // Within its column: the file alone.
        await model.move("b.md", to: model.columns[2], at: 1)
        XCTAssertEqual(try text("Library/Sprint/boards.json"), file([("a.md", "a0"), ("b.md", "a1")]))
        XCTAssertEqual(try text("Library/Sprint/b.md"), "---\nStatus: Doing\n---\nB\n")
        XCTAssertEqual(shown(model)[2], "Doing: a.md, b.md")

        // To "No Status": the tag goes.
        await model.move("a.md", to: model.columns[0], at: 1)
        XCTAssertEqual(try text("Library/Sprint/a.md"), "---\nsize: m\n---\nA\n")
        XCTAssertEqual(shown(model)[0], "-: Page.html, a.md")
    }

    func testAWriteIsMadeOnWhatSyncWroteMeanwhileAndDropsCardsThatWent() async throws {
        try put("Library/Sprint/boards.json", file([("a.md", "a0"), ("gone.md", "a1")]))
        let model = BoardModel(workspace: workspace, dir: "Library/Sprint")
        await model.reload()
        // Another device ranked b.md, and the file came here before the drop.
        try put("Library/Sprint/boards.json", file([("a.md", "a0"), ("b.md", "a5"), ("gone.md", "a1")]))
        await model.move("Page.html", to: model.columns[0], at: 0)
        XCTAssertEqual(
            try text("Library/Sprint/boards.json"),
            file([("Page.html", "a4"), ("a.md", "a0"), ("b.md", "a5")]),
            "sync's rank stays, and a card whose note is gone leaves"
        )
    }

    func testNewMakesAnUntitledNoteWithTheColumnsValueAtItsEnd() async throws {
        try put("Library/Sprint/boards.json", file([("a.md", "a0")]))
        let model = BoardModel(workspace: workspace, dir: "Library/Sprint")
        await model.reload()
        let made = await model.newCard(in: model.columns[2])
        XCTAssertEqual(made, "Library/Sprint/Untitled.md")
        XCTAssertEqual(try text("Library/Sprint/Untitled.md"), "---\nStatus: Doing\n---\n")
        XCTAssertEqual(try text("Library/Sprint/boards.json"), file([("Untitled.md", "a1"), ("a.md", "a0")]))
        XCTAssertEqual(shown(model)[2], "Doing: a.md, Untitled.md")

        let none = await model.newCard(in: model.columns[0])
        XCTAssertEqual(none, "Library/Sprint/Untitled 2.md")
        XCTAssertEqual(try text("Library/Sprint/Untitled 2.md"), "", "a note with no tag")
    }

    func testARenameHereKeepsTheCardsPlace() async throws {
        try put("Library/Sprint/boards.json", file([("a.md", "a0"), ("b.md", "a1")]))
        let folder = FolderModel(workspace: workspace, dir: "Library/Sprint")
        let a = try XCTUnwrap(try workspace.files.list("Library/Sprint").first { $0.name == "a" })
        try await folder.rename(a, to: "Alpha")
        XCTAssertEqual(try text("Library/Sprint/boards.json"), file([("Alpha.md", "a0"), ("b.md", "a1")]))

        // Moved to another folder, it leaves this board at the next write.
        let b = try XCTUnwrap(try workspace.files.list("Library/Sprint").first { $0.name == "b" })
        try await folder.move(b, into: "My files")
        XCTAssertEqual(try text("Library/Sprint/boards.json"), file([("Alpha.md", "a0"), ("b.md", "a1")]))
        let model = BoardModel(workspace: workspace, dir: "Library/Sprint")
        await model.reload()
        await model.group(by: "Size")
        XCTAssertEqual(try text("Library/Sprint/boards.json"), file([("Alpha.md", "a0")], tag: "Size"))
    }

    func testATagsRenameRegroupsItsBoardsAndAMissingTagSaysSo() async throws {
        try put("Library/Sprint/boards.json", file([("a.md", "a0")]))
        try put("Library/Sprint/Sub/boards.json", file([], tag: "Size"))
        // What `renameInNotes` does once the notes have the new name (the
        // whole rename, through the engine, is EngineLiveTests').
        let failed = await workspace.regroupBoards(from: "status", to: "Stage")
        XCTAssertEqual(failed, [])
        XCTAssertEqual(try text("Library/Sprint/boards.json"), file([("a.md", "a0")], tag: "Stage"))
        XCTAssertEqual(try text("Library/Sprint/Sub/boards.json"), file([], tag: "Size"), "a board grouped by another tag stays")

        try listing([TagDef(name: "Stage", values: ["Todo", "Doing", "Done"])])
        let model = BoardModel(workspace: workspace, dir: "Library/Sprint/Sub")
        await model.reload()
        XCTAssertEqual(model.state, .noTag("Size"))
    }

    func testAFileThisAppCantReadIsNeverWrittenOver() async throws {
        let newer = "{\"doklin\":\"boards\",\"v\":2,\"views\":[]}"
        try put("Library/Sprint/boards.json", newer)
        let model = BoardModel(workspace: workspace, dir: "Library/Sprint")
        await model.reload()
        XCTAssertEqual(model.state, .newer)
        let refused = await workspace.showAsBoard("Library/Sprint", by: "Status")
        XCTAssertNotNil(refused)
        try put("Library/Sprint/boards.json", "not json")
        let unread = await workspace.showAsBoard("Library/Sprint", by: "Status")
        XCTAssertNotNil(unread)
        XCTAssertEqual(try text("Library/Sprint/boards.json"), "not json")
        await model.reload()
        XCTAssertEqual(model.state, .unreadable)
    }
}
