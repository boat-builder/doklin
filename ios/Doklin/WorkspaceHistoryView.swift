import DoklinKit
import SwiftUI

/// The workspace as it was: every moment this iPhone kept of it, by day,
/// with what each changed. A section (Private, a restricted folder) keeps
/// moments of its own, picked from the bar.
struct WorkspaceHistoryView: View {
    @Environment(Workspaces.self) private var device
    @State private var timeline: WorkspaceTimeline
    @State private var expanded: Set<Date> = []

    init(workspace: Workspace) {
        _timeline = State(initialValue: WorkspaceTimeline(workspace: workspace, store: workspace.root))
    }

    private var workspace: Workspace { timeline.workspace }

    var body: some View {
        let dates = HistoryDates()
        let stores = device.stores(of: workspace)
        List {
            Section {
                if stores.count > 1 {
                    Picker("Folder", selection: Binding(get: { timeline.store }, set: { store in Task { await timeline.show(store) } })) {
                        ForEach(stores, id: \.self) { store in
                            Text(workspace.storeName(store)).tag(store)
                        }
                    }
                    .accessibilityIdentifier("history-folder")
                }
            } footer: {
                Text("What this iPhone kept since it joined. Pick a moment to see what restoring it would change.")
            }
            ForEach(dates.groups(timeline.moments)) { group in
                Section {
                    if group.recent || expanded.contains(group.day) {
                        ForEach(group.items) { moment in
                            NavigationLink(value: Route.history(.moment(store: timeline.store, moment))) {
                                MomentRow(moment: moment, dates: dates)
                            }
                            .accessibilityIdentifier("moment-row")
                        }
                    }
                } header: {
                    DayHeader(label: group.label, count: group.items.count, recent: group.recent, open: expanded.contains(group.day)) {
                        expanded.flip(group.day)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay { emptiness }
        .navigationTitle(timeline.store == workspace.root ? "Workspace history" : "\(workspace.storeName(timeline.store)) history")
        .navigationBarTitleDisplayMode(.inline)
        .task { await timeline.load() }
        .refreshable { await timeline.load() }
        .onChange(of: workspace.changes) { Task { await timeline.load() } }
        .onChange(of: workspace.left) { _, left in
            // The section shown left this iPhone, its history with it.
            if let left, workspace.relative(timeline.store).map(left.holds) == true {
                Task { await timeline.show(workspace.root) }
            }
        }
    }

    @ViewBuilder private var emptiness: some View {
        switch timeline.phase {
        case .failed(let message):
            ContentUnavailableView("Could not read the history", systemImage: "clock.badge.exclamationmark", description: Text(message))
        case .loaded where timeline.moments.isEmpty:
            ContentUnavailableView(
                "No versions yet",
                systemImage: "clock",
                description: Text("No versions of this folder yet. One is kept a couple of minutes after you stop typing.")
            )
        case .idle, .loading:
            ProgressView()
        default:
            EmptyView()
        }
    }
}

private struct MomentRow: View {
    let moment: SnapshotMeta
    let dates: HistoryDates

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(dates.time(moment.ts))
                    .font(.body.monospacedDigit())
                    .foregroundStyle(Theme.text1)
                Text(HistoryWords.delta(moment))
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(Theme.text2)
                if moment.pinned {
                    Image(systemName: "pin.fill")
                        .font(.caption2)
                        .foregroundStyle(Theme.accent)
                        .accessibilityLabel("Named — never thinned")
                }
            }
            if let label = moment.label {
                Text(label)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.text1)
            }
            let reason = HistoryWords.reason(moment.reason)
            if !reason.isEmpty {
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// One moment: every file restoring it would touch — what changes, what
/// comes back, what is removed — ticked to begin with. A restore asks first,
/// with the real counts; what it replaces is kept as a moment of its own
/// first, so it can be undone.
struct MomentView: View {
    @State private var plan: MomentPlan
    @State private var confirming: Bool?
    @State private var restoring = false
    @State private var failure: String?
    @Environment(Toaster.self) private var toaster

    init(workspace: Workspace, store: String, moment: SnapshotMeta) {
        _plan = State(initialValue: MomentPlan(workspace: workspace, store: store, moment: moment))
    }

    private var workspace: Workspace { plan.workspace }

    var body: some View {
        let dates = HistoryDates()
        List {
            if !plan.rows.isEmpty {
                Section {
                    ForEach(plan.rows) { row in
                        PlanRowView(row: row, ticked: plan.ticked.contains(row.path), mayChange: workspace.may("work")) {
                            plan.toggle(row.path)
                        }
                    }
                } header: {
                    Text("If you restore this moment")
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("A snapshot of now is taken first, so this can be undone.")
                        if plan.removes(all: true) {
                            Text("This iPhone has no Trash: a file the restore removes is gone from every device, and stays in the history, under Recently deleted.")
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .safeAreaInset(edge: .top, spacing: 0) {
            if workspace.may("work"), !plan.rows.isEmpty {
                HStack(spacing: 12) {
                    Button("Restore selected") { confirming = false }
                        .disabled(plan.ticked.isEmpty || restoring)
                        .accessibilityIdentifier("restore-selected")
                    Spacer(minLength: 0)
                    Button(restoring ? "Restoring…" : "Restore all") { confirming = true }
                        .disabled(restoring)
                        .accessibilityIdentifier("restore-all")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .font(.footnote.weight(.semibold))
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Theme.sunken)
            }
        }
        .overlay { emptiness }
        .navigationTitle(dates.moment(plan.moment.ts))
        .navigationBarTitleDisplayMode(.inline)
        .task { await plan.load() }
        .confirmationDialog(
            plan.question(all: confirming ?? false),
            isPresented: confirmingShown,
            titleVisibility: .visible
        ) {
            Button("Restore", role: .destructive) {
                if let all = confirming { restore(all: all) }
            }
            .disabled(plan.scope(all: confirming ?? false).isEmpty)
            Button("Cancel", role: .cancel) { confirming = nil }
        } message: {
            if plan.removes(all: confirming ?? false) {
                Text("What is removed goes from every device. It stays in the history, under Recently deleted.")
            }
        }
        .alert("That did not work", isPresented: failureShown) {
            Button("OK", role: .cancel) { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

    private var confirmingShown: Binding<Bool> {
        Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })
    }

    private var failureShown: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    @ViewBuilder private var emptiness: some View {
        switch plan.phase {
        case .failed(let message):
            ContentUnavailableView("Could not compare", systemImage: "exclamationmark.triangle", description: Text(message))
        case .loaded where plan.rows.isEmpty:
            ContentUnavailableView(
                "Nothing to restore",
                systemImage: "checkmark.circle",
                description: Text("This is exactly what the folder holds now — there is nothing to restore.")
            )
        case .idle, .loading:
            ProgressView("Comparing this folder with that moment…")
        default:
            EmptyView()
        }
    }

    private func restore(all: Bool) {
        confirming = nil
        restoring = true
        Task {
            defer { restoring = false }
            do {
                let (report, paths) = try await plan.restore(all: all)
                let store = plan.store
                let toaster = toaster
                toaster.show(
                    HistoryWords.restored(report),
                    tone: report.written + report.trashed > 0 ? .done : .info,
                    action: report.preRestoreTs == nil ? nil : Toaster.Action(label: "Undo") {
                        Task {
                            do {
                                try await MomentPlan.undo(report, paths: paths, store: store)
                            } catch {
                                toaster.show(HistoryWords.failed("Couldn't undo that restore", error), tone: .error)
                            }
                        }
                    }
                )
            } catch {
                failure = HistoryWords.failed("Couldn't restore that moment", error)
            }
        }
    }
}

/// One file of a moment's plan: ticked or not, its name and folder, and
/// what a restore does to it.
private struct PlanRowView: View {
    let row: PlanRow
    let ticked: Bool
    let mayChange: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 12) {
                if mayChange {
                    Image(systemName: ticked ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(ticked ? Theme.accent : Theme.text3)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(DocLinks.name(of: row.path))
                        .foregroundStyle(Theme.text1)
                        .lineLimit(2)
                    let folder = DocLinks.directory(of: row.path)
                    if !folder.isEmpty {
                        Text(folder)
                            .font(.footnote)
                            .foregroundStyle(Theme.text3)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                Text(row.word)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(row.kind == .isRemoved ? Theme.errorInk : Theme.text2)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(row.kind == .isRemoved ? Theme.errorInk.opacity(0.12) : Theme.sunken, in: Capsule())
            }
        }
        .buttonStyle(.plain)
        .disabled(!mayChange)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(ticked && mayChange ? .isSelected : [])
        .accessibilityIdentifier("plan-row")
    }
}
