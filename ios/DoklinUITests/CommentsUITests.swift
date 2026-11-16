// Comments and publishing, driven through the real screens against the
// harness worker (`node verify-harness/drive-ios.mjs --app`): a note's
// thread from the seed, read with its words and its author; a thread
// started on words of the note, answered, its reply deleted, and removed; a
// note published once its address can be one, its address seen, and
// stopped; a folder offered an address made of its name; every published
// page listed, and the home page moved.

import XCTest

final class CommentsUITests: UITestCase {
    /// Whatever matches an identifier that starts so, other than `but`.
    private func marked(startingWith prefix: String, but: String? = nil) -> XCUIElement {
        let format = but == nil ? "identifier BEGINSWITH %@" : "identifier BEGINSWITH %@ AND identifier != %@"
        let arguments: [Any] = but == nil ? [prefix] : [prefix, but!]
        return app.descendants(matching: .any).matching(NSPredicate(format: format, argumentArray: arguments)).firstMatch
    }

    private func type(_ words: String, into field: XCUIElement) {
        field.tap()
        field.typeText(words)
    }

    func testCommentsAndPublishing() throws {
        launchAndJoin()

        // The seed's note and its thread: the words it is on, who said what.
        expect(marked("entry-Comments"), "the Comments note").tap()
        expect(text(containing: "and more after it"), "the note's text")
        marked("comments").tap()
        expect(text(containing: "On “a highlighted phrase”"), "the thread's words")
        expect(text(containing: "Say it plainer."), "the thread's comment")
        expect(text(containing: "Ada"), "who wrote it")
        record("a note's comments")
        app.buttons["Done"].tap()

        // Words under a comment open its thread from the reader. Before iOS
        // 26 a paragraph is one element to the tests, its links inside it
        // out of their reach, so the tap is made where they can make it.
        if #available(iOS 26, *) {
            expect(app.links["a highlighted phrase"], "the commented words, a link").tap()
            expect(text(containing: "Say it plainer."), "the thread, opened from its words")
            app.buttons["Done"].tap()
        }

        // A new thread on words of the note, the sheet pulled up to its full height.
        marked("comments").tap()
        expect(marked("comments-list"), "the comments sheet").swipeUp()
        expect(marked("new-comment"), "New comment").tap()
        type("more after it", into: expect(marked("comment-words"), "the words field"))
        type("From the phone.", into: expect(marked("comment-body"), "the comment field"))
        record("a thread, being written")
        marked("add-comment").tap()
        expect(text(containing: "On “more after it”"), "the new thread's words")
        expect(text(containing: "From the phone."), "the new thread's comment")
        record("a thread, started")

        // Answered.
        let reply = expect(marked(startingWith: "reply-to-", but: "reply-to-plain1"), "Reply on the new thread")
        let id = String(reply.identifier.dropFirst("reply-to-".count))
        reply.tap()
        type("And a reply.", into: expect(marked("reply-field"), "the reply field"))
        marked("send-reply").tap()
        expect(text(containing: "And a reply."), "the reply in the thread")
        record("a thread, answered")

        // The reply deleted: the thread stays.
        expect(marked("reply-\(id)-1"), "the reply").swipeLeft()
        expect(app.buttons["Delete reply"], "Delete reply on the reply").tap()
        XCTAssertTrue(text(containing: "And a reply.").waitForNonExistence(timeout: 15), "the deleted reply is still listed")
        expect(text(containing: "From the phone."), "the thread, still there")

        // Removed: the conversation goes, the words stay.
        expect(marked("thread-\(id)"), "the new thread's first comment").swipeLeft()
        expect(app.buttons["Remove"], "Remove on the thread").tap()
        expect(text(containing: "The whole conversation goes"), "the confirmation")
        app.buttons["Remove"].firstMatch.tap()
        XCTAssertTrue(text(containing: "On “more after it”").waitForNonExistence(timeout: 15), "the removed thread is still listed")
        XCTAssertFalse(text(containing: "From the phone.").exists, "the removed thread's comment is still listed")
        expect(text(containing: "On “a highlighted phrase”"), "the seed's thread, still there")
        record("a thread, removed")

