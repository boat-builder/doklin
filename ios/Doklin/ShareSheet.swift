import DoklinKit
import SwiftUI

/// *Share* on a folder or a document: who can open it, and what is done
/// about that — sharing it with somebody, stopping, leaving it, deleting it
/// for everyone. One sheet, whether or not it is shared yet, in the words of
/// the Mac's Share dialog (`ShareWords`). What it shows is read from the
/// workspace's status, so a change shows as soon as the engine has it; when
/// what is shared leaves this iPhone — left, deleted, or no longer shared
/// with this person — the sheet closes.
struct ShareSheet: View {
    @State private var model: ShareModel
    @State private var picked: Set<String> = []
    @State private var question: Question?
    @Environment(\.dismiss) private var dismiss

    init(workspace: Workspace, target: ShareTarget) {
        _model = State(initialValue: ShareModel(workspace: workspace, target: target))
    }

    private var workspace: Workspace { model.workspace }

    var body: some View {
        NavigationStack {
            Group {
                if model.space != nil {
                    shared
                } else {
                    unshared
                }
            }
            .navigationTitle(model.title)
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(model.busy)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.space == nil ? "Cancel" : "Done") { dismiss() }
                        .disabled(model.busy)
                        .accessibilityIdentifier("share-close")
                }
            }
            .task { await model.load() }
            .onChange(of: model.gone) { _, gone in
                if gone { dismiss() }
            }
            .asking($question)
            .refusal($model.problem)
        }
    }

    /* ---------- Not shared yet ---------- */

    private var unshared: some View {
        Form {
            Section {
            } header: {
                VStack(alignment: .leading, spacing: 8) {
                    Intro(model.unsharedHint)
                    if let inside = model.insideHint { Intro(inside) }
                }
            }
            Section("Share with") {
                if let others = model.others {
                    if others.isEmpty {
                        Hint(ShareWords.alone(in: workspace.name))
                    }
                    ForEach(others) { member in
                        Toggle(isOn: Binding(
                            get: { picked.contains(member.id) },
                            set: { on in if on { picked.insert(member.id) } else { picked.remove(member.id) } }
                        )) {
                            person(member)
                        }
                        .disabled(model.busy)
                        .accessibilityIdentifier("share-pick-\(member.email)")
                    }
                } else if model.problem == nil {
                    ProgressView()
                }
            }
            Section {
                Button {
                    Task {
                        await model.share(with: Array(picked))
                        picked = []
                    }
                } label: {
                    HStack {
                        Text(model.busy ? "Sharing…" : "Share")
                        if model.busy {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(picked.isEmpty || model.busy)
                .accessibilityIdentifier("share-submit")
            }
        }
    }

    /* ---------- Shared ---------- */

    private var shared: some View {
        List {
            Section {
            } header: {
                Intro(model.sharedHint)
            }

            Section(ShareWords.count(model.people.count)) {
                ForEach(model.people) { person in
                    HStack {
                        NameLine(name: person.name, tags: person.tags)
                        Spacer(minLength: 8)
                        if person.direct, !person.you {
                            Button("Stop sharing") {
                                question = Question(
                                    "Stop sharing “\(model.name)” with \(person.name)?", ShareWords.stopping, button: "Stop sharing"
                                ) { await model.stop(person.id) }
                            }
                            .buttonStyle(.borderless)
                            .disabled(model.busy)
                        }
                    }
                    .accessibilityIdentifier("share-member-\(person.name)")
                }
            }

            Section("Share with more people") {
                if model.everyone != nil {
                    if model.addable.isEmpty {
                        Hint(ShareWords.everyoneOn(in: workspace.name))
                    }
                    ForEach(model.addable) { member in
                        HStack {
                            person(member)
                            Spacer(minLength: 8)
                            Button("Share") { Task { await model.add(member.id) } }
                                .buttonStyle(.borderless)
                                .disabled(model.busy)
                                .accessibilityIdentifier("share-add-\(member.email)")
                        }
                    }
                } else if model.problem == nil {
                    ProgressView()
                }
            }

            if model.mayLeave || model.mayDelete {
                Section {
                    if model.mayLeave {
                        Button("Leave this \(model.what)") {
                            question = Question("Leave “\(model.name)”?", ShareWords.leaving, button: "Leave") { await model.giveUp() }
                        }
                        .disabled(model.busy)
                        .accessibilityIdentifier("share-leave")
                    }
                    if let asked = model.deleteQuestion {
                        Button("Delete it for everyone", role: .destructive) {
                            question = Question(asked.title, asked.body, button: asked.button) { await model.giveUp() }
                        }
                        .disabled(model.busy)
                        .accessibilityIdentifier("share-delete")
                    }
                } header: {
                    HStack {
                        Text("This \(model.what)")
                        if model.busy { ProgressView().controlSize(.mini) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func person(_ member: MemberRecord) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(member.name.isEmpty ? member.email : member.name)
                .foregroundStyle(Theme.text1)
            if !member.name.isEmpty { Hint(member.email) }
        }
    }
}
