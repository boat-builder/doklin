import XCTest
@testable import DoklinKit

final class InlineTests: XCTestCase {
    private func parse(_ s: String) -> [Inline] { InlineParser.parse(s) }

    func testPlainTextIsOneNode() {
        XCTAssertEqual(parse("just words"), [.text("just words")])
    }

    func testEmphasisAndStrong() {
        XCTAssertEqual(parse("a *b* c"), [.text("a "), .emphasis([.text("b")]), .text(" c")])
        XCTAssertEqual(parse("a **b** c"), [.text("a "), .strong([.text("b")]), .text(" c")])
        XCTAssertEqual(parse("__b__"), [.strong([.text("b")])])
        XCTAssertEqual(parse("***b***"), [.emphasis([.strong([.text("b")])])])
        XCTAssertEqual(parse("**a *b* c**"), [.strong([.text("a "), .emphasis([.text("b")]), .text(" c")])])
    }

    func testUnderscoresInsideWordsStay() {
        XCTAssertEqual(parse("snake_case_name"), [.text("snake_case_name")])
        XCTAssertEqual(parse("2 * 3 * 4"), [.text("2 * 3 * 4")])
    }

    func testUnmatchedDelimitersAreText() {
        XCTAssertEqual(parse("a * b"), [.text("a * b")])
        XCTAssertEqual(parse("**open"), [.text("**open")])
    }

    func testStrikethrough() {
        XCTAssertEqual(parse("~~gone~~ here"), [.strikethrough([.text("gone")]), .text(" here")])
        XCTAssertEqual(parse("~5 or so"), [.text("~5 or so")])
    }

    func testCodeSpans() {
        XCTAssertEqual(parse("run `doklin ls` now"), [.text("run "), .code("doklin ls"), .text(" now")])
        XCTAssertEqual(parse("`` a ` b ``"), [.code("a ` b")])
        XCTAssertEqual(parse("`*not em*`"), [.code("*not em*")])
        XCTAssertEqual(parse("a ` b"), [.text("a ` b")])
    }

    func testLinks() {
        XCTAssertEqual(parse("[the plan](./plan.md)"), [.link(destination: "./plan.md", children: [.text("the plan")])])
        XCTAssertEqual(parse("[a **b**](https://x.y \"t\")"), [.link(destination: "https://x.y", children: [.text("a "), .strong([.text("b")])])])
        XCTAssertEqual(parse("[x](<a b.md>)"), [.link(destination: "a b.md", children: [.text("x")])])
        XCTAssertEqual(parse("[x](a(b).md)"), [.link(destination: "a(b).md", children: [.text("x")])])
        XCTAssertEqual(parse("[not a link] here"), [.text("[not a link] here")])
    }

    func testAutolinks() {
        XCTAssertEqual(parse("<https://doklin.cc>"), [.link(destination: "https://doklin.cc", children: [.text("https://doklin.cc")])])
        XCTAssertEqual(
            parse("see https://doklin.cc/a_b, then"),
            [.text("see "), .link(destination: "https://doklin.cc/a_b", children: [.text("https://doklin.cc/a_b")]), .text(", then")]
        )
        XCTAssertEqual(parse("(https://x.y/z)"), [.text("("), .link(destination: "https://x.y/z", children: [.text("https://x.y/z")]), .text(")")])
        XCTAssertEqual(parse("whttps://x.y"), [.text("whttps://x.y")])
    }

    func testImages() {
        XCTAssertEqual(parse("![a chart](img/chart.png)"), [.image(source: "img/chart.png", alt: "a chart")])
        XCTAssertEqual(parse("wow!"), [.text("wow!")])
    }

    func testBreaks() {
        XCTAssertEqual(parse("one\ntwo"), [.text("one two")])
        XCTAssertEqual(parse("one  \ntwo"), [.text("one"), .lineBreak, .text("two")])
        XCTAssertEqual(parse("one\\\ntwo"), [.text("one"), .lineBreak, .text("two")])
        XCTAssertEqual(parse("one<br>two"), [.text("one"), .lineBreak, .text("two")])
    }

    func testEscapes() {
        XCTAssertEqual(parse("\\*not\\* em"), [.text("*not* em")])
        XCTAssertEqual(parse("a\\b"), [.text("a\\b")])
    }

    func testHtmlTagsAreDroppedAndTheirTextKept() {
        XCTAssertEqual(parse("press <kbd>K</kbd> now"), [.text("press K now")])
        XCTAssertEqual(parse("a <!-- hidden --> b"), [.text("a  b")])
        XCTAssertEqual(parse("1 < 2 and 3 > 2"), [.text("1 < 2 and 3 > 2")])
    }

