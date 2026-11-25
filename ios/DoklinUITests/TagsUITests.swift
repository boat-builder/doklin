// Tags, driven through the real screens against the harness worker (`node
// verify-harness/drive-ios.mjs --app`): a note's first tag made from its
// More menu, which makes the workspace's list; its chip set to another
// value; the list's own note opened and that value renamed there, which
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

        // The list's own note shows the list; a value renamed there changes
        // the note that has it.
        reveal(marked("entry-Tags"), "the tag list's note, made with the tag").tap()
        expect(marked("tag-list-Status"), "Status in the list")
        record("the tag list")
        marked("tag-edit-Status").tap()
        let doing = expect(marked("tag-value-1"), "Doing's field")
        focus(doing, at: CGVector(dx: 0.95, dy: 0.5))
        doing.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5) + "Underway")
        expect(marked("tag-edit-effect"), "what the rename changes")
        record("a value, being renamed")
        marked("tag-save").tap()
        expect(text(containing: "One note changed to match."), "the note the rename changed", timeout: 60)
        expect(text(containing: "Underway"), "the renamed value in the list")
        back()
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
