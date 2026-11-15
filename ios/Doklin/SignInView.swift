import DoklinKit
import SwiftUI

/// Joining a workspace as a device of yours: one line from another device —
/// a Mac's Add a device — or from an invite, pasted here. The code in it
/// works once and becomes this iPhone's own sign-in; then the whole
/// workspace downloads and stays in step.
struct SignInView: View {
    /// Shown as a sheet over a workspace: there is something to go back to.
    var canCancel = false

    @Environment(Workspaces.self) private var device
    @Environment(\.dismiss) private var dismiss
    @State private var line = ""
    @State private var working = false
    @State private var failure: String?

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Join a workspace")
                        .font(.system(.title2, design: .serif))
                    Text("On a Mac that has the workspace, open its menu and choose Devices… → Add a device. Paste the line it shows here. A line from an invite works too.")
                        .font(.callout)
                        .foregroundStyle(Theme.text2)
                }
                .padding(.vertical, 6)
            }

            Section {
                TextField("doklin-invite https://… dkln-…", text: $line, axis: .vertical)
                    .lineLimit(2...5)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(.callout, design: .monospaced))
                    .accessibilityIdentifier("line")
                    .disabled(working)
                PasteButton(payloadType: String.self) { strings in
                    let pasted = strings.joined(separator: "\n")
                    DispatchQueue.main.async {
                        line = pasted
                        failure = nil
                    }
                }
                .labelStyle(.titleAndIcon)
                .disabled(working)
            } header: {
                Text("The line")
            } footer: {
                if let failure {
                    Text(failure).foregroundStyle(Theme.errorInk)
                } else {
                    Text("A line works once.")
                }
            }

            Section {
                Button {
                    Task { await join() }
                } label: {
                    HStack {
                        Text(working ? (device.joiningWords ?? "Joining…") : "Join")
                        if working {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(working || line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("join")
            } footer: {
                Text("Everything in the workspace downloads to this iPhone and stays in step with your other devices. Doklin keeps the sign-in in this iPhone's Keychain.")
            }
        }
        .navigationTitle("Doklin")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(working)
        .toolbar {
            if canCancel {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(working)
                }
            }
        }
    }

    private func join() async {
        working = true
        failure = nil
        defer { working = false }
        do {
            try await device.join(pasted: line)
            if canCancel { dismiss() }
        } catch {
            failure = (error as? DoklinError)?.message ?? error.localizedDescription
        }
    }
}
