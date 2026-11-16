// Editing a note in place: the Mac's own editor (src/ios-editor/, built into
// the app as Editor/ by scripts/ios-editor.sh) in a web view, driven from
// here. The bridge is `window.doklin` there and the `doklin` message handler
// here — change both sides with src/ios-editor/main.ts.
//
// The web view is made once, after the first frame, and kept: Edit hands it
// a note, it does not start a browser. It is served from a scheme of the
// app's own (`doklin-editor://app/`), which answers the editor's files and
// the note's pictures from this iPhone and nothing else; every other load is
// blocked, so nothing in the page reaches a domain or the workspace's token.

import DoklinKit
import ObjectiveC
import SwiftUI
import UIKit
import WebKit

/// The one web view the editor runs in, and what it last said.
@MainActor
@Observable
final class EditorPage: NSObject {
    static let shared = EditorPage()
    static let scheme = "doklin-editor"

    /// The page has loaded and can take a note.
    private(set) var ready = false
    /// The marks where the caret is: `strong`, `emphasis`, `strike_through`, `inlineCode`.
    private(set) var marks: Set<String> = []
    /// The kind of block the caret is in: `text`, `heading2`, `todo`, …
    private(set) var block = "text"

    /// What the page says, to the editing that has it now.
    @ObservationIgnored var heard: ((Said) -> Void)?
    @ObservationIgnored fileprivate var files: WorkspaceFiles?
    @ObservationIgnored private var made: WKWebView?
    @ObservationIgnored private var waiting: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private let relay = Relay()
    @ObservationIgnored private let server = EditorFiles()

    enum Said {
        case loaded(String)
        case changed(String)
        case failed(String)
    }

    /// Make the web view and load the editor, ahead of the first Edit.
    func warm() {
        _ = view
    }

    var view: WKWebView {
        if let made { return made }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(server, forURLScheme: Self.scheme)
        relay.page = self
        configuration.userContentController.add(relay, name: "doklin")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.keyboardDismissMode = .interactive
        view.navigationDelegate = relay
        #if DEBUG
            view.isInspectable = true
        #endif
        made = view
        server.page = self
        // Nothing the page asks for leaves this iPhone.
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "doklin-editor-offline",
            encodedContentRuleList: #"[{"trigger":{"url-filter":"^(https?|wss?|ftp):"},"action":{"type":"block"}}]"#
        ) { list, _ in
            if let list { configuration.userContentController.add(list) }
        }
        if let page = URL(string: "\(Self.scheme)://app/index.html") {
            view.load(URLRequest(url: page))
        }
        return view
    }

    fileprivate func said(_ body: Any) {
        guard let message = body as? [String: Any], let kind = message["kind"] as? String else { return }
        switch kind {
        case "ready":
            ready = true
            view.dropInputAccessory()
            waiting.forEach { $0.resume() }
            waiting = []
        case "loaded":
            heard?(.loaded(message["markdown"] as? String ?? ""))
        case "changed":
            heard?(.changed(message["markdown"] as? String ?? ""))
        case "failed":
            heard?(.failed(message["message"] as? String ?? "The editor could not open this note."))
        case "selection":
            marks = Set(message["marks"] as? [String] ?? [])
            block = message["block"] as? String ?? "text"
        default:
            break
        }
    }

    private func whenReady() async {
        _ = view
        if ready { return }
        await withCheckedContinuation { waiting.append($0) }
    }

    /// Hand the editor a note, as the file has it, with the caret at the
    /// start of its top-level block `block` (whose text starts `prefix`).
    func open(_ markdown: String, meta: String?, folder: String, files: WorkspaceFiles, block: Int?, prefix: String?) async {
        await whenReady()
        self.files = files
        let folders = folder.split(separator: "/").map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }
        let base = "/doc/" + folders.map { $0 + "/" }.joined()
        let nothing: Any = NSNull()
        let input: [String: Any] = [
            "markdown": markdown,
            "base": base,
            "meta": meta.map { $0 as Any } ?? nothing,
            "block": block.map { $0 as Any } ?? nothing,
            "prefix": prefix.map { $0 as Any } ?? nothing,
        ]
        _ = await run("await window.doklin.load(input)", ["input": input])
    }

    func command(_ name: String) {
        Task { _ = await run("window.doklin.command(name)", ["name": name]) }
    }

    func editable(_ on: Bool) {
        Task { _ = await run("window.doklin.editable(on)", ["on": on]) }
    }

    /// What the note would hold if it were written now.
    func markdown() async -> String? {
        guard ready else { return nil }
        return await run("return window.doklin.markdown()") as? String
    }

    /// Put the keyboard away.
    func blur() {
        Task { _ = await run("window.doklin.blur()") }
    }

    /// Run `body` in the page, as an async function of `arguments`; its
    /// answer, or nil.
    private func run(_ body: String, _ arguments: [String: Any] = [:]) async -> Any? {
        let view = self.view
        return await withCheckedContinuation { (done: CheckedContinuation<Any?, Never>) in
            view.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { result in
                switch result {
                case .success(let value): done.resume(returning: value is NSNull ? nil : value)
                case .failure: done.resume(returning: nil)
                }
            }
        }
    }

    /// The message handler and navigation delegate, held weakly by the page
    /// they serve (WebKit keeps a message handler alive).
    private final class Relay: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var page: EditorPage?

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            let body = message.body
            MainActor.assumeIsolated { page?.said(body) }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            action.request.url?.scheme == EditorPage.scheme ? .allow : .cancel
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            // Its memory was taken back: load the editor again, ready for the next Edit.
            MainActor.assumeIsolated { page?.restart() }
        }
    }

    fileprivate func restart() {
        ready = false
        if let page = URL(string: "\(Self.scheme)://app/index.html") {
            made?.load(URLRequest(url: page))
        }
    }
}

