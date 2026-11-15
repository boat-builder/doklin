import DoklinKit
import SwiftUI

/// One workspace: its folders and documents, pushed one over the other,
/// with how its sync stands along the bottom.
struct WorkspaceView: View {
    let workspace: Workspace

    @Environment(Workspaces.self) private var device
    @State private var path: [Route] = []
    @State private var joining = false
    @State private var confirmingLeave = false
    @State private var failure: String?

    var body: some View {
        NavigationStack(path: $path) {
            FolderView(workspace: workspace, dir: "", path: $path)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { menu }
                }
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .folder(let dir):
                        FolderView(workspace: workspace, dir: dir, path: $path)
                    case .document(let file):
                        DocumentView(workspace: workspace, path: file, route: $path)
                    case .search:
                        SearchView(workspace: workspace)
                    }
                }
        }
        .safeAreaInset(edge: .top, spacing: 0) { notice }
        .safeAreaInset(edge: .bottom, spacing: 0) { SyncLine(workspace: workspace) }
        .sheet(isPresented: $joining) {
            NavigationStack {
                SignInView(canCancel: true)
            }
        }
        .confirmationDialog(
            "Remove \(workspace.name) from this iPhone?",
            isPresented: $confirmingLeave,
            titleVisibility: .visible
        ) {
            Button("Remove from this iPhone", role: .destructive) { leave() }
        } message: {
            Text("This iPhone is signed out of \(workspace.name) and its copy here is deleted. Nothing changes for anybody else, and nothing is deleted in the cloud.")
        }
        .alert("That did not work", isPresented: failureShown) {
            Button("OK", role: .cancel) { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

    private var failureShown: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    private var menu: some View {
        Menu {
            Section("Workspaces") {
                ForEach(device.statuses) { status in
                    Button {
                        device.select(status.root)
                    } label: {
                        if status.root == workspace.root {
                            Label(status.name, systemImage: "checkmark")
                        } else {
                            Text(status.name)
                        }
                    }
                }
                Button {
                    joining = true
                } label: {
                    Label("Join another workspace", systemImage: "plus")
                }
            }
            Section {
                Button {
                    Task { await device.syncNow(workspace.root) }
                } label: {
                    Label("Sync now", systemImage: "arrow.triangle.2.circlepath")
                }
                Button(role: .destructive) {
                    confirmingLeave = true
                } label: {
                    Label("Remove from this iPhone", systemImage: "iphone.slash")
                }
            }
        } label: {
            Label(workspace.name, systemImage: "square.stack")
        }
        .accessibilityIdentifier("workspace-menu")
    }

    /// The first thing sync said that has not been read yet.
    @ViewBuilder private var notice: some View {
        if let first = device.notices.first(where: { $0.root == workspace.root }) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.bubble")
                    .foregroundStyle(Theme.warnInk)
                Text(first.text)
                    .font(.footnote)
                    .foregroundStyle(Theme.text1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let file = first.path {
                    Button("Open") {
                        device.dismiss(first)
                        path.append(.document(file))
                    }
                    .font(.footnote)
                }
                Button {
                    device.dismiss(first)
                } label: {
                    Image(systemName: "xmark")
                        .font(.footnote)
                }
                .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Theme.sunken)
        }
    }

    private func leave() {
        Task {
            do {
                try await device.leave(workspace.root)
            } catch {
                failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
    }
}

/// How the workspace's sync stands, in the Mac's words — and, when it is
/// holding a large deletion, the way to let it go ahead.
struct SyncLine: View {
    let workspace: Workspace

    @Environment(Workspaces.self) private var device
    @State private var confirming = false

    var body: some View {
        if let status = workspace.status {
            HStack(spacing: 8) {
                Circle()
                    .fill(tint(status))
                    .frame(width: 7, height: 7)
                Text(words(status))
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
                    .accessibilityIdentifier("sync-status")
                Spacer(minLength: 8)
                if status.phase == .pendingDeletes {
                    Button("Review") { confirming = true }
                        .font(.footnote)
                } else {
                    Text(status.domain)
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(.bar)
            .contentShape(Rectangle())
            .onTapGesture { Task { await device.syncNow(workspace.root) } }
            .confirmationDialog(
                "\(status.pendingDeletes) files disappeared from this workspace",
                isPresented: $confirming,
                titleVisibility: .visible
            ) {
                Button("Delete them on \(status.domain)", role: .destructive) {
                    Task { try? await Engine.shared.run("cloud_confirm_deletes", ["root": .string(workspace.root)]) }
                }
            } message: {
                Text("Sync holds a deletion this large until you say so. Delete them on \(status.domain) too, or put the files back and they sync again on their own.")
            }
        }
    }

    private func words(_ status: CloudStatus) -> String {
        switch status.phase {
        case .idle: return status.lastSyncMs == nil ? "Not synced yet" : "Synced"
        case .syncing: return "Syncing…"
        case .offline: return "Offline — changes wait on this iPhone"
        case .paused: return "Sync paused"
        case .pendingDeletes: return "\(status.pendingDeletes) deletion\(status.pendingDeletes == 1 ? "" : "s") to confirm"
        case .workerOutdated: return "Worker update needed — update it from a Mac"
        case .revoked: return "Not signed in"
        case .error: return status.error.map { "Can't sync: \($0)" } ?? "Can't sync"
        }
    }

    private func tint(_ status: CloudStatus) -> Color {
        switch status.phase {
        case .idle: return Theme.live
        case .syncing: return Theme.accent
        case .offline, .paused: return Theme.text3
        case .pendingDeletes, .workerOutdated: return Theme.warnInk
        case .revoked, .error: return Theme.errorInk
        }
    }
}