    func testCommentMarkers() {
        XCTAssertEqual(
            parse("ship {==next week==}{>>#c7k2x9<<} maybe"),
            [.text("ship "), .highlight(thread: "c7k2x9", children: [.text("next week")]), .text(" maybe")]
        )
        // The inline form carries the conversation in the marker.
        XCTAssertEqual(
            parse("{==odd==}{>>#c7k2x9 Sherin · 2026-07-14T09:12:33Z: This reads odd<<}{>>Aisha · 2026-07-14T10:01:05Z: agree<<}"),
            [.highlight(thread: "c7k2x9", children: [.text("odd")])]
        )
        // Hand-written CriticMarkup has no id.
        XCTAssertEqual(parse("{==x==}{>>why<<}"), [.highlight(thread: nil, children: [.text("x")])])
        // Halves on their own are cleaned away, as a copy out of the app is.
        XCTAssertEqual(parse("a {==b==} c"), [.text("a b c")])
        XCTAssertEqual(parse("a {>>stray<<}b"), [.text("a b")])
        XCTAssertEqual(parse("{ not critic }"), [.text("{ not critic }")])
    }

    func testRunsFlattenStylesAndMerge() {
        let runs = parse("a **b *c*** [d](x.md) {==e==}{>>#abcd12<<}").runs
        XCTAssertEqual(runs.map(\.text), ["a ", "b ", "c", " ", "d", " ", "e"])
        XCTAssertTrue(runs[1].bold && !runs[1].italic)
        XCTAssertTrue(runs[2].bold && runs[2].italic)
        XCTAssertEqual(runs[4].link, "x.md")
        XCTAssertTrue(runs[6].highlighted)
        XCTAssertEqual(runs[6].thread, "abcd12")
        XCTAssertEqual(parse("**a** **b**").plainText, "a b")
    }
}

final class BlockTests: XCTestCase {
    private func blocks(_ s: String) -> [Block] { MarkdownDocument.parse(s).blocks.map(\.block) }

    func testHeadingsAndParagraphs() {
        XCTAssertEqual(
            blocks("# Title\n\nFirst line\nsecond line\n\n## Next ##\n"),
            [
                .heading(level: 1, content: [.text("Title")]),
                .paragraph([.text("First line second line")]),
                .heading(level: 2, content: [.text("Next")]),
            ]
        )
        XCTAssertEqual(blocks("#hashtag"), [.paragraph([.text("#hashtag")])])
        XCTAssertEqual(blocks("Title\n=====\n\nSub\n---\n"), [.heading(level: 1, content: [.text("Title")]), .heading(level: 2, content: [.text("Sub")])])
    }

    func testFrontmatterIsSetAside() {
        let doc = MarkdownDocument.parse("---\ntitle: Plan\ntags: [a, b]\n---\n\n# Plan\n")
        XCTAssertEqual(doc.frontmatter, "title: Plan\ntags: [a, b]")
        XCTAssertEqual(doc.blocks.map(\.block), [.heading(level: 1, content: [.text("Plan")])])
        // The heading is on the sixth line of the file, whatever was set aside.
        XCTAssertEqual(doc.blocks[0].line, 5)
        XCTAssertNil(MarkdownDocument.parse("text\n\n---\n\nmore").frontmatter)
    }

    func testCodeBlocks() {
        XCTAssertEqual(blocks("```swift\nlet a = 1\n\n  let b = 2\n```\nafter"), [.code(language: "swift", text: "let a = 1\n\n  let b = 2"), .paragraph([.text("after")])])
        XCTAssertEqual(blocks("~~~\n# not a heading\n~~~"), [.code(language: nil, text: "# not a heading")])
        XCTAssertEqual(blocks("    indented\n    code\n\npara"), [.code(language: nil, text: "indented\ncode"), .paragraph([.text("para")])])
        // A fence left open runs to the end.
        XCTAssertEqual(blocks("```\nopen"), [.code(language: nil, text: "open")])
    }

    func testThematicBreak() {
        XCTAssertEqual(blocks("a\n\n---\n\nb\n\n* * *"), [.paragraph([.text("a")]), .thematicBreak, .paragraph([.text("b")]), .thematicBreak])
    }

    func testBlockquote() {
        XCTAssertEqual(
            blocks("> quoted **words**\n> more\nlazy\n\nout"),
            [.blockquote([BlockNode(id: 0, line: 0, block: .paragraph([.text("quoted "), .strong([.text("words")]), .text(" more lazy")]))]), .paragraph([.text("out")])]
        )
    }

    private func list(_ s: String) -> ListBlock? {
        if case .list(let l)? = blocks(s).first { return l }
        return nil
    }

    func testBulletList() throws {
        let l = try XCTUnwrap(list("- one\n- two\n- three"))
        XCTAssertFalse(l.ordered)
        XCTAssertTrue(l.tight)
        XCTAssertEqual(l.items.map { $0.blocks.map(\.block) }, [[.paragraph([.text("one")])], [.paragraph([.text("two")])], [.paragraph([.text("three")])]])
        XCTAssertEqual(l.items.map(\.line), [0, 1, 2])
    }