/// `doklin-editor://app/…`: the editor's own files, from the app; the note's
/// pictures (`/doc/<path>`), from the workspace on this iPhone. Nothing else.
private final class EditorFiles: NSObject, WKURLSchemeHandler {
    weak var page: EditorPage?
    private let editor = Bundle.main.url(forResource: "Editor", withExtension: nil)

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        let path = url.path.removingPercentEncoding ?? url.path
        var data: Data?
        if path.hasPrefix("/doc/") {
            let file = String(path.dropFirst("/doc/".count))
            if FileKind.of(file) == .image {
                data = MainActor.assumeIsolated { try? page?.files?.read(file) }
            }
        } else if let editor {
            let file = editor.appendingPathComponent(path == "/" ? "index.html" : String(path.dropFirst()))
            if file.standardizedFileURL.path.hasPrefix(editor.standardizedFileURL.path) {
                data = try? Data(contentsOf: file)
            }
        }
        guard let data else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        task.didReceive(URLResponse(url: url, mimeType: Self.type(of: path), expectedContentLength: data.count, textEncodingName: nil))
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}

    private static func type(of path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "avif": return "image/avif"
        case "heic": return "image/heic"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "wasm": return "application/wasm"
        default: return "application/octet-stream"
        }
    }
}

extension WKWebView {
    /// WebKit puts a bar of its own over the keyboard (previous, next, done);
    /// the editor has its own, so WebKit's goes. Its content view becomes a
    /// subclass of itself with no accessory view.
    func dropInputAccessory() {
        guard let content = scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }) else { return }
        let base: AnyClass = type(of: content)
        let name = "\(NSStringFromClass(base))_DoklinNoAccessory"
        var subclass: AnyClass? = NSClassFromString(name)
        if subclass == nil, let made = objc_allocateClassPair(base, name, 0) {
            let none: @convention(block) (AnyObject) -> UIView? = { _ in nil }
            class_addMethod(made, #selector(getter: UIResponder.inputAccessoryView), imp_implementationWithBlock(none), "@@:")
            objc_registerClassPair(made)
            subclass = made
        }
        if let subclass { object_setClass(content, subclass) }
    }
}

/// The editor's web view, in a screen.
struct EditorSurface: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let holder = UIView()
        holder.backgroundColor = .clear
        let view = EditorPage.shared.view
        view.removeFromSuperview()
        view.frame = holder.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        holder.addSubview(view)
        return holder
    }

    func updateUIView(_ holder: UIView, context: Context) {
        let view = EditorPage.shared.view
        if view.superview !== holder {
            view.removeFromSuperview()
            view.frame = holder.bounds
            holder.addSubview(view)
        }
    }
}

/* ---------- One note being edited ---------- */

/// A note being edited here: what the editor holds, what the file holds,
/// and saving the one into the other as typing pauses. While it is open,
/// other devices see it edited here and open it view-only; one that holds it
/// already makes it view-only here, until this iPhone takes over. Sync
/// merges what was typed here with what changed elsewhere meanwhile —
/// unless both changed while this editor held unsaved text: then the person
/// chooses, as on a Mac.
@MainActor
@Observable
final class NoteEditing {
    enum Phase: Equatable {
        case opening
        case editing
        case failed(String)
    }

