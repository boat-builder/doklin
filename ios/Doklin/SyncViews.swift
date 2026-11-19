import DoklinKit
import SwiftUI

/// One workspace's screens, as the tabs share them: which tab is showing,
/// what each has pushed, and the sheets and questions any screen can raise.
@MainActor
@Observable
final class Shell {
    enum Tab: Hashable {
        case home, browse, search
    }

    var tab: Tab = .home
    var home: [Route] = []
    var browse: [Route] = []
    var search: [Route] = []
    /// The workspace switcher.
    var switching = false
    var joining = false
    /// Sync holds a large deletion: the question about it.
    var confirmingDeletes = false
    /// This device's big changes wait for tomorrow: the question about
    /// sending them now.
    var lifting = false
    /// A sentence the bar above the tabs could only begin, in full.
    var reading: String?
    /// A row Browse should show, from *Show in Browse*.
    var revealing: String?
    /// Documents on screen: they hide the tab bar, and with it the bar above
    /// the tabs, so what was just done shows in their own bar instead.
    var documents = 0

    /// Push `route` over whatever the showing tab has.
    func open(_ route: Route) {
        switch tab {
        case .home: home.append(route)
        case .browse: browse.append(route)
        case .search: search.append(route)
        }
    }

    /// Show `path` in the tree.
    func showInBrowse(_ path: String) {
        revealing = path
        browse = []
        tab = .browse
    }

    /// Close every screen that `gone` says goes.
    func close(where gone: (Route) -> Bool) {
        home.removeAll(where: gone)
        browse.removeAll(where: gone)
        search.removeAll(where: gone)
    }
}

/// How a workspace's sync stands, in the Mac's words (`syncWords`,
/// src/cloud.ts; the limits' in Limits.swift — change both).
enum SyncWords {
    static func time(_ ms: Int) -> String {
        HistoryDates().time(ms)
    }

    static func line(_ status: CloudStatus) -> String {
        if let hold = status.hold { return LimitWords.line(hold, time: time) }
        switch status.phase {
        case .idle: return status.lastSyncMs == nil ? "Not synced yet" : "Synced"
        case .syncing: return "Syncing…"
        case .offline: return "Offline — changes wait on this iPhone"
        case .paused: return "Sync paused"
        case .pendingDeletes: return "\(status.pendingDeletes) deletion\(status.pendingDeletes == 1 ? "" : "s") to confirm"
        case .pendingAdds: return LimitWords.pendingAdds(status.pendingAdds)
        case .workerOutdated: return "Worker update needed — update it from a Mac"
        case .revoked: return "Not signed in"
        case .limited: return status.error ?? "Today’s Cloudflare requests are used up"
        case .error: return status.error.map { "Can't sync: \($0)" } ?? "Can't sync"
        }
    }

    static func tint(_ status: CloudStatus) -> Color {
        switch status.hold {
        case .waiting?, .slow?: return Theme.warnInk
        case .sending?: return Theme.accent
        case nil: break
        }
        switch status.phase {
        case .idle: return Theme.live
        case .syncing: return Theme.accent
        case .offline, .paused: return Theme.text3
        case .pendingDeletes, .pendingAdds, .workerOutdated, .limited: return Theme.warnInk
        case .revoked, .error: return Theme.errorInk
        }
    }

    /// Whether sync needs this person: a hold, a question, an error. The
    /// rest is said quietly, under the workspace's name on Home.
    static func needsYou(_ status: CloudStatus) -> Bool {
        if status.hold != nil { return true }
        switch status.phase {
        case .idle, .syncing, .offline, .paused: return false
        case .pendingDeletes, .pendingAdds, .workerOutdated, .revoked, .limited, .error: return true
        }
    }
}

/// The quiet line under the workspace's name: how sync stands. A tap syncs now.
struct SyncQuietLine: View {
    let workspace: Workspace

    @Environment(Workspaces.self) private var device

    var body: some View {
        if let status = workspace.status {
            Button {
                Task { await device.syncNow(workspace.root) }
            } label: {
                HStack(spacing: 6) {
                    Circle()
                        .fill(SyncWords.tint(status))
                        .frame(width: 7, height: 7)
                    Text(SyncWords.line(status))
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                        .lineLimit(1)
                }
            }
            .buttonStyle(.plain)
            .accessibilityHint("Syncs now")
            .accessibilityIdentifier("sync-status")
        }
    }
}

/// The one bar above the tabs: what was just done, what sync said, and what
/// sync needs from this person — the first of those there is.
struct NeedsYouBar: View {
    let workspace: Workspace

    @Environment(Workspaces.self) private var device
    @Environment(Toaster.self) private var toaster
    @Environment(Shell.self) private var shell

    /// Whether the bar has anything to say.
    static func shows(_ workspace: Workspace, device: Workspaces, toaster: Toaster, shell: Shell) -> Bool {
        (toaster.shown != nil && shell.documents == 0)
            || device.notices.contains { $0.root == workspace.root }
            || workspace.status.map(SyncWords.needsYou) == true
    }

