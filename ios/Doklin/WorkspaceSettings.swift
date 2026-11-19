import DoklinKit
import SwiftUI

/// The workspace's name, tapped: this iPhone's workspaces, how the one in
/// view syncs and who is in it now, and the way to its people and settings.
struct WorkspaceSwitcher: View {
    let workspace: Workspace

    @Environment(Workspaces.self) private var device
    @Environment(Shell.self) private var shell
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) {
                        WorkspaceBadge(name: workspace.name, size: 40)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(workspace.name)
                                .font(.headline)
                            Text(workspace.domain)
                                .font(.footnote)
                                .foregroundStyle(Theme.text3)
                            SyncQuietLine(workspace: workspace)
                        }
                        Spacer(minLength: 8)
                        Button("Sync now") {
                            Task { await device.syncNow(workspace.root) }
                        }
                        .buttonStyle(.glass)
                    }
                    if let here = hereNow {
                        Button {
                            go(.hereNow)
                        } label: {
                            Label(here, systemImage: "dot.radiowaves.left.and.right")
                                .foregroundStyle(Theme.text1)
                        }
                    }
                    Button {
                        go(.people)
                    } label: {
                        Label("People", systemImage: "person.2")
                    }
                    Button {
                        go(.settings)
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                    .accessibilityIdentifier("workspace-settings")
                }
                let others = device.statuses.filter { $0.root != workspace.root }
                if !others.isEmpty {
                    Section("Also on this \(device.kind)") {
                        ForEach(others) { status in
                            Button {
                                dismiss()
                                device.select(status.root)
                            } label: {
                                HStack(spacing: 12) {
                                    WorkspaceBadge(name: status.name, size: 32)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(status.name)
                                            .foregroundStyle(Theme.text1)
                                        Text(SyncWords.line(status))
                                            .font(.footnote)
                                            .foregroundStyle(Theme.text2)
                                    }
                                }
                            }
                        }
                    }
                }
                Section {
                    Button {
                        dismiss()
                        shell.joining = true
                    } label: {
                        Label("Join another workspace", systemImage: "plus")
                    }
                }
            }
            .navigationTitle("Workspaces")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// Who else is here now, in a line: "Here now: Maya on her Mac, Tom on iPhone".
    private var hereNow: String? {
        guard let presence = workspace.status?.presence, !presence.isEmpty else { return nil }
        let names = presence.prefix(3).map { "\($0.name) on \($0.device)" }
        let more = presence.count > 3 ? " and \(presence.count - 3) more" : ""
        return "Here now: " + names.joined(separator: ", ") + more
    }

    private func go(_ route: Route) {
        dismiss()
        shell.tab = .home
        shell.home.append(route)
    }
}

/// A workspace's settings: how it syncs and on which plan, its people,
/// agents and devices, its pages and history, and taking it off this iPhone.
struct SettingsView: View {
    let workspace: Workspace
    @Binding var path: [Route]

    @Environment(Workspaces.self) private var device
    @State private var confirmingLeave = false
    /// What has not synced would go with the copy: asked once more.
    @State private var confirmingUnsynced = false
    @State private var leaving = false
    @State private var publishingLibrary = false
    @State private var failure: String?
    @State private var question: Question?

    var body: some View {
        List {
            Section {
                HStack {
                    SyncQuietLine(workspace: workspace)
                    Spacer()
                    Button("Sync now") {
                        Task { await device.syncNow(workspace.root) }
                    }
                }
                plan
            } header: {
                Text(workspace.domain)
            }
            Section("People and access") {
                row("People", "person.2", .people)
                if workspace.may("agents.own") { row("Your agents", "terminal", .agents) }
                if workspace.may("devices.own") { row("Your devices", "laptopcomputer.and.iphone", .devices) }
                row("Here now", "dot.radiowaves.left.and.right", .hereNow, count: workspace.status?.presence.count)
            }
            Section("Pages and history") {
                row("Published pages", "globe", .publishedPages, count: workspace.status?.public.count)
                if workspace.mayPublish {
                    Button {
                        publishingLibrary = true
                    } label: {
                        Label(workspace.pages(of: TreeModel.libraryFolder).contains { $0.kind == .dir } ? "Edit Library’s page…" : "Publish Library…", systemImage: "network")
                    }
                }
                row("Workspace history", "clock.arrow.circlepath", .history(.timeline))
                row("Recently deleted", "trash", .history(.deleted))
            }
            Section {
                Button(role: .destructive) {
                    confirmingLeave = true
                } label: {
                    Label("Remove from this \(device.kind)", systemImage: "iphone.slash")
                }
            } header: {
                Text("This \(device.kind)")
            } footer: {
                Text("Signs this \(device.kind) out of \(workspace.name) and deletes its copy here. Nothing changes for anybody else.")
            }
        }
        .navigationTitle(workspace.name)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $publishingLibrary) {
            PublishView(workspace: workspace, path: TreeModel.libraryFolder, kind: .dir) { path.append(.publishedPages) }
        }
        .confirmationDialog(
            "Remove \(workspace.name) from this \(device.kind)?",
            isPresented: $confirmingLeave,
            titleVisibility: .visible
        ) {
            Button("Remove from this \(device.kind)", role: .destructive) { leave(checked: false) }
        } message: {
            Text("This \(device.kind) is signed out of \(workspace.name) and its copy here is deleted. Nothing changes for anybody else, and nothing is deleted in the cloud.")
        }
        .confirmationDialog(
            "Some changes have not synced",
            isPresented: $confirmingUnsynced,
            titleVisibility: .visible
        ) {
            Button("Remove anyway", role: .destructive) { leave(checked: true) }
        } message: {
            Text("Changes made on this \(device.kind) that have not reached \(workspace.domain) yet are deleted with its copy. To keep them, connect to the internet and let it sync first.")
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

    private func row(_ title: String, _ symbol: String, _ route: Route, count: Int? = nil) -> some View {
        NavigationLink(value: route) {
            HStack {
                Label(title, systemImage: symbol)
                if let count, count > 0 {
                    Spacer()
                    Text("\(count)")
                        .foregroundStyle(Theme.text3)
                        .monospacedDigit()
                }
            }
        }
    }

    private var failureShown: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    /// The Cloudflare plan the domain's limits come from: the superadmin's to
    /// change, from any device of theirs; everybody else reads it.
    @ViewBuilder private var plan: some View {
        if let status = workspace.status, let plan = status.usage.plan {
            if status.can.contains("workspace.manage") {
                Picker(selection: Binding(get: { plan }, set: { ask(plan: $0, from: plan) })) {
                    ForEach(CloudPlan.allCases, id: \.self) { choice in
                        Text(LimitWords.plan(choice)).tag(choice)
                    }
                } label: {
                    Label("Cloudflare plan", systemImage: "cloud")
                }
            } else {
                LabeledContent {
                    Text(LimitWords.plan(plan))
                } label: {
                    Label("Cloudflare plan", systemImage: "cloud")
                }
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
                    failure = "This \(device.kind) is signed out of \(name), but its copy here could not be deleted. Nothing was deleted in the cloud."
                }
            } catch {
                failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
    }
}
