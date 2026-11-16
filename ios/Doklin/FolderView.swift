import DoklinKit
import SwiftUI

/// What one folder holds, on a screen of its own: where a restricted folder
/// just made, or its access screen, leads. Browse is the tree; this is one
/// branch of it. A row opens; a long press or a swipe renames, moves or
/// removes (`EntryActions`).
struct FolderView: View {
    @Binding var path: [Route]
    @State private var model: FolderModel
    @State private var acting = EntryActing()

    init(workspace: Workspace, dir: String, path: Binding<[Route]>) {
        _path = path
        _model = State(initialValue: FolderModel(workspace: workspace, dir: dir))
    }

    private var workspace: Workspace { model.workspace }
    private var mayChange: Bool { workspace.may("work") }

    var body: some View {
        List {
            ForEach(model.entries) { entry in
                NavigationLink(value: route(for: entry)) {
                    EntryRow(entry: entry, audience: workspace.audience(of: entry.path), published: !workspace.pages(of: entry.path).isEmpty)
                }
                .accessibilityIdentifier("entry-\(entry.name)")
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    EntrySwipes(entry: entry, workspace: workspace)
                }
                .contextMenu {
                    EntryMenu(entry: entry, workspace: workspace) { path.append($0) }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay { emptiness }
        .navigationTitle(model.title)
        .navigationBarTitleDisplayMode(model.dir.isEmpty ? .large : .inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if mayChange, model.canHoldNotes {
                    Menu {
                        Button {
                            acting.create(.note, in: model.dir)
                        } label: {
                            Label("New note", systemImage: "square.and.pencil")
                        }
                        Button {
                            acting.create(.folder, in: model.dir)
                        } label: {
                            Label("New folder", systemImage: "folder.badge.plus")
                        }
                        if model.dir.isEmpty, workspace.mayRestrict {
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
                if model.holdsRestrictedFolders, workspace.mayRestrict {
                    Button {
                        acting.restricting = .new
                    } label: {
                        Label("New restricted folder", systemImage: "plus")
                    }
                    .accessibilityIdentifier("new-restricted")
                }
                if let space = workspace.restrictedFolder(at: model.dir) {
                    Button {
                        path.append(.access(space.id))
                    } label: {
                        Label("Who can open this", systemImage: "person.2")
                    }
                    .accessibilityIdentifier("access")
                }
            }
        }
        .refreshable { await workspace.syncNow() }
        .onAppear { model.load() }
        .onChange(of: workspace.changes) { model.load() }
        .modifier(EntryActionsHost(workspace: workspace, acting: acting) { path.append($0) })
    }

    @ViewBuilder private var emptiness: some View {
        switch model.phase {
        case .failed(let message):
            ContentUnavailableView("Could not open this folder", systemImage: "exclamationmark.triangle", description: Text(message))
        case .loaded where model.entries.isEmpty:
            let next = !mayChange ? "This folder is empty."
                : model.canHoldNotes ? "Make a note with the plus above."
                : model.holdsRestrictedFolders && workspace.mayRestrict ? "Make one with the plus above."
                : "This folder is empty."
            ContentUnavailableView(
                "Nothing here yet",
                systemImage: "tray",
                description: Text(model.emptyHint.map { "\($0) \(next)" } ?? next)
            )
        default:
            EmptyView()
        }
    }

    private func route(for entry: FolderEntry) -> Route {
        if case .folder(let dir) = entry { return .folder(dir) }
        return .document(entry.path)
    }
}

struct EntryRow: View {
    let entry: FolderEntry
    let audience: Audience
    var published = false

    var body: some View {
        HStack(spacing: 12) {
            EntryIcon(entry: entry, audience: audience)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .foregroundStyle(Theme.text1)
                    .lineLimit(2)
                if let detail = EntryIcon.detail(entry, audience) {
                    detail
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                }
            }
            Spacer(minLength: 0)
            if published {
                Image(systemName: "globe")
                    .font(.footnote)
                    .foregroundStyle(Theme.live)
                    .accessibilityLabel("Published")
            }
        }
        .padding(.vertical, 2)
    }
}

/// What a row is, at a glance: a folder (and whose), a note, a page, a file.
struct EntryIcon: View {
    let entry: FolderEntry
    let audience: Audience

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
            switch audience {
            case .everyone: return "folder"
            case .onlyYou: return "lock"
            case .folder, .folders: return "person.2"
            case .nowhere: return "icloud.slash"
            }
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

    /// The line under a row's name: whose a folder is, when a document changed.
    static func detail(_ entry: FolderEntry, _ audience: Audience) -> Text? {
        switch entry {
        case .folder(let path):
            switch audience {
            case .everyone: return nil
            case .onlyYou: return path.contains("/") ? nil : Text("Only you")
            case .folder(let name): return path.split(separator: "/").count == 2 ? Text("Only the people of \(name)") : nil
            case .folders: return Text("Folders with their own people")
            case .nowhere: return Text("In no restricted folder, so it stays on this iPhone")
            }
        case .document(let row):
            let page = row.html != nil ? Text(" · with a page") : Text("")
            if let changed = entry.modified {
                return Text(changed, format: .relative(presentation: .named)) + page
            }
            return row.isHTML ? Text("Page") : nil
        case .file(let row):
            let size = Text(Int64(row.size), format: .byteCount(style: .file))
            if let changed = entry.modified {
                return Text(changed, format: .relative(presentation: .named)) + Text(" · ") + size
            }
            return size
        }
    }
}
