import DoklinKit
import SwiftUI

/// Every version of one note, newest first, by day: who kept each and why.
/// A version opens read-only, to compare or restore. The list itself reads
/// and never writes, but for naming a version — which keeps it for good.
struct NoteHistoryView: View {
    @State private var model: NoteHistory
    @State private var naming = ""
    @State private var savingName = false
    @State private var expanded: Set<Date> = []
    @State private var failure: String?

    init(workspace: Workspace, path: String) {
        _model = State(initialValue: NoteHistory(workspace: workspace, path: path))
    }

    private var workspace: Workspace { model.workspace }

    var body: some View {
        let dates = HistoryDates()
        List {
            Section {
                Text(model.trust(dates))
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
                    .accessibilityIdentifier("history-trust")
                TextField("Name this version", text: $naming)
                    .submitLabel(.done)
                    .onSubmit { name() }
                    .disabled(model.history == nil || savingName)
                    .accessibilityIdentifier("name-version")
            } footer: {
                Text("A named version is kept for good, however old it gets.")
            }
            ForEach(dates.groups(model.versions)) { group in
                Section {
                    if group.recent || expanded.contains(group.day) {
                        ForEach(group.items) { version in
                            if let opened = model.open(version) {
                                NavigationLink(value: Route.history(.version(opened))) {
                                    VersionRow(version: version, dates: dates)
                                }
                                .accessibilityIdentifier("version-row")
                            }
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
        .navigationTitle("Version history")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        .onChange(of: workspace.changes) {
            // Sync, or a restore, wrote the note: it has a new version.
            if workspace.lastChanged.contains(model.path.lowercased()) { Task { await model.load() } }
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

    @ViewBuilder private var emptiness: some View {
        switch model.phase {
        case .failed(let message):
            ContentUnavailableView("Could not read this note's history", systemImage: "clock.badge.exclamationmark", description: Text(message))
        case .loaded where model.versions.isEmpty:
            ContentUnavailableView(
                "No versions yet",
                systemImage: "clock",
                description: Text("No versions of this document yet. One is kept a couple of minutes after you stop typing.")
            )
        case .idle, .loading:
            ProgressView()
        default:
            EmptyView()
        }
    }

    private func name() {
        let label = naming
        guard !label.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        savingName = true
        Task {
            defer { savingName = false }
            do {
                try await model.name(label)
                naming = ""
            } catch {
                failure = HistoryWords.failed("That version could not be named", error)
            }
        }
    }
}

/// One version in a list: when, whether it is named or what the note says
/// now, its name, who kept it and why, and what it was restored from.
private struct VersionRow: View {
    let version: FileVersion
    let dates: HistoryDates

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(dates.time(version.ts))
                    .font(.body.monospacedDigit())
                    .foregroundStyle(Theme.text1)
                if version.pinned {
                    Image(systemName: "pin.fill")
                        .font(.caption2)
                        .foregroundStyle(Theme.accent)
                        .accessibilityLabel("Named — never thinned")
                }
                if version.current {
                    Text("current")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Theme.accentWash, in: Capsule())
                }
            }
            if let label = version.label {
                Text(label)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.text1)
            }
            let meta = [version.by, HistoryWords.reason(version.reason)].filter { !$0.isEmpty }.joined(separator: " · ")
            if !meta.isEmpty {
                Text(meta)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
            }
            if let from = version.restoredFrom {
                Text("restored from \(dates.day(from)) \(dates.time(from))")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
