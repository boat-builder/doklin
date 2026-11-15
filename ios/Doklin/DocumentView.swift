import DoklinKit
import SwiftUI
import UIKit

/// One document, open for reading — and the way to editing it, to its
/// comments and to its page on the web.
struct DocumentView: View {
    @Binding var route: [Route]
    @State private var model: DocumentModel
    @State private var comments: CommentsModel
    @State private var editing = false
    @State private var showingPage = false
    @State private var scrollTarget: Int?
    /// The comments sheet, and what it opens on: a thread, or words for a new one.
    @State private var commentStart: CommentStart?
    @State private var publishing = false
    @Environment(\.openURL) private var openInSystem

    init(workspace: Workspace, path: String, route: Binding<[Route]>) {
        _route = route
        _model = State(initialValue: DocumentModel(workspace: workspace, path: path))
        _comments = State(initialValue: CommentsModel(workspace: workspace, path: path))
    }

    private var workspace: Workspace { model.workspace }

    var body: some View {
        content
            .background(Theme.sheet)
            .navigationTitle(model.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .onAppear {
                model.load()
                comments.load()
            }
            .onChange(of: workspace.changes) {
                // Sync, or a restore, wrote this document: read it again.
                if model.isAffected(by: workspace.lastChanged) { model.load() }
                if comments.isAffected(by: workspace.lastChanged) { comments.load() }
            }
            .onChange(of: model.html == nil) { _, gone in
                // The page went (removed, or moved off on another device):
                // what is shown, edited and outlined is the markdown again.
                if gone { showingPage = false }
            }
            .fullScreenCover(isPresented: $editing) {
                EditorView(model: model)
            }
            .sheet(item: $commentStart) { start in
                CommentsView(model: comments, start: start, mayComment: mayComment)
            }
            .sheet(isPresented: $publishing) {
                PublishView(workspace: workspace, path: model.path, kind: .file) { route.append(.publishedPages) }
            }
            .alert("Doklin", isPresented: problemShown) {
                Button("OK", role: .cancel) { model.problem = nil }
            } message: {
                Text(model.problem ?? "")
            }
    }

    private var problemShown: Binding<Bool> {
        Binding(get: { model.problem != nil }, set: { if !$0 { model.problem = nil } })
    }

    /* ---------- What is shown ---------- */

    @ViewBuilder private var content: some View {
        if case .failed(let message) = model.phase {
            ContentUnavailableView {
                Label("Could not open this", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { model.load() }
            }
        } else if model.phase != .loaded {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.kind == .html || (showingPage && model.html != nil) {
            HTMLView(html: model.html ?? "")
        } else if let document = model.document {
            VStack(spacing: 0) {
                if let lease = model.lease {
                    NoticeBar(text: LeaseWords.line(lease))
                }
                reader(document)
            }
        } else if let data = model.data {
            FileView(path: model.path, data: data)
        }
    }

    private func reader(_ document: MarkdownDocument) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                MarkdownView(document: document, file: model.path, workspace: workspace, actions: actions)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)
                    .frame(maxWidth: 700)
                    .frame(maxWidth: .infinity)
            }
            .refreshable { await workspace.syncNow() }
            .onChange(of: scrollTarget) { _, target in
                guard let target else { return }
                withAnimation { proxy.scrollTo(target, anchor: .top) }
                scrollTarget = nil
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            guard let tap = NoteLink.tap(url) else { return .systemAction }
            switch tap {
            case .thread(let id): commentStart = CommentStart(version: .md, thread: id)
            case .href(let href): follow(href)
            }
            return .handled
        })
    }

    private var actions: MarkdownActions {
        var actions = MarkdownActions()
        if model.canEdit, model.lease == nil {
            actions.toggleTask = { line in
                Task { await model.toggleTask(line: line) }
            }
        }
        if mayComment, model.isNote {
            actions.comment = { line in
                let words = model.text.flatMap { MarkdownEditing.commentAnchor(in: $0, line: line) } ?? ""
                commentStart = CommentStart(version: .md, words: words, composing: true)
            }
        }
        return actions
    }

    /// Comments are written here: this person may work, and no other device
    /// holds the document.
    private var mayComment: Bool { workspace.may("work") && model.lease == nil }

    /// The form being read, whose threads the comments sheet shows.
    private var shownVersion: CommentVersion { model.kind == .html || showingPage ? .html : .md }

    /// The publish entry in words: the page's state and address, as the
    /// Mac's chip says them.
    private func publishWords(_ status: CloudStatus) -> String? {
        guard let page = Publishing.page(for: model.path, kind: .file, in: status) else {
            return workspace.mayPublish ? "Publish…" : nil
        }
        let state = Publishing.state(of: page, in: status, pending: workspace.changedSinceSync(model.path))
        return "\(state.label) · /\(page.slug)"
    }

    /// Follow a link written in the note, the way the Mac app does: another
    /// document opens, a heading scrolls into view, the web opens in the system.
    private func follow(_ href: String) {
        switch DocLinks.target(of: href, from: model.path) {
        case .document(let path):
            if workspace.files.exists(path) {
                route.append(.document(path))
            } else {
                model.problem = "\(DocLinks.name(of: path)) is not in this workspace."
            }
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
            if model.phase == .loaded, model.isNote || model.kind == .html {
                Button {
                    commentStart = CommentStart(version: shownVersion)
                } label: {
                    Label("Comments", systemImage: comments.threads(on: shownVersion).isEmpty ? "bubble.left" : "bubble.left.fill")
                }
                .accessibilityIdentifier("comments")
            }
            if model.canEdit, !showingPage {
                Button {
                    editing = true
                } label: {
                    Label("Edit", systemImage: "square.and.pencil")
                }
                .accessibilityIdentifier("edit")
            }
            if model.phase == .loaded {
                Menu {
                    menu
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
            }
        }
    }

    @ViewBuilder private var menu: some View {
        if model.html != nil, model.isNote {
            Picker("Show", selection: $showingPage) {
                Text("Markdown").tag(false)
                Text("Page").tag(true)
            }
        }
        if let headings = model.document?.headings, headings.count > 1, !showingPage {
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
        if let text = model.text {
            // A copy out of the app reads clean: no comment markers.
            ShareLink(item: CriticMarkup.stripComments(text)) {
                Label("Share the text", systemImage: "square.and.arrow.up")
            }
        }
        if [.markdown, .html, .text].contains(model.kind) {
            Button {
                route.append(.history(.note(model.path)))
            } label: {
                Label("Version history", systemImage: "clock.arrow.circlepath")
            }
        }
        if let status = workspace.status, model.isNote || model.kind == .html, let words = publishWords(status) {
            Section {
                Button {
                    publishing = true
                } label: {
                    Label(words, systemImage: "globe")
                }
                .accessibilityIdentifier("publish")
            }
        }
    }
}

/// Another device holds a document: what the reader and the editor say.
enum LeaseWords {
    static func line(_ lease: LeaseHolder) -> String {
        lease.own ? "Open on your other device, \(lease.device) — view only" : "\(lease.name) is editing — view only"
    }

    static func takeOverHint(_ lease: LeaseHolder) -> String {
        lease.own ? "Edit here instead — the other device goes view-only." : "Edit here instead — \(lease.name)'s copy goes view-only."
    }
}
