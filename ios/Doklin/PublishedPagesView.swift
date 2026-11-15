import DoklinKit
import SwiftUI
import UIKit

/// Every page published from what this person can open — the shared
/// workspace, their Private, the restricted folders they are in — with each
/// address to copy, share or open, the home page, and the way to stop one.
/// An owner also sees what was published from sections they are not in,
/// and can take any of it down.
struct PublishedPagesView: View {
    let workspace: Workspace
    @Binding var route: [Route]

    @Environment(Workspaces.self) private var device
    @Environment(\.openURL) private var openURL
    @State private var every: EveryPageModel
    @State private var stopping: PublicPage?
    @State private var takingDown: EveryPage?
    @State private var editing: PublicPage?
    @State private var copied: String?
    @State private var failure: String?

    init(workspace: Workspace, route: Binding<[Route]>) {
        self.workspace = workspace
        _route = route
        _every = State(initialValue: EveryPageModel(workspace: workspace))
    }

    private var status: CloudStatus? { workspace.status }
    private var pages: [PublicPage] { status?.public ?? [] }
    private var now: Int { Int(Date().timeIntervalSince1970 * 1000) }

    var body: some View {
        List {
            Section {
                if pages.isEmpty {
                    Text("Nothing is published yet. Choose Publish… in a note’s menu, or press and hold a folder and choose Publish folder…")
                        .font(.callout)
                        .foregroundStyle(Theme.text2)
                        .accessibilityIdentifier("published-empty")
                } else {
                    ForEach(pages) { page in
                        row(page)
                    }
                }
            } header: {
                Text(workspace.domain)
                    .textCase(nil)
            }
            if every.seesAll, !every.elsewhere.isEmpty || every.problem != nil {
                elsewhere
            }
        }
        .navigationTitle("Published pages")
        .navigationBarTitleDisplayMode(.inline)
        // Again once the domain has said what this person may do.
        .task(id: every.seesAll) { await every.load() }
        .refreshable {
            await workspace.syncNow()
            await every.load()
        }
        .sheet(item: $editing) { page in
            PublishView(workspace: workspace, path: page.path, kind: .dir)
        }
        .confirmationDialog(
            "Stop publishing “\(stopping.map { Publishing.name(of: $0, workspace: workspace.name) } ?? "")”?",
            isPresented: shown($stopping),
            titleVisibility: .visible
        ) {
            Button("Stop", role: .destructive) { stop() }
            Button("Cancel", role: .cancel) { stopping = nil }
        } message: {
            Text(stopping?.kind == .dir ? "Every address under it stops working." : "The link stops working.")
        }
        .confirmationDialog(
            "Take down “\(takingDown.map { $0.title.isEmpty ? $0.slug : $0.title } ?? "")”?",
            isPresented: shown($takingDown),
            titleVisibility: .visible
        ) {
            Button("Take down", role: .destructive) { takeDown() }
            Button("Cancel", role: .cancel) { takingDown = nil }
        } message: {
            Text("Its address stops working for everyone.")
        }
        .alert("That did not work", isPresented: shown($failure)) {
            Button("OK", role: .cancel) { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

    private func shown<T>(_ value: Binding<T?>) -> Binding<Bool> {
        Binding(get: { value.wrappedValue != nil }, set: { if !$0 { value.wrappedValue = nil } })
    }

    /* ---------- A page of this person's ---------- */

    private func row(_ page: PublicPage) -> some View {
        let openable = page.kind == .file && page.alive
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: page.kind == .dir ? "folder" : "doc.text")
                .foregroundStyle(Theme.text3)
                .frame(width: 22)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(Publishing.name(of: page, workspace: workspace.name))
                        .foregroundStyle(Theme.text1)
                        .lineLimit(1)
                    if page.root { badge("Home page", Theme.accentWash, Theme.text1) }
                    if !page.alive { badge(page.kind == .dir ? "empty folder" : "file missing", Theme.sunken, Theme.warnInk) }
                }
                Text(Publishing.detail(of: page, now: now))
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture {
                if openable { route.append(.document(page.path)) }
            }
            actions(page)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("page-\(page.slug)")
    }

    private func badge(_ words: String, _ fill: Color, _ ink: Color) -> some View {
        Text(words)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ink)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(fill, in: Capsule())
    }

