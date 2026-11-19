// Who is in the workspace and how they got in, through the real screens
// against the harness worker: the people, an invite made, made again from
// further down and withdrawn, a role given and taken back, this iPhone among
// Sherin's devices and a line for another, an agent added and removed, who else
// is here, and restricted folders: one made with somebody in it, listed,
// renamed, looked into and deleted here; another deleted on another device
// while a note in it is open here.

import XCTest

final class PeopleUITests: UITestCase {
    /// Words anywhere on screen, whatever their case (section headers are
    /// drawn in capitals).
    private func words(_ text: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch
    }

    /// Open one of the workspace's settings.
    private func open(_ item: String) {
        setting(item)
    }

    /// Answer "are you sure" with the button that does it: in a sheet, or in
    /// a popover beside the button that asked — then the last of that name.
    private func confirm(_ label: String) {
        let inSheet = app.sheets.buttons[label]
        if inSheet.waitForExistence(timeout: 3) {
            inSheet.tap()
            return
        }
        let named = app.buttons.matching(NSPredicate(format: "label == %@", label))
        expect(named.element(boundBy: max(0, named.count - 1)), "\(label), to confirm").tap()
    }

    /// Wait for something to go.
    private func gone(_ element: XCUIElement, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let going = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        if XCTWaiter().wait(for: [going], timeout: 20) != .completed {
            record("still there — \(what)")
            XCTFail("\(what) never went", file: file, line: line)
        }
    }

