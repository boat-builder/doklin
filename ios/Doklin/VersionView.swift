import DoklinKit
import SwiftUI

/// One old version of a note, read-only: read as the note reads, or as what
/// changed from it to the next. Restoring puts it back as the note — the
/// note as it was before is kept as a version first, so the restore can be
/// undone. For a deleted document this is what it last held, and restoring
/// brings it back.
struct VersionView: View {
    @Binding var route: [Route]
    @State private var reader: VersionReader
    @State private var showingChanges = false
    @State private var restoring = false
    @State private var copying = false
    @State private var failure: String?
    @State private var scrollTarget: Int?
    @Environment(Toaster.self) private var toaster
    @Environment(\.openURL) private var openInSystem

    init(workspace: Workspace, opened: OpenVersion, route: Binding<[Route]>) {
        _route = route
        _reader = State(initialValue: VersionReader(workspace: workspace, opened: opened))
    }

    private var workspace: Workspace { reader.workspace }
    private var opened: OpenVersion { reader.opened }
    private var mayChange: Bool { workspace.may("work") }

    var body: some View {
        let dates = HistoryDates()
        VStack(spacing: 0) {
            banner(dates)
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Theme.sheet)
        .navigationTitle(DocLinks.stem(of: DocLinks.name(of: opened.path)))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar(dates) }
        .task { await reader.load() }
        .task(id: showingChanges) {
            if showingChanges { await reader.compare() }
        }
        .alert("That did not work", isPresented: failureShown) {
            Button("OK", role: .cancel) { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

    private var failureShown: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    /* ---------- What is shown ---------- */

    /// Which version this is, and what can be done with it: compared, or
    /// restored — on the banner, as the Mac has them.
    private func banner(_ dates: HistoryDates) -> some View {
        let then = DocLinks.name(of: opened.version.path)
        let renamed = then != DocLinks.name(of: opened.path) ? Text(" · then called \(opened.version.path)") : Text("")
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: opened.deleted == nil ? "clock.arrow.circlepath" : "trash")
                    .foregroundStyle(Theme.text3)
                    .accessibilityHidden(true)
                (Text("Viewing the version from ") + Text(dates.moment(opened.version.ts)).bold() + renamed)
                    .font(.footnote)
                    .foregroundStyle(Theme.text1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("version-banner")
            }
            if opened.deleted == nil || mayChange {
                HStack(spacing: 12) {
                    if opened.deleted == nil {
                        Button(showingChanges ? "Hide changes" : "Show changes") { showingChanges.toggle() }
                            .buttonStyle(.bordered)
                            .disabled(reader.text == nil)
                            .accessibilityIdentifier("show-changes")
                    }
                    Spacer(minLength: 0)
                    if mayChange {
                        Button(restoreWords) { restore(dates) }
                            .buttonStyle(.borderedProminent)
                            .disabled(reader.text == nil || restoring)
                            .accessibilityIdentifier("restore-version")
                    }
                }
                .controlSize(.small)
                .font(.footnote.weight(.semibold))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Theme.sunken)
    }

    @ViewBuilder private var content: some View {
        switch reader.phase {
        case .failed(let message):
            ContentUnavailableView("Could not open that version", systemImage: "exclamationmark.triangle", description: Text(message))
        case .loaded:
            if showingChanges {
                changes
            } else {
                version
            }
        default:
            ProgressView("Opening that version…")
        }
    }

    /// The version's tags, read with the list as it is now: shown, never
    /// changed here.
    private var versionTags: [NoteTag] {
        reader.text.map { Tags.noteTags($0, list: workspace.tagList.tags) } ?? []
    }

    /// The rest of the version's block, when it holds more than its tags.
    private var frontmatterShown: Bool {
        reader.text.map { workspace.tagList.frontmatter(of: $0, reader: reader.document?.frontmatter) != nil } ?? true
    }

    @ViewBuilder private var version: some View {
        if let document = reader.document {
            ScrollViewReader { proxy in
                ScrollView {
                    MarkdownView(
                        document: document, file: opened.path, workspace: workspace,
                        underTitle: versionTags.isEmpty ? nil : AnyView(TagsRow(tags: versionTags, list: workspace.tagList.tags)),
                        showsFrontmatter: frontmatterShown
                    )
                        .padding(.horizontal, 20)
                        .padding(.vertical, 16)
                        .frame(maxWidth: 700)
                        .frame(maxWidth: .infinity)
                }
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
        } else if reader.kind == .html {
            HTMLView(html: reader.text ?? "")
        } else {
            ScrollView {
                Text(reader.text ?? "")
                    .font(.docCode)
                    .foregroundStyle(Theme.text1)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
        }
    }

    @ViewBuilder private var changes: some View {
        if let problem = reader.changesProblem {
            ContentUnavailableView("Could not compare", systemImage: "exclamationmark.triangle", description: Text(problem))
        } else if let lines = reader.changes {
            DiffView(lines: lines, changed: reader.changed, against: opened.newer)
        } else {
            ProgressView("Comparing…")
        }
    }

    /// Follow a link written in the version as the note follows one:
    /// another document opens as it is now, a heading of this version
    /// scrolls into view, the web opens in the system. A tap on words under
    /// a comment does nothing here — the threads are the note's, not the
    /// version's.
    private func follow(_ href: String) {
        switch DocLinks.target(of: href, from: opened.path) {
        case .document(let path):
            if workspace.files.exists(path) {
                route.append(.document(path))
            } else {
                failure = "\(DocLinks.name(of: path)) is not in this workspace."
            }
        case .heading(let fragment):
            let wanted = DocLinks.slug(fragment)
            if let heading = reader.document?.headings.first(where: { DocLinks.slug($0.title) == wanted }) {
                scrollTarget = heading.id
            }
        case .external(let address):
            if let url = URL(string: address) { openInSystem(url) }
        case .nowhere:
            failure = "That link leads outside this workspace."
        }
    }

    /* ---------- What can be done ---------- */

    @ToolbarContentBuilder private func toolbar(_ dates: HistoryDates) -> some ToolbarContent {
        if mayChange, opened.deleted == nil {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        copy(dates)
                    } label: {
                        Label(copying ? "Copying…" : "Make a copy", systemImage: "doc.on.doc")
                    }
                    .disabled(reader.text == nil || copying)
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
            }
        }
    }

    private var restoreWords: String {
        if opened.deleted != nil { return restoring ? "Bringing it back…" : "Restore" }
        return restoring ? "Restoring…" : "Restore this version"
    }

    private func restore(_ dates: HistoryDates) {
        restoring = true
        Task {
            defer { restoring = false }
            if let deleted = opened.deleted {
                do {
                    let path = try await deleted.bringBack(in: workspace)
                    // Only this screen, if it is still on top: the person
                    // may have gone back while the restore ran.
                    if route.last == .history(.version(opened)) { route.removeLast() }
                    toaster.show("\(deleted.name) is back.", action: Toaster.Action(label: "Open") { [$route] in
                        $route.wrappedValue.append(.document(path))
                    })
                } catch {
                    failure = HistoryWords.failed("Couldn't bring that file back", error)
                }
                return
            }
            do {
                let outcome = try await reader.restore()
                backToTheNote()
                let opened = opened
                let workspace = workspace
                let toaster = toaster
                toaster.show(
                    "Restored the version from \(dates.moment(opened.version.ts)).",
                    action: outcome.preRestoreHash == nil ? nil : Toaster.Action(label: "Undo") {
                        Task {
                            do {
                                try await VersionReader.undo(outcome, of: opened, in: workspace)
                            } catch {
                                toaster.show(HistoryWords.failed("Couldn't undo that restore", error), tone: .error)
                            }
                        }
                    }
                )
            } catch {
                failure = HistoryWords.failed("Couldn't restore that version", error)
            }
        }
    }

    /// After a restore: the note itself, which now says what this version did.
    private func backToTheNote() {
        let note = Route.document(opened.path)
        if let index = route.lastIndex(of: note) {
            route.removeSubrange((index + 1)...)
        } else {
            while case .history = route.last { route.removeLast() }
            route.append(note)
        }
    }

    private func copy(_ dates: HistoryDates) {
        copying = true
        Task {
            defer { copying = false }
            do {
                let path = try await reader.copy(dates)
                route.append(.document(path))
            } catch {
                failure = HistoryWords.failed("Couldn't make a copy", error)
            }
        }
    }
}

/// What changed from one version to the next, a line at a time: what was
/// added marked with a plus on green, what was taken out with a minus on red.
struct DiffView: View {
    let lines: [DiffLine]
    /// Whether anything differs at all.
    let changed: Bool
    /// The version it is compared with; nil for the note as it is now.
    let against: FileVersion?

