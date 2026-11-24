// The phone's side of a flowchart held to the cases the Mac's renderer is
// held to: verify-harness/flowchart-fixture.json, which
// verify-harness/flowchart.test.mjs checks the TypeScript against. Every
// scene there must be read whole — a key this side does not know is a part
// of the picture it would not draw — and, where there is a JavaScript
// context to run it in, the script the app carries must lay each source out
// as that scene.

import XCTest
@testable import DoklinKit

final class FlowchartTests: XCTestCase {
    private static let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()

    private struct Fixture: Decodable {
        let cases: [Case]
        let refused: [Refused]

        struct Case: Decodable {
            let name: String
            let frame: Int
            let source: String
            let scene: FlowchartScene
        }

        struct Refused: Decodable {
            let name: String
            let source: String
            let why: FlowchartResult.Why
            let message: String
        }
    }

    private static let data: Data = {
        let url = repo.appendingPathComponent("verify-harness/flowchart-fixture.json")
        guard let data = try? Data(contentsOf: url) else { fatalError("\(url.path) is missing") }
        return data
    }()

    private func fixture() throws -> Fixture {
        try JSONDecoder().decode(Fixture.self, from: Self.data)
    }

    func testEverySceneOfTheFixtureIsRead() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.cases.isEmpty)
        var kinds = Set<String>()
        for one in fixture.cases {
            XCTAssertFalse(one.scene.items.isEmpty, one.name)
            XCTAssertGreaterThanOrEqual(one.scene.width, Double(one.frame), one.name)
            for item in one.scene.items {
                switch item {
                case .rect: kinds.insert("rect")
                case .path(let d, _, _):
                    kinds.insert("path")
                    guard case .move? = d.first else { return XCTFail("\(one.name): a path that does not start with a move") }
                case .text(_, _, _, _, _, let runs):
                    kinds.insert("text")
                    XCTAssertFalse(runs.isEmpty, one.name)
                }
            }
        }
        XCTAssertEqual(kinds, ["rect", "path", "text"], "the fixture draws every kind of item")
    }

    /// What this side reads of each kind of item. A key the fixture holds and
    /// this does not is one scene.ts gained and Scene.swift did not.
    func testNoPartOfASceneIsLeftUnread() throws {
        let known: [String: Set<String>] = [
            "rect": ["t", "x", "y", "w", "h", "r", "stroke", "width", "fill", "opacity"],
            "path": ["t", "d", "dash", "stroke", "width", "fill", "opacity"],
            "text": ["t", "x", "y", "anchor", "size", "paint", "runs"],
        ]
        let whole = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.data) as? [String: Any])
        for one in try XCTUnwrap(whole["cases"] as? [[String: Any]]) {
            let scene = try XCTUnwrap(one["scene"] as? [String: Any])
            XCTAssertEqual(Set(scene.keys), ["width", "height", "label", "items"])
            for item in try XCTUnwrap(scene["items"] as? [[String: Any]]) {
                let kind = try XCTUnwrap(item["t"] as? String)
                XCTAssertTrue(Set(item.keys).isSubset(of: try XCTUnwrap(known[kind])), "\(kind) with \(item.keys.sorted())")
                for run in item["runs"] as? [[String: Any]] ?? [] {
                    XCTAssertTrue(Set(run.keys).isSubset(of: ["s", "bold", "italic"]), "a run with \(run.keys.sorted())")
                }
            }
        }
    }

    func testAResultIsAPictureOrASentence() throws {
        let drawn = try JSONDecoder().decode(
            FlowchartResult.self, from: Data(#"{"ok":true,"scene":{"width":240,"height":80,"label":"One box","items":[]}}"#.utf8))
        guard case .scene(let scene) = drawn else { return XCTFail("a scene was read as \(drawn)") }
        XCTAssertEqual(scene.label, "One box")
        let refused = try JSONDecoder().decode(
            FlowchartResult.self, from: Data(#"{"ok":false,"why":"unsupported","message":"Doklin draws flowcharts."}"#.utf8))
        XCTAssertEqual(refused, .undrawn(.unsupported, message: "Doklin draws flowcharts."))
    }

    #if canImport(JavaScriptCore)
    /// The script the app carries, built by scripts/ios-editor.sh.
    private func renderer() throws -> FlowchartRenderer {
        let script = Self.repo.appendingPathComponent("ios/Editor/flowchart.js")
        guard FileManager.default.fileExists(atPath: script.path) else {
            throw XCTSkip("the flowchart script is not built — run: scripts/ios-editor.sh")
        }
        return FlowchartRenderer(script: script)
    }

    func testTheScriptLaysTheFixtureOut() async throws {
        let renderer = try renderer()
        let fixture = try fixture()
        for one in fixture.cases {
            let result = await renderer.layout(one.source, room: one.frame)
            XCTAssertEqual(result, .scene(one.scene), "\(one.name) at \(one.frame)")
            XCTAssertEqual(renderer.remembered(one.source), result, one.name)
        }
        for one in fixture.refused {
            let result = await renderer.layout(one.source, room: 360)
            XCTAssertEqual(result, .undrawn(one.why, message: one.message), one.name)
        }
    }

    func testAColumnWiderThanThePageIsThePage() async throws {
        let renderer = try renderer()
        let source = "flowchart TB\n  a[One] --> b[Two]"
        guard case .scene(let page) = await renderer.layout(source, room: 760), case .scene(let wide) = await renderer.layout(source, room: 1200) else {
            return XCTFail("a flowchart of two boxes was not drawn")
        }
        XCTAssertEqual(wide, page)
    }

    func testAMissingScriptIsASentence() async {
        let renderer = FlowchartRenderer(script: Self.repo.appendingPathComponent("ios/Editor/no-such-file.js"))
        guard case .undrawn(.error, let message) = await renderer.layout("flowchart TB\n  a --> b", room: 360) else {
            return XCTFail("a renderer with no script drew something")
        }
        XCTAssertTrue(message.hasSuffix("."), message)
    }
    #endif
}
