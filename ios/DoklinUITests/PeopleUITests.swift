// Who is in the workspace and how they got in, through the real screens
// against the harness worker: the people, an invite made and withdrawn, a
// role given and taken back, this iPhone among Ada's devices and a line for
// another, an agent added and removed, who else is here, and a restricted
// folder made with somebody in it, looked into and deleted.

import XCTest

final class PeopleUITests: UITestCase {
    /// Words anywhere on screen, whatever their case (section headers are
    /// drawn in capitals).
    private func words(_ text: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch
    }

    /// Open something from the workspace menu.
    private func open(_ item: String) {
        marked("workspace-menu").tap()
        expect(app.buttons[item], "\(item) in the workspace menu").tap()
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

    /// Scroll a list until something further down it is on screen.
    @discardableResult
    private func reveal(_ element: XCUIElement, _ what: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        for _ in 0..<8 where !(element.exists && element.isHittable) {
            app.swipeUp()
        }
        return expect(element, what, timeout: 5, file: file, line: line)
    }

    /// Tick a switch in a form: its knob, not its words.
    private func tick(_ toggle: XCUIElement) {
        let knob = toggle.switches.firstMatch
        if knob.exists { knob.tap() } else { toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap() }
    }

    private func type(_ text: String, into field: XCUIElement) {
        field.tap()
        field.typeText(text)
    }

    func testPeopleDevicesAgentsAndARestrictedFolder() throws {
        launchAndJoin()

        // People: Ada made the workspace, and this iPhone is hers.
        open("People")
        let ada = expect(marked("person-ada@example.com"), "Ada among the people")
        XCTAssertTrue(ada.label.contains("Ada (drive)") && ada.label.contains("you") && ada.label.contains("owner"), ada.label)
        expect(app.staticTexts["this iPhone"], "this iPhone among Ada's devices")
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

        // Devices: this iPhone, never offered for signing out, and a line for another.
        open("Devices")
        expect(app.staticTexts["this iPhone"], "this iPhone among your devices")
        XCTAssertFalse(app.buttons["Sign out"].exists, "this iPhone is offered for signing out")
        marked("device-add").tap()
        expect(text(containing: "doklin-invite http://localhost"), "the line for another device")
        expect(text(containing: "It works once, for "), "how long the line lasts")
        record("a line for another device")
        reveal(marked("once-done"), "Done under the code").tap()
        expect(marked("device-add"), "Add a device, again")
        back()

        // Agents: one added, its login shown once, then removed.
        open("Agents")
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
        // of Ada's is editing the plan, which opens here view-only until this
        // iPhone takes it over.
        open("Here now")
        expect(marked("here-alone"), "only this iPhone here")
        try ask("editing?path=Projects/plan.md")
        expect(text(containing: "editing Projects/plan.md"), "the other device, editing the plan", timeout: 45)
        record("here now")
        app.staticTexts["Ada's Mac (drive)"].tap()
        expect(text(containing: "Open on your other device, Ada's Mac (drive) — view only"), "the plan, view only")
        record("the plan, view only")
        marked("edit").tap()
        expect(app.buttons["Take over"], "Take over in the editor").tap()
        gone(app.buttons["Taking over…"], "the other device's hold")
        XCTAssertFalse(app.buttons["Take over"].exists, "the plan is still view-only after taking it over")
        record("the plan, taken over")
        marked("done").tap()
        expect(app.staticTexts["The plan"], "the plan, read")
        XCTAssertFalse(text(containing: "view only").exists, "the plan is still view-only")
        back()
        back()

        // A restricted folder, with Bea in it.
        marked("new").tap()
        expect(app.buttons["New restricted folder"], "New restricted folder in the menu").tap()
        type("Finance", into: expect(marked("restricted-name"), "the folder's name field"))
        tick(expect(marked("restricted-pick-bea@example.com"), "Bea, to pick"))
        record("a restricted folder, being made")
        marked("restricted-create").tap()
        expect(app.navigationBars["Finance"], "the new folder, open")
        marked("access").tap()
        expect(words("2 people"), "Ada and Bea in it")
        expect(marked("space-member-Bea"), "Bea in it")
        record("who can open the folder")

        // Bea taken out; then the folder deleted, and everything open in it closes.
        app.buttons["Remove"].tap()
        confirm("Remove")
        expect(words("1 person"), "only Ada in it")
        reveal(marked("space-delete"), "Delete it for everyone").tap()
        confirm("Delete the folder")
        expect(marked("entry-Projects"), "the top of the workspace, once the folder is gone")
        if marked("entry-Restricted").exists {
            marked("entry-Restricted").tap()
            XCTAssertFalse(marked("entry-Finance").waitForExistence(timeout: 3), "the folder is still listed")
            record("restricted, after the delete")
            back()
        }
        XCTAssertFalse(text(containing: "is no longer on this iPhone").exists, "a folder given up here was told as news")

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
