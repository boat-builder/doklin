import DoklinKit
import SwiftUI

/// Making a restricted folder: its name, and who is in it besides this
/// person. Made from nothing, from a folder that is there, or around a
/// private note being shared. Once made, `made` is told its folder.
struct RestrictedFolderSheet: View {
    let made: (String) -> Void

    @State private var model: RestrictedFolderModel
    @State private var name: String
    @State private var picked: Set<String> = []
    @Environment(\.dismiss) private var dismiss

    init(workspace: Workspace, source: RestrictedSource, made: @escaping (String) -> Void) {
        self.made = made
        _model = State(initialValue: RestrictedFolderModel(workspace: workspace, source: source))
        _name = State(initialValue: source.prefill)
    }

    private var source: RestrictedSource { model.source }
    private var ready: Bool { source.ready(name: name, picked: picked.count) && !model.busy }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                } header: {
                    Intro(source.hint)
                }
                Section(source.nameLabel) {
                    TextField("Finance", text: $name)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit { create() }
                        .disabled(model.busy)
                        .accessibilityIdentifier("restricted-name")
                }
                Section {
                    people
                } header: {
                    Text("Who is in it")
                } footer: {
                    if case .folder = source, let others = model.others, !others.isEmpty {
                        Text(RestrictedSource.whoWillHave(others.filter { picked.contains($0.id) }.map(display)))
                    }
                }
                Section {
                    Button {
                        create()
                    } label: {
                        HStack {
                            Text(model.busy ? "Working…" : source.button)
                            if model.busy {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(!ready)
                    .accessibilityIdentifier("restricted-create")
                } footer: {
                    if let problem = model.problem { Text(problem).foregroundStyle(Theme.errorInk) }
                }
            }
            .navigationTitle(source.title)
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(model.busy)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(model.busy)
                }
            }
            .task { await model.load() }
        }
    }

    @ViewBuilder private var people: some View {
        if let others = model.others {
            if others.isEmpty {
                Hint("Nobody else is in \(model.workspace.name) yet, so it starts with only you.")
            } else {
                NameLine(name: model.me, tags: ["you"])
                ForEach(others) { member in
                    Toggle(isOn: Binding(
                        get: { picked.contains(member.id) },
                        set: { on in if on { picked.insert(member.id) } else { picked.remove(member.id) } }
                    )) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(display(member))
                            if !member.name.isEmpty { Hint(member.email) }
                        }
                    }
                    .disabled(model.busy)
                    .accessibilityIdentifier("restricted-pick-\(member.email)")
                }
            }
        } else if model.problem == nil {
            ProgressView()
        }
    }

    private func display(_ member: MemberRecord) -> String {
        member.name.isEmpty ? member.email : member.name
    }

    private func create() {
        guard ready else { return }
        Task {
            if let folder = await model.create(name: name, members: Array(picked)) {
                dismiss()
                made(folder)
            }
        }
    }
}

/// Who can open one restricted folder, and what anyone in it may do about
/// that: add people, take them out, leave, delete it for everyone. The
/// folder is read from the workspace's status, so a change shows as soon as
/// the engine has it; once the folder has left this iPhone, the screen —
/// and whatever was open in the folder — goes.
struct SpaceAccessView: View {
    @Binding var route: [Route]
    @State private var model: SpaceAccessModel
    @State private var question: Question?

    init(workspace: Workspace, id: String, route: Binding<[Route]>) {
        _route = route
        _model = State(initialValue: SpaceAccessModel(workspace: workspace, id: id))
    }

    private var workspace: Workspace { model.workspace }

    var body: some View {
        Group {
            if let space = model.space {
                list(space)
            } else {
                ContentUnavailableView("This folder is not here", systemImage: "person.2.slash", description: Text("It is no longer on this iPhone."))
            }
        }
        .navigationTitle(model.space.map { "Who can open “\($0.name)”" } ?? "Who can open it")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .onChange(of: model.space == nil) { _, gone in
            if gone { close() }
        }
        .asking($question)
        .refusal($model.problem)
    }

