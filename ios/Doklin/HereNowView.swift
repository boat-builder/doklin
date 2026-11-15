import DoklinKit
import SwiftUI

/// The other devices that have the workspace open now, whose they are, and
/// what each is editing — as the workspace's status says, kept current by
/// the engine's poll. A document someone is editing opens from its row.
struct HereNowView: View {
    let workspace: Workspace

    @State private var now = Clock.now

    private var others: [PresenceDevice] { workspace.status?.presence ?? [] }

    var body: some View {
        List {
            Section {
                if others.isEmpty {
                    Hint("Only this iPhone.")
                        .accessibilityIdentifier("here-alone")
                }
                ForEach(others) { device in
                    if let path = device.path, workspace.files.exists(path) {
                        NavigationLink(value: Route.document(path)) { row(device) }
                    } else {
                        row(device)
                    }
                }
            } footer: {
                Text("The other devices that have \(workspace.name) open now.")
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Here now")
        .navigationBarTitleDisplayMode(.inline)
        .ticking($now)
        .refreshable { await workspace.syncNow() }
    }

    private func row(_ device: PresenceDevice) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(device.name)
                .foregroundStyle(Theme.text1)
            Hint(device.words(now: now))
        }
        .padding(.vertical, 2)
    }
}
