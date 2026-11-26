// What every journey through the app's screens shares: the device line it
// joins with, finding things, and keeping what was on screen.
//
// `node verify-harness/drive-ios.mjs --app` serves what only the domain's
// side can do, at an address in the environment: each test class asks it for
// a line of its own as it starts — a line works once, and a new one stops the
// one before. A class run without the drive skips itself.

import XCTest

class UITestCase: XCTestCase {
    let app = XCUIApplication()
    /// `doklin-invite <address> <code>`, for this class alone.
    var line = ""
    /// Where the drive answers.
    private var drive: URL!

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let raw = ProcessInfo.processInfo.environment["DOKLIN_TEST_DRIVE"], let drive = URL(string: raw) else {
            throw XCTSkip("no worker to talk to — run: node verify-harness/drive-ios.mjs --app")
        }
        self.drive = drive
        line = try ask("line")
    }

    /// Ask the drive for something only the domain's side can do: `line`;
    /// `editing?path=<path in Library, without its name>` — another device
    /// editing it now; `shared?name=<name>` — somebody else sharing a folder
    /// with this person; `deleted?name=<name>` — a folder this person shares
    /// deleted on another device of theirs.
    /// What the drive could not do fails the journey there, in its words,
    /// rather than later as something else.
    @discardableResult
    func ask(_ what: String) throws -> String {
        let url = try XCTUnwrap(URL(string: what, relativeTo: drive), "the drive cannot be asked for \(what)")
        let answer = DriveAnswer()
        let answered = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: url) { data, response, error in
            answer.body = data.map { String(decoding: $0, as: UTF8.self) } ?? ""
            answer.status = (response as? HTTPURLResponse)?.statusCode ?? 0
            answer.error = error
            answered.signal()
        }.resume()
        guard answered.wait(timeout: .now() + 120) == .success else {
            throw DriveRefused(what: what, why: "it did not answer within two minutes")
        }
        if let error = answer.error { throw DriveRefused(what: what, why: error.localizedDescription) }
        guard answer.status == 200 else { throw DriveRefused(what: what, why: "\(answer.status) \(answer.body)") }
        return answer.body
    }

    /* ---------- Finding things ---------- */

    func marked(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    func text(containing words: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", words)).firstMatch
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

    /// Scroll a list until something further down it is on screen, clear
    /// of the tab bar and the bar over it along the bottom edge. A row
    /// half under the tab bar counts as hittable, and a tap on it lands on
    /// the tab bar.
    @discardableResult
    func reveal(_ element: XCUIElement, _ what: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        for _ in 0..<8 where !reachable(element) {
            app.swipeUp()
        }
        return expect(element, what, timeout: 5, file: file, line: line)
    }

    private func reachable(_ element: XCUIElement) -> Bool {
        guard element.exists, element.isHittable else { return false }
        let bar = app.tabBars.firstMatch
        return !bar.exists || !bar.isHittable || element.frame.maxY < bar.frame.minY - 64
    }

    /* ---------- Getting around ---------- */

    /// Back one screen by the navigation bar's back button: false when
    /// there is none, at the top of a tab.
    @discardableResult
    func backIfAny() -> Bool {
        let button = app.navigationBars.buttons["BackButton"]
        guard button.exists else { return false }
        button.tap()
        return true
    }

    /// A tab, by its name: Browse, Recent, Search. A document hides the tab
    /// bar, so it is backed out of first.
    func tab(_ name: String) {
        let button = app.tabBars.buttons[name]
        for _ in 0..<6 where !button.waitForExistence(timeout: 2) {
            if !backIfAny() { break }
        }
        expect(button, "the \(name) tab").tap()
    }

    /// Back until `root` shows: the top of a tab.
    private func backTo(_ root: XCUIElement) {
        for _ in 0..<6 where !root.waitForExistence(timeout: 2) {
            if !backIfAny() { break }
        }
    }

    /// Browse, at its top: the workspace's tree.
    func browse() {
        for _ in 0..<2 where !app.navigationBars["Browse"].exists {
            tab("Browse")
            backTo(app.navigationBars["Browse"])
        }
    }

    /// Recent, at its top: what changed.
    func recent() {
        for _ in 0..<2 where !app.navigationBars["Recent changes"].exists {
            tab("Recent")
            backTo(app.navigationBars["Recent changes"])
        }
    }

    /// The workspace's settings, through its name on Browse.
    func settings() {
        browse()
        // A tap the moment the app has launched can be lost: tap again when
        // the switcher did not open.
        for _ in 0..<3 where !marked("workspace-settings").exists {
            marked("workspace-menu").tap()
            _ = marked("workspace-settings").waitForExistence(timeout: 5)
        }
        expect(marked("workspace-settings"), "Settings in the switcher").tap()
    }

    /// One of the workspace's settings — People, Your devices, Workspace
    /// history…
    func setting(_ item: String) {
        settings()
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", item)).firstMatch
        // Settings, done arriving: a row below its edge, which a list
        // doesn't make until it is scrolled to, is revealed.
        _ = app.staticTexts["People and access"].waitForExistence(timeout: 5)
        reveal(row, "\(item) in Settings").tap()
    }

    /* ---------- Typing ---------- */

    /// Give a field the keyboard, by a tap in its middle or at `point` of
    /// it. A tap made while its screen is still settling — a sheet coming
    /// up, the editor fading in, the first screen after a removal — can land
    /// before the field takes the keyboard, and what is typed then has
    /// nowhere to go: tap again until it has it.
    func focus(_ field: XCUIElement, at point: CGVector? = nil) {
        for _ in 0..<5 {
            if let point { field.coordinate(withNormalizedOffset: point).tap() } else { field.tap() }
            for _ in 0..<8 {
                if (field.value(forKey: "hasKeyboardFocus") as? Bool) == true { return }
                Thread.sleep(forTimeInterval: 0.25)
            }
        }
    }

    func type(_ words: String, into field: XCUIElement) {
        focus(field)
        field.typeText(words)
    }

    /// Answer the alert called `title` with one of its buttons, once its
    /// field is typed into. On iOS 27 a tap made just after typing can be
    /// lost: the alert stays up as it was, its action never run. Tap again
    /// while it is.
    func answerAlert(_ title: String, with button: String, file: StaticString = #filePath, line: UInt = #line) {
        let alert = expect(app.alerts[title], "the \(title) alert", file: file, line: line)
        for _ in 0..<3 where alert.exists {
            alert.buttons[button].tap()
            _ = alert.waitForNonExistence(timeout: 3)
        }
        if alert.exists {
            record("still up — the \(title) alert")
            XCTFail("the \(title) alert stayed up after \(button)", file: file, line: line)
        }
    }

    /// Edit the note on screen, with the caret after its last line. The
    /// editor opens with its caret on the block that was being read. A tap
    /// after the last line gives it the keyboard and moves the caret there —
    /// but one made while the editor is still coming up can take the
    /// keyboard and leave the caret where it was, so ⌘↓ then takes it to the
    /// end of the note.
    @discardableResult
    func editAtTheEnd() -> XCUIElement {
        marked("edit").tap()
        expect(text(containing: "other devices see it view-only"), "the editor, ready")
        let editor = expect(app.webViews.textViews["Note"], "the editor")
        focus(editor, at: CGVector(dx: 0.97, dy: 0.97))
        editor.typeKey(.downArrow, modifierFlags: .command)
        return editor
    }

    /// Make a note with New — Browse's own, which makes it in Library, or the
    /// plus on another heading (`new-mine`) — which opens it in the editor as
    /// Untitled with the caret in its title, and name it: the file takes the
    /// name, and Return goes into the note, whose text view this answers.
    @discardableResult
    func newNote(named name: String, from menu: String = "new") -> XCUIElement {
        marked(menu).tap()
        expect(app.buttons["New note"], "New note in the menu").tap()
        expect(text(containing: "other devices see it view-only"), "the new note, open to edit")
        let title = expect(app.webViews.textViews["Title"], "the new note's title")
        title.tap()
        title.typeText(name + "\n")
        return expect(app.webViews.textViews["Note"], "the new note's text")
    }

    /* ---------- Joining and leaving ---------- */

    /// Launch, take off any workspace a stopped run left behind, and join
    /// with this class's line. Ends on Browse, the workspace's tree, where
    /// what everyone has is under Library.
    func launchAndJoin() {
        app.launch()
        for _ in 0..<3 where marked("workspace-menu").waitForExistence(timeout: 8) {
            removeFromThisPhone()
            _ = marked("line").waitForExistence(timeout: 10)
        }
        type(line, into: expect(marked("line"), "the line field"))
        marked("join").tap()
        expect(marked("workspace-menu"), "Browse, once joined", timeout: 60)
        expect(marked("entry-Projects"), "the workspace, downloaded", timeout: 60)
        expect(app.staticTexts["Library"], "Library's heading over what everyone has")
    }

    /// Take the workspace being looked at off this iPhone, from its settings.
    func removeFromThisPhone() {
        settings()
        let remove = app.buttons["Remove from this iPhone"]
        // Settings, done arriving: the button is at its foot, which a list
        // doesn't make until it is scrolled to, and is revealed.
        _ = app.staticTexts["People and access"].waitForExistence(timeout: 5)
        reveal(remove, "Remove from this iPhone in Settings").tap()
        let confirm = app.sheets.buttons["Remove from this iPhone"]
        if confirm.waitForExistence(timeout: 5) {
            confirm.tap()
        } else {
            app.buttons.matching(identifier: "Remove from this iPhone").firstMatch.tap()
        }
        // A workspace that could not sync first — its worker gone, as one a
        // stopped run left behind — is asked about once more.
        let anyway = app.buttons["Remove anyway"]
        if anyway.waitForExistence(timeout: 15) { anyway.tap() }
    }
}

/// The drive's answer to one question, filled in on URLSession's queue and
/// read once the semaphore says it is there.
private final class DriveAnswer: @unchecked Sendable {
    var body = ""
    var status = 0
    var error: Error?
}

private struct DriveRefused: LocalizedError {
    let what: String
    let why: String

    var errorDescription: String? { "the drive could not answer \(what): \(why)" }
}