    private func list(_ space: SpaceStatus) -> some View {
        List {
            Section {
            } header: {
                Intro("Only the people here have this folder, on their own devices. Nobody else in \(workspace.name) sees it, or that it exists. Anyone in it can add people, take them out, rename it and delete it.")
            }

            Section("\(space.members.count) \(space.members.count == 1 ? "person" : "people")") {
                ForEach(space.members, id: \.self) { member in
                    HStack {
                        NameLine(name: model.name(of: member), tags: model.isYou(member) ? ["you"] : [])
                        Spacer(minLength: 8)
                        if !model.isYou(member) {
                            Button("Remove") {
                                question = Question(
                                    "Take \(model.name(of: member)) out of “\(space.name)”?",
                                    "Their devices delete their copy of this folder.",
                                    button: "Remove"
                                ) { await model.takeOut(member) }
                            }
                            .buttonStyle(.borderless)
                            .disabled(model.busy)
                        }
                    }
                    .accessibilityIdentifier("space-member-\(model.name(of: member))")
                }
            }

            Section("Add people") {
                if model.everyone != nil {
                    if model.addable.isEmpty {
                        Hint("Everyone in \(workspace.name) is in this folder already.")
                    }
                    ForEach(model.addable) { member in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(member.name.isEmpty ? member.email : member.name)
                                    .foregroundStyle(Theme.text1)
                                if !member.name.isEmpty { Hint(member.email) }
                            }
                            Spacer(minLength: 8)
                            Button("Add") { Task { await model.add(member.id) } }
                                .buttonStyle(.borderless)
                                .disabled(model.busy)
                        }
                    }
                } else {
                    ProgressView()
                }
            }

            Section {
                Button("Leave this folder") { question = leaving(space) }
                    .disabled(model.busy)
                Button("Delete it for everyone", role: .destructive) { question = deleting(space) }
                    .disabled(model.busy)
                    .accessibilityIdentifier("space-delete")
            } header: {
                HStack {
                    Text("This folder")
                    if model.busy { ProgressView().controlSize(.mini) }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func leaving(_ space: SpaceStatus) -> Question {
        guard model.alone else {
            return Question(
                "Leave “\(space.name)”?",
                "This iPhone deletes its copy of the folder. The others keep theirs.",
                button: "Leave"
            ) { await model.leave() }
        }
        // The last person: hand it to someone, or delete it.
        let hand = model.addable.map { member in
            Question.Choice(label: "Hand it to \(member.name.isEmpty ? member.email : member.name)", destructive: false) {
                await model.leave(handingTo: member.id)
            }
        }
        let delete = Question.Choice(label: "Delete it") {
            // A second question, once the first has gone.
            try? await Task.sleep(nanoseconds: 400_000_000)
            question = deleting(space)
        }
        return Question(
            "You are the last person in “\(space.name)”",
            "A folder is not left with nobody in it. Hand it to someone — they get it, and you leave — or delete it.",
            choices: hand + [delete]
        )
    }

    private func deleting(_ space: SpaceStatus) -> Question {
        Question(
            "Delete “\(space.name)” for everyone in it?",
            "Everything in it is erased from the cloud, and from the devices of each person in it. This cannot be undone.",
            button: "Delete the folder"
        ) { await model.delete() }
    }

    /// The folder is gone: so are this screen and anything open inside it.
    private func close() {
        let lower = model.folder.lowercased()
        let inside = { (path: String) in !lower.isEmpty && (path.lowercased() == lower || path.lowercased().hasPrefix(lower + "/")) }
        let first = route.firstIndex { step in
            switch step {
            case .access(let id): return id == model.id
            case .folder(let path), .document(let path): return inside(path)
            default: return false
            }
        }
        if let first { route.removeSubrange(first...) }
    }
}
