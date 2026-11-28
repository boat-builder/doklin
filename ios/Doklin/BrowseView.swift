import DoklinKit
import SwiftUI

/// The Browse tab, the first: the tree, with a document pushed over it — or,
/// on an iPad's full width, the tree beside the document.
struct BrowseTab: View {
    let workspace: Workspace
    @Binding var path: [Route]

    @Environment(\.horizontalSizeClass) private var width
    /// The document beside the tree, on a wide screen.
    @State private var beside: String?

    var body: some View {
        if width == .regular {
            NavigationSplitView {
                BrowseView(workspace: workspace, path: $path, chosen: beside) { file in
                    beside = file
                    path = []
                }
            } detail: {
                NavigationStack(path: $path) {
                    Group {
                        if let beside {
                            DocumentView(workspace: workspace, path: beside, route: $path)
                                .id(beside)
                        } else {
                            ContentUnavailableView("Choose a document", systemImage: "doc.text", description: Text("Pick one in the tree to read it here."))
                        }
                    }
                    .destinations(workspace, path: $path)
                }
            }
        } else {
            NavigationStack(path: $path) {
                BrowseView(workspace: workspace, path: $path, chosen: nil) { file in path.append(.document(file)) }
                    .destinations(workspace, path: $path)
            }
        }
    }
}

/// The workspace as one tree: folders open in place, documents open over
/// it, under the Mac sidebar's three headings — Library, My files, Shared
/// with me. What is open is kept. The workspace's name, top left, switches
/// workspaces and leads to its settings; how sync stands is the quiet line
/// under it.
struct BrowseView: View {
    let workspace: Workspace
    @Binding var path: [Route]
    /// The document shown beside the tree, on a wide screen.
    let chosen: String?
    let open: (String) -> Void

    @Environment(Shell.self) private var shell
    @State private var tree: TreeModel
    @State private var acting = EntryActing()

