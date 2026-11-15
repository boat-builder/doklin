import DoklinKit
import SwiftUI

/// This person's devices here: the Macs and iPhones signed in as them, each
/// on a sign-in of its own, so any one can be signed out without touching
/// the others — every one but this iPhone, which leaves by being removed
/// from it. Another is added with a line that works once.
///
/// The phone never holds the domain's own token — it joins with a line,
/// always — so nothing here is about that token: it is shown on the Mac
/// that holds it.
struct DevicesView: View {
    @State private var model: PeopleModel
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
                Asking(phase: model.phase, words: "Asking \(workspace.domain) about your devices…") { await model.load() }
            }
        }
        .navigationTitle("Devices")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .ticking($now)
        .asking($question)
        .refusal($model.problem)
    }

    private func list(_ people: People) -> some View {
        List {
            Section {
            } header: {
                Intro("Your devices in \(workspace.name): the Macs and iPhones signed in as you. Each holds a copy of the workspace and keeps it in step, on a sign-in of its own — so any one of them can be signed out without touching the others.")
            }
            if let code = model.deviceCode {
                OnceCard(
                    title: "A code for another device of yours",
                    shown: code.blob,
                    copyLabel: "Copy the line",
                    words: [
                        "On the other Mac or iPhone, open Doklin, choose Join a workspace and paste this line. It works once, for \(Clock.left(code.expiresAt, now: now)). That device is then signed in as you: it sees what you see, and you can sign it out here.",
                        "This is the only time the code is shown — \(workspace.domain) kept nothing but its fingerprint. Making another code stops this one.",
                    ]
                ) { model.deviceCode = nil }
            } else {
                Section {
                    Button {
                        Task { await model.addDevice() }
                    } label: {
                        HStack {
                            Text(model.busy ? "Making a code…" : "Add a device")
                            if model.busy {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(model.busy)
                    .accessibilityIdentifier("device-add")
                } footer: {
                    Text("Another Mac, or an iPhone. It joins with one line you paste there.")
                }
            }

            Section("Your devices") {
                ForEach(people.mine) { device in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            NameLine(name: device.deviceName ?? "A device", tags: people.isThisDevice(device) ? ["this iPhone"] : [])
                            Hint("Joined \(Clock.ago(device.createdAt, now: now))")
                        }
                        Spacer(minLength: 8)
                        if !people.isThisDevice(device) {
                            Button("Sign out") {
                                question = Question(
                                    "Sign out \(device.deviceName ?? "this device")?",
                                    "It stops syncing, and deletes its copy of \(workspace.name) the next time Doklin runs there.",
                                    button: "Sign out"
                                ) { await model.signOut(device) }
                            }
                            .buttonStyle(.borderless)
                            .disabled(model.busy)
                        }
                    }
                    .padding(.vertical, 2)
                    .accessibilityIdentifier("device-\(device.deviceName ?? device.id)")
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await model.load() }
    }
}
