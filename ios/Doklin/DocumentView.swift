import DoklinKit
import SwiftUI
import UIKit

/// One document, open for reading — and the way to everything else done to
/// it: editing, comments, publishing.
struct DocumentView: View {
    @Binding var route: [Route]
    @State private var model: DocumentModel
    @State private var editing = false
    /// The comments sheet, and what it opens on: a thread, or words for a new one.
    @State private var commentStart: CommentStart?
    @State private var scrollTarget: Int?
    @State private var confirmingPublish = false
    @State private var confirmingStop = false
    @Environment(\.openURL) private var openInSystem

    init(session: Session, path: String, route: Binding<[Route]>) {
        _route = route
        _model = State(initialValue: DocumentModel(session: session, path: path))
    }

    private var session: Session { model.session }

    var body: some View {
        content
            .background(Theme.sheet)
            .navigationTitle(model.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .task(id: session.wakes) { await model.load() }
            .sheet(isPresented: $editing) {
                EditorView(model: model)
            }
            .sheet(item: $commentStart) { start in
                CommentsView(model: model, start: start)
            }
            .alert("Doklin", isPresented: problemShown) {
                Button("OK", role: .cancel) { model.problem = nil }
            } message: {
                Text(model.problem ?? "")
            }
            .confirmationDialog("Publish \(model.title)?", isPresented: $confirmingPublish, titleVisibility: .visible) {
                Button("Publish") { publish() }
            } message: {
                Text("It gets an address on \(session.account.domain) that anyone with the link can read.")
            }
            .confirmationDialog("Stop publishing \(model.title)?", isPresented: $confirmingStop, titleVisibility: .visible) {
                Button("Stop publishing", role: .destructive) { stopPublishing() }
            } message: {
                Text("Its link stops working.")
            }
    }

    private var problemShown: Binding<Bool> {
        Binding(get: { model.problem != nil }, set: { if !$0 { model.problem = nil } })
    }

    /* ---------- What is shown ---------- */

    @ViewBuilder private var content: some View {
        if let shown = model.content {
            VStack(spacing: 0) {
                if let notice = model.notice {
                    NoticeBar(text: notice)
                }
                if shown.kind == .file {
                    FileView(content: shown)
                } else if shown.version == .html {
                    HTMLView(html: shown.text ?? "")
                } else if let document = model.document {
                    reader(document, file: shown.file)
                } else {
                    ContentUnavailableView("This note is not text", systemImage: "doc.questionmark", description: Text("It cannot be read as markdown."))
                }
            }
        } else if case .failed(let message) = model.phase {
            ContentUnavailableView {
                Label("Could not open this", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") {
                    Task { await model.load() }
                }
            }
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func reader(_ document: MarkdownDocument, file: String) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                MarkdownView(document: document, file: file, session: session, actions: actions)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)
                    .frame(maxWidth: 700)
                    .frame(maxWidth: .infinity)
            }
            .refreshable { await model.load() }
            .onChange(of: scrollTarget) { _, target in
                guard let target else { return }
                withAnimation { proxy.scrollTo(target, anchor: .top) }
                scrollTarget = nil
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            guard let tap = NoteLink.tap(url) else { return .systemAction }
            switch tap {
            case .thread(let id):
                commentStart = CommentStart(thread: id)
            case .href(let href):
                follow(href, from: file)
            }
            return .handled
        })
    }

    private var actions: MarkdownActions {
        var actions = MarkdownActions()
        if model.canEdit {
            actions.toggleTask = { line in
                Task { await model.toggleTask(line: line) }
            }
        }
        if session.may(.comment), model.notice == nil {
            actions.comment = { line in
                commentStart = CommentStart(words: model.commentAnchor(line: line) ?? "", composing: true)
            }
        }
        return actions
    }

    /// Follow a link written in the note, the way the Mac app does: another
    /// note opens, a heading scrolls into view, the web opens in the system.
    private func follow(_ href: String, from file: String) {
        switch DocLinks.target(of: href, from: file) {
        case .document(let path):
            route.append(.document(path))
        case .heading(let fragment):
            let wanted = DocLinks.slug(fragment)
            if let heading = model.document?.headings.first(where: { DocLinks.slug($0.title) == wanted }) {
                scrollTarget = heading.id
            }
        case .external(let address):
            if let url = URL(string: address) { openInSystem(url) }
        case .nowhere:
            model.problem = "That link leads outside this workspace."
        }
    }

    /* ---------- The bar ---------- */

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if model.isDocument {
                Button {
                    commentStart = CommentStart()
                } label: {
                    Label("Comments", systemImage: model.shownThreads.isEmpty ? "bubble.left" : "bubble.left.fill")
                }
                if model.canEdit {
                    Button {
                        editing = true
                    } label: {
                        Label("Edit", systemImage: "square.and.pencil")
                    }
                }
            }
            if model.content != nil {
                Menu {
                    menu
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
            }
        }
    }

    @ViewBuilder private var menu: some View {
        if let versions = model.info?.versions, versions.count > 1 {
            Picker("Version", selection: shownVersion) {
                Text("Markdown").tag(DocVersion.md)
                Text("Page").tag(DocVersion.html)
            }
        }
        if let headings = model.document?.headings, headings.count > 1 {
            Menu {
                ForEach(headings) { heading in
                    Button(String(repeating: "  ", count: max(0, heading.level - 1)) + heading.title) {
                        scrollTarget = heading.id
                    }
                }
            } label: {
                Label("Outline", systemImage: "list.bullet.indent")
            }
        }
        if let text = model.text, model.isDocument {
            ShareLink(item: text) {
                Label("Share the text", systemImage: "square.and.arrow.up")
            }
        }
        Section {
            ForEach(model.addresses, id: \.self) { address in
                if let url = URL(string: address) {
                    ShareLink(item: url) {
                        Label("Share public link", systemImage: "globe")
                    }
                    Button {
                        UIPasteboard.general.string = address
                    } label: {
                        Label("Copy public link", systemImage: "link")
                    }
                    Button {
                        openInSystem(url)
                    } label: {
                        Label("Open public page", systemImage: "safari")
                    }
                }
            }
            if session.may(.publish), model.content != nil, model.notice == nil {
                if model.addresses.isEmpty {
                    Button {
                        confirmingPublish = true
                    } label: {
                        Label("Publish…", systemImage: "globe")
                    }
                } else {
                    Button(role: .destructive) {
                        confirmingStop = true
                    } label: {
                        Label("Stop publishing", systemImage: "xmark.circle")
                    }
                }
            }
        }
    }

    private var shownVersion: Binding<DocVersion> {
        Binding(
            get: { model.version ?? .md },
            set: { version in
                Task { await model.load(version: version) }
            }
        )
    }

    private func publish() {
        Task {
            do {
                let address = try await model.publish()
                UIPasteboard.general.string = address
                model.problem = "Published at \(address) — the link is on the clipboard."
            } catch {
                model.problem = session.explain(error)
            }
        }
    }

    private func stopPublishing() {
        Task {
            do {
                try await model.unpublish()
            } catch {
                model.problem = session.explain(error)
            }
        }
    }
}

/// What the comments sheet starts on.
struct CommentStart: Identifiable {
    let id = UUID()
    /// A thread to show first.
    var thread: String?
    /// Words offered for a new thread.
    var words = ""
    /// Open straight into writing a new comment.
    var composing = false
}