    func testOrderedListKeepsItsStart() throws {
        let l = try XCTUnwrap(list("3. three\n4. four"))
        XCTAssertTrue(l.ordered)
        XCTAssertEqual(l.start, 3)
        XCTAssertEqual(l.items.count, 2)
    }

    func testTaskListRemembersLinesAndTicks() throws {
        let l = try XCTUnwrap(list("- [ ] buy milk\n- [x] call **Aisha**\n- plain"))
        XCTAssertEqual(l.items.map(\.task), [false, true, nil])
        XCTAssertEqual(l.items[1].blocks.map(\.block), [.paragraph([.text("call "), .strong([.text("Aisha")])])])
    }

    func testNestedLists() throws {
        let l = try XCTUnwrap(list("- a\n  - a1\n  - a2\n- b\n\n  still b\n"))
        XCTAssertEqual(l.items.count, 2)
        guard case .list(let inner)? = l.items[0].blocks.last?.block else { return XCTFail("no nested list") }
        XCTAssertEqual(inner.items.map(\.line), [1, 2])
        XCTAssertEqual(l.items[1].blocks.map(\.block), [.paragraph([.text("b")]), .paragraph([.text("still b")])])
        XCTAssertFalse(l.tight)
    }

    func testListEndsWhereAParagraphBegins() {
        let all = blocks("- a\n- b\n\nafter")
        XCTAssertEqual(all.count, 2)
        XCTAssertEqual(all.last, .paragraph([.text("after")]))
    }

    func testAListInterruptsAParagraph() {
        let all = blocks("Shopping:\n- milk\n- eggs")
        XCTAssertEqual(all.count, 2)
        XCTAssertEqual(all.first, .paragraph([.text("Shopping:")]))
    }

    func testDifferentMarkersAreDifferentLists() {
        XCTAssertEqual(blocks("- a\n- b\n\n1. c\n2. d").count, 2)
    }

    func testTable() throws {
        guard case .table(let t)? = blocks("| Name | Qty |\n| :-- | --: |\n| Milk | 2 |\n| Eggs `a|b` | 12 | extra |\n\nafter").first else { return XCTFail("no table") }
        XCTAssertEqual(t.alignments, [.leading, .trailing])
        XCTAssertEqual(t.header, [[.text("Name")], [.text("Qty")]])
        XCTAssertEqual(t.rows.count, 2)
        XCTAssertEqual(t.rows[0], [[.text("Milk")], [.text("2")]])
        XCTAssertEqual(t.rows[1][0], [.text("Eggs "), .code("a|b")])
        XCTAssertEqual(blocks("a | b\nnot a table").count, 1)
    }

    func testImageOnItsOwnIsABlock() {
        XCTAssertEqual(blocks("![chart](img/c.png)"), [.image(source: "img/c.png", alt: "chart")])
        XCTAssertEqual(blocks("see ![chart](img/c.png)"), [.paragraph([.text("see "), .image(source: "img/c.png", alt: "chart")])])
    }

    func testHtmlBlocksAndComments() {
        XCTAssertEqual(blocks("<div class=\"x\">\nhi\n</div>\n\nafter"), [.html("<div class=\"x\">\nhi\n</div>"), .paragraph([.text("after")])])
        XCTAssertEqual(blocks("<!-- a note\nto self -->\nshown"), [.paragraph([.text("shown")])])
    }

    func testWindowsLineEndings() {
        XCTAssertEqual(blocks("# T\r\n\r\ntext\r\n"), [.heading(level: 1, content: [.text("T")]), .paragraph([.text("text")])])
    }

    func testHeadingsOutline() {
        let doc = MarkdownDocument.parse("# One\n\n> ## Two\n\n- ### Three")
        XCTAssertEqual(doc.headings.map(\.title), ["One", "Two", "Three"])
        XCTAssertEqual(doc.headings.map(\.level), [1, 2, 3])
        XCTAssertEqual(doc.title, "One")
    }

    func testIdsAreUnique() {
        let doc = MarkdownDocument.parse("# a\n\n- b\n  - c\n\n> d\n\ne")
        var seen = Set<Int>()
        func walk(_ nodes: [BlockNode]) {
            for n in nodes {
                XCTAssertTrue(seen.insert(n.id).inserted)
                switch n.block {
                case .blockquote(let inner): walk(inner)
                case .list(let l): l.items.forEach { walk($0.blocks) }
                default: break
                }
            }
        }
        walk(doc.blocks)
        XCTAssertEqual(seen.count, 8)
    }
}

