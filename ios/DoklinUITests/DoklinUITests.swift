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
    func testAPersonsWayThroughTheApp() throws {
        // Joining: the line from another device, typed as a paste would put it.
        launchAndJoin()

        // The workspace, downloaded: its tree, and no comment file in it.
        expect(marked("entry-Home"), "the Home note")
        record("the workspace")
        XCTAssertFalse(marked("entry-Comments.meta.jsonl").exists, "a comment file is listed")

        // Home: what changed, and how sync stands, quietly.
        home()
        expect(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Synced")).firstMatch, "the sync line")
        expect(text(containing: "Recent changes"), "Home's title")
        record("home")

        // A folder opened in place in the tree, and a note in it, read.
        browse()
        let plan = marked("entry-plan")
        if !plan.waitForExistence(timeout: 2) { marked("entry-Projects").tap() }
        expect(plan, "the plan, under Projects in the tree").tap()
        expect(app.staticTexts["The plan"], "the plan's heading")
        expect(text(containing: "Ship it by June"), "the plan's first paragraph")
        record("a note, read")
        back()

        // Editing in place: what is typed is what the note then says.
        expect(marked("entry-Scratch"), "the Scratch note").tap()
        expect(app.staticTexts["Scratch"], "Scratch's heading")
        let editor = editAtTheEnd()
        editor.typeText("\nTyped in the simulator.")
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
        let fresh = editAtTheEnd()
        fresh.typeText("\n- [ ] milk")
        marked("done").tap()
        expect(app.buttons["Not done"], "the unticked box").tap()
        expect(app.buttons["Done"], "the ticked box")
        expect(app.staticTexts["milk"], "the task's words")
        expect(app.staticTexts["Phone list"], "the new note's heading after the edit")
        record("a box, ticked")
        back()
        expect(marked("entry-Phone list"), "the new note in the tree")

        // Home has what was just changed here, by you.
        home()
        // Made here and then changed here: the last change is the edit, by you.
        let row = expect(marked("recent-Phone list"), "the new note among what changed")
        XCTAssertTrue(row.label.contains("You edited"), "who changed it last, in \(row.label)")
        record("home, after the edits")

        // Search finds a note by words in it.
        tab("Search")
        let search = expect(app.searchFields.firstMatch, "the search field")
        search.tap()
        search.typeText("ship it by june")
        expect(marked("result-plan"), "the plan among the results")
        record("search")

        // Quit and come back: still joined, and the edit is still there.
        app.terminate()
        app.launch()
        browse()
        expect(marked("entry-Scratch"), "the workspace after a relaunch").tap()
        expect(app.staticTexts["Typed in the simulator."], "the edit after a relaunch")
        back()

        // Removing the workspace from this iPhone goes back to the first screen.
        removeFromThisPhone()
        expect(marked("line"), "the first screen after removing the workspace")
        record("removed")
    }
}
