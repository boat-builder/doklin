import DoklinKit
import SwiftUI

/// The Browse tab: the tree, with a document pushed over it — or, on an
/// iPad's full width, the tree beside the document.
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
/// it, sections as the Mac's sidebar has them. What is open is kept.
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
                ForEach(tree.groups) { group in
                    Section {
                        ForEach(group.rows) { row in
                            TreeRowView(row: row, workspace: workspace, chosen: chosen?.lowercased() == row.id) {
                                tap(row)
                            }
                            .id(row.id)
                            .accessibilityIdentifier("entry-\(row.entry.name)")
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                EntrySwipes(entry: row.entry, workspace: workspace)
                            }
                            .contextMenu {
                                EntryMenu(entry: row.entry, workspace: workspace) { path.append($0) }
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
                        if workspace.mayRestrict {
                            Button {
                                acting.restricting = .new
                            } label: {
                                Label("New restricted folder", systemImage: "folder.badge.person.crop")
                            }
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
        .modifier(EntryActionsHost(workspace: workspace, acting: acting) { route in
            if case .document(let file) = route { open(file) } else { path.append(route) }
        })
    }

    private var filter: Binding<String> {
        Binding(get: { tree.filter }, set: { tree.filter = $0 })
    }

    private func tap(_ row: TreeRow) {
        switch row.entry {
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
            case .restricted:
                Image(systemName: "person.2")
                Text("Restricted")
                if workspace.mayRestrict {
                    Spacer()
                    Button {
                        acting.restricting = .new
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New restricted folder")
                    .accessibilityIdentifier("new-restricted")
                }
            case .personal:
                Image(systemName: "lock")
                Text("Private")
                if workspace.may("work") {
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
                    .accessibilityLabel("New in Private")
                    .accessibilityIdentifier("new-private")
                }
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
            return "These are in no section, so they stay on this iPhone. Move them into Library or Private to sync them."
        }
        guard group.rows.isEmpty, !tree.isFiltering else { return nil }
        switch group.section {
        case .library: return "No documents yet. Make one with the plus above."
        case .restricted: return "Folders only the people you choose can open."
        case .personal: return "Only you can see what you put here."
        case .nowhere: return nil
        }
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
/// chevron, a document with when it changed.
struct TreeRowView: View {
    let row: TreeRow
    let workspace: Workspace
    let chosen: Bool
    let tap: () -> Void

    var body: some View {
        Button(action: tap) {
            HStack(spacing: 8) {
                if row.isFolder {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.text3)
                        .rotationEffect(.degrees(row.open ? 90 : 0))
                        .frame(width: 14)
                } else {
                    Color.clear.frame(width: 14, height: 1)
                }
                EntryIcon(entry: row.entry, audience: workspace.audience(of: row.entry.path))
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.entry.name)
                        .foregroundStyle(Theme.text1)
                        .lineLimit(1)
                    if let detail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(Theme.text3)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if !workspace.pages(of: row.entry.path).isEmpty {
                    Image(systemName: "globe")
                        .font(.footnote)
                        .foregroundStyle(Theme.live)
                        .accessibilityLabel("Published")
                }
            }
            .padding(.leading, CGFloat(row.depth) * 18)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(chosen ? Theme.accentWash : nil)
        .accessibilityAddTraits(row.isFolder ? [] : .isLink)
        .accessibilityValue(row.isFolder ? (row.open ? "Open" : "Closed") : "")
    }

    /// Whose a restricted folder is, or when a document changed.
    private var detail: String? {
        if let space = workspace.restrictedFolder(at: row.entry.path) {
            return "\(space.members.count) \(space.members.count == 1 ? "person" : "people")"
        }
        if case .document = row.entry, let changed = row.entry.modified {
            return changed.formatted(.relative(presentation: .named))
        }
        return nil
    }
}