final class EditingTests: XCTestCase {
    func testTickingATask() {
        let source = "# List\n\n- [ ] milk\n- [x] eggs\n> 1. [ ] quoted\n"
        XCTAssertEqual(MarkdownEditing.togglingTask(in: source, line: 2), "# List\n\n- [x] milk\n- [x] eggs\n> 1. [ ] quoted\n")
        XCTAssertEqual(MarkdownEditing.togglingTask(in: source, line: 3), "# List\n\n- [ ] milk\n- [ ] eggs\n> 1. [ ] quoted\n")
        XCTAssertEqual(MarkdownEditing.togglingTask(in: source, line: 4), "# List\n\n- [ ] milk\n- [x] eggs\n> 1. [x] quoted\n")
        // Not a task, or not a line: nothing is guessed.
        XCTAssertNil(MarkdownEditing.togglingTask(in: source, line: 0))
        XCTAssertNil(MarkdownEditing.togglingTask(in: source, line: 99))
        XCTAssertNil(MarkdownEditing.togglingTask(in: "[ ] bare", line: 0))
        // Only the box changes: a note with Windows line endings keeps them.
        XCTAssertEqual(MarkdownEditing.togglingTask(in: "a\r\n- [ ] b\r\nc", line: 1), "a\r\n- [x] b\r\nc")
        XCTAssertNil(MarkdownEditing.togglingTask(in: "- [", line: 0))
        XCTAssertNil(MarkdownEditing.togglingTask(in: "- [ok] no", line: 0))
    }

    func testATickLandsOnTheLineTheParserNamed() throws {
        let source = "---\nk: v\n---\n\nIntro\n\n- [ ] one\n  - [ ] nested\n- [ ] two\n"
        guard case .list(let l)? = MarkdownDocument.parse(source).blocks.last?.block else { return XCTFail("no list") }
        guard case .list(let inner)? = l.items[0].blocks.last?.block else { return XCTFail("no nested list") }
        let toggled = try XCTUnwrap(MarkdownEditing.togglingTask(in: source, line: inner.items[0].line))
        XCTAssertEqual(toggled, "---\nk: v\n---\n\nIntro\n\n- [ ] one\n  - [x] nested\n- [ ] two\n")
    }

    func testCommentAnchorIsPlainAndUnique() {
        let source = "# Launch plan\n\nWe ship the beta next week, weather permitting.\n\n- [ ] tell **everyone** about the launch party on Friday\n- We ship the beta\n"
        XCTAssertEqual(MarkdownEditing.commentAnchor(in: source, line: 0), "Launch plan")
        // "We ship the beta" is on two lines: more words are taken until it is one place.
        XCTAssertEqual(MarkdownEditing.commentAnchor(in: source, line: 2), "We ship the beta next")
        // Formatting cannot be inside a marker: the longest plain stretch is offered.
        XCTAssertEqual(MarkdownEditing.commentAnchor(in: source, line: 4), "about the launch party on")
        // Words that occur twice and cannot be told apart offer nothing.
        XCTAssertNil(MarkdownEditing.commentAnchor(in: source, line: 5))
        XCTAssertNil(MarkdownEditing.commentAnchor(in: source, line: 1))
        // Words a comment is on already are passed over for the next.
        let commented = "A sentence with {==a highlighted phrase==}{>>#plain1<<} and more after it.\n"
        XCTAssertEqual(MarkdownEditing.commentAnchor(in: commented, line: 0), "and more after it.")
    }

    func testLinkTargets() {
        XCTAssertEqual(DocLinks.target(of: "./other.md", from: "Projects/plan.md"), .document("Projects/other.md"))
        XCTAssertEqual(DocLinks.target(of: "../Archive/x%20y.md#part", from: "Projects/plan.md"), .document("Archive/x y.md"))
        XCTAssertEqual(DocLinks.target(of: "notes.md", from: "plan.md"), .document("notes.md"))
        XCTAssertEqual(DocLinks.target(of: "../../out.md", from: "Projects/plan.md"), .nowhere)
        XCTAssertEqual(DocLinks.target(of: "/Users/me/x.md", from: "plan.md"), .nowhere)
        XCTAssertEqual(DocLinks.target(of: "https://doklin.cc", from: "plan.md"), .external("https://doklin.cc"))
        XCTAssertEqual(DocLinks.target(of: "mailto:a@b.c", from: "plan.md"), .external("mailto:a@b.c"))
        XCTAssertEqual(DocLinks.target(of: "#next-steps", from: "plan.md"), .heading("next-steps"))
        XCTAssertEqual(DocLinks.slug("Next steps: Q3 & beyond"), "next-steps-q3--beyond")
        XCTAssertEqual(DocLinks.directory(of: "a/b/c.md"), "a/b")
        XCTAssertEqual(DocLinks.directory(of: "c.md"), "")
        XCTAssertEqual(DocLinks.name(of: "a/b/c.md"), "c.md")
    }
}
