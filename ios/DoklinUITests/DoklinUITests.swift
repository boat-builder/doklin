// The app itself, driven in a simulator against the real worker — the
// harness worker over the seed workspace, started by
// `node verify-harness/drive-ios.mjs --app`, which also mints the device
// line this joins with (UITestCase.swift). Skipped when run without it
// (from Xcode's Test button, say).
//
// One journey, in the order a person would take it: join with a line from
// another device, look around, read a note, edit one, make one, tick a box
// in it, search, quit and come back, remove the workspace from this iPhone.
//
// Every step prints what is on screen (lines that begin `UI>`) and keeps a
// screenshot in the result bundle, so a run can be read afterwards without
// having watched it.

import XCTest

final class DoklinUITests: UITestCase {
    /// Put the caret where a person adding to a note puts it: after the last line.
    private func tapBelowTheText(of editor: XCUIElement) {
        editor.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)).tap()
    }

    func testAPersonsWayThroughTheApp() throws {
        // Joining: the line from another device, typed as a paste would put it.
        launchAndJoin()

        // The workspace, downloaded: its folders and notes, and no comment
        // file among them.
        expect(marked("entry-Home"), "the Home note")
        expect(text(containing: "Synced"), "the sync line")
        record("the workspace")
        XCTAssertFalse(marked("entry-Comments.meta.jsonl").exists, "a comment file is listed")

        // A folder, and a note in it, read.
        marked("entry-Projects").tap()
        expect(marked("entry-plan"), "the plan in Projects").tap()
        expect(app.staticTexts["The plan"], "the plan's heading")
        expect(text(containing: "Ship it by June"), "the plan's first paragraph")
        record("a note, read")
        back()
        back()

        // Editing: what is typed is what the note then says.
        expect(marked("entry-Scratch"), "the Scratch note").tap()
        expect(app.staticTexts["Scratch"], "Scratch's heading")
        marked("edit").tap()
        let editor = expect(app.textViews.firstMatch, "the editor")
        tapBelowTheText(of: editor)
        editor.typeText("\n\nTyped in the simulator.")
        record("the editor")
        marked("done").tap()
        // A paragraph of its own under what was there, and the title still the title.
        expect(app.staticTexts["Typed in the simulator."], "the saved text, as its own paragraph")
        expect(app.staticTexts["Scratch"], "Scratch's heading after the edit")
        expect(app.staticTexts["Not public."], "what the note said before")
        record("a note, edited")
        back()

        // A new note, a task in it, and the box ticked from the reading view.
        marked("new").tap()
        expect(app.buttons["New note"], "New note in the menu").tap()
        let name = expect(app.alerts.textFields.firstMatch, "the new note's name field")
        name.tap()
        name.typeText("Phone list")
        app.alerts.buttons["Create"].tap()
        expect(app.staticTexts["Phone list"], "the new note's heading")
        marked("edit").tap()
        let fresh = expect(app.textViews.firstMatch, "the editor for the new note")
        tapBelowTheText(of: fresh)
        fresh.typeText("- [ ] milk")
        marked("done").tap()
        expect(app.buttons["Not done"], "the unticked box").tap()
        expect(app.buttons["Done"], "the ticked box")
        expect(app.staticTexts["milk"], "the task's words")
        expect(app.staticTexts["Phone list"], "the new note's heading after the edit")
        record("a box, ticked")
        back()
        expect(marked("entry-Phone list"), "the new note in the list")

        // Search finds a note by words in it.
        app.buttons["Search"].tap()
        let search = expect(app.searchFields.firstMatch, "the search field")
        search.tap()
        search.typeText("ship it by june")
        expect(marked("result-plan"), "the plan among the results")
        record("search")
        back()

        // Quit and come back: still joined, and the edit is still there.
        app.terminate()
        app.launch()
        expect(marked("entry-Scratch"), "the workspace after a relaunch").tap()
        expect(app.staticTexts["Typed in the simulator."], "the edit after a relaunch")
        back()

        // Removing the workspace from this iPhone goes back to the first screen.
        removeFromThisPhone()
        expect(marked("line"), "the first screen after removing the workspace")
        record("removed")
    }
}
