// Flowcharts laid out by the Mac's own renderer, so a note's flowchart is
// the same picture on the phone: src/flowchart/, built to one script
// (src/flowchart/phone.ts, scripts/ios-editor.sh), run here in a JavaScript
// context with no page. The context has no JIT inside an app, so a layout is
// slow by a web view's measure: it runs off the main thread, and what it
// gave is kept.
//
// The script's one name is `DoklinFlowchart`, and its one function is
// `layout` — src/flowchart/phone.ts gives it those names: change both.

#if canImport(JavaScriptCore)
import Foundation
import JavaScriptCore

public final class FlowchartRenderer: @unchecked Sendable {
    private let script: URL

    /// The context is used from this queue alone.
    private let queue = DispatchQueue(label: "cc.doklin.flowchart", qos: .userInitiated)
    private var layoutFunction: JavaScriptCore.JSValue?
    private var loadFailed = false

    private struct Asked: Hashable {
        let source: String
        let room: Int
    }

    /// What was laid out, most recent last. A note is read many times and a
    /// flowchart changes rarely; a turn of the phone asks for a second room.
    private let lock = NSLock()
    private var kept: [(asked: Asked, result: FlowchartResult)] = []
    private static let keptCount = 64

    /// `script` is the renderer's script file: Editor/flowchart.js in the app.
    public init(script: URL) {
        self.script = script
    }

    /// What this source was last laid out as, whatever the room: a picture to
    /// show at once, while the one for this room is on its way.
    public func remembered(_ source: String) -> FlowchartResult? {
        lock.withLock { kept.last { $0.asked.source == source }?.result }
    }

    /// The ```mermaid block `source`, laid out for a column `room` points wide.
    public func layout(_ source: String, room: Int) async -> FlowchartResult {
        let asked = Asked(source: source, room: room)
        if let result = recall(asked) { return result }
        return await withCheckedContinuation { answer in
            queue.async {
                // Two blocks with one source ask twice: the second finds the first's.
                let result = self.recall(asked) ?? self.run(asked)
                self.keep(asked, result)
                answer.resume(returning: result)
            }
        }
    }

    private func recall(_ asked: Asked) -> FlowchartResult? {
        lock.withLock { kept.first { $0.asked == asked }?.result }
    }

    private func keep(_ asked: Asked, _ result: FlowchartResult) {
        lock.withLock {
            kept.removeAll { $0.asked == asked }
            kept.append((asked, result))
            if kept.count > Self.keptCount { kept.removeFirst(kept.count - Self.keptCount) }
        }
    }

    private func run(_ asked: Asked) -> FlowchartResult {
        guard let layout = loaded(),
            let json = layout.call(withArguments: [asked.source, asked.room])?.toString(),
            let result = try? JSONDecoder().decode(FlowchartResult.self, from: Data(json.utf8))
        else {
            return .undrawn(.error, message: "Flowcharts cannot be drawn in this build of the app.")
        }
        return result
    }

    private func loaded() -> JavaScriptCore.JSValue? {
        if let layoutFunction { return layoutFunction }
        guard !loadFailed else { return nil }
        guard let text = try? String(contentsOf: script, encoding: .utf8), let context = JSContext() else {
            loadFailed = true
            return nil
        }
        context.evaluateScript(text)
        guard let layout = context.objectForKeyedSubscript("DoklinFlowchart")?.objectForKeyedSubscript("layout"), layout.isObject else {
            loadFailed = true
            return nil
        }
        layoutFunction = layout
        return layout
    }
}
#endif
