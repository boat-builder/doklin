import DoklinKit
import SwiftUI

/// The app's flowchart renderer: the script scripts/ios-editor.sh builds into
/// the app as Editor/flowchart.js (vite.ios-flowchart.config.ts names the
/// file: change both).
enum Flowcharts {
    static let renderer = FlowchartRenderer(
        script: Bundle.main.bundleURL.appendingPathComponent("Editor/flowchart.js"))
}

/// A ```mermaid block of a note, read. A flowchart is a picture, laid out for
/// the column it is in, so its words are the size the renderer set them at;
/// another kind of diagram, or a flowchart that cannot be read, is its source
/// under the sentence that says why.
struct FlowchartBlock: View {
    let source: String
    let container: String

    @State private var shown: FlowchartResult?
    @State private var width: CGFloat = 0
    /// A scene's unit in points, in hundredths: one point at the text size a
    /// phone ships with, more as the person's own text size grows — a
    /// picture's words grow with the note's.
    @ScaledMetric(relativeTo: .footnote) private var hundredth: CGFloat = 100

    init(source: String, container: String) {
        self.source = source
        self.container = container
        // A note scrolled back to shows the picture it showed, at once.
        _shown = State(initialValue: Flowcharts.renderer.remembered(source))
    }

    private var unit: CGFloat { hundredth / 100 }

    private struct Asked: Equatable {
        let source: String
        let room: Int
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .task(id: Asked(source: source, room: Int(width / unit))) {
                let room = Int(width / unit)
                guard room > 0 else { return }
                let result = await Flowcharts.renderer.layout(source, room: room)
                // Asked again meanwhile (the phone turned): that answer is the one to show.
                if !Task.isCancelled { shown = result }
            }
    }

    @ViewBuilder private var content: some View {
        switch shown {
        case .scene(let scene):
            FlowchartPicture(scene: scene, unit: unit)
        case .undrawn(_, let message):
            CodeView(note: message, text: source, container: container)
        case nil:
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: 80)
        }
    }
}

/// A scene, drawn: its items in order, in the app's own colours, scaled down
/// when the column is narrower than the scene.
private struct FlowchartPicture: View {
    let scene: FlowchartScene
    let unit: CGFloat

    var body: some View {
        Canvas { context, size in
            let scale = size.width / scene.width
            context.scaleBy(x: scale, y: scale)
            for item in scene.items {
                Self.draw(item, in: &context)
            }
        }
        .aspectRatio(scene.width / scene.height, contentMode: .fit)
        .frame(maxWidth: scene.width * unit)
        .accessibilityElement()
        .accessibilityLabel(scene.label)
        .accessibilityAddTraits(.isImage)
        .accessibilityIdentifier("flowchart")
    }

    private static func draw(_ item: FlowchartScene.Item, in context: inout GraphicsContext) {
        switch item {
        case .rect(let x, let y, let w, let h, let r, let look):
            paint(Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: r), look, dash: nil, in: &context)
        case .path(let d, let dash, let look):
            var path = Path()
            for seg in d {
                switch seg {
                case .move(let x, let y): path.move(to: CGPoint(x: x, y: y))
                case .line(let x, let y): path.addLine(to: CGPoint(x: x, y: y))
                case .quad(let cx, let cy, let x, let y): path.addQuadCurve(to: CGPoint(x: x, y: y), control: CGPoint(x: cx, y: cy))
                case .cubic(let x1, let y1, let x2, let y2, let x, let y):
                    path.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2))
                case .close: path.closeSubpath()
                }
            }
            paint(path, look, dash: dash, in: &context)
        case .text(let x, let y, let anchor, let size, let paint, let runs):
            var line = AttributedString()
            for run in runs {
                var piece = AttributedString(run.s)
                let font = Font.system(size: size, weight: run.bold ? .semibold : .regular)
                piece.font = run.italic ? font.italic() : font
                line.append(piece)
            }
            line.foregroundColor = Theme.figure(paint)
            let text = context.resolve(Text(line))
            let whole = CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
            let left = anchor == .middle ? x - text.measure(in: whole).width / 2 : x
            context.draw(text, at: CGPoint(x: left, y: y - text.firstBaseline(in: whole)), anchor: .topLeading)
        }
    }

    private static func paint(_ path: Path, _ look: FlowchartScene.Look, dash: [Double]?, in context: inout GraphicsContext) {
        if let fill = look.fill {
            context.fill(path, with: .color(Theme.figure(fill).opacity(look.opacity ?? 1)))
        }
        if let stroke = look.stroke {
            let style = StrokeStyle(
                lineWidth: look.width ?? 1, lineCap: dash == nil ? .butt : .round, lineJoin: .round, dash: (dash ?? []).map { CGFloat($0) })
            context.stroke(path, with: .color(Theme.figure(stroke)), style: style)
        }
    }
}
