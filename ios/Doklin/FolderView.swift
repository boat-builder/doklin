import DoklinKit
import SwiftUI

/// What a folder holds. A row opens; a long press or a swipe renames, moves
/// or removes — each through the same call the `doklin` command makes.
struct FolderView: View {
    @Binding var path: [Route]
    @State private var model: FolderModel
    @State private var naming = false
    @State private var newName = ""
    @State private var renaming: FolderEntry?
    @State private var moving: FolderEntry?
    @State private var removing: FolderEntry?
    @State private var failure: String?

    init(session: Session, dir: String, path: Binding<[Route]>) {
        _path = path
        _model = State(initialValue: FolderModel(session: session, dir: dir))
    }

    private var session: Session { model.session }

    var body: some View {
        List {
            if let notice = model.notice {
                Section {
                    NoticeBar(text: notice)
                        .listRowInsets(EdgeInsets())
                }
            }
            ForEach(model.entries) { entry in
                NavigationLink(value: route(for: entry)) {
                    EntryRow(entry: entry, audience: session.audience(of: entry.path))
                }
                .accessibilityIdentifier("entry-\(entry.name)")
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    if session.may(.edit), movable(entry) {
                        if !isFolder(entry) {
                            Button(role: .destructive) {
                                removing = entry
                            } label: {
                                Label("Remove", systemImage: "trash")
                            }
                        }
                        Button {
                            moving = entry
                        } label: {
                            Label("Move", systemImage: "folder")
                        }
                        .tint(Theme.accent)
                    }
                }
                .contextMenu {
                    if session.may(.edit), movable(entry) {
                        Button {
                            newName = entry.name
                            renaming = entry
                        } label: {
                            Label("Rename", systemImage: "pencil")
                        }
                        Button {
                            moving = entry
                        } label: {
                            Label("Move…", systemImage: "folder")
                        }
                        if !isFolder(entry) {
                            Button(role: .destructive) {
                                removing = entry
                            } label: {
                                Label("Remove", systemImage: "trash")
                            }
                        }
                    }
                    ForEach(entry.addresses, id: \.self) { address in
                        if let url = URL(string: address) {
                            ShareLink(item: url) {
                                Label("Share public link", systemImage: "globe")
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay { emptiness }
        .navigationTitle(model.title)
        .navigationBarTitleDisplayMode(model.dir.isEmpty ? .large : .inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    path.append(.search)
                } label: {
                    Label("Search", systemImage: "magnifyingglass")
                }
                if session.may(.edit), canHoldNotes {
                    Button {
                        newName = ""
                        naming = true
                    } label: {
                        Label("New note", systemImage: "square.and.pencil")
                    }
                }
            }
        }
        .refreshable { await model.load() }
        .task(id: session.stamp) { await model.load() }
        .alert("New note", isPresented: $naming) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Create") { create() }
        } message: {
            Text(whoSeesNew)
        }
        .alert("Rename", isPresented: renamingShown) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Rename") { rename() }
        }
        .confirmationDialog(
            "Remove \(removing?.name ?? "")?",
            isPresented: removingShown,
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) { remove() }
            Button("Cancel", role: .cancel) { removing = nil }
        } message: {
            Text("It is removed from every Mac that syncs this workspace. A Mac's version history can bring it back.")
        }
        .sheet(item: $moving) { entry in
            MoveSheet(model: model, entry: entry) { message in failure = message }
        }
        .alert("That did not work", isPresented: failureShown) {
            Button("OK", role: .cancel) { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

    private var renamingShown: Binding<Bool> {
        Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })
    }

    private var removingShown: Binding<Bool> {
        Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
    }

    private var failureShown: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    @ViewBuilder private var emptiness: some View {
        switch model.phase {
        case .loading:
            ProgressView()
        case .failed(let message):
            ContentUnavailableView {
                Label("Could not open this folder", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") {
                    Task { await model.load() }
                }
            }
        case .loaded where model.entries.isEmpty:
            ContentUnavailableView(
                "Nothing here yet",
                systemImage: "tray",
                description: Text(session.may(.edit) && canHoldNotes ? "Make a note with the pencil above." : "This folder is empty.")
            )
        default:
            EmptyView()
        }
    }

    private func route(for entry: FolderEntry) -> Route {
        if case .folder(let dir) = entry { return .folder(dir) }
        return .document(entry.path)
    }

    private func isFolder(_ entry: FolderEntry) -> Bool {
        if case .folder = entry { return true }
        return false
    }

    /// A section of the workspace is not a folder to rename or move: only
    /// what is inside one is.
    private func movable(_ entry: FolderEntry) -> Bool {
        guard isFolder(entry) else { return true }
        switch session.audience(of: entry.path) {
        case .everyone: return true
        case .folders: return false
        case .onlyYou, .folder: return entry.path.lowercased() != sectionRoot(of: entry.path)
        }
    }

    /// The folder a section starts at, for a path inside one.
    private func sectionRoot(of path: String) -> String {
        let lower = path.lowercased()
        for mount in session.me?.sections ?? [] where lower == mount.lowercased() || lower.hasPrefix(mount.lowercased() + "/") {
            return mount.lowercased()
        }
        return ""
    }

    /// Nothing syncs from directly under the folder that holds the restricted folders.
    private var canHoldNotes: Bool { session.audience(of: model.dir) != .folders }

    private var whoSeesNew: String {
        switch session.audience(of: model.dir) {
        case .everyone: return "Everyone in \(session.account.workspace) will see it."
        case .onlyYou: return "Only you will see it."
        case .folder(let name): return "The people of \(name) will see it."
        case .folders: return ""
        }
    }

    private func create() {
        let name = newName
        Task {
            do {
                let made = try await model.createNote(named: name)
                path.append(.document(made))
            } catch {
                failure = session.explain(error)
            }
        }
    }

    private func rename() {
        guard let entry = renaming else { return }
        let name = newName
        renaming = nil
        Task {
            do {
                try await model.rename(entry, to: name)
            } catch {
                failure = session.explain(error)
            }
        }
    }

    private func remove() {
        guard let entry = removing else { return }
        removing = nil
        Task {
            do {
                let answer = try await model.remove(entry)
                if let still = answer.stillPublic, !still.isEmpty {
                    failure = "\(entry.name) is removed, and its public address is still held: \(still.joined(separator: ", ")). Stop it under Published pages."
                }
            } catch {
                failure = session.explain(error)
            }
        }
    }
}

private struct EntryRow: View {
    let entry: FolderEntry
    let audience: Audience

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(tint)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .foregroundStyle(Theme.text1)
                    .lineLimit(2)
                if let detail {
                    detail
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                }
            }
            Spacer(minLength: 0)
            if !entry.addresses.isEmpty {
                Image(systemName: "globe")
                    .font(.footnote)
                    .foregroundStyle(Theme.live)
                    .accessibilityLabel("Published")
            }
        }
        .padding(.vertical, 2)
    }

    private var isSectionRow: Bool {
        if case .folder = entry { return audience != .everyone }
        return false
    }

    private var icon: String {
        switch entry {
        case .folder:
            switch audience {
            case .everyone: return "folder"
            case .onlyYou: return "lock"
            case .folder, .folders: return "person.2"
            }
        case .document(let row):
            return row.md == nil ? "doc.richtext" : "doc.text"
        case .file(let row):
            switch FileKind.of(row.path) {
            case .image: return "photo"
            case .pdf: return "doc.viewfinder"
            case .text: return "doc.plaintext"
            case .other: return "doc"
            }
        }
    }

    private var tint: Color {
        if case .folder = entry { return Theme.accent }
        return Theme.text2
    }

    private var detail: Text? {
        switch entry {
        case .folder:
            switch audience {
            case .everyone: return nil
            case .onlyYou: return Text("Only you")
            case .folder(let name): return isSectionRow ? Text("Only the people of \(name)") : nil
            case .folders: return Text("Folders with their own people")
            }
        case .document(let row):
            let page = row.html != nil && row.md != nil ? Text(" · with a page") : Text("")
            if let changed = entry.changed {
                return Text(changed, format: .relative(presentation: .named)) + page
            }
            return row.html != nil && row.md == nil ? Text("Page") : nil
        case .file(let row):
            let size = Text(Int64(row.size), format: .byteCount(style: .file))
            if let changed = entry.changed {
                return Text(changed, format: .relative(presentation: .named)) + Text(" · ") + size
            }
            return size
        }
    }
}