    /// Scroll a list until something further down it is on screen, clear
    /// of the tab bar and the bar over it along the bottom edge.
    @discardableResult
    private func reveal(_ element: XCUIElement, _ what: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
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

    /// Tick a switch in a form: its knob, not its words.
    private func tick(_ toggle: XCUIElement) {
        let knob = toggle.switches.firstMatch
        if knob.exists { knob.tap() } else { toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap() }
    }

    /// Wait for something to be on screen, where a finger can reach it.
    private func inView(_ element: XCUIElement, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let shown = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND hittable == true"), object: element)
        if XCTWaiter().wait(for: [shown], timeout: 10) != .completed {
            record("out of view — \(what)")
            XCTFail("\(what) is not in view", file: file, line: line)
        }
    }

    func testPeopleDevicesAgentsAndARestrictedFolder() throws {
        launchAndJoin()

        // People: Sherin is the workspace's superadmin, and this iPhone is hers.
        open("People")
        let sherin = expect(marked("person-sherin@example.com"), "Sherin among the people")
        XCTAssertTrue(sherin.label.contains("Sherin") && sherin.label.contains("you") && sherin.label.contains("superadmin"), sherin.label)
        expect(app.staticTexts["this iPhone"], "this iPhone among Sherin's devices")
        record("people")

        // An invite: the line to send, once, then the code waits until it is withdrawn.
        app.buttons["Invite someone"].tap()
        type("bea@example.com", into: expect(marked("invite-email"), "the invite's email field"))
        type("Bea", into: marked("invite-name"))
        record("an invite, filled in")
        marked("invite-send").tap()
        expect(text(containing: "doklin-invite http://localhost"), "the invite's line")
        expect(words("A code for bea@example.com"), "whom the code is for")
        record("an invite's line")
        reveal(marked("once-done"), "Done under the code").tap()
        reveal(words("the code runs out in"), "Bea's code among the codes nobody has used")

        // A new code, asked for from the bottom of the list: it is shown at
        // the top, and the list goes there.
        reveal(app.buttons["New code"], "New code on Bea's code").tap()
        expect(marked("invite-send"), "the invite, filled in again").tap()
        inView(marked("once-shown"), "the new code")
        expect(words("A code for bea@example.com"), "whom the new code is for")
        record("a new code, scrolled into view")
        reveal(marked("once-done"), "Done under the new code").tap()
        reveal(marked("withdraw-bea@example.com"), "Withdraw on Bea's code").tap()
        confirm("Withdraw")
        gone(words("the code runs out in"), "Bea's code, withdrawn")
        let bea = expect(marked("person-bea@example.com"), "Bea, still invited to nothing")
        XCTAssertTrue(bea.label.contains("No device signed in."), bea.label)

        // A role, given and taken back.
        app.buttons["Make an owner"].tap()
        confirm("Make an owner")
        expect(app.buttons["Make a member"], "Bea, an owner")
        record("Bea, an owner")
        app.buttons["Make a member"].tap()
        confirm("Make a member")
        expect(app.buttons["Make an owner"], "Bea, a member again")
        back()

        // Devices: this iPhone, never offered for signing out — her Mac is —
        // the way back in, and a line for another.
        open("Your devices")
        expect(app.staticTexts["this iPhone"], "this iPhone among your devices")
        expect(marked("device-Sherin's MacBook Pro"), "her Mac among her devices")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@", "Sign out")).count, 1, "only the Mac is offered for signing out, never this iPhone")
        expect(text(containing: "Recover with your Cloudflare account"), "the way back in, for the superadmin")
        marked("device-add").tap()
        expect(text(containing: "doklin-invite http://localhost"), "the line for another device")
        expect(text(containing: "It works once, for "), "how long the line lasts")
        record("a line for another device")
        reveal(marked("once-done"), "Done under the code").tap()
        expect(marked("device-add"), "Add a device, again")
        back()

        // Agents: one added, its login shown once, then removed.
        open("Your agents")
        expect(text(containing: "None yet."), "no agents yet")
        marked("agent-open").tap()
        type("Research bot", into: expect(marked("agent-name"), "the agent's name field"))
        record("an agent, being added")
        marked("agent-save").tap()
        expect(text(containing: "doklin login http://localhost"), "the agent's login")
        record("an agent's login")
        reveal(marked("once-done"), "Done under the code").tap()
        let bot = expect(marked("agent-Research bot"), "the agent among yours")
        XCTAssertTrue(bot.label.contains("read · comment · edit"), bot.label)
        reveal(marked("agent-remove-Research bot"), "Remove on the agent").tap()
        confirm("Remove")
        expect(text(containing: "None yet."), "no agents once it is removed")
        back()

        // Here now: nobody else has the workspace open — then another device
        // of Sherin's is editing the plan, which opens here view-only until this
        // iPhone takes it over.
        open("Here now")
        expect(marked("here-alone"), "only this iPhone here")
        try ask("editing?path=Projects/plan.md")
        // It is here once a poll has said so: pulling the list down asks now.
        // This iPhone names the plan by its path here, Library's name first.
        let editing = text(containing: "editing Library/Projects/plan.md")
        for _ in 0..<6 where !editing.waitForExistence(timeout: 10) {
            app.collectionViews.firstMatch.swipeDown()
        }
        expect(editing, "the other device, editing the plan", timeout: 15)
        record("here now")
        let other = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Sherin's Mac (drive)")).firstMatch
        let viewOnly = text(containing: "Open on your other device, Sherin's Mac (drive) — view only")
        // The row is drawn again as the poll lands: a tap in between is tried once more.
        for _ in 0..<3 where !viewOnly.exists {
            expect(other, "the other device's row").tap()
            _ = viewOnly.waitForExistence(timeout: 8)
        }
        expect(viewOnly, "the plan, view only")
        record("the plan, view only")
        marked("edit").tap()
        expect(app.buttons["Take over"], "Take over in the editor").tap()
        gone(app.buttons["Taking over…"], "the other device's hold")
        XCTAssertFalse(app.buttons["Take over"].exists, "the plan is still view-only after taking it over")
        record("the plan, taken over")
        marked("done").tap()
        expect(app.staticTexts["The plan"], "the plan, read")
        XCTAssertFalse(text(containing: "view only").exists, "the plan is still view-only")

        // A restricted folder, with Bea in it, listed under Restricted.
        browse()
        marked("new").tap()
        expect(app.buttons["New restricted folder"], "New restricted folder in the menu").tap()
        type("Finance", into: expect(marked("restricted-name"), "the folder's name field"))
        tick(expect(marked("restricted-pick-bea@example.com"), "Bea, to pick"))
        record("a restricted folder, being made")
        marked("restricted-create").tap()
        expect(app.navigationBars["Finance"], "the new folder, open")
        back()
        expect(marked("entry-Finance"), "the new folder, listed under Restricted")
        record("restricted, with the new folder")

        // Renamed here, for everyone in it.
        marked("entry-Finance").press(forDuration: 1.0)
        expect(app.buttons["Rename"], "Rename on the restricted folder").tap()
        let name = expect(app.alerts.textFields.firstMatch, "the new name's field")
        type(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12) + "Money", into: name)
        app.alerts.buttons["Rename"].tap()
        // Its access is the domain's: offered once the domain has the new name.
        let money = expect(marked("entry-Money"), "the folder, renamed")
        let manage = app.buttons["Manage access…"]
        // A tap above the menu shuts it; one that misses leaves the row covered.
        let shutMenu = {
            for _ in 0..<4 where !money.isHittable {
                self.app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
                Thread.sleep(forTimeInterval: 1)
            }
        }
        for _ in 0..<9 where !manage.exists {
            shutMenu()
            money.press(forDuration: 1.0)
            if manage.waitForExistence(timeout: 3) { break }
            shutMenu()
            Thread.sleep(forTimeInterval: 4)
        }
        expect(manage, "Manage access on the renamed folder, once the domain has the new name").tap()
        expect(app.navigationBars["Who can open “Money”"], "the folder's people, once the domain has the new name", timeout: 45)
        expect(words("2 people"), "Sherin and Bea in it")
        expect(marked("space-member-Bea"), "Bea in it")
        record("who can open the folder")

        // Bea taken out; then the folder deleted here, and everything open in
        // it closes, back to Restricted, which no longer lists it.
        app.buttons["Remove"].tap()
        confirm("Remove")
        expect(words("1 person"), "only Sherin in it")
        reveal(marked("space-delete"), "Delete it for everyone").tap()
        confirm("Delete the folder")
        expect(app.navigationBars["Browse"], "the tree, once the folder is gone")
        gone(marked("entry-Money"), "the deleted folder, from the list")
        expect(text(containing: "Folders only the people you choose can open."), "Restricted, empty")
        XCTAssertFalse(text(containing: "is no longer on this iPhone").exists, "a folder given up here was told as news")
        record("restricted, after the delete")

        // Another folder, with a note in it open for editing — deleted on
        // another device. The editor closes with what was typed, nothing
        // puts the folder back, and the iPhone says why it went.
        marked("new-restricted").tap()
        type("Plans", into: expect(marked("restricted-name"), "the second folder's name field"))
        marked("restricted-create").tap()
        expect(app.navigationBars["Plans"], "the second folder, open")
        marked("new").tap()
        expect(app.buttons["New note"], "New note in the menu").tap()
        type("Draft", into: expect(app.alerts.textFields.firstMatch, "the note's name field"))
        app.alerts.buttons["Create"].tap()
        expect(app.staticTexts["Draft"], "the new note's heading")
        let editor = editAtTheEnd()
        editor.typeText("\nNumbers nobody else may see.")
        record("a note in Plans, being edited")
        try ask("deleted?name=Plans")
        expect(text(containing: "“Plans” is no longer on this iPhone"), "why the folder went", timeout: 60)
        gone(app.webViews.textViews.firstMatch, "the editor, in a folder that is gone")
        expect(app.navigationBars["Browse"], "the tree, once the folder is gone")
        record("a folder deleted elsewhere")
        // Long enough for a save the editor had waiting.
        Thread.sleep(forTimeInterval: 2)
        XCTAssertFalse(marked("entry-Plans").exists, "the folder came back on this iPhone")
        app.buttons["Dismiss"].tap()

        // Bea removed from the workspace.
        open("People")
        expect(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Remove from")).firstMatch, "Remove Bea").tap()
        confirm("Remove")
        gone(marked("person-bea@example.com"), "Bea, removed")
        record("people, after removing Bea")
        back()

        removeFromThisPhone()
        expect(marked("line"), "the first screen after removing the workspace")
    }
}
