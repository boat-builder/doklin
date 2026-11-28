import DoklinKit
import SwiftUI

/// One workspace, in three tabs: Browse (its tree, the first), Recent (what
/// changed) and Search — each with its own screens pushed over it. A followed
/// link's page opens over Browse, whatever tab was showing, so Back always
/// leads to the tree.
/// What sync needs from this person, and what was just done, sit in one bar
/// above the tabs.
struct WorkspaceView: View {
    let workspace: Workspace

    @Environment(Workspaces.self) private var device
    @State private var shell = Shell()
    @State private var toaster = Toaster()

    var body: some View {
        @Bindable var shell = shell
        TabView(selection: $shell.tab) {
            Tab("Browse", systemImage: "folder", value: Shell.Tab.browse) {
                BrowseTab(workspace: workspace, path: $shell.browse)
            }
            Tab("Recent", systemImage: "clock", value: Shell.Tab.recent) {
                NavigationStack(path: $shell.recent) {
                    RecentView(workspace: workspace)
                        .destinations(workspace, path: $shell.recent)
                }
            }
            Tab(value: Shell.Tab.search, role: .search) {
                NavigationStack(path: $shell.search) {
                    SearchView(workspace: workspace, path: $shell.search)
                        .destinations(workspace, path: $shell.search)
                }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .tabBarMinimizeBehavior(.onScrollDown)
        .tabViewBottomAccessory(isEnabled: NeedsYouBar.shows(workspace, device: device, toaster: toaster, shell: shell)) {
            NeedsYouBar(workspace: workspace)
        }
        .animation(.default, value: toaster.shown?.id)
        .modifier(SyncQuestions(workspace: workspace))
        .onChange(of: workspace.left) { _, left in
            if let left { close(left) }
        }
        .onChange(of: workspace.relocated) { _, moved in
            if let moved { follow(moved) }
        }
        // A followed link's page opens over Browse.
        .onChange(of: device.opening, initial: true) { _, opening in
            guard let opening, opening.root == workspace.root else { return }
            device.opened(opening)
            shell.tab = .browse
            shell.browse.removeAll { $0 == .arriving }
            if shell.browse.last != .document(opening.path) { shell.browse.append(.document(opening.path)) }
        }
        // …and while it is on its way, its place is held there.
        .onChange(of: device.arrivingPage?.id, initial: true) { _, _ in
            guard let arriving = device.arrivingPage, arriving.root == workspace.root else { return }
            shell.tab = .browse
            if shell.browse.last != .arriving { shell.browse = [.arriving] }
        }
        .sheet(isPresented: $shell.switching) {
            WorkspaceSwitcher(workspace: workspace)
        }
        .sheet(isPresented: $shell.joining) {
            NavigationStack {
                SignInView(canCancel: true)
            }
        }
        // Outermost, so everything above — the bar over the tabs, the
        // questions, the sheets — finds them.
        .environment(toaster)
        .environment(shell)
    }

    /// Something shared left this iPhone: every screen of it or inside it
    /// closes, as a Mac closes its tabs. The rest stay.
    private func close(_ left: ShareLeft) {
        shell.close { route in
            switch route {
            case .document(let file), .made(let file), .match(let file, _, _):
                return left.holds(shell.now(file))
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

    /// Something shared is somewhere else on this iPhone now, or called
    /// something else: its history is asked for where it is. A document on
    /// screen follows by itself, under the screen it was opened in
    /// (`DocumentView`).
    private func follow(_ moved: SharesMoved) {
        shell.rewrite { route in
            switch route {
            case .history(.note(let note)):
                return moved.now(note).map { .history(.note($0)) }
            case .history(.version(let opened)):
                return opened.following(moved, in: workspace).map { .history(.version($0)) }
            case .history(.moment(let store, let moment)):
                return workspace.store(store, after: moved).map { .history(.moment(store: $0, moment)) }
            default:
                return nil
            }
        }
    }
}

extension View {
    /// Every screen a tab can push, over the tab's own path.
    func destinations(_ workspace: Workspace, path: Binding<[Route]>) -> some View {
        navigationDestination(for: Route.self) { route in
            RouteView(route: route, workspace: workspace, path: path)
        }
    }
}

/// The screen a route leads to.
struct RouteView: View {
    let route: Route
    let workspace: Workspace
    @Binding var path: [Route]

    var body: some View {
        switch route {
        case .document(let file):
            DocumentView(workspace: workspace, path: file, route: $path)
        case .made(let file):
            DocumentView(workspace: workspace, path: file, route: $path, naming: true)
        case .match(let file, let query, let line):
            DocumentView(workspace: workspace, path: file, route: $path, find: query, line: line)
        case .arriving:
            ArrivingView(workspace: workspace)
        case .settings:
            SettingsView(workspace: workspace, path: $path)
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
        case .publishedPages:
            PublishedPagesView(workspace: workspace, route: $path)
        case .tags:
            TagsView(workspace: workspace)
        }
    }
}

/// A followed link's page, not on this iPhone yet: it opens here by itself
/// when sync brings it, or says why it never came.
struct ArrivingView: View {
    let workspace: Workspace

    @Environment(Workspaces.self) private var device
    @Environment(Shell.self) private var shell

    var body: some View {
        VStack(spacing: 14) {
            if let problem = device.arrivingPage?.problem {
                Image(systemName: "questionmark.folder")
                    .font(.largeTitle)
                    .foregroundStyle(Theme.text3)
                Text("Can't open that link")
                    .font(.title3.weight(.semibold))
                Text(problem)
                    .font(.body)
                    .foregroundStyle(Theme.text2)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("arriving-problem")
                Button("Back to Browse") {
                    device.dismissArriving()
                    shell.browse = []
                }
                .buttonStyle(.glass)
                .padding(.top, 6)
            } else {
                ProgressView()
                    .controlSize(.large)
                Text("Getting it from \(workspace.domain)")
                    .font(.title3.weight(.semibold))
                    .multilineTextAlignment(.center)
                Text("This document hasn't reached this \(device.kind) yet. It opens here by itself as soon as it does.")
                    .font(.body)
                    .foregroundStyle(Theme.text2)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("arriving")
                SyncQuietLine(workspace: workspace)
                    .padding(.top, 4)
            }
        }
        .padding(32)
        .frame(maxWidth: 460)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.sheet)
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear {
            // Gone back before it came: nothing is waited for any more.
            if shell.browse.last != .arriving { device.dismissArriving() }
        }
    }
}
