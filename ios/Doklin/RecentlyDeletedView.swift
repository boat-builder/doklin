import DoklinKit
import SwiftUI

/// Every file the workspace's history holds and its folders do not — removed
/// here, on another device, or by a restore. A note comes back with its page
/// and its comments, where it was, or beside it when that name is taken now.
/// Above them, what was shared and deleted for everyone, for whoever can
/// bring it back: it returns whole, with its people and its history.
struct RecentlyDeletedView: View {
    @Binding var route: [Route]
    @Environment(Workspaces.self) private var device
    @Environment(Toaster.self) private var toaster
    @State private var model: RecentlyDeleted
    @State private var restoring: String?
    @State private var failure: String?
    @State private var now = Clock.now

    init(workspace: Workspace, route: Binding<[Route]>) {
        _route = route
        _model = State(initialValue: RecentlyDeleted(workspace: workspace))
    }

    private var workspace: Workspace { model.workspace }

    var body: some View {
        let dates = HistoryDates()
        let shares = DeletedShare.listed(in: workspace.status)
        List {
            if !shares.isEmpty {
                Section {
                    ForEach(shares) { share in
                        row(share)
                    }
                } header: {
                    Text("Shared")
                } footer: {
                    Text(DeletedShare.restoring)
                }
            }
            if !model.documents.isEmpty {
                Section {
                    ForEach(model.documents) { document in
                        row(document, dates)
                    }
                } footer: {
                    Text("Deleted recently, since this iPhone joined. Something deleted comes back where it was, or beside it when that name is taken.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay { if shares.isEmpty { emptiness } }
        .navigationTitle("Recently deleted")
        .navigationBarTitleDisplayMode(.inline)
        .ticking($now)
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: workspace.changes) { Task { await load() } }
        .alert("That did not work", isPresented: failureShown) {
            Button("OK", role: .cancel) { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

    private var failureShown: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    private func load() async {
        await model.load(stores: device.stores(of: workspace))
    }

    /// Something shared, deleted for everyone: it comes back as it was.
    private func row(_ share: DeletedShare) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(share.space.name)
                    .foregroundStyle(Theme.text1)
                    .lineLimit(2)
                Text(share.words(now: now))
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("deleted-share-\(share.space.name)")
            if workspace.may("work") {
                Button(restoring == share.id ? "Bringing it back…" : "Restore") { bringBack(share) }
                    .disabled(restoring != nil)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityIdentifier("restore-share-\(share.space.name)")
            }
        }
        .padding(.vertical, 4)
    }

    private func bringBack(_ share: DeletedShare) {
        restoring = share.id
        Task {
            defer { restoring = nil }
            do {
                try await workspace.restore(share)
                toaster.show(share.restored)
            } catch {
                failure = HistoryWords.failed("Couldn't bring “\(share.space.name)” back", error)
            }
        }
    }

    private func row(_ document: DeletedDocument, _ dates: HistoryDates) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(document.name)
                    .foregroundStyle(Theme.text1)
                    .lineLimit(2)
                Text("\(model.place(of: document)) · last seen \(Clock.ago(document.lastSeenMs))")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("deleted-\(document.name)")
            HStack(spacing: 10) {
                if workspace.may("work") {
                    Button(restoring == document.id ? "Bringing it back…" : "Restore") { bringBack(document) }
                        .disabled(restoring != nil)
                        .accessibilityIdentifier("restore-\(document.name)")
                }
                Button("Open") { route.append(.history(.version(model.open(document)))) }
                    .accessibilityIdentifier("open-\(document.name)")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private var emptiness: some View {
        switch model.phase {
        case .failed(let message):
            ContentUnavailableView("Could not read what was deleted", systemImage: "exclamationmark.triangle", description: Text(message))
        case .loaded where model.documents.isEmpty:
            ContentUnavailableView(
                "Nothing deleted",
                systemImage: "trash",
                description: Text("Nothing has been deleted from this workspace.")
            )
        case .idle, .loading:
            ProgressView()
        default:
            EmptyView()
        }
    }

    private func bringBack(_ document: DeletedDocument) {
        restoring = document.id
        Task {
            defer { restoring = nil }
            do {
                let path = try await document.bringBack(in: workspace)
                await load()
                toaster.show("\(document.name) is back.", action: Toaster.Action(label: "Open") { [$route] in
                    $route.wrappedValue.append(.document(path))
                })
            } catch {
                failure = HistoryWords.failed("Couldn't bring that file back", error)
            }
        }
    }
}
