import DoklinKit
import SwiftUI

/// Where in a workspace's history a tap can lead. `Route.history` carries one.
enum HistoryPlace: Hashable {
    /// A note's versions, by its workspace-relative path.
    case note(String)
    /// One version of a note, or the last of a deleted one, read-only.
    case version(OpenVersion)
    /// The moments of the workspace, and of each of its sections.
    case timeline
    /// One moment of a store: what restoring it would change.
    case moment(store: String, SnapshotMeta)
    /// What the workspace's history holds and its folders do not.
    case deleted
}

/// The screen for a place in the history.
struct HistoryScreen: View {
    let place: HistoryPlace
    let workspace: Workspace
    @Binding var route: [Route]

    var body: some View {
        switch place {
        case .note(let path):
            NoteHistoryView(workspace: workspace, path: path)
        case .version(let opened):
            VersionView(workspace: workspace, opened: opened, route: $route)
        case .timeline:
            WorkspaceHistoryView(workspace: workspace)
        case .moment(let store, let moment):
            MomentView(workspace: workspace, store: store, moment: moment)
        case .deleted:
            RecentlyDeletedView(workspace: workspace, route: $route)
        }
    }
}

/// The heading of one day of a history. Today and yesterday stay open;
/// an older day folds to its count, and opens with a tap.
struct DayHeader: View {
    let label: String
    let count: Int
    let recent: Bool
    let open: Bool
    let toggle: () -> Void

    var body: some View {
        if recent {
            words
        } else {
            Button(action: toggle) {
                HStack(spacing: 6) {
                    words
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(open ? "Open" : "Folded")
        }
    }

    private var words: some View {
        HStack(spacing: 6) {
            Text(label)
            Text("\(count)")
                .foregroundStyle(Theme.text3)
            Spacer(minLength: 0)
        }
    }
}

extension Set where Element == Date {
    mutating func flip(_ day: Date) {
        if contains(day) { remove(day) } else { insert(day) }
    }
}
