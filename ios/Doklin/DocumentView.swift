import DoklinKit
import SwiftUI
import UIKit

/// One document, open for reading — and the way to editing it.
struct DocumentView: View {
    @Binding var route: [Route]
    @State private var model: DocumentModel
    @State private var editing = false
    @State private var showingPage = false
    @State private var scrollTarget: Int?
    @Environment(\.openURL) private var openInSystem

    init(workspace: Workspace, path: String, route: Binding<[Route]>) {
        _route = route
        _model = State(initialValue: DocumentModel(workspace: workspace, path: path))
    }

    private var workspace: Workspace { model.workspace }

    var body: some View {
        content
            .background(Theme.sheet)
            .navigationTitle(model.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .onAppear { model.load() }
            .onChange(of: workspace.changes) {
                // Sync, or a restore, wrote this document: read it again.
                if model.isAffected(by: workspace.lastChanged) { model.load() }
            }
            .fullScreenCover(isPresented: $editing) {
                EditorView(model: model)
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
            if case .href(let href) = tap { follow(href) }
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
        return actions
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
            ShareLink(item: text) {
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
