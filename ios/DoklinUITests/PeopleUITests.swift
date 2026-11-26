// Who is in the workspace and how they got in, through the real screens
// against the harness worker: the people, an invite made, made again from
// further down and withdrawn, a role given and taken back, this iPhone among
// Sherin's devices and a line for another, an agent added and removed, who else
// is here, and sharing in place: a folder of My files shared with somebody,
// renamed, stopped, deleted for everyone and restored; a document shared on
// its own; a folder somebody else shares, found under Shared with me, copied
// and left; and a shared folder deleted on another device while a note in it
// is open here.

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

    /// Tick a switch in a form: its knob, not its words.
    private func tick(_ toggle: XCUIElement) {
        let knob = toggle.switches.firstMatch
        if knob.exists { knob.tap() } else { toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap() }
    }

    /// Wait for something to be on screen, where a finger can reach it: as
    /// long as `expect` waits, since one look at the screen can take a slow
    /// runner most of ten seconds.
    private func inView(_ element: XCUIElement, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let shown = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND hittable == true"), object: element)
        if XCTWaiter().wait(for: [shown], timeout: 30) != .completed {
            record("out of view — \(what)")
            XCTFail("\(what) is not in view", file: file, line: line)
        }
    }

    /// Long-press a row until its menu offers `item`, and choose it. What a
    /// row offers follows the domain — a folder just renamed is shared again
    /// once the engine has caught up — so a menu without it is shut, by a tap
    /// above it, and asked for again.
    private func choose(_ item: String, on row: XCUIElement, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let offered = app.buttons[item]
        for _ in 0..<8 where !offered.exists {
            row.press(forDuration: 1.0)
            if offered.waitForExistence(timeout: 3) { break }
            for _ in 0..<4 where !row.isHittable {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
                Thread.sleep(forTimeInterval: 1)
            }
            Thread.sleep(forTimeInterval: 3)
        }
        expect(offered, what, file: file, line: line).tap()
    }

    /// The plus on the My files heading, in reach: the tree is taken back to
    /// its top first, where the heading is, when it has scrolled away.
    private func newInMyFiles() -> XCUIElement {
        let plus = marked("new-mine")
        for _ in 0..<3 where !(plus.exists && plus.isHittable) {
            app.collectionViews.firstMatch.swipeDown()
        }
        return reveal(plus, "New in My files, once the domain has said it is hers")
    }

    /// Make a folder in My files, from the plus on its heading.
    private func newFolderInMyFiles(_ name: String) -> XCUIElement {
        newInMyFiles().tap()
        expect(app.buttons["New folder"], "New folder in the menu").tap()
        type(name, into: expect(marked("new-name"), "the folder's name field"))
        answerAlert("New folder", with: "Create")
        return reveal(marked("entry-\(name)"), "the new folder, under My files")
    }

    /// Share what the open Share sheet is about with Bea, and close it.
    private func shareWithBea(_ what: String) {
        expect(text(containing: "It stays where it is. The people you pick find it under Shared with me"), "what sharing \(what) does")
        tick(expect(marked("share-pick-bea@example.com"), "Bea, to pick"))
        record("\(what), being shared")
        marked("share-submit").tap()
        expect(words("2 people can open it"), "Sherin and Bea can open \(what)")
        expect(marked("share-member-Bea"), "Bea, whom \(what) is shared with")
        record("who can open \(what)")
        marked("share-close").tap()
    }

    /// Wait for a row, or the line that says who can open a note, to say
    /// `words`: one element, whose label is everything it shows.
    private func says(_ element: XCUIElement, _ words: String, _ what: String, timeout: TimeInterval = 60, file: StaticString = #filePath, line: UInt = #line) {
        until(what, timeout: timeout, { element.exists && (element.label.localizedCaseInsensitiveContains(words) || anything(saying: words)) }, file: file, line: line)
    }

    /// Whether anything on screen says `words`.
    private func anything(saying words: String) -> Bool {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", words)).count > 0
    }

    /// How many elements carry a row's mark.
    private func count(_ identifier: String) -> Int {
        app.descendants(matching: .any).matching(identifier: identifier).count
    }

    /// Wait for a count to be what is wanted.
    private func until(_ what: String, timeout: TimeInterval = 60, _ met: () -> Bool, file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if met() { return }
            Thread.sleep(forTimeInterval: 1)
        }
        record("never — \(what)")
        XCTFail("\(what) never happened", file: file, line: line)
    }

    func testPeopleDevicesAgentsAndSharing() throws {
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

        // The three headings, as the Mac's sidebar has them.
        browse()
        expect(app.staticTexts["My files"], "the My files heading")
        expect(app.staticTexts["Shared with me"], "the Shared with me heading")

        // A folder made in My files, shared with Bea where it is: it stays
        // under My files, and its row says it is shared.
        let finance = newFolderInMyFiles("Finance")
        choose("Share…", on: finance, "Share on a folder of My files")
        shareWithBea("the folder")
        says(finance, "Shared with 1 person", "the shared folder's row says it is shared")
        record("my files, with the shared folder")

        // Renamed here, for everyone who can open it: the same share still.
        choose("Rename", on: finance, "Rename on the shared folder")
        expect(text(containing: "It is renamed for everyone who can open it."), "what renaming something shared does")
        let name = expect(app.alerts.textFields.firstMatch, "the new name's field")
        type(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12) + "Money", into: name)
        answerAlert("Rename", with: "Rename")
        let money = reveal(marked("entry-Money"), "the folder, renamed")
        says(money, "Shared with 1 person", "the folder is still shared, under its new name")

        // One document, shared on its own, from the line that says who can
        // open it.
        _ = newInMyFiles()
        let note = newNote(named: "Pay rise", from: "new-mine")
        note.typeText("Ask in March.")
        marked("done").tap()
        says(expect(marked("audience"), "who can open the note"), "Only you", "a note in My files is hers alone")
        marked("share").tap()
        shareWithBea("the note")
        says(marked("audience"), "You and 1 other", "who can open the note now, above its title")
        record("a shared note")
        browse()
        reveal(marked("entry-Pay rise"), "the shared note, still under My files")

        // Stopped with Bea, then deleted for everyone: it goes from here with
        // no word of news, and waits in Recently deleted.
        choose("Share…", on: money, "Share on the shared folder")
        expect(words("2 people can open it"), "Sherin and Bea, before it stops")
        app.buttons["Stop sharing"].firstMatch.tap()
        confirm("Stop sharing")
        expect(words("1 person can open it"), "only Sherin can open it")
        reveal(marked("share-delete"), "Delete it for everyone").tap()
        confirm("Delete the folder")
        gone(marked("entry-Money"), "the deleted folder, from the tree")
        XCTAssertFalse(text(containing: "is no longer on this iPhone").exists, "something given up here was told as news")
        record("my files, after the delete")

        // …from where it comes back as it was: a share, with nobody on it now.
        open("Recently deleted")
        expect(marked("deleted-share-Money"), "the deleted folder, to restore", timeout: 60)
        record("recently deleted, with the shared folder")
        marked("restore-share-Money").tap()
        gone(marked("deleted-share-Money"), "the restored folder, from Recently deleted")
        browse()
        says(expect(marked("entry-Money"), "the folder, restored", timeout: 60), "Shared with nobody yet", "the folder is restored as the share it was")
        record("my files, with the folder restored")

        // What somebody else shares with her shows under Shared with me:
        // hers to read and edit, not hers to move.
        try ask("shared?name=Budget")
        let budget = marked("entry-Budget")
        // It is here once a poll has listed it: pulling the tree down asks now.
        for _ in 0..<6 where !budget.waitForExistence(timeout: 10) {
            app.collectionViews.firstMatch.swipeDown()
        }
        says(reveal(budget, "the folder Cy shared, under Shared with me"), "Shared with you", "its row says it is shared with her")
        record("shared with me")
        budget.tap()
        reveal(marked("entry-Numbers"), "the note in the folder, opened in place").tap()
        expect(text(containing: "Shared by Cy, in Budget."), "the shared note, read", timeout: 60)
        says(expect(marked("audience"), "who can open the shared note"), "You and 1 other", "Cy and she can open the shared note")
        browse()

        // She copies it into her own files…
        let before = count("entry-Budget")
        budget.press(forDuration: 1.0)
        expect(app.buttons["Copy to My files"], "Copy to My files on what is shared with her")
        XCTAssertFalse(app.buttons["Move…"].exists, "something shared with her was offered to move")
        XCTAssertTrue(app.buttons["Leave…"].exists, "something shared with her is left, never deleted")
        app.buttons["Copy to My files"].tap()
        expect(text(containing: "Copied to My files as “Budget”."), "the copy, said")
        until("the copy, a row under My files") { count("entry-Budget") > before }
        let rows = count("entry-Budget")
        record("a copy in My files")
        app.buttons["Dismiss"].tap()

        // …and leaves it: the row under Shared with me, the last of the two,
        // goes; the copy stays, and nothing is told as news.
        let shared = app.descendants(matching: .any).matching(identifier: "entry-Budget").element(boundBy: rows - 1)
        choose("Leave…", on: shared, "Leave on what is shared with her")
        confirm("Leave")
        until("the folder she left, gone from Shared with me") { count("entry-Budget") < rows }
        XCTAssertFalse(anything(saying: "Shared with you"), "what she left is still marked as shared with her")
        XCTAssertTrue(marked("entry-Budget").exists, "her copy went with what she left")
        XCTAssertFalse(text(containing: "is no longer on this iPhone").exists, "something left here was told as news")
        record("shared with me, after leaving")

        // Another folder she shares, with a note in it open for editing —
        // deleted for everyone on another device of hers. The editor closes
        // with what was typed, nothing puts the folder back, and the iPhone
        // says why it went.
        let plans = newFolderInMyFiles("Plans")
        choose("Share…", on: plans, "Share on the second folder")
        shareWithBea("the second folder")
        choose("New note here", on: plans, "New note here on the shared folder")
        expect(text(containing: "other devices see it view-only"), "the new note, open to edit")
        let title = expect(app.webViews.textViews["Title"], "the new note's title")
        title.tap()
        title.typeText("Draft\n")
        expect(app.webViews.textViews["Note"], "the new note's text").typeText("Numbers nobody else may see.")
        record("a note in Plans, being edited")
        try ask("deleted?name=Plans")
        expect(text(containing: "“Plans” is no longer on this iPhone"), "why the folder went", timeout: 60)
        gone(app.webViews.textViews["Note"], "the editor, in a folder that is gone")
        expect(app.navigationBars["Browse"], "the tree, once the folder is gone")
        record("a shared folder deleted elsewhere")
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
