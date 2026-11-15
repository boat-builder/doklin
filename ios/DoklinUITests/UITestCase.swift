// What every journey through the app's screens shares: the device line it
// joins with, finding things, and keeping what was on screen.
//
// `node verify-harness/drive-ios.mjs --app` mints one line per test class —
// one for each `*UITests.swift` here, by its name — since a line works
// once. A class run without the drive skips itself.

import XCTest

class UITestCase: XCTestCase {
    let app = XCUIApplication()
    /// `doklin-invite <address> <code>`, for this class alone.
    var line = ""

    override func setUpWithError() throws {
        continueAfterFailure = false
        let name = String(describing: type(of: self))
        guard let raw = ProcessInfo.processInfo.environment["DOKLIN_TEST_DEVICE_LINES"],
              let lines = try? JSONDecoder().decode([String: String].self, from: Data(raw.utf8)),
              let line = lines[name]
        else { throw XCTSkip("no worker to talk to — run: node verify-harness/drive-ios.mjs --app") }
        self.line = line
    }

    /* ---------- Finding things ---------- */

    func marked(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    func text(containing words: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    /// What is on screen, into the log and the result bundle.
    func record(_ title: String) {
        print("UI> ---- \(title)")
        for row in app.debugDescription.split(separator: "\n") { print("UI> \(row)") }
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = title
        shot.lifetime = .keepAlways
        add(shot)
    }

    @discardableResult
    func expect(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 30, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        if !element.waitForExistence(timeout: timeout) {
            record("missing — \(what)")
            XCTFail("\(what) never appeared", file: file, line: line)
        }
        return element
    }

    func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    /* ---------- Joining and leaving ---------- */

    /// Launch, take off any workspace a stopped run left behind, and join
    /// with this class's line. Ends on the workspace's top folder.
    func launchAndJoin() {
        app.launch()
        while marked("workspace-menu").waitForExistence(timeout: 8) {
            removeFromThisPhone()
            _ = marked("line").waitForExistence(timeout: 10)
        }
        let field = expect(marked("line"), "the line field")
        field.tap()
        field.typeText(line)
        marked("join").tap()
        expect(marked("entry-Projects"), "the workspace, downloaded", timeout: 60)
    }

    /// Take the workspace being looked at off this iPhone, through its menu.
    func removeFromThisPhone() {
        marked("workspace-menu").tap()
        expect(app.buttons["Remove from this iPhone"], "Remove from this iPhone in the menu").tap()
        let confirm = app.sheets.buttons["Remove from this iPhone"]
        if confirm.waitForExistence(timeout: 5) {
            confirm.tap()
        } else {
            app.buttons.matching(identifier: "Remove from this iPhone").firstMatch.tap()
        }
    }
}