        // A reply that stays: the drive finds it on the domain afterwards.
        marked("reply-to-plain1").tap()
        type("Plainer, then.", into: expect(marked("reply-field"), "the reply field"))
        marked("send-reply").tap()
        expect(text(containing: "Plainer, then."), "the reply on the seed's thread")
        app.buttons["Done"].tap()
        expect(text(containing: "and more after it"), "the words the thread was on, still in the note")
        back()

        // A note published at an address of its own, then stopped.
        expect(marked("entry-Scratch"), "the Scratch note").tap()
        expect(app.staticTexts["Not public."], "Scratch's text")
        app.buttons["More"].tap()
        expect(marked("publish"), "Publish… in the menu").tap()
        let address = expect(marked("publish-slug"), "the address field")
        type("API", into: address)
        expect(text(containing: "“api” is taken by the site itself."), "why the address cannot be one")
        XCTAssertFalse(marked("publish-go").isEnabled, "Publish, with an address that cannot be one")
        record("an address that cannot be one")
        address.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3) + "phone-scratch")
        XCTAssertFalse(marked("publish-slug-problem").exists, "a problem with an address that can be one")
        marked("publish-go").tap()
        expect(text(containing: "/phone-scratch"), "the page's address")
        expect(marked("publish-state"), "where the page stands")
        expect(text(containing: "by you"), "who published it")
        record("a note, published")
        marked("publish-stop").tap()
        expect(app.buttons["Stop"], "the confirmation").tap()
        expect(marked("publish-go"), "Publish again, once stopped")
        record("a note, stopped")
        app.buttons["Done"].tap()
        back()

        // A folder not yet public is offered an address made of its name,
        // and none at all is not one.
        expect(marked("entry-Projects"), "the Projects folder").tap()
        expect(marked("entry-Roadmap"), "the Roadmap folder, opened in place").press(forDuration: 1.2)
        expect(app.buttons["Publish folder…"], "Publish folder… in its menu").tap()
        let folderAddress = expect(marked("publish-slug"), "the folder's address field")
        XCTAssertEqual(folderAddress.value as? String, "roadmap", "the address offered for Roadmap")
        expect(text(containing: "/roadmap · a note at"), "where the folder's pages will be")
        record("a folder, about to be published")
        folderAddress.tap()
        folderAddress.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 7))
        expect(text(containing: "An address is 3 to 64 characters"), "why no address is not one")
        XCTAssertFalse(marked("publish-go").isEnabled, "Publish folder, with no address")
        record("a folder, with no address")
        app.buttons["Done"].tap()

        // Every published page of the workspace, the seed's among them.
        setting("Published pages")
        expect(marked("page-home"), "the home page")
        expect(marked("page-plan"), "the plan's page")
        expect(marked("page-projects"), "the Projects folder's page")
        expect(text(containing: "file missing"), "the page whose file is gone")
        expect(text(containing: "Home page"), "the home page's badge")
        XCTAssertFalse(marked("page-phone-scratch").exists, "the stopped page is still listed")
        record("published pages")

        // A folder's page: its address, title and description, to change.
        marked("page-menu-projects").tap()
        expect(app.buttons["Edit publishing…"], "Edit publishing… for the folder").tap()
        expect(text(containing: "“Projects” is live"), "the folder's page, live")
        expect(marked("publish-title"), "the folder page's title")
        expect(text(containing: "notes is public, every note in it"), "what the folder page shows")
        expect(text(containing: "/projects · a note at"), "where the folder's pages are")
        record("a folder's page")
        app.buttons["Done"].tap()

        // The plan becomes the domain's home page, and back.
        marked("page-menu-plan").tap()
        expect(app.buttons["Use as home page"], "Use as home page").tap()
        marked("page-menu-plan").tap()
        expect(app.buttons["Unset as home page"], "the plan as the home page").tap()
        marked("page-menu-home").tap()
        expect(app.buttons["Use as home page"], "Home no longer the home page").tap()
        // Read off the list, not a menu left open over the screen.
        expect(marked("page-home").staticTexts["Home page"], "Home the home page again")
        XCTAssertFalse(marked("page-plan").staticTexts["Home page"].exists, "the plan still the home page")
        record("the home page, moved and back")
        back()

        removeFromThisPhone()
        expect(marked("line"), "the first screen after removing the workspace")
    }
}
