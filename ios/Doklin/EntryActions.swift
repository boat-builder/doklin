import DoklinKit
import SwiftUI

/// What can be done to a row of the tree — make, rename, move, remove,
/// share, copy, publish — and the questions each asks. Every change is made
/// here first and reaches every other device through sync. A screen hosts it
/// once (`EntryActionsHost`); its rows offer it (`EntryMenu`, `EntrySwipes`).
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
    var sharing: ShareTarget?
    /// Something shared with this person, being copied into their My files.
    var copying: FolderEntry?
    /// Something shared about to be left, or deleted for everyone.
    var question: Question?
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

    /// Remove a row. Something shared is not removed like the rows beside
    /// it: whoever can open the folder it sits in deletes it for everyone it
    /// is shared with, and anyone else leaves it — asked first, naming who
    /// loses it. A folder that holds something shared is not removed around
    /// it either: each is deleted for everyone first, or the folder stays.
    func remove(_ entry: FolderEntry, in workspace: Workspace) {
        if let own = workspace.share(entry) {
            giveUp(own, in: workspace) {}
        } else if case .folder(let dir) = entry {
            empty(entry, of: Sections.shares(inside: dir, in: workspace.status), in: workspace)
        } else {
            removing = entry
        }
    }

    private func empty(_ folder: FolderEntry, of held: [SpaceStatus], in workspace: Workspace) {
        guard let next = held.first else {
            removing = folder
            return
        }
        giveUp(next, inside: folder.name, in: workspace) {
            // The next question, once this one has gone.
            try? await Task.sleep(nanoseconds: 400_000_000)
            self.empty(folder, of: Array(held.dropFirst()), in: workspace)
        }
    }

    private func giveUp(_ space: SpaceStatus, inside: String? = nil, in workspace: Workspace, then: @escaping () async -> Void) {
        guard let status = workspace.status else { return }
        let asked = Sections.deleteQuestion(space, inside: inside, in: status)
        question = Question(asked.title, asked.body, button: asked.button) {
            do {
                try await workspace.giveUp(space)
            } catch {
                self.failure = (error as? DoklinError)?.message ?? error.localizedDescription
                return
            }
            await then()
        }
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
    /// Somewhere to go: a note just made, a copy, Published pages.
    let open: (Route) -> Void

    @Environment(Toaster.self) private var toaster
    @Environment(Shell.self) private var shell

    func body(content: Content) -> some View {
        @Bindable var acting = acting
        return content
            .environment(acting)
            .onChange(of: acting.makingNote) { _, dir in
                if let dir { makeNote(in: dir) }
            }
            .onChange(of: acting.copying) { _, entry in
                if let entry { copyToMyFiles(entry) }
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
                if let renaming = acting.renaming, workspace.share(renaming) != nil {
                    Text("It is renamed for everyone who can open it.")
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
            .sheet(item: $acting.sharing) { target in
                ShareSheet(workspace: workspace, target: target)
            }
            .asking($acting.question)
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

    /// What was shared with this person, as a note or a folder of their own.
    private func copyToMyFiles(_ entry: FolderEntry) {
        acting.copying = nil
        Task {
            do {
                let copy = try await workspace.copyToMyFiles(entry)
                let action: Toaster.Action
                if case .folder = copy {
                    action = Toaster.Action(label: "Show") { shell.showInBrowse(copy.path) }
                } else {
                    action = Toaster.Action(label: "Open") { open(.document(copy.path)) }
                }
                toaster.show("Copied to My files as “\(copy.name)”.", action: action)
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

    @Environment(EntryActing.self) private var acting

    var body: some View {
        let model = folder(of: entry, in: workspace)
        let mayChange = workspace.may("work") && !model.isSection(entry)
        if case .folder(let dir) = entry, workspace.may("work"), FolderModel(workspace: workspace, dir: dir).canHoldNotes {
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
        if mayChange {
            Button {
                acting.rename(entry)
            } label: {
                Label("Rename", systemImage: "pencil")
            }
        }
        if mayChange, model.movable(entry) {
            Button {
                acting.moving = entry
            } label: {
                Label("Move…", systemImage: "folder")
            }
        }
        if let target = ShareTarget(entry), workspace.shareable(target) {
            Button {
                acting.sharing = target
            } label: {
                Label("Share…", systemImage: "person.crop.circle.badge.plus")
            }
        }
        if model.copiesToMyFiles(entry) {
            Button {
                acting.copying = entry
            } label: {
                Label("Copy to My files", systemImage: "doc.on.doc")
            }
        }
        if case .folder(let dir) = entry, workspace.mayPublish, workspace.status != nil, workspace.place(of: dir) != .nowhere {
            Button {
                acting.publishing = PublishTarget(path: dir, kind: .dir)
            } label: {
                let published = workspace.pages(of: dir).contains { $0.kind == .dir }
                Label(published ? "Edit publishing…" : "Publish folder…", systemImage: "globe")
            }
        }
        if mayChange {
            Button(role: .destructive) {
                acting.remove(entry, in: workspace)
            } label: {
                RemoveLabel(share: workspace.share(entry), ellipsis: true)
            }
        }
    }
}

/// What removing a row is called. Something shared is deleted for everyone
/// by whoever can open the folder it sits in, and left by anyone else.
private struct RemoveLabel: View {
    let share: SpaceStatus?
    /// In a menu, where a question follows: "Delete for everyone…".
    var ellipsis = false

    var body: some View {
        switch share?.placed {
        case nil: Label("Remove", systemImage: "trash")
        case true?: Label(ellipsis ? "Delete for everyone…" : "Delete", systemImage: "trash")
        case false?: Label(ellipsis ? "Leave…" : "Leave", systemImage: "rectangle.portrait.and.arrow.right")
        }
    }
}

/// A row's swipe: remove, or move.
struct EntrySwipes: View {
    let entry: FolderEntry
    let workspace: Workspace

    @Environment(EntryActing.self) private var acting

    var body: some View {
        let model = folder(of: entry, in: workspace)
        if workspace.may("work"), !model.isSection(entry) {
            Button(role: .destructive) {
                acting.remove(entry, in: workspace)
            } label: {
                RemoveLabel(share: workspace.share(entry))
            }
            if model.movable(entry) {
                Button {
                    acting.moving = entry
                } label: {
                    Label("Move", systemImage: "folder")
                }
                .tint(Theme.accent)
            }
        }
    }
}

/// Choosing the folder something moves into — and, when that changes who
/// can open it, saying so first.
struct MoveSheet: View {
    let model: FolderModel
    let entry: FolderEntry
    let failed: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var folders: [String] = []
    @State private var asking: (folder: String, question: ShareQuestion)?

    var body: some View {
        NavigationStack {
            List {
                if model.takes(entry, in: TreeModel.libraryFolder) {
                    Button {
                        choose(TreeModel.libraryFolder)
                    } label: {
                        Label("Library", systemImage: "books.vertical")
                    }
                }
                ForEach(folders.filter(offered), id: \.self) { folder in
                    Button {
                        choose(folder)
                    } label: {
                        Label(folder, systemImage: "folder")
                    }
                    .accessibilityIdentifier("move-to-\(folder)")
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
            .confirmationDialog(asking?.question.title ?? "", isPresented: askingShown, titleVisibility: .visible) {
                Button(asking?.question.button ?? "Move") {
                    if let folder = asking?.folder { move(into: folder) }
                }
                Button("Cancel", role: .cancel) { asking = nil }
            } message: {
                Text(asking?.question.body ?? "")
            }
        }
    }

    private var askingShown: Binding<Bool> {
        Binding(get: { asking != nil }, set: { if !$0 { asking = nil } })
    }

    /// Not Library itself, which is the top choice.
    private func offered(_ folder: String) -> Bool {
        folder.lowercased() != TreeModel.libraryFolder.lowercased() && model.takes(entry, in: folder)
    }

    private func choose(_ folder: String) {
        if let question = model.moveQuestion(entry, into: folder) {
            asking = (folder, question)
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
