import DoklinKit
import SwiftUI

/// Logging this device in to a workspace. The way in is the one an agent has:
/// a line from the Mac app — `doklin login <address> <code>` — whose code
/// works once. Pasting the line, or the whole prompt around it, fills both fields.
struct SignInView: View {
    /// Shown as a sheet over a workspace: there is something to go back to.
    var canCancel = false

    @Environment(AccountStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var code = ""
    @State private var working = false
    @State private var failure: String?

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Open a workspace")
                        .font(.system(.title2, design: .serif))
                    Text("On your Mac, open Doklin and choose Cloud → Agents → Add agent. Name it after this device, tick what it may do, and copy the login it shows.")
                        .font(.callout)
                        .foregroundStyle(Theme.text2)
                }
                .padding(.vertical, 6)
            }

            Section {
                PasteButton(payloadType: String.self) { strings in
                    let pasted = strings.joined(separator: "\n")
                    DispatchQueue.main.async { paste(pasted) }
                }
                .labelStyle(.titleAndIcon)
            } footer: {
                Text("Paste the login from your Mac, or fill in the two fields.")
            }

            Section {
                TextField("notes.example.com", text: $address)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .accessibilityIdentifier("address")
                    .onChange(of: address) { before, typed in
                        // The whole line pasted into the first field is the line all the same.
                        if pasted(before, typed), let line = LoginLine.find(in: typed) { fill(line) }
                    }
                TextField("Login code", text: $code)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .font(.system(.body, design: .monospaced))
                    .accessibilityIdentifier("code")
                    .onChange(of: code) { before, typed in
                        if pasted(before, typed), let line = LoginLine.find(in: typed) { fill(line) }
                    }
            } header: {
                Text("Address and login code")
            } footer: {
                if let failure {
                    Text(failure).foregroundStyle(Theme.errorInk)
                } else {
                    Text("A code works once and runs out an hour after it is made.")
                }
            }

            Section {
                Button {
                    Task { await signIn() }
                } label: {
                    HStack {
                        Text("Log in")
                        if working {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(working || address.trimmingCharacters(in: .whitespaces).isEmpty || code.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("login")
            }
        }
        .navigationTitle("Doklin")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if canCancel {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    /// Whether a field's text arrived all at once. A line being typed is
    /// left alone: its code is not whole until the last character.
    private func pasted(_ before: String, _ after: String) -> Bool {
        after.count - before.count > 8
    }

    private func fill(_ line: LoginLine) {
        address = line.address
        code = line.code
        failure = nil
    }

    private func paste(_ text: String) {
        if let line = LoginLine.find(in: text) {
            fill(line)
        } else {
            failure = "That is not a Doklin login — on your Mac, copy it from Cloud → Agents."
        }
    }

    private func signIn() async {
        working = true
        failure = nil
        defer { working = false }
        do {
            try await store.signIn(address: address, code: code, host: Device.name)
            if canCancel { dismiss() }
        } catch {
            failure = (error as? DoklinError)?.message ?? error.localizedDescription
        }
    }
}
