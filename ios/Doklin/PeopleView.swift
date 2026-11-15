import DoklinKit
import SwiftUI

/// Everyone in the workspace, each on a device of their own. Everybody sees
/// who is here; an owner also lets people in with a code, takes access away,
/// makes other owners, and signs out anybody's devices. What is offered is
/// what the domain said this person may do, asked as the screen opens.
struct PeopleView: View {
    @State private var model: PeopleModel
    @State private var inviting: InviteDraft?
    @State private var question: Question?
    @State private var now = Clock.now

    init(workspace: Workspace) {
        _model = State(initialValue: PeopleModel(workspace: workspace))
    }

    private var workspace: Workspace { model.workspace }

    var body: some View {
        Group {
            if let people = model.people {
                list(people)
            } else {
                Asking(phase: model.phase, words: "Asking \(workspace.domain) who is here…") { await model.load() }
            }
        }
        .navigationTitle("People")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .ticking($now)
        .sheet(item: $inviting) { draft in
            InviteSheet(model: model, draft: draft)
        }
        .asking($question)
        .refusal($model.problem)
    }

    private func list(_ people: People) -> some View {
        List {
            Section {
            } header: {
                Intro(people.may("people.invite")
                    ? "Everyone in \(workspace.name). Each has a copy of it on a device of their own, kept in step with yours. You let someone in with an invite code, and they stay until an owner removes them."
                    : "Everyone in \(workspace.name). Each has a copy of it on a device of their own, kept in step with yours. An owner invites people and removes them.")
            }
            if let invited = model.invited {
                OnceCard(
                    title: "A code for \(invited.invite.email)",
                    shown: invited.blob,
                    copyLabel: "Copy the line to send",
                    alsoCopy: ("Copy the code alone", invited.code),
                    words: [
                        "The code works once, for \(Clock.left(invited.invite.expiresAt, now: now)). Their access lasts until an owner removes them.",
                        "Send the whole line: it carries the address too, and they join with one paste. This is the only time the code is shown — \(workspace.domain) kept nothing but its fingerprint, so nobody, you included, can read it back.",
                    ]
                ) { model.invited = nil }
            }

            if people.may("people.invite") {
                Section {
                    Button("Invite someone") {
                        model.invited = nil
                        inviting = InviteDraft()
                    }
                    .accessibilityIdentifier("invite-open")
                } footer: {
                    Text("They join with one line you send them.")
                }
            }

            if people.members.isEmpty {
                Section("0 people") { Hint("Nobody but you yet.") }
            }
            ForEach(Array(people.members.enumerated()), id: \.element.id) { index, member in
                Section {
                    person(member, in: people)
                } header: {
                    if index == 0 { Text("\(people.members.count) \(people.members.count == 1 ? "person" : "people")") }
                }
            }

            if people.may("people.invite"), !people.invites.isEmpty {
                Section("Codes nobody has used yet") {
                    ForEach(people.invites) { invite in
                        code(invite, in: people)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await model.load() }
    }

    /* ---------- A person ---------- */

    @ViewBuilder private func person(_ member: MemberRecord, in people: People) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            NameLine(
                name: member.name.isEmpty ? member.email : member.name,
                tags: (people.isYou(member) ? ["you"] : []) + (member.role == "owner" ? ["owner"] : [])
            )
            if !member.name.isEmpty {
                Text(member.email)
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
            }
            Hint(people.summary(of: member, now: now))
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("person-\(member.email)")

        ForEach(people.devices(of: member)) { device in
            deviceRow(device, of: member, in: people)
        }

        if people.changeable(member) {
            if people.may("people.roles") {
                Button(member.role == "owner" ? "Make a member" : "Make an owner") {
                    question = roleQuestion(member)
                }
                .disabled(model.busy)
            }
            if people.may("people.remove") {
                Button("Remove from \(workspace.name)", role: .destructive) {
                    question = removeQuestion(member)
                }
                .disabled(model.busy)
            }
        }
    }

    private func deviceRow(_ device: DeviceRecord, of member: MemberRecord, in people: People) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                NameLine(name: device.deviceName ?? "A device", tags: people.isThisDevice(device) ? ["this iPhone"] : [])
                    .font(.subheadline)
                Hint("joined \(Clock.ago(device.createdAt, now: now))")
            }
            .padding(.leading, 12)
            Spacer(minLength: 8)
            // Never this iPhone: signing it out would delete the copy being
            // looked at. Removing the workspace from this iPhone is how.
            if !people.isThisDevice(device) {
                Button("Sign out") {
                    question = signOutQuestion(device)
                }
                .buttonStyle(.borderless)
                .disabled(model.busy)
            }
        }
    }

    private func roleQuestion(_ member: MemberRecord) -> Question {
        let name = member.name.isEmpty ? member.email : member.name
        return member.role == "owner"
            ? Question(
                "Make \(name) a member?",
                "They keep working here, and stop being able to invite or remove people. Codes nobody has used yet are withdrawn.",
                button: "Make a member", destructive: false
            ) { await model.flipRole(of: member) }
            : Question(
                "Make \(name) an owner?",
                "They will be able to invite and remove people, make other owners, and delete the workspace.",
                button: "Make an owner", destructive: false
            ) { await model.flipRole(of: member) }
    }

    private func removeQuestion(_ member: MemberRecord) -> Question {
        let name = member.name.isEmpty ? member.email : member.name
        var words = "Their code stops working, and every device they signed in on stops syncing and deletes its copy of \(workspace.name) the next time Doklin runs there. Nothing in the cloud is deleted, and their name stays on what they wrote."
        if member.role == "owner" { words += " Codes nobody has used yet are withdrawn with them." }
        return Question("Remove \(name) from \(workspace.name)?", words, button: "Remove") { await model.remove(member) }
    }

    private func signOutQuestion(_ device: DeviceRecord) -> Question {
        Question(
            "Sign out \(device.deviceName ?? "this device")?",
            "It stops syncing, and deletes its copy of \(workspace.name) the next time Doklin runs there.",
            button: "Sign out"
        ) { await model.signOut(device) }
    }

    /* ---------- A code nobody has used ---------- */

    @ViewBuilder private func code(_ invite: InviteRecord, in people: People) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            NameLine(name: invite.name.isEmpty ? invite.email : invite.name)
            if !invite.name.isEmpty {
                Text(invite.email)
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
            }
            Hint("the code runs out in \(Clock.left(invite.expiresAt, now: now))")
            HStack(spacing: 20) {
                if people.mayInviteAgain(invite.memberId) {
                    Button("New code") {
                        model.invited = nil
                        inviting = InviteDraft(email: invite.email, name: invite.name)
                    }
                }
                Button("Withdraw", role: .destructive) {
                    question = Question(
                        "Withdraw the code for \(invite.name.isEmpty ? invite.email : invite.name)?",
                        "The code stops working; they stay invited to nothing.",
                        button: "Withdraw"
                    ) { await model.withdraw(invite) }
                }
                .accessibilityIdentifier("withdraw-\(invite.email)")
            }
            .buttonStyle(.borderless)
            .font(.subheadline)
            .padding(.top, 4)
            .disabled(model.busy)
        }
        .padding(.vertical, 2)
    }
}

