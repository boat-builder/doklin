import DoklinKit
import SwiftUI

/// The Search tab: documents by their names, then notes by their words,
/// on this iPhone's copy. A note found by its words opens at them; a press
/// and hold shows the document without leaving.
struct SearchView: View {
    let workspace: Workspace
    @Binding var path: [Route]

    @Environment(Shell.self) private var shell
    @Environment(Toaster.self) private var toaster
    @State private var model: SearchModel
    @State private var query = ""
    @State private var recents: [String] = []

    init(workspace: Workspace, path: Binding<[Route]>) {
        self.workspace = workspace
        _path = path
        _model = State(initialValue: SearchModel(workspace: workspace))
    }

    private var remembered: RecentSearches { RecentSearches(wsId: workspace.status?.wsId ?? workspace.root) }

    var body: some View {
        List {
            if query.trimmingCharacters(in: .whitespaces).isEmpty {
                if !recents.isEmpty {
                    Section {
                        ForEach(recents, id: \.self) { recent in
                            Button {
                                query = recent
                            } label: {
                                Label(recent, systemImage: "clock.arrow.circlepath")
                                    .foregroundStyle(Theme.text1)
                            }
                        }
                    } header: {
                        HStack {
                            Text("Recent searches")
                            Spacer()
                            Button("Clear") {
                                remembered.clear()
                                recents = []
                            }
                            .font(.footnote)
                        }
                    }
                }
            } else {
                Section {
                    scopes
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                }
                if !model.tagged.isEmpty {
                    Section("With \(TagWords.filters(model.tags)) · \(model.tagged.count)") {
                        ForEach(model.tagged) { result in
                            row(result, opens: .document(result.path)) {
                                NameResult(result: result, workspace: workspace)
                            }
                        }
                    }
                }
                if !model.named.isEmpty {
                    Section("Names · \(model.named.count)") {
                        ForEach(model.named) { result in
                            row(result, opens: .document(result.path)) {
                                NameResult(result: result, workspace: workspace)
                            }
                        }
                    }
                }
                if !model.inText.isEmpty {
                    Section("In the text of notes · \(model.inText.count)") {
                        ForEach(model.inText) { result in
                            row(result, opens: .match(result.path, query: model.query, line: result.hits.first?.line)) {
                                TextResult(result: result, query: model.query)
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay { state }
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: workspace.tagList.isEmpty ? "A name, or words in a note" : "A name, words, or a tag")
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .onSubmit(of: .search) { remember() }
        .onAppear { recents = remembered.all }
        .task(id: query) {
            // Not a search a keystroke: wait until the typing pauses.
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            await model.run(query)
        }
        .onChange(of: workspace.changes) { Task { await model.run(query) } }
    }

    private func remember() {
        remembered.add(query)
        recents = remembered.all
    }

    private func row<Label: View>(_ result: SearchResult, opens route: Route, @ViewBuilder label: () -> Label) -> some View {
        Button {
            remember()
            path.append(route)
        } label: {
            label()
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("result-\(result.name)")
        .contextMenu {
            Button {
                remember()
                path.append(route)
            } label: {
                SwiftUI.Label("Open", systemImage: "doc.text")
            }
            if workspace.status != nil {
                Button {
                    copyLink(result.path)
                } label: {
                    SwiftUI.Label("Copy link", systemImage: "link")
                }
            }
            Button {
                shell.showInBrowse(result.path)
            } label: {
                SwiftUI.Label("Show in Browse", systemImage: "folder")
            }
        } preview: {
            DocumentPeek(workspace: workspace, path: result.path, find: route == .document(result.path) ? nil : model.query)
        }
    }

    private func copyLink(_ path: String) {
        Task {
            do {
                let link = try await workspace.link(to: path)
                UIPasteboard.general.string = link.url
                toaster.show("Link copied. \(link.who)")
            } catch {
                toaster.show((error as? DoklinError)?.message ?? error.localizedDescription, tone: .error)
            }
        }
    }

    private var scopes: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach([SearchScope.all, .notes, .pages], id: \.self) { scope in
                    chip(scope.label, on: model.scope == scope) { model.scope = scope }
                }
                Menu {
                    Button("Anywhere") { model.scope = .all }
                    ForEach(workspace.files.everyFolder().filter { workspace.place(of: $0) != .nowhere }, id: \.self) { folder in
                        Button(folder) { model.scope = .folder(folder) }
                    }
                } label: {
                    if case .folder(let folder) = model.scope {
                        chipLabel("In \(DocLinks.name(of: folder))", on: true, chevron: true)
                    } else {
                        chipLabel("Anywhere", on: false, chevron: true)
                    }
                }
                .accessibilityIdentifier("scope-folder")
            }
            .padding(.horizontal, 16)
        }
    }

    private func chip(_ label: String, on: Bool, run: @escaping () -> Void) -> some View {
        Button(action: run) { chipLabel(label, on: on, chevron: false) }
            .buttonStyle(.plain)
            .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func chipLabel(_ label: String, on: Bool, chevron: Bool) -> some View {
        HStack(spacing: 4) {
            Text(label)
            if chevron { Image(systemName: "chevron.down").font(.caption2.weight(.semibold)) }
        }
        .font(.subheadline.weight(.medium))
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .foregroundStyle(on ? Theme.sheet : Theme.text1)
        .background(on ? Theme.text1 : Theme.sunken, in: Capsule())
    }

    @ViewBuilder private var state: some View {
        if query.trimmingCharacters(in: .whitespaces).isEmpty {
            if recents.isEmpty {
                ContentUnavailableView(
                    "Search \(workspace.name)",
                    systemImage: "magnifyingglass",
                    description: Text(TagWords.searchHint(workspace.tagList))
                )
            }
        } else {
            switch model.phase {
            case .loading where model.results.isEmpty:
                ProgressView()
            case .loaded where model.isEmpty:
                ContentUnavailableView.search(text: query)
            default:
                EmptyView()
            }
        }
    }
}

/// A document found by its name.
private struct NameResult: View {
    let result: SearchResult
    let workspace: Workspace

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: FileKind.of(result.path) == .html ? "doc.richtext" : "doc.text")
                .font(.title3)
                .foregroundStyle(Theme.text2)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(result.name)
                        .foregroundStyle(Theme.text1)
                    if FileKind.of(result.path) == .html {
                        Text("Page")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Theme.text2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Theme.sunken, in: Capsule())
                    }
                }
                Text(place)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }

