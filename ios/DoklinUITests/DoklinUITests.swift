// The app itself, driven in a simulator against the real worker — the
// harness worker over the seed workspace, started by
// `node verify-harness/drive-ios.mjs --app`, which also adds the agent this
// logs in as. Skipped when run without it (from Xcode's Test button, say).
//
// One journey, in the order a person would take it: log in with a code,
// look around, read a note, edit one, make one, tick a box in it, search,
// quit and come back, log out.
//
// Every step prints what is on screen (lines that begin `UI>`) and keeps a
// screenshot in the result bundle, so a run can be read afterwards without
// having watched it.

import XCTest

final class DoklinUITests: XCTestCase {
    private let app = XCUIApplication()
    private var endpoint = ""
    private var code = ""

    override func setUpWithError() throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        guard let endpoint = environment["DOKLIN_TEST_ENDPOINT"], let raw = environment["DOKLIN_TEST_CODES"],
              let codes = try? JSONDecoder().decode([String: String].self, from: Data(raw.utf8)), let code = codes["app"]
        else { throw XCTSkip("no worker to talk to — run: node verify-harness/drive-ios.mjs --app") }
        self.endpoint = endpoint
        self.code = code
    }

    /* ---------- Finding things ---------- */

    private func marked(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func text(containing words: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    /// What is on screen, into the log and the result bundle.
    private func record(_ title: String) {
        print("UI> ---- \(title)")
        for row in app.debugDescription.split(separator: "\n") { print("UI> \(row)") }
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = title
        shot.lifetime = .keepAlways
        add(shot)
    }

    @discardableResult
    private func expect(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 30, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        if !element.waitForExistence(timeout: timeout) {
            record("missing — \(what)")
            XCTFail("\(what) never appeared", file: file, line: line)
        }
        return element
    }

    private func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    /* ---------- The journey ---------- */

    func testAPersonsWayThroughTheApp() throws {
        app.launch()

        // Logging in: the address and the code from a Mac, typed.
        let address = expect(marked("address"), "the address field")
        record("first launch")
        address.tap()
        address.typeText(endpoint)
        let codeField = marked("code")
        codeField.tap()
        codeField.typeText(code)
        marked("login").tap()

        // The workspace: its folders and notes, and no sidecar among them.
        expect(marked("entry-Projects"), "the Projects folder")
        expect(marked("entry-Home"), "the Home note")
        record("the workspace")
        XCTAssertFalse(marked("entry-Comments.meta.jsonl").exists, "a comments sidecar is listed as a file")

        // A folder, and a note in it, read.
        marked("entry-Projects").tap()
        expect(marked("entry-plan"), "the plan in Projects").tap()
        expect(app.staticTexts["The plan"], "the plan's heading")
        expect(text(containing: "Ship it by June"), "the plan's first paragraph")
        record("a note, read")
        back()
        back()

        // Editing: what is typed and saved is what the note then says.
        expect(marked("entry-Scratch"), "the Scratch note").tap()
        expect(app.staticTexts["Scratch"], "Scratch's heading")
        app.buttons["Edit"].tap()
        let editor = expect(app.textViews.firstMatch, "the editor")
        editor.tap()
        editor.typeText("\n\nTyped in the simulator.")
        record("the editor")
        app.buttons["Save"].tap()
        expect(text(containing: "Typed in the simulator."), "the saved text in the note")
        record("a note, edited")
        back()

        // A new note, a task in it, and the box ticked from the reading view.
        app.buttons["New note"].tap()
        let name = expect(app.alerts.textFields.firstMatch, "the new note's name field")
        name.tap()
        name.typeText("Phone list")
        app.alerts.buttons["Create"].tap()
        expect(app.staticTexts["Phone list"], "the new note's heading")
        app.buttons["Edit"].tap()
        let fresh = expect(app.textViews.firstMatch, "the editor for the new note")
        fresh.tap()
        fresh.typeText("- [ ] milk")
        app.buttons["Save"].tap()
        expect(app.buttons["Not done"], "the unticked box").tap()
        expect(app.buttons["Done"], "the ticked box")
        record("a box, ticked")
        back()
        expect(marked("entry-Phone list"), "the new note in the list")

        // Search finds a note by words in it.
        app.buttons["Search"].tap()
        let search = expect(app.searchFields.firstMatch, "the search field")
        search.tap()
        search.typeText("ship it by june")
        expect(app.staticTexts["plan"], "the plan among the results")
        record("search")

        // Quit and come back: still logged in, and the edit is still there.
        app.terminate()
        app.launch()
        expect(marked("entry-Scratch"), "the workspace after a relaunch").tap()
        expect(text(containing: "Typed in the simulator."), "the edit after a relaunch")
        back()

        // Logging out goes back to the first screen.
        app.buttons["Workspaces"].tap()
        expect(app.buttons["Log out"], "Log out in the menu").tap()
        let confirm = app.sheets.buttons["Log out"]
        if confirm.waitForExistence(timeout: 5) {
            confirm.tap()
        } else {
            app.buttons.matching(identifier: "Log out").firstMatch.tap()
        }
        expect(marked("address"), "the first screen after logging out")
        record("logged out")
    }
}
