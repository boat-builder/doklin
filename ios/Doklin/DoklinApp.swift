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
                .task {
                    device.start(.onThisPhone)
                    // The note editor is ready before the first Edit, made
                    // once the first screen is up.
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    EditorPage.shared.warm()
                }
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
        return EngineSetup(
            secrets: KeychainSecretStore(service: Bundle.main.bundleIdentifier ?? "doklin"),
            dataDirectory: support,
            workspacesDirectory: documents,
            anchor: URL(fileURLWithPath: NSHomeDirectory()),
            client: "ios/\(AppVersion.client)",
            deviceName: UIDevice.current.name,
            deviceKind: UIDevice.current.model
        )
    }
}

/// What this build is, as TestFlight shows it and as `x-doklin-client` says
/// it (cloud-worker/src/clients.ts — change both): the version, and the
/// build Xcode numbered it on upload. A build run from Xcode says `dev`, which
/// no domain turns away: its number is the project's, never one TestFlight
/// gave.
enum AppVersion {
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    #if DEBUG
    static let build = "dev"
    #else
    static let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
    #endif
    /// `0.1.0+57`.
    static var client: String { "\(version)+\(build)" }
    /// `0.1.0 (57)`.
    static var shown: String { "\(version) (\(build))" }
}

struct RootView: View {
    @Environment(Workspaces.self) private var device

    var body: some View {
        ZStack {
            content
                .accessibilityHidden(!device.turnedAwayBy.isEmpty)
                .allowsHitTesting(device.turnedAwayBy.isEmpty)
            if !device.turnedAwayBy.isEmpty {
                UpdateRequiredView(domains: device.turnedAwayBy)
            }
        }
    }

    private var content: some View {
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
        // A link to a page: from doklin.cc straight (Doklin.entitlements),
        // or as the page there hands it on (`doklin://`, Info.plist).
        .onOpenURL { url in
            Task { await device.follow(url) }
        }
        .alert("Can't open that link", isPresented: linkProblemShown) {
            Button("OK", role: .cancel) { device.dismissLinkProblem() }
        } message: {
            Text(device.linkProblem ?? "")
        }
    }

    private var linkProblemShown: Binding<Bool> {
        Binding(get: { device.linkProblem != nil }, set: { if !$0 { device.dismissLinkProblem() } })
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
