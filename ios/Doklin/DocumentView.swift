import DoklinKit
import SwiftUI
import UIKit

/// One document, open for reading: where it is, who made it or changed it
/// last, and — when it changed since this person last read it here — what
/// changed, marked. *Edit*, or a double tap on a paragraph, edits it right
/// here; its comments, its link, its page on the web and its history are in
/// the bar along the bottom.
struct DocumentView: View {
    @Binding var route: [Route]
    @State private var model: DocumentModel
    @State private var comments: CommentsModel
    /// The note being edited here, while it is.
    @State private var session: NoteEditing?
    /// *Aa*: the panel that turns a block into another kind, in place of the keyboard.
    @State private var turning = false
    /// The top-level block at the top of the screen, by id: where Edit starts.
    @State private var topBlock: Int?
    @State private var showingPage = false
    @State private var scrollTarget: Int?
    /// The comments sheet, and what it opens on: a thread, or words for a new one.
    @State private var commentStart: CommentStart?
    @State private var publishing = false
    /// The words a search found, while the find bar is up.
    @State private var find: String?
    @State private var found: FindResult?
    @State private var foundIndex = 0
    /// The source line a search found, for when its words span markup.
    private let foundLine: Int?
    /// The changes since it was read, while they are marked.
    @State private var changesShown = true
    @State private var changeIndex: Int?
    @Environment(\.openURL) private var openInSystem
    @Environment(Workspaces.self) private var device
    @Environment(Toaster.self) private var toaster
    @Environment(Shell.self) private var shell
    @Environment(\.scenePhase) private var scenePhase

    init(workspace: Workspace, path: String, route: Binding<[Route]>, find: String? = nil, line: Int? = nil) {
        _route = route
        _model = State(initialValue: DocumentModel(workspace: workspace, path: path))
        _comments = State(initialValue: CommentsModel(workspace: workspace, path: path))
        _find = State(initialValue: find)
        foundLine = line
    }

    private var workspace: Workspace { model.workspace }

