import DoklinKit
import SwiftUI

/// One workspace: its folders and documents, pushed one over the other.
struct WorkspaceView: View {
    let session: Session

    @Environment(AccountStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var path: [Route] = []
    @State private var addingWorkspace = false
    @State private var confirmingLogout = false

    var body: some View {
        NavigationStack(path: $path) {
            FolderView(session: session, dir: "", path: $path)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { accountMenu }
                }
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .folder(let dir):
                        FolderView(session: session, dir: dir, path: $path)
                    case .document(let document):
                        DocumentView(session: session, path: document, route: $path)
                    case .search:
                        SearchView(session: session)
                    case .pages:
                        PagesView(session: session)
                    }
                }
        }
        .task { await session.refresh() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            session.woke()
            Task { await session.refresh() }
        }
        .sheet(isPresented: $addingWorkspace) {
            NavigationStack {
                SignInView(canCancel: true)
            }
        }
        .confirmationDialog(
            "Log out of \(session.account.workspace)?",
            isPresented: $confirmingLogout,
            titleVisibility: .visible
        ) {
            Button("Log out", role: .destructive) {
                Task { await store.signOut(session.account) }
            }
        } message: {
            Text("This device stops being able to open the workspace. Nothing in the workspace changes.")
        }
    }

    private var accountMenu: some View {
        Menu {
            Section(session.account.agent) {
                ForEach(store.accounts) { account in
                    Button {
                        store.select(account)
                    } label: {
                        if account.endpoint == session.account.endpoint {
                            Label(account.workspace, systemImage: "checkmark")
                        } else {
                            Text(account.workspace)
                        }
                    }
                }
            }
            Button {
                path.append(.pages)
            } label: {
                Label("Published pages", systemImage: "globe")
            }
            Button {
                addingWorkspace = true
            } label: {
                Label("Add a workspace", systemImage: "plus")
            }
            Button(role: .destructive) {
                confirmingLogout = true
            } label: {
                Label("Log out", systemImage: "rectangle.portrait.and.arrow.right")
            }
        } label: {
            Label("Workspaces", systemImage: "person.crop.circle")
        }
    }
}
