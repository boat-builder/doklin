import DoklinKit
import SwiftUI
import UIKit

@main
struct DoklinApp: App {
    @State private var device = Workspaces()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(device)
                .tint(Theme.accent)
                .task { device.start(.onThisPhone) }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: settle()
            case .active: Task { await device.woke() }
            default: break
            }
        }
    }

    /// Leaving the screen: what was written here is kept and sent while iOS
    /// still lets the app run — about thirty seconds.
    private func settle() {
        let application = UIApplication.shared
        var task = UIBackgroundTaskIdentifier.invalid
        task = application.beginBackgroundTask(withName: "Sync") {
            application.endBackgroundTask(task)
            task = .invalid
        }
        Task {
            await device.settle(within: 25)
            if task != .invalid { application.endBackgroundTask(task) }
        }
    }
}

extension EngineSetup {
    /// Where this iPhone keeps things: the engine's own files in Application
    /// Support, each workspace in Documents, sign-ins in the Keychain.
    /// Everything written down is relative to the app's folder, which iOS
    /// moves on an update. None of it goes into a backup: it is all in the
    /// cloud, and a phone restored from one joins again as a new device —
    /// with a device id of its own, and no copy that nothing signs in to.
    @MainActor static var onThisPhone: EngineSetup {
        let files = FileManager.default
        var support = files.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Doklin")
        var documents = files.urls(for: .documentDirectory, in: .userDomainMask)[0]
        var notBackedUp = URLResourceValues()
        notBackedUp.isExcludedFromBackup = true
        try? files.createDirectory(at: support, withIntermediateDirectories: true)
        try? support.setResourceValues(notBackedUp)
        try? documents.setResourceValues(notBackedUp)
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        return EngineSetup(
            secrets: KeychainSecretStore(service: Bundle.main.bundleIdentifier ?? "doklin"),
            dataDirectory: support,
            workspacesDirectory: documents,
            anchor: URL(fileURLWithPath: NSHomeDirectory()),
            client: "ios/\(version)",
            deviceName: UIDevice.current.name
        )
    }
}

struct RootView: View {
    @Environment(Workspaces.self) private var device

    var body: some View {
        Group {
            if !device.ready {
                ProgressView()
            } else if let failure = device.failure {
                ContentUnavailableView("Doklin could not start", systemImage: "exclamationmark.triangle", description: Text(failure))
            } else if let workspace = device.current {
                WorkspaceView(workspace: workspace)
                    .id(workspace.root)
            } else {
                NavigationStack {
                    SignInView()
                }
            }
        }
        .alert(removedTitle, isPresented: removedShown) {
            Button("OK", role: .cancel) { device.dismissRemoved() }
        } message: {
            Text(removedWords)
        }
    }

    private var removedShown: Binding<Bool> {
        Binding(get: { device.removed != nil }, set: { if !$0 { device.dismissRemoved() } })
    }

    private var removedTitle: String {
        "This iPhone is signed out of \(device.removed?.name ?? "the workspace")"
    }

    /// The domain said this device's sign-in is gone: it was signed out from
    /// another device, or an owner took its access away.
    private var removedWords: String {
        guard let gone = device.removed else { return "" }
        let copy = gone.deleted
            ? "Its copy on this iPhone has been deleted."
            : "It no longer syncs, but its folder on this iPhone could not be deleted."
        return "It was signed out from another device, or an owner of \(gone.domain) took its access away. \(copy) Nothing was deleted in the cloud. To come back, add this iPhone again from a device that is still signed in."
    }
}
