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
    /// What has not synced would go with the copy: asked once more.
    @State private var confirmingUnsynced = false
    @State private var leaving = false
    @State private var publishingWorkspace = false
    @State private var failure: String?
    @State private var question: Question?
    @State private var toaster = Toaster()

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
                    case .history(let place):
                        HistoryScreen(place: place, workspace: workspace, route: $path)
                    case .people:
                        PeopleView(workspace: workspace)
                    case .devices:
                        DevicesView(workspace: workspace)
                    case .agents:
                        AgentsView(workspace: workspace)
                    case .hereNow:
                        HereNowView(workspace: workspace)
                    case .access(let id):
                        SpaceAccessView(workspace: workspace, id: id)
                    case .publishedPages:
                        PublishedPagesView(workspace: workspace, route: $path)
                    }
                }
        }
        .onChange(of: workspace.left) { _, left in
            if let left { close(left) }
        }
        // What sync said, and what was just done, sit over the sync line, as
        // a Mac's notes sit at the bottom: at the top they would cover the
        // screen's navigation bar.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                adds
                notice
                ToastBar(toaster: toaster)
                SyncLine(workspace: workspace)
            }
            .animation(.default, value: toaster.shown?.id)
        }
        .environment(toaster)
        .sheet(isPresented: $joining) {
            NavigationStack {
                SignInView(canCancel: true)
            }
        }
        .sheet(isPresented: $publishingWorkspace) {
            PublishView(workspace: workspace, path: "", kind: .dir) { path.append(.publishedPages) }
        }
        .confirmationDialog(
            "Remove \(workspace.name) from this iPhone?",
            isPresented: $confirmingLeave,
            titleVisibility: .visible
        ) {
            Button("Remove from this iPhone", role: .destructive) { leave(checked: false) }
        } message: {
            Text("This iPhone is signed out of \(workspace.name) and its copy here is deleted. Nothing changes for anybody else, and nothing is deleted in the cloud.")
        }
        .confirmationDialog(
            "Some changes have not synced",
            isPresented: $confirmingUnsynced,
            titleVisibility: .visible
        ) {
            Button("Remove anyway", role: .destructive) { leave(checked: true) }
        } message: {
            Text("Changes made on this iPhone that have not reached \(workspace.domain) yet are deleted with its copy. To keep them, connect to the internet and let it sync first.")
        }
        .overlay {
            if leaving {
                ProgressView("Syncing before removing…")
                    .padding(20)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .asking($question)
        .alert("That did not work", isPresented: failureShown) {
            Button("OK", role: .cancel) { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

    private var failureShown: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    /// A restricted folder left this iPhone: every screen inside it closes,
    /// and its access screen, as a Mac closes its tabs. The rest stay.
    private func close(_ left: FolderLeft) {
        path.removeAll { route in
            switch route {
            case .folder(let dir), .document(let dir):
                return left.holds(dir)
            case .access(let id):
                // Still listed when the engine says it left, or listed no more.
                return workspace.space(id: id).map { left.holds($0.path) } ?? true
            case .history(.note(let note)):
                return left.holds(note)
            case .history(.version(let opened)):
                return left.holds(opened.path) || (workspace.relative(opened.store).map(left.holds) ?? false)
            case .history(.moment(let store, _)):
                return workspace.relative(store).map(left.holds) ?? false
            default:
                return false
            }
        }
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
                    path.append(.people)
                } label: {
                    Label("People", systemImage: "person.2")
                }
                if workspace.may("devices.own") {
                    Button {
                        path.append(.devices)
                    } label: {
                        Label("Devices", systemImage: "laptopcomputer.and.iphone")
                    }
                }
                if workspace.may("agents.own") {
                    Button {
                        path.append(.agents)
                    } label: {
                        Label("Agents", systemImage: "terminal")
                    }
                }
                Button {
                    path.append(.hereNow)
                } label: {
                    Label("Here now", systemImage: "dot.radiowaves.left.and.right")
                }
            }
            Section {
                Button {
                    path.append(.history(.timeline))
                } label: {
                    Label("Workspace history", systemImage: "clock.arrow.circlepath")
                }
                Button {
                    path.append(.history(.deleted))
                } label: {
                    Label("Recently deleted", systemImage: "trash")
                }
            }
            Section {
                Button {
                    path.append(.publishedPages)
                } label: {
                    Label("Published pages (\(workspace.status?.public.count ?? 0))", systemImage: "globe")
                }
                if workspace.mayPublish {
                    Button {
                        publishingWorkspace = true
                    } label: {
                        Label(workspace.pages(of: "").contains { $0.kind == .dir } ? "Edit the workspace’s page…" : "Publish the whole workspace…", systemImage: "network")
                    }
                }
            }
            Section {
                plan
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

    /// The Cloudflare plan the domain's limits come from: the superadmin's to
    /// change, from any device of theirs; everybody else reads it.
    @ViewBuilder private var plan: some View {
        if let status = workspace.status, let plan = status.usage.plan {
            let words = "Cloudflare plan: \(LimitWords.plan(plan))"
            if status.can.contains("workspace.manage") {
                Menu {
                    Picker(words, selection: Binding(get: { plan }, set: { ask(plan: $0, from: plan) })) {
                        ForEach(CloudPlan.allCases, id: \.self) { choice in
                            Text(LimitWords.plan(choice)).tag(choice)
                        }
                    }
                } label: {
                    Label(words, systemImage: "cloud")
                }
            } else {
                Button {} label: {
                    Label(words, systemImage: "cloud")
                }
                .disabled(true)
            }
        }
    }

    private func ask(plan: CloudPlan, from current: CloudPlan) {
        guard plan != current else { return }
        let named = LimitWords.plan(plan)
        question = Question(
            "Change the Cloudflare plan to \(named)?", LimitWords.planChange(to: plan), button: "Use \(named)", destructive: false
        ) {
            do {
                try await workspace.setPlan(plan)
            } catch {
                failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
    }

    /// Many new documents appeared at once: they wait for this person's yes,
    /// while edits, moves and deletions go on.
    @ViewBuilder private var adds: some View {
        if let status = workspace.status, status.phase == .pendingAdds {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "doc.badge.plus")
                        .foregroundStyle(Theme.warnInk)
                    Text(LimitWords.adds(status.pendingAdds, in: workspace.adds?.folders ?? [], workspace: workspace.name))
                        .font(.footnote)
                        .foregroundStyle(Theme.text1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("pending-adds")
                }
                HStack(spacing: 20) {
                    Spacer()
                    Button("Not now") { answerAdds(sync: false) }
                    Button(LimitWords.syncThem(status.pendingAdds)) { answerAdds(sync: true) }
                        .fontWeight(.semibold)
                }
                .font(.footnote)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Theme.sunken)
        }
    }

    private func answerAdds(sync: Bool) {
        Task {
            do {
                try await workspace.confirmAdds(sync: sync)
            } catch {
                failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
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

    /// Remove the workspace — once what was written here has synced, or
    /// after the person said to go ahead without it.
    private func leave(checked: Bool) {
        let (root, name) = (workspace.root, workspace.name)
        Task {
            if !checked {
                leaving = true
                let synced = await device.synced(root)
                leaving = false
                guard synced else {
                    confirmingUnsynced = true
                    return
                }
            }
            do {
                if try await !device.leave(root) {
                    failure = "This iPhone is signed out of \(name), but its copy here could not be deleted. Nothing was deleted in the cloud."
                }
            } catch {
                failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
    }
}

/// How the workspace's sync stands, in the Mac's words — and, when it is
/// holding a large deletion, the way to let it go ahead; when this device's
/// share of today's big changes is spent, the way to send them anyway.
struct SyncLine: View {
    let workspace: Workspace

    @Environment(Workspaces.self) private var device
    @Environment(Toaster.self) private var toaster
    @State private var confirming = false
    @State private var lifting = false

    var body: some View {
        if let status = workspace.status {
            let hold = status.hold
            HStack(spacing: 8) {
                Circle()
                    .fill(tint(status, hold))
                    .frame(width: 7, height: 7)
                Text(words(status, hold))
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
                    .accessibilityIdentifier("sync-status")
                Spacer(minLength: 8)
                if status.phase == .pendingDeletes {
                    Button("Review") { confirming = true }
                        .font(.footnote)
                } else if case .waiting(_, _, liftable: true)? = hold {
                    Button("Send now") { lifting = true }
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
            .confirmationDialog(
                hold.map { LimitWords.line($0, time: time) } ?? "",
                isPresented: $lifting,
                titleVisibility: .visible
            ) {
                Button("Send them now") { lift() }
            } message: {
                Text(LimitWords.share(of: device.kind, until: status.usage.resumesAt.map(time)))
            }
        }
    }

    /// A moment as a time of day, in this person's language and zone: 05:30.
    private func time(_ ms: Int) -> String {
        HistoryDates().time(ms)
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

    private func words(_ status: CloudStatus, _ hold: SyncHold?) -> String {
        if let hold { return LimitWords.line(hold, time: time) }
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

    private func tint(_ status: CloudStatus, _ hold: SyncHold?) -> Color {
        switch hold {
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
}
