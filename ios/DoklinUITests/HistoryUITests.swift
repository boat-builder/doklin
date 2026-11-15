// The history screens, driven in a simulator against the harness worker
// (`node verify-harness/drive-ios.mjs --app`): a note's versions — read one,
// compare it, restore it, undo — the workspace's moments — restore one, undo
// — and a note removed and brought back from Recently deleted.

import XCTest

final class HistoryUITests: UITestCase {
    /// Anything on screen whose words hold `words`: a row of a list, a line
    /// of a comparison, as well as a text.
    private func anything(containing words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    /// Wait for something to go.
    private func expectGone(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 15, file: StaticString = #filePath, line: UInt = #line) {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
        if XCTWaiter().wait(for: [gone], timeout: timeout) != .completed {
            record("still there — \(what)")
            XCTFail("\(what) never went", file: file, line: line)
        }
    }

    /// Answer a question just asked with one of its buttons — the last of
    /// that name on screen, which is the question's. A question with no
    /// Cancel of its own goes with a tap away from it.
    private func answer(_ button: String) {
        let inSheet = app.sheets.buttons[button]
        if inSheet.waitForExistence(timeout: 5) {
            inSheet.tap()
            return
        }
        let named = app.buttons.matching(identifier: button)
        if named.count > 0 {
            named.element(boundBy: named.count - 1).tap()
        } else if button == "Cancel" {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        } else {
            record("no \(button) to answer with")
            XCTFail("the question has no \(button)")
        }
    }

    func testANotesVersionsTheWorkspacesMomentsAndWhatWasDeleted() throws {
        launchAndJoin()

        // An edit made here, so the note has a version before it and one after.
        expect(marked("entry-Scratch"), "the Scratch note").tap()
        expect(app.staticTexts["Scratch"], "Scratch's heading")
        marked("edit").tap()
        let editor = expect(app.textViews.firstMatch, "the editor")
        editor.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)).tap()
        editor.typeText("\n\nA line for history.")
        marked("done").tap()
        expect(app.staticTexts["A line for history."], "the line, saved")

        // Its history: the newest is the note now, the one before it is from
        // before the edit.
        app.buttons["More"].tap()
        expect(app.buttons["Version history"], "Version history in the menu").tap()
        let versions = app.buttons.matching(identifier: "version-row")
        expect(versions.element(boundBy: 1), "a second version")
        XCTAssertGreaterThanOrEqual(versions.count, 2)
        XCTAssertTrue(versions.element(boundBy: 0).label.contains("current"), versions.element(boundBy: 0).label)
        expect(text(containing: "Every change since"), "the trust line")
        record("a note's versions")

        // The older one, read as the note reads.
        versions.element(boundBy: 1).tap()
        expect(text(containing: "Viewing the version from"), "the version's banner")
        expect(app.staticTexts["Not public."], "what the note said then")
        XCTAssertFalse(app.staticTexts["A line for history."].exists, "the old version shows the new line")
        record("an old version")

        // What changed from it to the note now: the line, marked as added.
        marked("show-changes").tap()
        expect(anything(containing: "Added: A line for history."), "the added line, marked")
        expect(text(containing: "the note as it is now"), "what it is compared with: the next version, which is the note now")
        record("the changes")

        // Restoring it: back on the note, which says what it said then.
        marked("restore-version").tap()
        expect(app.staticTexts["Not public."], "the note after the restore")
        expectGone(app.staticTexts["A line for history."], "the line, after the restore")
        expect(text(containing: "Restored the version from"), "the restore's toast")
        record("restored")

        // Undo puts back what it said before.
        app.buttons["Undo"].tap()
        expect(app.staticTexts["A line for history."], "the line, back after Undo")
        record("undone")
        back()

        // The workspace's history lists its moments; the first, from joining,
        // would put Scratch back as it was.
        marked("workspace-menu").tap()
        expect(app.buttons["Workspace history"], "Workspace history in the menu").tap()
        let moments = app.buttons.matching(identifier: "moment-row")
        expect(moments.element(boundBy: 1), "a second moment")
        XCTAssertGreaterThanOrEqual(moments.count, 2)
        record("the workspace's history")
        moments.element(boundBy: moments.count - 1).tap()
        expect(anything(containing: "Scratch.md"), "Scratch among what restoring that moment changes")
        expect(text(containing: "If you restore"), "the plan's heading")
        record("a moment")
        marked("restore-all").tap()
        expect(text(containing: "Write 1 file"), "the restore's question, in counts")
        record("restoring a moment, asked")
        answer("Cancel")

        // Restored, Scratch is as it was when this iPhone joined; the
        // toast's Undo puts the line back.
        marked("restore-all").tap()
        expect(text(containing: "Write 1 file"), "the restore's question, asked again")
        answer("Restore")
        expect(text(containing: "Restored — 1 file written."), "the moment restore's toast")
        record("a moment restored")
        app.buttons["Undo"].tap()
        expectGone(text(containing: "Restored — 1 file written."), "the moment restore's toast, after Undo")
        back()
        back()
        expect(marked("entry-Scratch"), "the Scratch note, after the moment's undo").tap()
        expect(app.staticTexts["A line for history."], "the line, back after the moment's Undo")
        back()

        // A note removed here is under Recently deleted, as one row with its
        // comments, and comes back to its folder.
        let comments = expect(marked("entry-Comments"), "the Comments note")
        comments.swipeLeft()
        expect(app.buttons["Remove"], "Remove, under the swipe").tap()
        answer("Remove")
        expectGone(marked("entry-Comments"), "the removed note, in the folder")
        marked("workspace-menu").tap()
        expect(app.buttons["Recently deleted"], "Recently deleted in the menu").tap()
        expect(marked("deleted-Comments"), "the removed note under Recently deleted")
        XCTAssertFalse(marked("deleted-Comments.meta.jsonl").exists, "the note's comments are a row of their own")
        record("recently deleted")
        marked("restore-Comments").tap()
        expect(text(containing: "Comments is back."), "the toast saying so")
        expectGone(marked("deleted-Comments"), "the note, under Recently deleted once it is back")
        record("brought back")
        back()
        expect(marked("entry-Comments"), "the note, back in its folder")
        record("back in the folder")

        removeFromThisPhone()
        expect(marked("line"), "the first screen after removing the workspace")
    }
}
