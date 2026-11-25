// The app itself, driven in a simulator against the real worker — the
// harness worker over the seed workspace, started by
// `node verify-harness/drive-ios.mjs --app`, which also mints the device
// line this joins with (UITestCase.swift). Skipped when run without it
// (from Xcode's Test button, say).
//
// One journey, in the order a person would take it: join with a line from
// another device, look around, read a note and one with a flowchart, edit
// one, make one, tick a box in it, search, quit and come back, remove the
// workspace from this iPhone.
//
// Every step prints what is on screen (lines that begin `UI>`) and keeps a
// screenshot in the result bundle, so a run can be read afterwards without
// having watched it.

import XCTest

final class DoklinUITests: UITestCase {
    func testAPersonsWayThroughTheApp() throws {
        // Joining: the line from another device, typed as a paste would put it.
        launchAndJoin()

        // The workspace, downloaded: its tree, what everyone has under
        // Library, and no comment file in it.
        expect(marked("entry-Home"), "the Home note, under Library")
        record("the workspace")
        XCTAssertFalse(marked("entry-Comments.meta.jsonl").exists, "a comment file is listed")

        // How sync stands, quietly, over the tree.
        expect(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Synced")).firstMatch, "the sync line")

        // Recent: what changed.
        recent()
        expect(text(containing: "Recent changes"), "Recent's title")
        record("recent")

        // A folder opened in place in the tree, and a note in it, read.
        browse()
        let plan = marked("entry-plan")
        if !plan.waitForExistence(timeout: 2) { marked("entry-Projects").tap() }
        expect(plan, "the plan, under Projects in the tree").tap()
        expect(app.staticTexts["The plan"], "the plan's heading")
        expect(text(containing: "Ship it by June"), "the plan's first paragraph")
        record("a note, read")
        back()

        // A flowchart is a picture; another kind of diagram is its source,
        // under the sentence that says why.
        reveal(marked("entry-Diagram"), "the Diagram note").tap()
        XCTAssertEqual(expect(marked("flowchart"), "the flowchart, drawn").label, "Flowchart")
        expect(text(containing: "Doklin draws flowcharts. A sequence diagram is shown as its source."), "why the other diagram is not drawn")
        record("a flowchart, read")
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

        // A new note, made in Library and named by its title, a task in it,
        // and the box ticked from the reading view.
        let fresh = newNote(named: "Phone list")
        fresh.typeText("- [ ] ")
        // The line is drawn again as a to-do, with its box, and words typed
        // while that happens can land in the line above: they wait until the
        // bar says the caret is in a to-do.
        _ = app.buttons.matching(NSPredicate(format: "label == %@ AND selected == true", "To-do")).firstMatch.waitForExistence(timeout: 10)
        fresh.typeText("milk")
        marked("done").tap()
        expect(app.buttons["Not done"], "the unticked box").tap()
        expect(app.buttons["Done"], "the ticked box")
        expect(app.staticTexts["milk"], "the task's words")
        expect(app.staticTexts["Phone list"], "the new note's title, its name, after the edit")
        record("a box, ticked")
        back()
        expect(marked("entry-Phone list"), "the new note in the tree, under Library")

        // Recent has what was just changed here, by you.
        recent()
        // Made here and then changed here: the last change is the edit, by you.
        let row = expect(marked("recent-Phone list"), "the new note among what changed")
        XCTAssertTrue(row.label.contains("You edited"), "who changed it last, in \(row.label)")
        record("recent, after the edits")

        // Search finds a note by words in it.
        tab("Search")
        type("ship it by june", into: expect(app.searchFields.firstMatch, "the search field"))
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
