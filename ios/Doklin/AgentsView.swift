import DoklinKit
import SwiftUI

/// This person's agents — bots on other computers that work with the
/// workspace through the `doklin` command line — and, for an owner, everyone
/// else's, to log out or remove. Adding one ends in the prompt that logs it
/// in, shown once.
struct AgentsView: View {
    @State private var model: AgentsModel
    @State private var editing: AgentDraft?
    @State private var question: Question?
    @State private var now = Clock.now

    init(workspace: Workspace) {
        _model = State(initialValue: AgentsModel(workspace: workspace))
    }

    private var workspace: Workspace { model.workspace }

    var body: some View {
        Group {
            if model.agents != nil {
                list
            } else {
                Asking(phase: model.phase, words: "Asking \(workspace.domain) about its agents…") { await model.load() }
            }
        }
        .navigationTitle("Agents")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .ticking($now)
        .sheet(item: $editing) { draft in
            AgentSheet(model: model, draft: draft)
        }
        .asking($question)
        .refusal($model.problem)
    }

    private var list: some View {
        ScrollViewReader { proxy in
            rows
                .revealing(model.login?.id, in: proxy)
        }
    }

    private var rows: some View {
        List {
            Section {
            } header: {
                Intro("Agents are bots. Each works with this workspace from another computer through the doklin command line, with no copy of the folder. An agent you add is yours: it sees what you see — Library, your My files, what is shared with you — and reads, writes, comments and publishes there within what you allow.")
            }

            if let shown = model.login {
                OnceCard(
                    title: "Log \(shown.name) in",
                    lead: "Give this to the agent — paste it into its chat and it sets itself up — or run the two commands in it on the machine the agent works from.",
                    shown: AgentPrompt.login(domain: workspace.domain, line: shown.login.line, expiresAt: shown.login.expiresAt),
                    long: true,
                    copyLabel: "Copy prompt",
                    words: [
                        "The code in it works once, on one machine, and stops working in \(Clock.left(shown.login.expiresAt, now: now)). This is the only time it is shown: \(workspace.domain) kept nothing but its fingerprint. A second machine needs a code of its own — New login code on the agent’s row.",
                    ]
                ) { model.login = nil }
            }

            Section {
                Button("Add an agent") {
                    model.login = nil
                    editing = AgentDraft()
                }
                .accessibilityIdentifier("agent-open")
            } footer: {
                Text("A bot gets an identity of its own, which you can take back.")
            }

            if model.mine.isEmpty {
                Section("Your agents · 0") { Hint("None yet.") }
            }
            ForEach(Array(model.mine.enumerated()), id: \.element.id) { index, agent in
                Section {
                    row(agent, whose: nil)
                    machines(of: agent)
                    Button("New login code") {
                        editing = nil
                        Task { await model.newLogin(for: agent) }
                    }
                    .disabled(model.busy)
                    Button("Edit") {
                        model.login = nil
                        editing = AgentDraft(agent)
                    }
                    removeButton(agent)
                } header: {
                    if index == 0 { Text("Your agents · \(model.mine.count)") }
                }
            }

            ForEach(Array(model.others.enumerated()), id: \.element.id) { index, agent in
                Section {
                    row(agent, whose: model.whose(agent))
                    machines(of: agent)
                    removeButton(agent)
                } header: {
                    if index == 0 { Text("Other people’s agents · \(model.others.count)") }
                } footer: {
                    if index == model.others.count - 1 {
                        Text("Each sees what its person sees. As an owner you can log one out or remove it; changing it, or logging it in, is its person’s.")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await model.load() }
    }

    private func row(_ agent: AgentRecord, whose: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            NameLine(name: agent.name, tags: (whose.map { [$0] } ?? []) + (agent.canPublish ? ["can publish"] : []))
            Text(agent.scopeWords)
                .font(.footnote)
                .foregroundStyle(Theme.text2)
            Hint(agent.summary(now: now))
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("agent-\(agent.name)")
    }

    @ViewBuilder private func machines(of agent: AgentRecord) -> some View {
        ForEach(agent.machines) { machine in
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(machine.host)
                        .font(.subheadline)
                        .foregroundStyle(Theme.text1)
                    Hint("logged in \(Clock.ago(machine.createdAt, now: now))")
                }
                .padding(.leading, 12)
                Spacer(minLength: 8)
                Button("Log out") {
                    question = Question("Log \(agent.name) out of \(machine.host)?", "Its next command is refused.", button: "Log out") {
                        await model.logOut(agent, from: machine)
                    }
                }
                .buttonStyle(.borderless)
                .disabled(model.busy)
            }
        }
    }

    private func removeButton(_ agent: AgentRecord) -> some View {
        Button("Remove", role: .destructive) {
            question = Question(
                "Remove \(agent.name)?",
                "Every machine it is logged in on is refused from its next command. What it wrote stays.",
                button: "Remove"
            ) { await model.remove(agent) }
        }
        .disabled(model.busy)
        .accessibilityIdentifier("agent-remove-\(agent.name)")
    }
}

/// An agent being added, or changed.
struct AgentDraft: Identifiable {
    let id = UUID()
    /// The agent being changed; nil for a new one.
    var agent: AgentRecord?
    var name = ""
    var scopes = AgentScope.usual

