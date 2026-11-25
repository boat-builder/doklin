import DoklinKit
import SwiftUI

/// What can be done to a row of a folder or of the tree — make, rename,
/// move, remove, restrict, share, publish — and the questions each asks.
/// Every change is made here first and reaches every other device through
/// sync. A screen hosts it once (`EntryActionsHost`); its rows offer it
/// (`EntryMenu`, `EntrySwipes`).
@MainActor
@Observable
final class EntryActing {
    /// A note to make, and where (workspace-relative): it is made at once,
    /// "Untitled", and opens to be named by its title.
    var makingNote: String?
    /// A folder being made, and where: its name is asked first.
    var creatingFolder: String?
    var newName = ""
    var renaming: FolderEntry?
    var moving: FolderEntry?
    var removing: FolderEntry?
    var restricting: RestrictedSource?
    var publishing: PublishTarget?
    var failure: String?

    func newNote(in dir: String) {
        makingNote = dir
    }

    func newFolder(in dir: String) {
        newName = ""
        creatingFolder = dir
    }

    func rename(_ entry: FolderEntry) {
        newName = entry.name
        renaming = entry
    }
}

/// The model a row's change goes through: the folder it is in.
@MainActor
private func folder(of entry: FolderEntry, in workspace: Workspace) -> FolderModel {
    FolderModel(workspace: workspace, dir: DocLinks.directory(of: entry.path))
}

/// The questions and sheets of `EntryActing`, over one screen.
struct EntryActionsHost: ViewModifier {
    let workspace: Workspace
    let acting: EntryActing
    /// Somewhere to go: a note just made, a restricted folder, Published pages.
    let open: (Route) -> Void

    func body(content: Content) -> some View {
        @Bindable var acting = acting
        return content
            .environment(acting)
            .onChange(of: acting.makingNote) { _, dir in
                if let dir { makeNote(in: dir) }
            }
            .alert("New folder", isPresented: shown(\.creatingFolder)) {
                TextField("Name", text: $acting.newName)
                    .accessibilityIdentifier("new-name")
                Button("Cancel", role: .cancel) { acting.creatingFolder = nil }
                Button("Create") { createFolder() }
            } message: {
                if let dir = acting.creatingFolder, let who = FolderModel(workspace: workspace, dir: dir).whoSeesNew { Text(who) }
            }
            .alert("Rename", isPresented: shown(\.renaming)) {
                TextField("Name", text: $acting.newName)
                Button("Cancel", role: .cancel) { acting.renaming = nil }
                Button("Rename") { rename() }
            } message: {
                if let renaming = acting.renaming, workspace.restrictedFolder(at: renaming.path) != nil {
                    Text("It is renamed for everyone in it.")
                }
            }
            .confirmationDialog(
                "Remove \(acting.removing?.name ?? "")?",
                isPresented: shown(\.removing),
                titleVisibility: .visible
            ) {
                Button("Remove", role: .destructive) { remove() }
                Button("Cancel", role: .cancel) { acting.removing = nil }
            } message: {
                Text(removingWords)
            }
            .sheet(item: $acting.moving) { entry in
                MoveSheet(model: folder(of: entry, in: workspace), entry: entry) { message in acting.failure = message }
            }
            .sheet(item: $acting.restricting) { source in
                RestrictedFolderSheet(workspace: workspace, source: source) { made in open(.folder(made)) }
            }
            .sheet(item: $acting.publishing) { target in
                PublishView(workspace: workspace, path: target.path, kind: target.kind) { open(.publishedPages) }
            }
            .alert("That did not work", isPresented: shown(\.failure)) {
                Button("OK", role: .cancel) { acting.failure = nil }
            } message: {
                Text(acting.failure ?? "")
            }
    }

    private func shown<T>(_ key: ReferenceWritableKeyPath<EntryActing, T?>) -> Binding<Bool> {
        Binding(get: { acting[keyPath: key] != nil }, set: { if !$0 { acting[keyPath: key] = nil } })
    }

    private var removingWords: String {
        if case .folder(let dir) = acting.removing {
            let count = workspace.files.count(under: dir)
            return count == 0 ? "The folder is empty." : "The \(count) file\(count == 1 ? "" : "s") in it go from every device that has \(workspace.name). History keeps them, under Recently deleted."
        }
        return "It goes from every device that has \(workspace.name). Its history keeps it, under Recently deleted."
    }