    private func actions(_ page: PublicPage) -> some View {
        let url = status.map { Publishing.url(of: page, in: $0) } ?? ""
        return Menu {
            addressActions(url, slug: page.slug)
            if workspace.mayPublish {
                if page.kind == .dir {
                    Button {
                        editing = page
                    } label: {
                        Label("Edit publishing…", systemImage: "pencil")
                    }
                }
                // The home page is chosen from what everyone has.
                if workspace.audience(of: page.path) == .everyone {
                    Button {
                        home(page)
                    } label: {
                        Label(page.root ? "Unset as home page" : "Use as home page", systemImage: page.root ? "house.slash" : "house")
                    }
                }
                Button(role: .destructive) {
                    stopping = page
                } label: {
                    Label("Stop publishing", systemImage: "xmark.circle")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.title3)
                .foregroundStyle(Theme.text2)
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Page actions")
        .accessibilityIdentifier("page-menu-\(page.slug)")
    }

    @ViewBuilder private func addressActions(_ url: String, slug: String) -> some View {
        Button {
            UIPasteboard.general.string = url
            copied = slug
        } label: {
            Label(copied == slug ? "Copied" : "Copy link", systemImage: "doc.on.doc")
        }
        if let link = URL(string: url) {
            ShareLink(item: link) {
                Label("Share link", systemImage: "square.and.arrow.up")
            }
            Button {
                openURL(link)
            } label: {
                Label("Open", systemImage: "safari")
            }
        }
    }

    /* ---------- What other sections published ---------- */

    private var elsewhere: some View {
        Section {
            if let problem = every.problem {
                Text(problem)
                    .font(.footnote)
                    .foregroundStyle(Theme.warnInk)
            }
            ForEach(every.elsewhere) { page in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: page.kind == .dir ? "folder" : "doc.text")
                        .foregroundStyle(Theme.text3)
                        .frame(width: 22)
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(page.title.isEmpty ? page.slug : page.title)
                            .foregroundStyle(Theme.text1)
                            .lineLimit(1)
                        Text("/\(page.slug) · \(page.by.isEmpty ? "someone" : page.by)\(page.at > 0 ? " · \(Clock.ago(page.at, now: now))" : "")")
                            .font(.footnote)
                            .foregroundStyle(Theme.text3)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Menu {
                        addressActions(every.url(of: page), slug: page.slug)
                        Button(role: .destructive) {
                            takingDown = page
                        } label: {
                            Label("Take down", systemImage: "xmark.circle")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.title3)
                            .foregroundStyle(Theme.text2)
                            .frame(width: 36, height: 36)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Page actions")
                    .accessibilityIdentifier("page-menu-\(page.slug)")
                }
                .accessibilityIdentifier("page-\(page.slug)")
            }
            if every.truncated {
                Text("There are more than this list shows.")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
            }
        } header: {
            Text("From sections you are not in")
                .textCase(nil)
        } footer: {
            Text("Published from somebody’s Private or a restricted folder. You cannot open the files, but as an owner you can take a page down.")
        }
    }

    /* ---------- Doing ---------- */

    private func run(_ work: @escaping () async throws -> Void) {
        Task {
            do {
                try await work()
                await device.refresh()
            } catch {
                failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
    }

    private func home(_ page: PublicPage) {
        run { try await workspace.useAsHomePage(page.root ? nil : page.slug) }
    }

    private func stop() {
        guard let page = stopping else { return }
        stopping = nil
        run { try await workspace.unpublish(page.slug) }
    }

    private func takeDown() {
        guard let page = takingDown else { return }
        takingDown = nil
        run { try await every.takeDown(page.slug) }
    }
}