    var body: some View {
        Group {
            if let toast = toaster.shown, shell.documents == 0 {
                row(symbol: symbol(toast.tone), tint: tint(toast.tone), text: toast.text, id: "toast") {
                    if let action = toast.action {
                        Button(action.label) {
                            toaster.dismiss()
                            action.run()
                        }
                        .fontWeight(.semibold)
                    }
                    dismiss { toaster.dismiss() }
                }
            } else if let notice = device.notices.first(where: { $0.root == workspace.root }) {
                row(symbol: "exclamationmark.bubble", tint: Theme.warnInk, text: notice.text, id: "notice") {
                    if let file = notice.path {
                        Button("Open") {
                            device.dismiss(notice)
                            shell.open(.document(file))
                        }
                        .fontWeight(.semibold)
                    }
                    dismiss { device.dismiss(notice) }
                }
            } else if let status = workspace.status {
                sync(status)
            }
        }
        .font(.footnote)
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    @ViewBuilder private func sync(_ status: CloudStatus) -> some View {
        if status.phase == .pendingAdds {
            row(
                symbol: "doc.badge.plus", tint: Theme.warnInk,
                text: LimitWords.adds(status.pendingAdds, in: workspace.adds?.folders ?? []),
                id: "pending-adds"
            ) {
                Button("Not now") { answerAdds(sync: false) }
                Button(LimitWords.syncThem(status.pendingAdds)) { answerAdds(sync: true) }
                    .fontWeight(.semibold)
            }
        } else {
            row(symbol: "circle.fill", tint: SyncWords.tint(status), text: SyncWords.line(status), id: "sync-needs") {
                if status.phase == .pendingDeletes {
                    Button("Review") { shell.confirmingDeletes = true }
                        .fontWeight(.semibold)
                } else if case .waiting(_, _, liftable: true)? = status.hold {
                    Button("Send now") { shell.lifting = true }
                        .fontWeight(.semibold)
                }
            }
        }
    }

    private func row<Actions: View>(
        symbol: String, tint: Color, text: String, id: String, @ViewBuilder actions: () -> Actions
    ) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(symbol == "circle.fill" ? .system(size: 7) : .footnote)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(text)
                .foregroundStyle(Theme.text1)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture { shell.reading = text }
                .accessibilityIdentifier(id)
            actions()
        }
    }

    private func dismiss(_ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Image(systemName: "xmark")
        }
        .accessibilityLabel("Dismiss")
    }

    private func answerAdds(sync: Bool) {
        Task {
            do {
                try await workspace.confirmAdds(sync: sync)
            } catch {
                toaster.show((error as? DoklinError)?.message ?? error.localizedDescription, tone: .error)
            }
        }
    }

    private func symbol(_ tone: Toaster.Toast.Tone) -> String {
        switch tone {
        case .done: return "checkmark.circle"
        case .info: return "info.circle"
        case .error: return "exclamationmark.triangle"
        }
    }

    private func tint(_ tone: Toaster.Toast.Tone) -> Color {
        switch tone {
        case .done: return Theme.live
        case .info: return Theme.text2
        case .error: return Theme.errorInk
        }
    }
}

/// The questions the bar raises, asked over the whole workspace: a held
/// deletion, and sending big changes before tomorrow.
struct SyncQuestions: ViewModifier {
    let workspace: Workspace

    @Environment(Workspaces.self) private var device
    @Environment(Toaster.self) private var toaster
    @Environment(Shell.self) private var shell

    func body(content: Content) -> some View {
        @Bindable var shell = shell
        let status = workspace.status
        return content
            .confirmationDialog(
                "\(status?.pendingDeletes ?? 0) files disappeared from this workspace",
                isPresented: $shell.confirmingDeletes,
                titleVisibility: .visible
            ) {
                Button("Delete them on \(workspace.domain)", role: .destructive) {
                    Task { try? await Engine.shared.run("cloud_confirm_deletes", ["root": .string(workspace.root)]) }
                }
            } message: {
                Text("Sync holds a deletion this large until you say so. Delete them on \(workspace.domain) too, or put the files back and they sync again on their own.")
            }
            .confirmationDialog(
                status?.hold.map { LimitWords.line($0, time: SyncWords.time) } ?? "",
                isPresented: $shell.lifting,
                titleVisibility: .visible
            ) {
                Button("Send them now") { lift() }
            } message: {
                Text(LimitWords.share(of: device.kind, until: status?.usage.resumesAt.map(SyncWords.time)))
            }
            .alert("Doklin", isPresented: Binding(get: { shell.reading != nil }, set: { if !$0 { shell.reading = nil } })) {
                Button("OK", role: .cancel) { shell.reading = nil }
            } message: {
                Text(shell.reading ?? "")
            }
    }

    private func lift() {
        Task {
            do {
                try await workspace.liftWait()
            } catch {
                toaster.show((error as? DoklinError)?.message ?? error.localizedDescription, tone: .error)
            }
        }
    }
}
