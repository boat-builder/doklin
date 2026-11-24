// What a flowchart becomes: a flat list of rectangles, paths and lines of
// text, every one already placed. The Mac's renderer (src/flowchart/) lays a
// flowchart out; whoever shows the picture only draws the list, in order
// (later items sit on top).
//
// ⇄ src/flowchart/scene.ts, and `Result` in src/flowchart/index.ts: change
// both. Both sides are held to verify-harness/flowchart-fixture.json.

import Foundation

public struct FlowchartScene: Decodable, Equatable, Sendable {
    /// The scene's frame, in its own units: a drawer scales it to the room it has.
    public let width: Double
    public let height: Double
    /// What the picture is, for a screen reader.
    public let label: String
    public let items: [Item]

    /// A colour by name: the drawing token `--dg-<name>`; `sheet` is the page.
    public enum Paint: String, Decodable, Sendable {
        case ink, ink2 = "ink-2", rule, grid, accent, good, warn, bad, sheet
    }

    /// One step of a path, as in SVG path data.
    public enum Seg: Decodable, Equatable, Sendable {
        case move(x: Double, y: Double)
        case line(x: Double, y: Double)
        case quad(cx: Double, cy: Double, x: Double, y: Double)
        case cubic(x1: Double, y1: Double, x2: Double, y2: Double, x: Double, y: Double)
        case close

        public init(from decoder: Decoder) throws {
            var list = try decoder.unkeyedContainer()
            let name = try list.decode(String.self)
            var n: [Double] = []
            while !list.isAtEnd { n.append(try list.decode(Double.self)) }
            switch (name, n.count) {
            case ("M", 2): self = .move(x: n[0], y: n[1])
            case ("L", 2): self = .line(x: n[0], y: n[1])
            case ("Q", 4): self = .quad(cx: n[0], cy: n[1], x: n[2], y: n[3])
            case ("C", 6): self = .cubic(x1: n[0], y1: n[1], x2: n[2], y2: n[3], x: n[4], y: n[5])
            case ("Z", 0): self = .close
            default:
                throw DecodingError.dataCorruptedError(in: list, debugDescription: "\(name) with \(n.count) numbers is no step of a path")
            }
        }
    }

    /// A stretch of a line of text in one style. Bold is weight 600.
    public struct Run: Decodable, Equatable, Sendable {
        public let s: String
        public let bold: Bool
        public let italic: Bool

        private enum Keys: String, CodingKey { case s, bold, italic }

        public init(from decoder: Decoder) throws {
            let from = try decoder.container(keyedBy: Keys.self)
            s = try from.decode(String.self, forKey: .s)
            bold = try from.decodeIfPresent(Bool.self, forKey: .bold) ?? false
            italic = try from.decodeIfPresent(Bool.self, forKey: .italic) ?? false
        }
    }

    /// How a shape is painted. `opacity` is the fill's.
    public struct Look: Decodable, Equatable, Sendable {
        public let stroke: Paint?
        /// The stroke's width.
        public let width: Double?
        public let fill: Paint?
        public let opacity: Double?
    }

    public enum Anchor: String, Decodable, Sendable { case start, middle }

    public enum Item: Decodable, Equatable, Sendable {
        /// A rectangle with corner radius `r`.
        case rect(x: Double, y: Double, w: Double, h: Double, r: Double, look: Look)
        /// A path. Joins are round; a dashed one (`dash`: on, off) has round ends.
        case path(d: [Seg], dash: [Double]?, look: Look)
        /// One line of text. `y` is its baseline; `x` is its start or its middle, by `anchor`.
        case text(x: Double, y: Double, anchor: Anchor, size: Double, paint: Paint, runs: [Run])

        private enum Keys: String, CodingKey { case t, x, y, w, h, r, d, dash, anchor, size, paint, runs }

        public init(from decoder: Decoder) throws {
            let from = try decoder.container(keyedBy: Keys.self)
            let kind = try from.decode(String.self, forKey: .t)
            let number = { (key: Keys) in try from.decode(Double.self, forKey: key) }
            switch kind {
            case "rect":
                self = .rect(x: try number(.x), y: try number(.y), w: try number(.w), h: try number(.h), r: try number(.r), look: try Look(from: decoder))
            case "path":
                let dash = try from.decodeIfPresent([Double].self, forKey: .dash)
                if let dash, dash.count != 2 {
                    throw DecodingError.dataCorruptedError(forKey: .dash, in: from, debugDescription: "a dash is two numbers: on, off")
                }
                self = .path(d: try from.decode([Seg].self, forKey: .d), dash: dash, look: try Look(from: decoder))
            case "text":
                self = .text(
                    x: try number(.x), y: try number(.y), anchor: try from.decode(Anchor.self, forKey: .anchor), size: try number(.size),
                    paint: try from.decode(Paint.self, forKey: .paint), runs: try from.decode([Run].self, forKey: .runs))
            default:
                throw DecodingError.dataCorruptedError(forKey: .t, in: from, debugDescription: "\(kind) is no item of a scene")
            }
        }
    }
}

/// What laying a ```mermaid block out gives: its picture, or why there is
/// none, in a sentence — another kind of diagram, or a flowchart that cannot
/// be read.
public enum FlowchartResult: Decodable, Equatable, Sendable {
    case scene(FlowchartScene)
    case undrawn(Why, message: String)

    public enum Why: String, Decodable, Sendable { case unsupported, error }

    private enum Keys: String, CodingKey { case ok, scene, why, message }

    public init(from decoder: Decoder) throws {
        let from = try decoder.container(keyedBy: Keys.self)
        if try from.decode(Bool.self, forKey: .ok) {
            self = .scene(try from.decode(FlowchartScene.self, forKey: .scene))
        } else {
            self = .undrawn(try from.decode(Why.self, forKey: .why), message: try from.decode(String.self, forKey: .message))
        }
    }
}