    var body: some View {
        content
            .background(Theme.sheet)
            .navigationTitle(session == nil ? model.title : "")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(session != nil)
            .toolbar { editingToolbar }
            .toolbar(.hidden, for: .tabBar)
            .safeAreaInset(edge: .bottom, spacing: 0) { bottom }
            .onAppear {
                shell.documents += 1
                model.load()
                comments.load()
            }
            .task { await workspace.loadDocuments() }
            .onChange(of: workspace.documents) {
                model.relink()
                session?.documentsChanged()
            }
            .task(id: model.phase == .loaded) {
                guard model.phase == .loaded else { return }
                markFound()
                await model.shown()
            }
            .onChange(of: workspace.changes) {
                if let session {
                    Task {
                        if await session.heardChange() { close() }
                    }
                } else if model.isAffected(by: workspace.lastChanged) {
                    // Sync, or a restore, wrote this document: read it again.
                    model.load()
                    markFound()
                }
                if comments.isAffected(by: workspace.lastChanged) { comments.load() }
            }
            .onChange(of: model.lease) { session?.leaseChanged() }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active, let session { Task { await session.save() } }
            }
            .onDisappear {
                shell.documents = max(0, shell.documents - 1)
                if let session { Task { await session.leave() } }
            }
            .onChange(of: model.html == nil) { _, gone in
                // The page went (removed, or moved off on another device):
                // what is shown, edited and outlined is the markdown again.
                if gone { showingPage = false }
            }
            .alert("Not saved", isPresented: Binding(get: { session?.failure != nil }, set: { if !$0 { session?.failure = nil } })) {
                Button("OK", role: .cancel) { session?.failure = nil }
            } message: {
                Text(session?.failure ?? "")
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
            .modifier(FindQuestion(asking: $askingFind, words: $findWords) { words in
                let wanted = words.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !wanted.isEmpty else { return }
                find = wanted
                foundIndex = 0
                markFound()
            })
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
                if let session {
                    editingBanners(session)
                } else if let lease = model.lease {
                    NoticeBar(text: LeaseWords.line(lease))
                }
                ZStack {
                    reader(document)
                        .opacity(session?.phase == .editing ? 0 : 1)
                    if let session {
                        if case .failed(let message) = session.phase {
                            ContentUnavailableView("Can't edit this note here", systemImage: "pencil.slash", description: Text(message))
                                .background(Theme.sheet)
                        } else {
                            EditorSurface()
                                .opacity(session.phase == .editing ? 1 : 0)
                                .accessibilityIdentifier("editor")
                        }
                    }
                }
                .animation(.easeInOut(duration: 0.2), value: session?.phase)
            }
        } else if let data = model.data {
            FileView(path: model.path, data: data)
        }
    }

    private var marks: ReaderMarks {
        ReaderMarks(
            find: find == nil ? nil : found,
            current: find == nil ? nil : foundIndex,
            changes: changesShown ? model.sinceRead : nil
        )
    }

    private func reader(_ document: MarkdownDocument) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Breadcrumb(workspace: workspace, path: model.path)
                    if !MarkdownView.hasTitle(document) {
                        Text(model.title)
                            .font(.docHeading(1))
                            .foregroundStyle(Theme.text1)
                    }
                    MarkdownView(
                        document: document, file: model.path, workspace: workspace, actions: actions,
                        underTitle: AnyView(header)
                    )
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
                .frame(maxWidth: 700)
                .frame(maxWidth: .infinity)
                .environment(\.readerMarks, marks)
            }
            .scrollPosition(id: $topBlock, anchor: .top)
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
            // The engine's sentence for a link that finds nothing (`Follow`):
            // a deleted page and one in a folder this person is not in are
            // never told apart.
            case .closed:
                model.problem = "That page isn't one you can open in \(workspace.name): it may have been deleted, or moved where you can't see it."
            }
            return .handled
        })
    }

    /// Under the title: who made it or changed it last, and what changed
    /// since it was read here.
    @ViewBuilder private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let item = workspace.recentItem(model.path) {
                HStack(spacing: 10) {
                    WhoBadge(item: item, size: 34)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.who)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.text1)
                        Text("\(item.created ? "Created" : "Edited") \(Date(timeIntervalSince1970: Double(item.changed) / 1000).formatted(.relative(presentation: .named)))")
                            .font(.footnote)
                            .foregroundStyle(Theme.text2)
                    }
                    Spacer(minLength: 0)
                    if model.newToYou { NewBadge() }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("provenance")
            }
            if let changes = model.sinceRead {
                Button {
                    if changesShown {
                        changeIndex = 0
                        scrollTarget = changes.stops.first
                    } else {
                        changesShown = true
                    }
                } label: {
                    HStack {
                        Label(changedWords(changes), systemImage: "clock")
                        Spacer()
                        if changesShown {
                            Text("Hide")
                                .fontWeight(.medium)
                                .onTapGesture { hideChanges() }
                        }
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.accent)
                    .padding(.horizontal, 14)
                    .frame(height: 44)
                    .background(Theme.accentWash, in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("changes-since-read")
            } else if model.changedUnmarked {
                Label("Changed since you read it", systemImage: "clock")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.accent)
            }
        }
    }

    private func changedWords(_ changes: ChangeMarks) -> String {
        let count = "\(changes.count) change\(changes.count == 1 ? "" : "s") since you read it"
        guard let at = model.readAt else { return count }
        return "\(count) \(HistoryDates().day(at) == "Today" ? "today" : "on " + HistoryDates().day(at))"
    }

    private func hideChanges() {
        changesShown = false
        changeIndex = nil
    }

    private var actions: MarkdownActions {
        var actions = MarkdownActions()
        if model.canEdit, model.lease == nil {
            actions.toggleTask = { line in
                Task { await model.toggleTask(line: line) }
            }
            actions.edit = { index in startEditing(at: index) }
        }
        if mayComment, model.isNote {
            actions.comment = { line in
                let words = model.text.flatMap { MarkdownEditing.commentAnchor(in: $0, line: line) } ?? ""
                commentStart = CommentStart(version: .md, words: words, composing: true)
            }
        }
        return actions
    }

    /// Edit the note right here, at top-level block `index` — or, from the
    /// bar, at the block at the top of the screen.
    private func startEditing(at index: Int?) {
        // Another device's hold opens the editor view-only, with Take over.
        guard session == nil, model.canEdit, let document = model.document else { return }
        let block = index ?? topBlock.flatMap { id in document.blocks.firstIndex { $0.id == id } }
        let prefix = block.flatMap { document.blocks[safe: $0]?.plainText }.map { String($0.prefix(40)) }
        let editing = NoteEditing(model: model)
        turning = false
        session = editing
        Task { await editing.start(at: block, prefix: prefix) }
    }

    /// Done: what was typed is in the file, and the note reads again.
    private func finish() {
        guard let session else { return }
        Task {
            if await session.finish() { close() }
        }
    }

    private func close() {
        withAnimation(.easeInOut(duration: 0.2)) {
            session = nil
            turning = false
        }
        markFound()
    }

    @ToolbarContentBuilder private var editingToolbar: some ToolbarContent {
        if let session {
            ToolbarItem(placement: .principal) {
                Text(editingWords(session))
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
                    .lineLimit(1)
                    .accessibilityIdentifier("editing-status")
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { finish() }
                    .fontWeight(.semibold)
                    .accessibilityIdentifier("done")
            }
        }
    }

    private func editingWords(_ session: NoteEditing) -> String {
        if session.lease != nil || session.changedElsewhere { return "Not saved" }
        if session.saving { return "Saving…" }
        if session.phase == .opening { return "Opening…" }
        return "Saved · other devices see it view-only while you edit"
    }

    /// Why what is typed here can't be saved right now, and what to do.
    @ViewBuilder private func editingBanners(_ session: NoteEditing) -> some View {
        if let lease = session.lease {
            banner(LeaseWords.line(lease), symbol: "lock") {
                Button(session.takingOver ? "Taking over…" : "Take over") { session.takeOver() }
                    .disabled(session.takingOver)
                    .accessibilityHint(LeaseWords.takeOverHint(lease))
            }
        }
        if session.changedElsewhere {
            banner("This note changed on another device while you were typing.", symbol: "exclamationmark.triangle") {
                Button("Reload") { Task { await session.reload() } }
                Button("Keep mine") { Task { await session.keepMine() } }
            }
        }
    }

    private func banner<Actions: View>(_ words: String, symbol: String, @ViewBuilder actions: () -> Actions) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(words, systemImage: symbol)
                .font(.footnote)
                .foregroundStyle(Theme.text1)
            HStack(spacing: 16) { actions() }
                .font(.footnote.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Theme.sunken)
    }

    /// The words a search found, marked, and the find bar on the first.
    private func markFound() {
        guard let find, let document = model.document else { return }
        found = Find.occurrences(of: find, in: document)
        foundIndex = min(foundIndex, max(0, (found?.count ?? 1) - 1))
        if let first = found?.occurrences[safe: foundIndex] {
            scrollTarget = first.top
        } else if let line = foundLine, let block = Find.block(atLine: line, in: document) {
            scrollTarget = block
        }
    }

    private func step(_ by: Int) {
        guard let found, found.count > 0 else { return }
        foundIndex = (foundIndex + by + found.count) % found.count
        scrollTarget = found.occurrences[foundIndex].top
    }

    private func stepChange(_ by: Int) {
        guard let changes = model.sinceRead, !changes.isEmpty else { return }
        let next = ((changeIndex ?? -1) + by + changes.count) % changes.count
        changeIndex = next
        scrollTarget = changes.stops[next]
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

    /// *Copy link*: a link that opens this document in Doklin, for anybody
    /// who can see it — and who that is, said as it is copied.
    private func copyLink() {
        Task {
            do {
                let link = try await workspace.link(to: model.path)
                UIPasteboard.general.string = link.url
                toaster.show("Link copied. \(link.who)")
            } catch {
                model.problem = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
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
            guard let url = URL(string: address) else { return }
            // A link to a page opens here, not in a browser that would only
            // hand it back: one of this workspace's on this note's stack,
            // as a link by its path does; any other as from outside.
            if Workspaces.isPageLink(url) {
                Task {
                    if let path = await workspace.page(url) {
                        route.append(.document(path))
                    } else {
                        await device.follow(url)
                    }
                }
            } else {
                openInSystem(url)
            }
        case .nowhere:
            model.problem = "That link leads outside this workspace."
        }
    }

    /* ---------- The bar ---------- */

    @ViewBuilder private var bottom: some View {
        if session != nil {
            if turning {
                TurnIntoPanel { turning = false }
                    .transition(.move(edge: .bottom))
            } else {
                EditorBar(turning: $turning)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
            }
        } else {
            reading
        }
    }

    @ViewBuilder private var reading: some View {
        VStack(spacing: 8) {
            ToastBar(toaster: toaster)
                .clipShape(RoundedRectangle(cornerRadius: 14))
            if model.phase == .loaded {
                if let find, let found, model.document != nil {
                    FindBar(query: find, index: foundIndex, count: found.count, step: step) {
                        self.find = nil
                    }
                } else if changeIndex != nil, let changes = model.sinceRead, changesShown {
                    ChangeStepper(index: changeIndex ?? 0, count: changes.count, step: stepChange) {
                        hideChanges()
                    }
                } else {
                    bar
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .animation(.default, value: toaster.shown?.id)
    }

    private var bar: some View {
        HStack(spacing: 10) {
            if model.isNote || model.kind == .html {
                let threads = comments.threads(on: shownVersion).count
                Button {
                    commentStart = CommentStart(version: shownVersion)
                } label: {
                    Label(threads == 0 ? "Comments" : "\(threads)", systemImage: threads == 0 ? "bubble.left" : "bubble.left.fill")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.glass)
                .accessibilityLabel(threads == 0 ? "Comments" : "Comments, \(threads)")
                .accessibilityIdentifier("comments")
            }
            Spacer()
            Menu {
                menu
            } label: {
                Label("More", systemImage: "ellipsis")
                    .labelStyle(.iconOnly)
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.glass)
            .accessibilityIdentifier("more")
            if model.canEdit, !showingPage {
                Button {
                    startEditing(at: nil)
                } label: {
                    Text("Edit")
                        .fontWeight(.semibold)
                        .padding(.horizontal, 6)
                }
                .buttonStyle(.glassProminent)
                .accessibilityIdentifier("edit")
            }
        }
        .controlSize(.large)
    }

    @ViewBuilder private var menu: some View {
        if model.html != nil, model.isNote {
            Picker("Show", selection: $showingPage) {
                Text("Note").tag(false)
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
        if model.isNote, find == nil, model.document != nil {
            Button {
                startFinding()
            } label: {
                Label("Find in note", systemImage: "text.magnifyingglass")
            }
        }
        if let text = model.text {
            // A copy out of the app reads clean: no comment markers.
            ShareLink(item: CriticMarkup.stripComments(text)) {
                Label("Share the text", systemImage: "square.and.arrow.up")
            }
        }
        if workspace.status != nil, model.isNote || model.kind == .html, workspace.audience(of: model.path) != .nowhere {
            Button {
                copyLink()
            } label: {
                Label("Copy link", systemImage: "link")
            }
            .accessibilityIdentifier("copy-link")
        }
        Button {
            shell.showInBrowse(model.path)
        } label: {
            Label("Show in Browse", systemImage: "folder")
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

    /// *Find in note*: what the last search was for, or a word to type.
    @State private var askingFind = false
    @State private var findWords = ""

    private func startFinding() {
        findWords = ""
        askingFind = true
    }
}

extension DocumentView {
    /// The find question, asked over the reader.
    struct FindQuestion: ViewModifier {
        @Binding var asking: Bool
        @Binding var words: String
        let found: (String) -> Void

        func body(content: Content) -> some View {
            content.alert("Find in note", isPresented: $asking) {
                TextField("Words", text: $words)
                Button("Cancel", role: .cancel) {}
                Button("Find") { found(words) }
            }
        }
    }
}

/// Where a document is: the workspace, then its folders.
struct Breadcrumb: View {
    let workspace: Workspace
    let path: String

    var body: some View {
        let folders = DocLinks.directory(of: path).split(separator: "/").map(String.init)
        HStack(spacing: 6) {
            Image(systemName: "folder")
                .font(.caption)
            Text(([workspace.name] + folders).joined(separator: " › "))
                .lineLimit(1)
                .truncationMode(.head)
        }
        .font(.footnote)
        .foregroundStyle(Theme.text2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("In " + ([workspace.name] + folders).joined(separator: ", "))
    }
}

/// The find bar: the words, which of the places they are this is, and the
/// way to the next.
struct FindBar: View {
    let query: String
    let index: Int
    let count: Int
    let step: (Int) -> Void
    let close: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(query)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .padding(.leading, 12)
            Text(count == 0 ? "Not in what shows" : "\(index + 1) of \(count)")
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
                .monospacedDigit()
                .padding(.leading, 4)
                .accessibilityIdentifier("find-count")
            Spacer(minLength: 8)
            Button { step(-1) } label: { Image(systemName: "chevron.up") }
                .accessibilityLabel("Previous")
                .disabled(count < 2)
            Button { step(1) } label: { Image(systemName: "chevron.down") }
                .accessibilityLabel("Next")
                .disabled(count < 2)
            Button(action: close) { Image(systemName: "xmark") }
                .accessibilityLabel("Close find")
        }
        .buttonStyle(.glass)
        .controlSize(.large)
    }
}

/// Walking what changed since the note was read.
struct ChangeStepper: View {
    let index: Int
    let count: Int
    let step: (Int) -> Void
    let done: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Text("Change \(index + 1) of \(count)")
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .padding(.leading, 12)
            Spacer(minLength: 8)
            Button { step(-1) } label: { Image(systemName: "chevron.up") }
                .accessibilityLabel("Previous change")
            Button { step(1) } label: { Image(systemName: "chevron.down") }
                .accessibilityLabel("Next change")
            Button("Done", action: done)
                .buttonStyle(.glassProminent)
        }
        .buttonStyle(.glass)
        .controlSize(.large)
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
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