/// What an invite is being made for.
struct InviteDraft: Identifiable {
    let id = UUID()
    var email = ""
    var name = ""
    var days = InviteDays.usual
}

/// Inviting someone: their email, their name, and how long the code is good
/// for. What it ends in is the line to send them, shown once on the People
/// screen.
private struct InviteSheet: View {
    let model: PeopleModel
    @State var draft: InviteDraft

    @Environment(\.dismiss) private var dismiss
    @State private var failure: String?

    private var people: People? { model.people }

    var body: some View {
        NavigationStack {
            Form {
                Section("Their email") {
                    TextField("them@example.com", text: $draft.email)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("invite-email")
                }
                Section("Their name (optional)") {
                    TextField("Name", text: $draft.name)
                        .textContentType(.name)
                        .accessibilityIdentifier("invite-name")
                }
                Section {
                    Picker("The code is good for", selection: $draft.days) {
                        ForEach(InviteDays.choices, id: \.self) { days in
                            Text(InviteDays.words(days)).tag(days)
                        }
                    }
                } footer: {
                    Text("Only the code runs out. Once they have joined, their access lasts until an owner removes them. "
                        + (people?.creator == true
                            ? "Inviting somebody already here gives them a fresh code and stops the one they had. Inviting somebody who was removed brings them back as the same person."
                            : "A new code for somebody who has already signed in is theirs to make, or the workspace creator’s."))
                }
                Section {
                    Button {
                        Task { await send() }
                    } label: {
                        HStack {
                            Text(model.busy ? "Making a code…" : "Make a code")
                            if model.busy {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(model.busy || draft.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("invite-send")
                } footer: {
                    if let failure { Text(failure).foregroundStyle(Theme.errorInk) }
                }
            }
            .navigationTitle("Invite someone to \(model.workspace.name)")
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

    /// Make the code; what the engine refused is said here, under the form.
    private func send() async {
        failure = nil
        if await model.invite(email: draft.email, name: draft.name, days: draft.days) {
            dismiss()
        } else {
            failure = model.problem
            model.problem = nil
        }
    }
}