    init(workspace: Workspace, path: Binding<[Route]>, chosen: String?, open: @escaping (String) -> Void) {
        self.workspace = workspace
        _path = path
        self.chosen = chosen
        self.open = open
        _tree = State(initialValue: TreeModel(workspace: workspace))
    }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                Section {
                    SyncQuietLine(workspace: workspace)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
                ForEach(tree.groups) { group in
                    Section {
                        ForEach(group.rows) { row in
                            TreeRowView(row: row, workspace: workspace, chosen: chosen?.lowercased() == row.id) {
                                tap(row)
                            } toggle: {
                                withAnimation(.snappy(duration: 0.2)) { tree.toggle(row.entry.path) }
                            }
                            .id(row.id)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                EntrySwipes(entry: row.entry, workspace: workspace)
                            }
                            .contextMenu {
                                EntryMenu(entry: row.entry, workspace: workspace)
                            }
                        }
                        if let words = footnote(group) {
                            Text(words)
                                .font(.footnote)
                                .foregroundStyle(Theme.text3)
                        }
                    } header: {
                        header(group)
                    }
                }
            }
            .listStyle(.sidebar)
            .onChange(of: shell.revealing, initial: true) { _, revealing in
                guard let revealing else { return }
                tree.reveal(revealing)
                shell.revealing = nil
                withAnimation { proxy.scrollTo(revealing.lowercased(), anchor: .center) }
            }
        }
        .overlay { emptiness }
        .navigationTitle("Browse")
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: filter, placement: .navigationBarDrawer(displayMode: .always), prompt: "Filter the tree")
        .textInputAutocapitalization(.never)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                WorkspaceMenuButton(workspace: workspace)
            }
            if workspace.may("work") {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            acting.newNote(in: TreeModel.libraryFolder)
                        } label: {
                            Label("New note", systemImage: "square.and.pencil")
                        }
                        Button {
                            acting.newFolder(in: TreeModel.libraryFolder)
                        } label: {
                            Label("New folder", systemImage: "folder.badge.plus")
                        }
                    } label: {
                        Label("New", systemImage: "plus")
                    }
                    .accessibilityIdentifier("new")
                }
            }
        }
        .refreshable { await workspace.syncNow() }
        .onAppear { tree.load() }
        .onChange(of: workspace.changes) { tree.load() }
        // Also what sync moved before the tree was on screen, as just after launch.
        .onChange(of: workspace.relocated, initial: true) { _, moved in
            if let moved { tree.follow(moved.moves) }
        }
        .modifier(EntryActionsHost(workspace: workspace, acting: acting) { route in
            if case .document(let file) = route { open(file) } else { path.append(route) }
        })
    }

    private var filter: Binding<String> {
        Binding(get: { tree.filter }, set: { tree.filter = $0 })
    }

    /// A folder opens in place — or, shown as a board, opens its board; its
    /// chevron still opens the folder (`toggle`).
    private func tap(_ row: TreeRow) {
        switch row.entry {
        case .folder(let dir) where row.board:
            if path.last != .board(dir) { path.append(.board(dir)) }
        case .folder(let dir):
            withAnimation(.snappy(duration: 0.2)) { tree.toggle(dir) }
        case .document, .file:
            open(row.entry.path)
        }
    }

    private func header(_ group: TreeGroup) -> some View {
        HStack(spacing: 6) {
            switch group.section {
            case .library:
                Image(systemName: "books.vertical")
                Text("Library")
            case .mine:
                Image(systemName: "person")
                Text("My files")
                // Before the domain has said this is their My files, nothing made here would sync.
                if workspace.may("work"), workspace.myFiles != nil {
                    Spacer()
                    Menu {
                        Button {
                            acting.newNote(in: group.folder)
                        } label: {
                            Label("New note", systemImage: "square.and.pencil")
                        }
                        Button {
                            acting.newFolder(in: group.folder)
                        } label: {
                            Label("New folder", systemImage: "folder.badge.plus")
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New in My files")
                    .accessibilityIdentifier("new-mine")
                }
            case .shared:
                // What others shared with this person: nothing is made here.
                Image(systemName: "person.2")
                Text("Shared with me")
            case .nowhere:
                Image(systemName: "icloud.slash")
                Text("In no section")
            }
        }
    }

    /// The line under a group: what an empty section is for, and why what
    /// is in none stays here.
    private func footnote(_ group: TreeGroup) -> String? {
        if group.section == .nowhere {
            return "These are in no section, so they stay on this iPhone. Move them into Library or My files to sync them."
        }
        guard group.rows.isEmpty, !tree.isFiltering else { return nil }
        return group.section.emptyHint
    }

    @ViewBuilder private var emptiness: some View {
        if case .failed(let message) = tree.phase {
            ContentUnavailableView("Could not read the workspace", systemImage: "exclamationmark.triangle", description: Text(message))
        } else if tree.isFiltering, tree.groups.isEmpty {
            ContentUnavailableView {
                Label("Nothing in the tree is called that", systemImage: "line.3.horizontal.decrease.circle")
            } description: {
                Text("Search looks inside documents too.")
            } actions: {
                Button("Search for “\(tree.filter)”") { shell.tab = .search }
            }
        }
    }
}

/// One row of the tree: indented by how deep it is, a folder with its
/// chevron, a document with when it changed, something shared with its mark.
/// A folder shown as a board opens its board; its chevron is a button of its
/// own, which opens the folder.
struct TreeRowView: View {
    let row: TreeRow
    let workspace: Workspace
    let chosen: Bool
    let tap: () -> Void
    /// Open or shut the folder, from a board folder's chevron.
    let toggle: () -> Void

    var body: some View {
        if row.board {
            HStack(spacing: 0) {
                Button(action: toggle) {
                    chevron
                        .frame(width: 22, height: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(row.open ? "Close the folder \(row.entry.name)" : "Open the folder \(row.entry.name)")
                .accessibilityIdentifier("chevron-\(row.entry.name)")
                Button(action: tap) {
                    label(withChevron: false)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isLink)
                .accessibilityValue("Board")
                .accessibilityIdentifier("entry-\(row.entry.name)")
            }
            .padding(.leading, CGFloat(row.depth) * 18)
            .listRowBackground(chosen ? Theme.accentWash : nil)
        } else {
            Button(action: tap) {
                label(withChevron: true)
                    .padding(.leading, CGFloat(row.depth) * 18)
            }
            .buttonStyle(.plain)
            .listRowBackground(chosen ? Theme.accentWash : nil)
            .accessibilityAddTraits(row.isFolder ? [] : .isLink)
            .accessibilityValue(row.isFolder ? (row.open ? "Open" : "Closed") : "")
            .accessibilityIdentifier("entry-\(row.entry.name)")
        }
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.caption.weight(.semibold))
            .foregroundStyle(Theme.text3)
            .rotationEffect(.degrees(row.open ? 90 : 0))
            .frame(width: 14)
    }

    private func label(withChevron: Bool) -> some View {
        let share = workspace.share(row.entry)
        let place = workspace.place(of: row.entry.path)
        return HStack(spacing: 8) {
                if withChevron {
                    if row.isFolder {
                        chevron
                    } else {
                        Color.clear.frame(width: 14, height: 1)
                    }
                }
                EntryIcon(entry: row.entry, synced: place != .nowhere, board: row.board)
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.entry.name)
                        .foregroundStyle(Theme.text1)
                        .lineLimit(1)
                    if let detail = detail(share: share, place: place) {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(Theme.text3)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                if share != nil {
                    // The mark of something shared; the line under its name says with whom.
                    Image(systemName: "person.2.fill")
                        .font(.caption)
                        .foregroundStyle(Theme.text3)
                        .accessibilityHidden(true)
                }
                if !workspace.pages(of: row.entry.path).isEmpty {
                    Image(systemName: "globe")
                        .font(.footnote)
                        .foregroundStyle(Theme.live)
                        .accessibilityLabel("Published")
                }
            }
            .contentShape(Rectangle())
    }

    /// Who something shared is shared with, why a row at the top of a
    /// section syncs nowhere — what is in no section at all says so once,
    /// under its group — or when a document changed.
    private func detail(share: SpaceStatus?, place: Place) -> String? {
        if let share { return ShareWords.mark(share) }
        if place == .nowhere, row.depth == 0, row.entry.path.contains("/") { return Sections.notSyncedLine(row.entry.path) }
        if case .document = row.entry, let changed = row.entry.modified {
            return changed.formatted(.relative(presentation: .named))
        }
        return nil
    }
}

/// What a row is, at a glance: a folder, a note, a page, a file — and
/// whether it syncs.
struct EntryIcon: View {
    let entry: FolderEntry
    /// In a section: what is in none stays on this iPhone.
    let synced: Bool
    /// A folder shown as a board.
    var board = false

    var body: some View {
        Image(systemName: symbol)
            .font(.title3)
            .foregroundStyle(tint)
            .frame(width: 28)
            .accessibilityHidden(true)
    }

    private var symbol: String {
        switch entry {
        case .folder:
            return synced ? (board ? "rectangle.split.3x1" : "folder") : "icloud.slash"
        case .document(let row):
            return row.isHTML ? "doc.richtext" : "doc.text"
        case .file(let row):
            switch FileKind.of(row.path) {
            case .image: return "photo"
            case .pdf: return "doc.viewfinder"
            case .text: return "doc.plaintext"
            default: return "doc"
            }
        }
    }

    private var tint: Color {
        if case .folder = entry { return Theme.accent }
        return Theme.text2
    }
}