    private var heading: String {
        guard let against else { return "From this version to the note as it is now" }
        return against.current ? "From this version to the next, which is the note as it is now" : "From this version to the next one"
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                Text(heading)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                if !changed {
                    Text(against == nil ? "This version is what the note says now." : "Nothing changed between this version and the next.")
                        .font(.body)
                        .foregroundStyle(Theme.text2)
                        .padding(.horizontal, 16)
                }
                ForEach(lines) { line in
                    row(line)
                }
            }
            .padding(.bottom, 16)
        }
        .accessibilityIdentifier("version-changes")
    }

    @ViewBuilder private func row(_ line: DiffLine) -> some View {
        switch line.kind {
        case .starts(let number):
            Text("Line \(number)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.text3)
                .padding(.horizontal, 16)
                .padding(.top, line.id == 0 ? 0 : 14)
                .padding(.bottom, 4)
        case .added, .removed, .same:
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(mark(line.kind))
                    .foregroundStyle(ink(line.kind))
                    .frame(width: 12)
                    .accessibilityHidden(true)
                Text(line.text.isEmpty ? " " : line.text)
                    .foregroundStyle(line.kind == .same ? Theme.text2 : Theme.text1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(.docCode)
            .padding(.horizontal, 16)
            .padding(.vertical, 2)
            .background(wash(line.kind))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spoken(line))
        }
    }

    private func mark(_ kind: DiffLine.Kind) -> String {
        switch kind {
        case .added: return "+"
        case .removed: return "−"
        default: return ""
        }
    }

    private func ink(_ kind: DiffLine.Kind) -> Color {
        kind == .removed ? Theme.errorInk : Theme.live
    }

    private func wash(_ kind: DiffLine.Kind) -> Color {
        switch kind {
        case .added: return Theme.live.opacity(0.18)
        case .removed: return Theme.errorInk.opacity(0.14)
        default: return .clear
        }
    }

    private func spoken(_ line: DiffLine) -> String {
        let text = line.text.isEmpty ? "an empty line" : line.text
        switch line.kind {
        case .added: return "Added: \(text)"
        case .removed: return "Taken out: \(text)"
        default: return text
        }
    }
}
