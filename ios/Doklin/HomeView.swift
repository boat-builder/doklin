import DoklinKit
import SwiftUI

/// Home: what changed in the workspace, newest first, by whom — and a dot
/// on what changed since this person last read it here. The workspace's
/// name, top left, switches workspaces and leads to its settings.
struct HomeView: View {
    let workspace: Workspace

    @Environment(Shell.self) private var shell
    @State private var model: RecentModel

    init(workspace: Workspace) {
        self.workspace = workspace
        _model = State(initialValue: RecentModel(workspace: workspace))
    }

    var body: some View {
        List {
            Section {
                SyncQuietLine(workspace: workspace)
                    .listRowSeparator(.hidden)
                filters
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
            }
            ForEach(model.days()) { day in
                Section {
                    ForEach(day.items) { item in
                        NavigationLink(value: Route.document(item.path)) {
                            RecentRow(item: item, excerpt: model.excerpt(item), workspace: workspace)
                        }
                        .accessibilityIdentifier("recent-\(item.name)")
                    }
                } header: {
                    Text(day.label)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.text2)
                        .textCase(nil)
                }
            }
        }
        .listStyle(.plain)
        .overlay { emptiness }
        .navigationTitle("Recent changes")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    shell.switching = true
                } label: {
                    HStack(spacing: 6) {
                        WorkspaceBadge(name: workspace.name, size: 24)
                        Text(workspace.name)
                            .font(.headline)
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.text3)
                    }
                }
                .accessibilityLabel("\(workspace.name), workspaces and settings")
                .accessibilityIdentifier("workspace-menu")
            }
        }
        .refreshable {
            await workspace.syncNow()
            await model.load()
        }
        .task { await model.load() }
        .onChange(of: workspace.changes) { Task { await model.load() } }
        .onChange(of: workspace.status?.lastSyncMs) { Task { await model.load() } }
    }

    private var filters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(RecentFilter.allCases, id: \.self) { filter in
                    let on = model.filter == filter
                    Button {
                        model.filter = filter
                    } label: {
                        Text(filter == .unread && model.unreadCount > 0 ? "\(filter.label) \(model.unreadCount)" : filter.label)
                            .font(.subheadline.weight(.medium))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 7)
                            .foregroundStyle(on ? Theme.sheet : Theme.text1)
                            .background(on ? Theme.text1 : Theme.sunken, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .accessibilityIdentifier("filter-\(filter.rawValue)")
                }
            }
            .padding(.horizontal, 16)
        }
    }

    @ViewBuilder private var emptiness: some View {
        if model.items.isEmpty {
            switch model.phase {
            case .failed(let message):
                ContentUnavailableView("Could not read what changed", systemImage: "exclamationmark.triangle", description: Text(message))
            case .loaded where model.filter == .all:
                ContentUnavailableView(
                    "Nothing has changed yet",
                    systemImage: "clock",
                    description: Text("What anybody makes or changes in \(workspace.name) shows here, newest first.")
                )
            case .loaded:
                ContentUnavailableView(
                    model.filter == .unread ? "Nothing unread" : "Nothing here",
                    systemImage: "line.3.horizontal.decrease.circle",
                    description: Text(model.filter == .unread ? "You have read everything that changed." : "Nothing that changed lately matches.")
                )
            default:
                ProgressView()
            }
        }
    }
}

/// One document in Home's list.
struct RecentRow: View {
    let item: RecentItem
    let excerpt: String?
    let workspace: Workspace

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(item.unread ? Theme.accent : Color.clear)
                .frame(width: 8, height: 8)
                .padding(.top, 7)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline) {
                    if item.isPage {
                        Image(systemName: "doc.richtext")
                            .font(.footnote)
                            .foregroundStyle(Theme.text2)
                            .accessibilityLabel("Page")
                    }
                    Text(item.name)
                        .font(.body.weight(item.unread ? .semibold : .medium))
                        .foregroundStyle(Theme.text1)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    Text(RecentWords.time(item.changed))
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                        .monospacedDigit()
                }
                HStack(spacing: 6) {
                    WhoBadge(item: item, size: 18)
                    Text("\(item.who) \(item.verb)")
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                        .lineLimit(1)
                    if item.created, item.unread {
                        NewBadge()
                    }
                }
                if item.changedSinceRead {
                    Text("Changed since you read it")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                } else if let excerpt {
                    Text(excerpt)
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                        .lineLimit(2)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityValue(item.unread ? "Unread" : "")
    }
}

/// Who changed something, as a small badge: an agent's mark, or a person's
/// initials.
struct WhoBadge: View {
    let item: RecentItem
    let size: CGFloat

    var body: some View {
        Group {
            if item.byAgent {
                Image(systemName: "terminal")
                    .font(.system(size: size * 0.55, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .frame(width: size, height: size)
                    .background(Theme.accentWash, in: RoundedRectangle(cornerRadius: size * 0.28))
            } else {
                Text(item.byMe ? "Y" : WhoWords.initials(item.who))
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(Theme.text2)
                    .frame(width: size, height: size)
                    .background(Theme.sunken, in: Circle())
            }
        }
        .accessibilityHidden(true)
    }
}

struct NewBadge: View {
    var body: some View {
        Text("New")
            .font(.caption2.weight(.bold))
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Theme.accentWash, in: Capsule())
    }
}

/// A workspace's first letter in a rounded square: how the switcher and
/// Home's header mark one.
struct WorkspaceBadge: View {
    let name: String
    let size: CGFloat

    var body: some View {
        Text(String(name.first.map { String($0).uppercased() } ?? "?"))
            .font(.system(size: size * 0.5, weight: .bold))
            .foregroundStyle(Theme.sheet)
            .frame(width: size, height: size)
            .background(Theme.accent, in: RoundedRectangle(cornerRadius: size * 0.28))
            .accessibilityHidden(true)
    }
}
