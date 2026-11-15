import DoklinKit
import SwiftUI
import UIKit

@main
struct DoklinApp: App {
    @State private var store = AccountStore.onDevice()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .tint(Theme.accent)
        }
    }
}

extension AccountStore {
    /// The store this device keeps: the list of workspaces in Application
    /// Support, copies of what was read in Caches, tokens in the Keychain.
    static func onDevice() -> AccountStore {
        let files = FileManager.default
        let support = (files.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? files.temporaryDirectory)
            .appendingPathComponent("Doklin")
        let caches = (files.urls(for: .cachesDirectory, in: .userDomainMask).first ?? files.temporaryDirectory)
            .appendingPathComponent("Doklin")
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        return AccountStore(
            directory: support,
            cacheDirectory: caches,
            secrets: KeychainSecretStore(service: Bundle.main.bundleIdentifier ?? "doklin"),
            clientName: "ios/\(version)"
        )
    }
}

/// What a Mac's Agents panel lists this device as.
enum Device {
    @MainActor static var name: String { UIDevice.current.name }
}

struct RootView: View {
    @Environment(AccountStore.self) private var store

    var body: some View {
        if let session = store.current {
            if let message = session.loggedOut {
                LoggedOutView(session: session, message: message)
            } else {
                WorkspaceView(session: session)
                    .id(session.id)
            }
        } else {
            NavigationStack {
                SignInView()
            }
        }
    }
}

/// The domain said this device's login is gone. Nothing of the workspace is
/// shown past this point: the person removed it, or logged the device out.
struct LoggedOutView: View {
    let session: Session
    let message: String
    @Environment(AccountStore.self) private var store

    var body: some View {
        ContentUnavailableView {
            Label("Logged out of \(session.account.workspace)", systemImage: "person.crop.circle.badge.xmark")
        } description: {
            Text(message)
        } actions: {
            Button("Remove from this device") {
                store.forget(session.account)
            }
            .buttonStyle(.borderedProminent)
        }
        .background(Theme.canvas)
    }
}