/// Choosing the folder something moves into.
private struct MoveSheet: View {
    let model: FolderModel
    let entry: FolderEntry
    let failed: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var folders: [String]?
    @State private var problem: String?
    @State private var working = false

    var body: some View {
        NavigationStack {
            List {
                if let folders {
                    Button {
                        move(into: "")
                    } label: {
                        Label(model.session.account.workspace, systemImage: "tray.full")
                    }
                    ForEach(folders.filter(allowed), id: \.self) { folder in
                        Button {
                            move(into: folder)
                        } label: {
                            Label(folder, systemImage: "folder")
                        }
                    }
                } else if let problem {
                    Text(problem).foregroundStyle(Theme.errorInk)
                } else {
                    ProgressView()
                }
            }
            .disabled(working)
            .navigationTitle("Move \(entry.name) to")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task {
                do {
                    folders = try await model.everyFolder()
                } catch {
                    problem = model.session.explain(error)
                }
            }
        }
    }

    /// Not where it already is, not itself, and not the folder that only holds other folders.
    private func allowed(_ folder: String) -> Bool {
        if folder == DocLinks.directory(of: entry.path) { return false }
        if case .folder(let own) = entry, folder == own || folder.hasPrefix(own + "/") { return false }
        return model.session.audience(of: folder) != .folders
    }

    private func move(into folder: String) {
        working = true
        Task {
            do {
                let unpublished = try await model.move(entry, into: folder)
                if !unpublished.isEmpty {
                    failed("It moved, and these addresses stopped being public: \(unpublished.joined(separator: ", ")).")
                }
            } catch {
                if let message = model.session.explain(error) { failed(message) }
            }
            dismiss()
        }
    }
}