    init() {}

    init(_ agent: AgentRecord) {
        self.agent = agent
        name = agent.name
        scopes = agent.picked
    }
}

/// An agent's name and what it may do: a new one's, or a change to one.
private struct AgentSheet: View {
    let model: AgentsModel
    @State var draft: AgentDraft

    @Environment(\.dismiss) private var dismiss
    @State private var failure: String?

    private var adding: Bool { draft.agent == nil }

    var body: some View {
        NavigationStack {
            Form {
                Section("Its name") {
                    TextField("Research bot", text: $draft.name)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("agent-name")
                }
                Section {
                    ForEach(AgentScope.allCases) { scope in
                        Toggle(isOn: binding(scope)) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(scope.label)
                                Text(scope.what)
                                    .font(.footnote)
                                    .foregroundStyle(Theme.text3)
                            }
                        }
                        .disabled(scope == .read)
                        .accessibilityIdentifier("agent-scope-\(scope.rawValue)")
                    }
                } header: {
                    Text("It may")
                } footer: {
                    Text("The name is what its comments and changes are signed with. It sees what you see and no more, and the boxes are what it may do there: it cannot see or change who is on this workspace, its history or its settings, whatever is ticked. A change to the boxes reaches it on its next command.")
                }
                Section {
                    Button {
                        Task { await save() }
                    } label: {
                        HStack {
                            Text(adding ? (model.busy ? "Adding…" : "Add, and make a login code") : (model.busy ? "Saving…" : "Save"))
                            if model.busy {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(model.busy || draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("agent-save")
                } footer: {
                    if let failure { Text(failure).foregroundStyle(Theme.errorInk) }
                }
            }
            .navigationTitle(adding ? "Add an agent of your own" : "Edit this agent")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(model.busy)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(model.busy)
                }
            }
        }
    }

    /// A box: read is always ticked, and stays so.
    private func binding(_ scope: AgentScope) -> Binding<Bool> {
        Binding(
            get: { scope == .read || draft.scopes.contains(scope) },
            set: { on in
                guard scope != .read else { return }
                if on { draft.scopes.insert(scope) } else { draft.scopes.remove(scope) }
            }
        )
    }

    private func save() async {
        failure = nil
        let done: Bool
        if let agent = draft.agent {
            done = await model.update(agent, name: draft.name, scopes: draft.scopes)
        } else {
            done = await model.add(name: draft.name, scopes: draft.scopes)
        }
        if done {
            dismiss()
        } else {
            failure = model.problem
            model.problem = nil
        }
    }
}