    let model: DocumentModel
    private(set) var phase: Phase = .opening
    /// What the file holds, as far as this editing knows.
    private(set) var saved: String
    /// The note as the editor first had it: opening a note writes nothing.
    private var baseline: String?
    /// What the editor holds now.
    private var current: String?
    /// What this editing last wrote, or is writing.
    private var written: String?
    private(set) var saving = false
    /// The file changed elsewhere while something typed here was unsaved.
    var changedElsewhere = false
    var takingOver = false
    var failure: String?
    @ObservationIgnored private var pending: Task<Void, Never>?

    init(model: DocumentModel) {
        self.model = model
        saved = model.text ?? ""
    }

    /// Typed here and not in the file yet.
    var unsaved: Bool {
        guard let current else { return false }
        return current != (written ?? baseline)
    }

    var lease: LeaseHolder? { model.lease }

    /// Open the note in the editor, with the caret at top-level block `block`.
    func start(at block: Int?, prefix: String?) async {
        let page = EditorPage.shared
        page.heard = { [weak self] said in self?.hear(said) }
        await model.editing(true)
        let meta = try? model.workspace.files.text(DocLinks.metaFile(of: model.path))
        await page.open(saved, meta: meta, folder: DocLinks.directory(of: model.path), files: model.workspace.files, block: block, prefix: prefix)
        page.editable(lease == nil && !changedElsewhere)
    }

    private func hear(_ said: EditorPage.Said) {
        switch said {
        case .loaded(let markdown):
            baseline = markdown
            current = markdown
            written = nil
            phase = .editing
        case .changed(let markdown):
            current = markdown
            schedule()
        case .failed(let message):
            phase = .failed(message)
        }
    }

    /// Save once the typing pauses.
    private func schedule() {
        pending?.cancel()
        guard unsaved, !changedElsewhere else { return }
        pending = Task {
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard !Task.isCancelled else { return }
            await save()
        }
    }

    /// Write what was typed. True when the file now holds it.
    @discardableResult
    func save() async -> Bool {
        if let now = await EditorPage.shared.markdown(), phase == .editing { current = now }
        guard unsaved, let typed = current else { return true }
        guard !changedElsewhere else { return false }
        saving = true
        defer { saving = false }
        written = typed
        do {
            try await model.save(typed, over: saved)
            saved = typed
            return true
        } catch is DocumentModel.ChangedElsewhere {
            written = nil
            pending?.cancel()
            changedElsewhere = true
            EditorPage.shared.editable(false)
        } catch {
            written = nil
            failure = (error as? DoklinError)?.message ?? error.localizedDescription
        }
        return false
    }

    /// Files of the workspace changed: when this note is one of them and
    /// not by this editing's hand, take the new text — or, with unsaved
    /// typing here, ask. True when the note is gone and editing is over.
    func heardChange() async -> Bool {
        guard model.isAffected(by: model.workspace.lastChanged) else { return false }
        if !model.exists {
            // Moved or removed on another device, or its folder left this
            // iPhone: there is nothing here to save into.
            pending?.cancel()
            await model.editing(false)
            return true
        }
        guard let disk = try? model.workspace.files.text(model.path), disk != saved, disk != written else { return false }
        if unsaved {
            pending?.cancel()
            changedElsewhere = true
            EditorPage.shared.editable(false)
        } else {
            saved = disk
            await start(at: nil, prefix: nil)
        }
        return false
    }

    func reload() async {
        guard let disk = try? model.workspace.files.text(model.path) else { return }
        changedElsewhere = false
        saved = disk
        await start(at: nil, prefix: nil)
    }

    func keepMine() async {
        changedElsewhere = false
        // What the other device wrote stays in the note's history.
        saved = (try? model.workspace.files.text(model.path)) ?? saved
        EditorPage.shared.editable(lease == nil)
        await save()
    }

    func takeOver() {
        takingOver = true
        Task { await model.takeOver() }
    }

    /// Another device's hold came or went.
    func leaseChanged() {
        takingOver = false
        EditorPage.shared.editable(lease == nil && !changedElsewhere)
    }

    /// Done: once what was typed is in the file — never over typing that is
    /// not, which the banner or the alert explains. True when it is over.
    func finish() async -> Bool {
        pending?.cancel()
        guard await save() else { return false }
        EditorPage.shared.blur()
        await model.editing(false)
        EditorPage.shared.heard = nil
        model.load()
        return true
    }

