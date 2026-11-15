import DoklinKit
import SwiftUI

/// Every public address this person can see, and the way to stop one.
struct PagesView: View {
    @State private var model: PagesModel
    @State private var stopping: Page?
    @State private var failure: String?

    init(session: Session) {
        _model = State(initialValue: PagesModel(session: session))
    }

    private var mayPublish: Bool { model.session.may(.publish) }

    var body: some View {
        List {
            ForEach(model.pages) { page in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(page.title ?? (page.path.isEmpty ? model.session.account.workspace : DocLinks.name(of: page.path)))
                            .foregroundStyle(Theme.text1)
                        if page.home == true {
                            Image(systemName: "house")
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                                .accessibilityLabel("Home page")
                        }
                    }
                    if let url = URL(string: page.url) {
                        Link(page.url, destination: url)
                            .font(.footnote)
                            .lineLimit(1)
                    }
                    if page.missing == true {
                        Text("Its file is gone, so the address shows nothing.")
                            .font(.caption)
                            .foregroundStyle(Theme.warnInk)
                    } else if let by = page.byName {
                        Text("Published by \(by)")
                            .font(.caption)
                            .foregroundStyle(Theme.text3)
                    }
                }
                .padding(.vertical, 2)
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    if mayPublish {
                        Button(role: .destructive) {
                            stopping = page
                        } label: {
                            Label("Stop", systemImage: "xmark.circle")
                        }
                    }
                }
                .contextMenu {
                    if let url = URL(string: page.url) {
                        ShareLink(item: url) {
                            Label("Share link", systemImage: "square.and.arrow.up")
                        }
                    }
                    if mayPublish {
                        Button(role: .destructive) {
                            stopping = page
                        } label: {
                            Label("Stop publishing", systemImage: "xmark.circle")
                        }
                    }
                }
            }
        }
        .overlay {
            switch model.phase {
            case .loading:
                ProgressView()
            case .failed(let message):
                ContentUnavailableView("Could not list the pages", systemImage: "exclamationmark.triangle", description: Text(message))
            case .loaded where model.pages.isEmpty:
                ContentUnavailableView("Nothing is published", systemImage: "globe", description: Text("Publish a note from its menu and its address appears here."))
            default:
                EmptyView()
            }
        }
        .navigationTitle("Published pages")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load() }
        .task { await model.load() }
        .confirmationDialog("Stop publishing?", isPresented: stoppingShown, titleVisibility: .visible) {
            Button("Stop publishing", role: .destructive) { stop() }
            Button("Cancel", role: .cancel) { stopping = nil }
        } message: {
            Text("\(stopping?.url ?? "The link") stops working.")
        }
        .alert("That did not work", isPresented: failureShown) {
            Button("OK", role: .cancel) { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

    private var stoppingShown: Binding<Bool> {
        Binding(get: { stopping != nil }, set: { if !$0 { stopping = nil } })
    }

    private var failureShown: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    private func stop() {
        guard let page = stopping else { return }
        stopping = nil
        Task {
            do {
                try await model.stop(page)
            } catch {
                failure = model.session.explain(error)
            }
        }
    }
}
