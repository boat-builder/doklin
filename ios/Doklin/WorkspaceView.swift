import DoklinKit
import SwiftUI

/// One workspace, in three tabs: Home (what changed), Browse (its tree) and
/// Search — each with its own screens pushed over it. A followed link's page
/// opens over Home, whatever tab was showing, so Back always leads Home.
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
            Tab("Home", systemImage: "clock", value: Shell.Tab.home) {
                NavigationStack(path: $shell.home) {
                    HomeView(workspace: workspace)
                        .destinations(workspace, path: $shell.home)
                }
            }
            Tab("Browse", systemImage: "folder", value: Shell.Tab.browse) {
                BrowseTab(workspace: workspace, path: $shell.browse)
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
        // A followed link's page opens over Home.
        .onChange(of: device.opening, initial: true) { _, opening in
            guard let opening, opening.root == workspace.root else { return }
            device.opened(opening)
            shell.tab = .home
            shell.home.removeAll { $0 == .arriving }
            if shell.home.last != .document(opening.path) { shell.home.append(.document(opening.path)) }
        }
        // …and while it is on its way, its place is held there.
        .onChange(of: device.arrivingPage?.id, initial: true) { _, _ in
            guard let arriving = device.arrivingPage, arriving.root == workspace.root else { return }
            shell.tab = .home
            if shell.home.last != .arriving { shell.home = [.arriving] }
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

    /// A restricted folder left this iPhone: every screen inside it closes,
    /// and its access screen, as a Mac closes its tabs. The rest stay.
    private func close(_ left: FolderLeft) {
        shell.close { route in
            switch route {
            case .folder(let dir), .document(let dir), .match(let dir, _, _):
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
        case .folder(let dir):
            FolderView(workspace: workspace, dir: dir, path: $path)
        case .document(let file):
            DocumentView(workspace: workspace, path: file, route: $path)
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
        case .access(let id):
            SpaceAccessView(workspace: workspace, id: id)
        case .publishedPages:
            PublishedPagesView(workspace: workspace, route: $path)
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
                Button("Back to Home") {
                    device.dismissArriving()
                    shell.home = []
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
            if shell.home.last != .arriving { device.dismissArriving() }
        }
    }
}
