// A folder shown as a board, driven through the real screens against the
// harness worker (`node verify-harness/drive-ios.mjs --app`): a folder made
// in Library with two notes, shown as a board by a tag made from its menu;
// a card moved from its menu, which sets its note's tag, and another
// dragged to the next column; "+ New" in a column; and the board shown as a
// folder again, its chevron and its notes as they were.

import XCTest

final class BoardUITests: UITestCase {
    func testAFolderShownAsABoard() throws {
        launchAndJoin()

        // A folder in Library, with two notes in it.
        marked("new").tap()
        expect(app.buttons["New folder"], "New folder in the menu").tap()
        type("Sprint", into: expect(app.alerts["New folder"].textFields.firstMatch, "the folder's name field"))
        answerAlert("New folder", with: "Create")
        for name in ["Fix the login", "Write the docs"] {
            choose("New note here", on: reveal(marked("entry-Sprint"), "the Sprint folder"), "New note here on Sprint")
            expect(text(containing: "other devices see it view-only"), "the new note, open to edit")
            let title = expect(app.webViews.textViews["Title"], "the new note's title")
            title.tap()
            title.typeText(name + "\n")
            expect(app.webViews.textViews["Note"], "the new note's text")
            marked("done").tap()
            back()
        }

        // Shown as a board, by a tag made for it: every note is a card in
        // "No Stage", and each value is a column.
        choose("Show as Board…", on: reveal(marked("entry-Sprint"), "the Sprint folder"), "Show as Board… on Sprint")
        expect(text(containing: "Make a tag, and Sprint shows its notes by it"), "what a board is, with no tags yet")
        marked("board-new-tag").tap()
        type("Stage", into: expect(marked("tag-name"), "the new tag's name field"))
        type("Todo\nDoing\nDone", into: expect(marked("tag-values"), "the new tag's values"))
        marked("tag-create").tap()
        expect(app.navigationBars["Sprint"], "the board, opened")
        expect(card("Fix the login", in: "none"), "Fix the login, in No Stage")
        expect(card("Write the docs", in: "none"), "Write the docs, in No Stage")
        XCTAssertTrue(marked("column-Todo").exists && marked("column-Doing").exists && marked("column-Done").exists, "a column for each value")
        record("a board, made")

        // Held and dragged onto the next column, at the board's edge. Held
        // a moment and moved, as a person drags; held still longer, the card
        // gives its menu instead.
        let docs = expect(card("Write the docs", in: "none"), "Write the docs, to drag")
        docs.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(
            forDuration: 0.5,
            thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.3)),
            withVelocity: .fast,
            thenHoldForDuration: 0.2
        )
        expect(card("Write the docs", in: "Todo"), "Write the docs, dragged to Todo", timeout: 15)
        record("a card, dragged")

        // "+ New" at the foot of a column: a note with its value, to be named.
        expect(marked("board-new-Todo"), "New in Todo").tap()
        let title = expect(app.webViews.textViews["Title"], "the new card's title")
        title.tap()
        title.typeText("Ship it\n")
        expect(app.webViews.textViews["Note"], "the new card's text")
        marked("done").tap()
        expect(app.buttons["Stage, Todo"], "the new card's chip, its column's value")
        back()
        expect(card("Ship it", in: "Todo"), "the new card, in Todo")
        record("a card, made in its column")

        // Held still, a card's menu moves it: its note gets the value. The
        // last card leaves "No Stage", which then shows only while a card is
        // dragged.
        choose("Move to", on: card("Fix the login", in: "none"), "Move to on a card")
        expect(app.buttons["Doing"], "Doing, to move it to").tap()
        expect(card("Fix the login", in: "Doing"), "Fix the login, moved to Doing")
        XCTAssertFalse(marked("column-none").exists, "No Stage, with no cards left")
        record("a card, moved from its menu")

        // Shown as a folder again: back in the tree, where the folder opens
        // in place with its notes.
        marked("board-menu").tap()
        expect(app.buttons["Show as Folder"], "Show as Folder in the board's menu").tap()
        expect(app.navigationBars["Browse"], "the tree, once the board is gone")
        let folder = reveal(marked("entry-Sprint"), "the Sprint folder")
        if !marked("entry-Ship it").waitForExistence(timeout: 2) { folder.tap() }
        expect(marked("entry-Ship it"), "the notes, in the folder opened in place")
        XCTAssertFalse(marked("chevron-Sprint").exists, "the folder is no longer a board")
        record("the folder, a folder again")
    }

    /// A card in a column — `none` for the notes with no value.
    private func card(_ name: String, in column: String) -> XCUIElement {
        marked("column-\(column)").descendants(matching: .any).matching(identifier: "card-\(name)").firstMatch
    }

    /// A row's or a card's long press, and an item of its menu. A press made
    /// as the screen settles can be lost: press again until it is offered.
    private func choose(_ item: String, on element: XCUIElement, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let offered = app.buttons[item]
        for _ in 0..<4 where !offered.exists {
            element.press(forDuration: 1.2)
            if offered.waitForExistence(timeout: 3) { break }
        }
        expect(offered, what, file: file, line: line).tap()
    }
}
