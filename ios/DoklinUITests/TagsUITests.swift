// Tags, driven through the real screens against the harness worker (`node
// verify-harness/drive-ios.mjs --app`): a note's first tag made from its
// More menu, with what its values mean; its chip set to another value;
// Settings' Tags, which lists the tag, and that value renamed there, which
// changes the note to match; and the note found by its tag in Search.

import XCTest

final class TagsUITests: UITestCase {
    func testTagsOnANote() throws {
        launchAndJoin()

        // A note with no tags: the first is made from More, and the note
        // gets the first of its values.
        reveal(marked("entry-Ideas"), "the Ideas note").tap()
        expect(text(containing: "A teleporter, or a jetpack."), "the note's text")
        marked("more").tap()
        expect(app.buttons["Add tag"], "Add tag in More").tap()
        expect(app.buttons["New tag…"], "New tag… under Add tag").tap()
        type("Status", into: expect(marked("tag-name"), "the new tag's name field"))
        type("Todo\nDoing\nDone", into: expect(marked("tag-values"), "the new tag's values"))
        type("Where a piece of work is.", into: expect(marked("tag-desc"), "what the values mean"))
        record("a tag, being made")
        marked("tag-create").tap()
        expect(app.buttons["Status, Todo"], "the note's chip, with the first value")
        record("a tag, made")

        // The chip's menu: another value.
        app.buttons["Status, Todo"].tap()
        expect(app.buttons["Doing"], "Doing in the chip's menu").tap()
        expect(app.buttons["Status, Doing"], "the chip, with the value picked")
        record("a tag, set")
        back()

        // Settings' Tags lists it, with what its values mean; a value
        // renamed there changes the note that has it.
        setting("Tags")
        let row = expect(marked("tags-edit-Status"), "Status in Settings' Tags")
        XCTAssertTrue(row.label.contains("Where a piece of work is."), "what Status's values mean, in \(row.label)")
        record("the workspace's tags")
        row.tap()
        let doing = expect(marked("tag-value-1"), "Doing's field")
        focus(doing, at: CGVector(dx: 0.95, dy: 0.5))
        doing.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5) + "Underway")
        expect(marked("tag-edit-effect"), "what the rename changes")
        record("a value, being renamed")
        marked("tag-save").tap()
        expect(text(containing: "One note changed to match."), "the note the rename changed", timeout: 60)
        expect(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Underway")).firstMatch, "the renamed value in the list")
        browse()
        reveal(marked("entry-Ideas"), "the Ideas note").tap()
        expect(app.buttons["Status, Underway"], "the note's chip, renamed with the list")
        record("a note, renamed to match")

        // Search finds it by its tag.
        tab("Search")
        type("status:underway", into: expect(app.searchFields.firstMatch, "the search field"))
        expect(marked("result-Ideas"), "the note, found by its tag")
        record("search, by a tag")
    }
}