    private var place: String {
        let folder = DocLinks.directory(of: result.path)
        let where_ = folder.replacingOccurrences(of: "/", with: " › ")
        guard let changed = workspace.recentItem(result.path)?.changed else { return where_ }
        let when = Date(timeIntervalSince1970: Double(changed) / 1000).formatted(.relative(presentation: .named))
        return "\(where_) · edited \(when)"
    }
}

/// A note found by its words: the words around the first place they are.
private struct TextResult: View {
    let result: SearchResult
    let query: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(result.name)
                    .foregroundStyle(Theme.text1)
                Spacer()
                Text("\(result.hits.count) match\(result.hits.count == 1 ? "" : "es")")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
            }
            let folder = DocLinks.directory(of: result.path)
            if !folder.isEmpty {
                Text(folder.replacingOccurrences(of: "/", with: " › "))
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
            }
            if let hit = result.hits.first {
                let snippet = SearchSnippet.around(query, in: hit.preview)
                (Text(snippet.before) + Text(snippet.match).bold().foregroundColor(Theme.text1) + Text(snippet.after))
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}

/// A document's first screen, for a press and hold: the note as it reads,
/// or the page.
struct DocumentPeek: View {
    let workspace: Workspace
    let path: String
    var find: String?

    var body: some View {
        Group {
            if FileKind.of(path) == .html {
                HTMLView(html: (try? workspace.files.text(path)) ?? "")
            } else if let text = try? workspace.files.text(path) {
                let document = MarkdownDocument.parse(text)
                ScrollView {
                    MarkdownView(document: document, file: path, workspace: workspace)
                        .padding(20)
                        .environment(\.readerMarks, ReaderMarks(find: find.map { Find.occurrences(of: $0, in: document) }))
                }
                .background(Theme.sheet)
            } else {
                ContentUnavailableView("Could not read this", systemImage: "exclamationmark.triangle")
            }
        }
        .frame(width: 360, height: 520)
    }
}

/// Tags in the search's words.
enum TagWords {
    /// What a search's tags are, as a heading says them: "status: Doing".
    static func filters(_ tags: [TagFilter]) -> String {
        tags.map { tag in tag.value.map { "\(tag.name): \($0)" } ?? tag.name }.joined(separator: ", ")
    }

    /// What can be searched for, with a tag the workspace has to show how.
    static func searchHint(_ list: [TagDef]) -> String {
        guard let def = list.first, let value = def.values.first else {
            return "Type part of a name, or a few words that are in a note."
        }
        let quote = { (s: String) in s.contains(" ") ? "\"\(s)\"" : s }
        return "Type part of a name, a few words that are in a note, or a tag, as \(quote(def.name)):\(quote(value))."
    }
}