    /// Leaving without Done (the app goes to the background, the screen
    /// closes): what was typed is written.
    func leave() async {
        pending?.cancel()
        await save()
        await model.editing(false)
        EditorPage.shared.heard = nil
    }
}

/* ---------- The bar over the keyboard ---------- */

/// What can be done to the words while editing: the marks, lists and to-dos,
/// undo — and *Aa*, which turns the block into another kind.
struct EditorBar: View {
    @Binding var turning: Bool

    private var page: EditorPage { EditorPage.shared }

    var body: some View {
        HStack(spacing: 2) {
            tool("textformat", "Turn into", on: turning) {
                turning.toggle()
                if turning { page.blur() }
            }
            .accessibilityIdentifier("turn-into")
            tool("bold", "Bold", on: page.marks.contains("strong")) { page.command("bold") }
            tool("italic", "Italic", on: page.marks.contains("emphasis")) { page.command("italic") }
            tool("list.bullet", "List", on: page.block == "bullet") { page.command("bullet") }
            tool("checklist", "To-do", on: page.block == "todo") { page.command("todo") }
            Spacer(minLength: 4)
            tool("arrow.uturn.backward", "Undo", on: false) { page.command("undo") }
            tool("arrow.uturn.forward", "Redo", on: false) { page.command("redo") }
            tool("keyboard.chevron.compact.down", "Hide keyboard", on: false) {
                turning = false
                page.blur()
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .glassEffect(.regular, in: Capsule())
    }

    private func tool(_ symbol: String, _ label: String, on: Bool, run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Image(systemName: symbol)
                .font(.body.weight(.medium))
                .frame(width: 38, height: 34)
                .foregroundStyle(on ? Theme.accent : Theme.text1)
                .background(on ? Theme.accentWash : Color.clear, in: RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// *Aa*: the block as another kind, and the marks, in place of the keyboard.
struct TurnIntoPanel: View {
    let done: () -> Void

    private var page: EditorPage { EditorPage.shared }
    private let kinds: [(String, String, String)] = [
        ("text", "Text", "text.alignleft"),
        ("heading1", "Heading 1", "textformat.size.larger"),
        ("heading2", "Heading 2", "textformat.size"),
        ("heading3", "Heading 3", "textformat.size.smaller"),
        ("bullet", "List", "list.bullet"),
        ("ordered", "Numbered", "list.number"),
        ("todo", "To-do", "checklist"),
        ("quote", "Quote", "text.quote"),
        ("codeBlock", "Code", "curlybraces"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Turn into")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.text2)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 8) {
                ForEach(kinds, id: \.0) { kind in
                    Button {
                        page.command(kind.0)
                        done()
                    } label: {
                        VStack(spacing: 6) {
                            Image(systemName: kind.2)
                                .font(.title3)
                            Text(kind.1)
                                .font(.caption)
                        }
                        .frame(maxWidth: .infinity, minHeight: 54)
                        .foregroundStyle(page.block == kind.0 ? Theme.accent : Theme.text1)
                        .background(page.block == kind.0 ? Theme.accentWash : Theme.sunken, in: RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(page.block == kind.0 ? .isSelected : [])
                }
            }
            HStack(spacing: 8) {
                mark("bold", "B", "strong", "Bold")
                mark("italic", "I", "emphasis", "Italic")
                mark("strike", "S", "strike_through", "Strikethrough")
                mark("code", "`a`", "inlineCode", "Code")
                Spacer()
                Button { page.command("outdent") } label: { Image(systemName: "decrease.indent") }
                    .accessibilityLabel("Outdent")
                Button { page.command("indent") } label: { Image(systemName: "increase.indent") }
                    .accessibilityLabel("Indent")
            }
            .buttonStyle(.glass)
        }
        .padding(16)
        .background(Theme.sheet)
    }

    private func mark(_ command: String, _ title: String, _ name: String, _ label: String) -> some View {
        Button {
            page.command(command)
        } label: {
            Text(title)
                .font(.body.weight(command == "bold" ? .bold : .regular))
                .italic(command == "italic")
                .strikethrough(command == "strike")
                .frame(minWidth: 28)
                .foregroundStyle(page.marks.contains(name) ? Theme.accent : Theme.text1)
        }
        .accessibilityLabel(label)
        .accessibilityAddTraits(page.marks.contains(name) ? .isSelected : [])
    }
}