    private func makeNote(in dir: String) {
        acting.makingNote = nil
        Task {
            do {
                open(.made(try await FolderModel(workspace: workspace, dir: dir).createNote()))
            } catch {
                acting.failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
    }

    private func createFolder() {
        guard let dir = acting.creatingFolder else { return }
        let name = acting.newName
        acting.creatingFolder = nil
        Task {
            do {
                _ = try await FolderModel(workspace: workspace, dir: dir).createFolder(named: name)
            } catch {
                acting.failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
    }

    private func rename() {
        guard let entry = acting.renaming else { return }
        let name = acting.newName
        acting.renaming = nil
        Task {
            do {
                try await folder(of: entry, in: workspace).rename(entry, to: name)
            } catch {
                acting.failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
    }

    private func remove() {
        guard let entry = acting.removing else { return }
        acting.removing = nil
        Task {
            do {
                try await folder(of: entry, in: workspace).remove(entry)
            } catch {
                acting.failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
    }
}

/// A row's long press: what can be done to it here.
struct EntryMenu: View {
    let entry: FolderEntry
    let workspace: Workspace
    let open: (Route) -> Void

    @Environment(EntryActing.self) private var acting

    var body: some View {
        let model = folder(of: entry, in: workspace)
        let mayChange = workspace.may("work")
        if case .folder(let dir) = entry, mayChange, FolderModel(workspace: workspace, dir: dir).canHoldNotes {
            Button {
                acting.newNote(in: dir)
            } label: {
                Label("New note here", systemImage: "square.and.pencil")
            }
            Button {
                acting.newFolder(in: dir)
            } label: {
                Label("New folder here", systemImage: "folder.badge.plus")
            }
        }
        if mayChange, model.renamable(entry) {
            Button {
                acting.rename(entry)
            } label: {
                Label("Rename", systemImage: "pencil")
            }
        }
        if mayChange, !model.isManaged(entry) {
            Button {
                acting.moving = entry
            } label: {
                Label("Move…", systemImage: "folder")
            }
            Button(role: .destructive) {
                acting.removing = entry
            } label: {
                Label("Remove", systemImage: "trash")
            }
        }
        if let space = workspace.restrictedFolder(at: entry.path) {
            Button {
                open(.access(space.id))
            } label: {
                Label("Manage access…", systemImage: "person.2")
            }
        }
        if model.restrictable(entry) {
            Button {
                acting.restricting = .folder(entry.path)
            } label: {
                Label("Restrict access…", systemImage: "lock")
            }
        }
        if model.shareable(entry) {
            Button {
                acting.restricting = .note(entry.path)
            } label: {
                Label("Share with…", systemImage: "person.crop.circle.badge.plus")
            }
        }
        if case .folder(let dir) = entry, workspace.mayPublish, workspace.status != nil, workspace.audience(of: dir) != .nowhere {
            Button {
                acting.publishing = PublishTarget(path: dir, kind: .dir)
            } label: {
                let published = workspace.pages(of: dir).contains { $0.kind == .dir }
                Label(published ? "Edit publishing…" : "Publish folder…", systemImage: "globe")
            }
        }
    }
}

/// A row's swipe: remove, or move.
struct EntrySwipes: View {
    let entry: FolderEntry
    let workspace: Workspace

    @Environment(EntryActing.self) private var acting

    var body: some View {
        if workspace.may("work"), !folder(of: entry, in: workspace).isManaged(entry) {
            Button(role: .destructive) {
                acting.removing = entry
            } label: {
                Label("Remove", systemImage: "trash")
            }
            Button {
                acting.moving = entry
            } label: {
                Label("Move", systemImage: "folder")
            }
            .tint(Theme.accent)
        }
    }
}

/// Choosing the folder something moves into — and, when more people would
/// see it there, saying so first.
struct MoveSheet: View {
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
                    choose(TreeModel.libraryFolder)
                } label: {
                    Label("Library", systemImage: "books.vertical")
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
                widening.map { model.wideningTitle(entry, into: $0.folder) } ?? "",
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

    /// Not Library itself, which is the top choice; not where it already
    /// is, not itself; not the folder that only holds other folders, and
    /// nowhere in no section, which would take it off every other device.
    private func allowed(_ folder: String) -> Bool {
        if folder.lowercased() == TreeModel.libraryFolder.lowercased() { return false }
        if folder == DocLinks.directory(of: entry.path) { return false }
        if case .folder(let own) = entry, folder == own || folder.hasPrefix(own + "/") { return false }
        let audience = model.workspace.audience(of: folder)
        return audience != .folders && audience != .nowhere
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
