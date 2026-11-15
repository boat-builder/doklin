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

    /// Ask the drive for something only the domain's side can do: `line`, or
    /// `editing?path=<workspace-relative>` — another device editing it now.
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
        let remove = app.buttons["Remove from this iPhone"]
        // A tap the moment the app has launched can be lost on older iOS:
        // open the menu again when it did not open.
        for _ in 0..<3 where !remove.exists {
            marked("workspace-menu").tap()
            _ = remove.waitForExistence(timeout: 5)
        }
        expect(remove, "Remove from this iPhone in the menu").tap()
        let confirm = app.sheets.buttons["Remove from this iPhone"]
        if confirm.waitForExistence(timeout: 5) {
            confirm.tap()
        } else {
            app.buttons.matching(identifier: "Remove from this iPhone").firstMatch.tap()
        }
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
