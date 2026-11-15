import DoklinKit
import SwiftUI

/// What a folder holds, on this iPhone. A row opens; a long press or a
/// swipe renames, moves or removes. Every change is made here first and
/// reaches every other device through sync.
struct FolderView: View {
    @Binding var path: [Route]
    @State private var model: FolderModel
    @State private var naming: NewThing?
    @State private var newName = ""
    @State private var renaming: FolderEntry?
    @State private var moving: FolderEntry?
    @State private var removing: FolderEntry?
    @State private var restricting: RestrictedSource?
    @State private var failure: String?

    enum NewThing { case note, folder }

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
                    if mayChange, !model.isManaged(entry) {
                        Button(role: .destructive) {
                            removing = entry
                        } label: {
                            Label("Remove", systemImage: "trash")
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
                    if mayChange, !model.isManaged(entry) {
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
                        Button(role: .destructive) {
                            removing = entry
                        } label: {
                            Label("Remove", systemImage: "trash")
                        }
                    }
                    if let space = workspace.restrictedFolder(at: entry.path) {
                        Button {
                            path.append(.access(space.id))
                        } label: {
                            Label("Manage access…", systemImage: "person.2")
                        }
                    }
                    if model.restrictable(entry) {
                        Button {
                            restricting = .folder(entry.path)
                        } label: {
                            Label("Restrict access…", systemImage: "lock")
                        }
                    }
                    if model.shareable(entry) {
                        Button {
                            restricting = .note(entry.path)
                        } label: {
                            Label("Share with…", systemImage: "person.crop.circle.badge.plus")
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
                if mayChange, model.canHoldNotes {
                    Menu {
                        Button {
                            newName = ""
                            naming = .note
                        } label: {
                            Label("New note", systemImage: "square.and.pencil")
                        }
                        Button {
                            newName = ""
                            naming = .folder
                        } label: {
                            Label("New folder", systemImage: "folder.badge.plus")
                        }
                        if model.dir.isEmpty, workspace.mayRestrict {
                            Button {
                                restricting = .new
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
                        restricting = .new
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
        .alert(naming == .folder ? "New folder" : "New note", isPresented: namingShown) {
            TextField("Name", text: $newName)
                .accessibilityIdentifier("new-name")
            Button("Cancel", role: .cancel) { naming = nil }
            Button("Create") { create() }
        } message: {
            if let who = model.whoSeesNew { Text(who) }
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
            Text(removingWords)
        }
        .sheet(item: $moving) { entry in
            MoveSheet(model: model, entry: entry) { message in failure = message }
        }
        .sheet(item: $restricting) { source in
            RestrictedFolderSheet(workspace: workspace, source: source) { folder in path.append(.folder(folder)) }
        }
        .alert("That did not work", isPresented: failureShown) {
            Button("OK", role: .cancel) { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

    private var namingShown: Binding<Bool> {
        Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })
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

    private var removingWords: String {
        let everywhere = "It goes from every device that has \(workspace.name). Its history keeps it, under Recently deleted."
        if case .folder(let dir) = removing {
            let count = workspace.files.count(under: dir)
            return count == 0 ? "The folder is empty." : "The \(count) file\(count == 1 ? "" : "s") in it go from every device that has \(workspace.name). The workspace's history keeps them, under Recently deleted."
        }
        return everywhere
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

    private func create() {
        let name = newName
        let what = naming
        naming = nil
        Task {
            do {
                if what == .folder {
                    _ = try await model.createFolder(named: name)
                } else {
                    path.append(.document(try await model.createNote(named: name)))
                }
            } catch {
                failure = (error as? DoklinError)?.message ?? error.localizedDescription
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
                failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
    }

    private func remove() {
        guard let entry = removing else { return }
        removing = nil
        Task {
            do {
                try await model.remove(entry)
            } catch {
                failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
    }
}

struct EntryRow: View {
    let entry: FolderEntry
    let audience: Audience
    var published = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(tint)
                .frame(width: 28)
                .accessibilityHidden(true)
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
            if published {
                Image(systemName: "globe")
                    .font(.footnote)
                    .foregroundStyle(Theme.live)
                    .accessibilityLabel("Published")
            }
        }
        .padding(.vertical, 2)
    }

    private var icon: String {
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

    private var detail: Text? {
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

/// Choosing the folder something moves into — and, when more people would
/// see it there, saying so first.
private struct MoveSheet: View {
    let model: FolderModel
    let entry: FolderEntry
    let failed: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var folders: [String] = []
    @State private var widening: (folder: String, words: String)?

    var body: some View {
        NavigationStack {
            List {
                Button {
                    choose("")
                } label: {
                    Label(model.workspace.name, systemImage: "tray.full")
                }
                ForEach(folders.filter(allowed), id: \.self) { folder in
                    Button {
                        choose(folder)
                    } label: {
                        Label(folder, systemImage: "folder")
                    }
                }
            }
            .navigationTitle("Move \(entry.name) to")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .onAppear { folders = model.workspace.files.everyFolder() }
            .confirmationDialog(
                "Move “\(entry.name)” to \(widening.map { $0.folder.isEmpty ? "the workspace" : "“\(DocLinks.name(of: $0.folder))”" } ?? "")?",
                isPresented: wideningShown,
                titleVisibility: .visible
            ) {
                Button("Move") {
                    if let folder = widening?.folder { move(into: folder) }
                }
                Button("Cancel", role: .cancel) { widening = nil }
            } message: {
                Text(widening?.words ?? "")
            }
        }
    }

    private var wideningShown: Binding<Bool> {
        Binding(get: { widening != nil }, set: { if !$0 { widening = nil } })
    }

    /// Not where it already is, not itself, and not the folder that only
    /// holds other folders.
    private func allowed(_ folder: String) -> Bool {
        if folder == DocLinks.directory(of: entry.path) { return false }
        if case .folder(let own) = entry, folder == own || folder.hasPrefix(own + "/") { return false }
        return model.workspace.audience(of: folder) != .folders
    }

    private func choose(_ folder: String) {
        if let words = model.widening(entry, into: folder) {
            widening = (folder, words)
        } else {
            move(into: folder)
        }
    }

    private func move(into folder: String) {
        Task {
            do {
                try await model.move(entry, into: folder)
            } catch {
                failed((error as? DoklinError)?.message ?? error.localizedDescription)
            }
            dismiss()
        }
    }
}
