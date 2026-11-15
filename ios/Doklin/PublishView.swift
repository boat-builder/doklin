import DoklinKit
import SwiftUI
import UIKit

/// What a publish sheet is about.
struct PublishTarget: Identifiable {
    /// Workspace-relative; a folder's `""` is the whole workspace.
    let path: String
    let kind: PublicKind

    var id: String { "\(kind) \(path)" }
}

/// Publishing one document or folder: give it an address anyone with the
/// link can read, see where its page stands, change the address, stop it.
/// What the Mac's Live chip and its folder dialog offer, in one sheet.
struct PublishView: View {
    let workspace: Workspace
    /// Workspace-relative; a folder's `""` is the whole workspace.
    let path: String
    let kind: PublicKind
    /// Called to show every published page, after the sheet goes.
    var showAll: (() -> Void)?

    @Environment(Workspaces.self) private var device
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var slug = ""
    @State private var title = ""
    @State private var desc = ""
    @State private var editing = false
    @State private var busy = false
    @State private var confirmingStop = false
    @State private var copied = false
    @State private var failure: String?

    private var status: CloudStatus? { workspace.status }
    private var page: PublicPage? { status.flatMap { Publishing.page(for: path, kind: kind, in: $0) } }
    private var isFolder: Bool { kind == .dir }
    private var now: Int { Int(Date().timeIntervalSince1970 * 1000) }

    /// What it is called: a note's name, a folder's, or the workspace's.
    private var name: String {
        if isFolder { return path.isEmpty ? workspace.name : DocLinks.name(of: path) }
        return DocLinks.stem(of: DocLinks.name(of: path))
    }

    var body: some View {
        NavigationStack {
            Form {
                if let status {
                    if let page {
                        published(page, status)
                    } else {
                        unpublished(status)
                    }
                    if let failure {
                        Section {
                            Text(failure)
                                .font(.footnote)
                                .foregroundStyle(Theme.errorInk)
                                .accessibilityIdentifier("publish-problem")
                        }
                    }
                }
            }
            .navigationTitle(isFolder ? (path.isEmpty ? "Publish the workspace" : "Publish folder") : "Publish")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear(perform: fill)
            .confirmationDialog(
                isFolder ? "Stop publishing the folder?" : "Stop publishing?",
                isPresented: $confirmingStop,
                titleVisibility: .visible
            ) {
                Button("Stop", role: .destructive) { stop() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(isFolder ? "Every address under it stops working." : "The link stops working.")
            }
        }
    }

    /// A fresh sheet starts from the page as it is.
    private func fill() {
        slug = page?.slug ?? ""
        title = page?.title ?? (isFolder ? name : "")
        desc = page?.desc ?? ""
    }

    /* ---------- Not published ---------- */

    @ViewBuilder private func unpublished(_ status: CloudStatus) -> some View {
        Section {
            address(status, placeholder: "random letters")
            if isFolder { folderFields }
        } header: {
            Text("Publish “\(name)”")
                .textCase(nil)
        } footer: {
            Text(isFolder ? folderWords(published: false) : "Anyone with the link can read it. Leave the address empty for a random one.")
        }
        insideLines(status, lead: "Already public inside")
        if workspace.mayPublish {
            Section {
                Button(busy ? "Publishing…" : (isFolder ? "Publish folder" : "Publish")) { publish() }
                    .disabled(busy || (isFolder && title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                    .accessibilityIdentifier("publish-go")
            }
        }
    }

    private var folderFields: some View {
        Group {
            LabeledContent("Title") {
                TextField("Title", text: $title)
                    .multilineTextAlignment(.trailing)
                    .accessibilityIdentifier("publish-title")
            }
            LabeledContent("Description") {
                TextField("A line under the title, optional", text: $desc, axis: .vertical)
                    .multilineTextAlignment(.trailing)
                    .accessibilityIdentifier("publish-desc")
            }
        }
    }

    private func folderWords(published: Bool) -> String {
        let what = path.isEmpty ? "The whole workspace" : "“\(name)”"
        let count = workspace.notes(under: path)
        return "\(what) — \(count) note\(count == 1 ? "" : "s") \(published ? "is" : "will be") public, every note in it, at addresses under one slug. Notes added later are public the moment they sync; a note can still be published on its own too."
    }

    private func address(_ status: CloudStatus, placeholder: String) -> some View {
        HStack(spacing: 2) {
            Text("\(status.domain)/")
                .foregroundStyle(Theme.text3)
            TextField(placeholder, text: $slug)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .accessibilityIdentifier("publish-slug")
        }
    }

    /* ---------- Published ---------- */

    @ViewBuilder private func published(_ page: PublicPage, _ status: CloudStatus) -> some View {
        let url = Publishing.url(of: page, in: status)
        let state = Publishing.state(of: page, in: status, pending: !isFolder && workspace.changedSinceSync(path))
        Section {
            Text(url.replacingOccurrences(of: "^https?://", with: "", options: .regularExpression))
                .font(.callout.monospaced())
                .foregroundStyle(Theme.accent)
                .textSelection(.enabled)
                .accessibilityIdentifier("publish-url")
            Button {
                UIPasteboard.general.string = url
                copied = true
            } label: {
                Label(copied ? "Copied" : "Copy link", systemImage: copied ? "checkmark" : "doc.on.doc")
            }
            .accessibilityIdentifier("publish-copy")
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
        } header: {
            HStack(spacing: 8) {
                Circle()
                    .fill(tint(state))
                    .frame(width: 7, height: 7)
                Text("“\(name)” \(state.heading)")
                    .textCase(nil)
                    .accessibilityIdentifier("publish-state")
                if page.root {
                    Text("Home page")
                        .font(.caption2.weight(.semibold))
                        .textCase(nil)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Theme.accentWash, in: Capsule())
                }
            }
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if let reason = Publishing.reason(state, in: status, now: now) {
                    Text(reason)
                        .foregroundStyle(state == .offline ? Theme.errorInk : Theme.warnInk)
                }
                Text("\(Publishing.byline(of: page, in: status, now: now)). Anyone with the link can read it; it’s hidden from search engines.")
                    .accessibilityIdentifier("publish-by")
                if isFolder { Text(folderWords(published: true)) }
            }
        }
        insideLines(status, lead: "Also inside")
        if workspace.mayPublish {
            Section {
                if isFolder {
                    address(status, placeholder: page.slug)
                    folderFields
                    Button(busy ? "Saving…" : "Save changes") { publish() }
                        .disabled(busy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("publish-save")
                } else if editing {
                    address(status, placeholder: page.slug)
                    Button(busy ? "Changing…" : "Change") { publish() }
                        .disabled(busy || Publishing.slug(typed: slug) == nil || Publishing.slug(typed: slug) == page.slug)
                        .accessibilityIdentifier("publish-rename")
                } else {
                    Button("Change address") {
                        slug = page.slug
                        editing = true
                    }
                    .accessibilityIdentifier("publish-change")
                }
            }
            Section {
                Button("Stop publishing", role: .destructive) { confirmingStop = true }
                    .disabled(busy)
                    .accessibilityIdentifier("publish-stop")
            }
        }
        if let showAll {
            Section {
                Button("All published pages") {
                    dismiss()
                    showAll()
                }
                .accessibilityIdentifier("publish-all")
            }
        }
    }

    /// The published folders a note can also be read inside.
    @ViewBuilder private func insideLines(_ status: CloudStatus, lead: String) -> some View {
        let nested = isFolder ? [] : Publishing.places(of: path, in: status).filter(\.nested)
        if !nested.isEmpty {
            Section {
                ForEach(nested, id: \.url) { place in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(lead) “\(Publishing.name(of: place.page, workspace: workspace.name))”")
                            .font(.footnote)
                            .foregroundStyle(Theme.text2)
                        if let link = URL(string: place.url) {
                            Link(place.url.replacingOccurrences(of: "^https?://", with: "", options: .regularExpression), destination: link)
                                .font(.footnote)
                                .lineLimit(1)
                        }
                    }
                }
            }
        }
    }

    private func tint(_ state: PageState) -> Color {
        switch state {
        case .live: return Theme.live
        case .updating: return Theme.accent
        case .stale: return Theme.warnInk
        case .offline: return Theme.errorInk
        case .unpublished: return Theme.text3
        }
    }

    /* ---------- Doing ---------- */

    private func publish() {
        let typed = Publishing.slug(typed: slug)
        let heading = isFolder ? title.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        let line = isFolder ? desc.trimmingCharacters(in: .whitespacesAndNewlines) : ""
        busy = true
        failure = nil
        Task {
            defer { busy = false }
            do {
                slug = try await workspace.publish(path, slug: typed, title: heading, desc: line.isEmpty ? nil : line)
                editing = false
                // The page is in the status as soon as the engine has queued it.
                await device.refresh()
            } catch {
                failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
    }

    private func stop() {
        guard let page else { return }
        busy = true
        failure = nil
        Task {
            defer { busy = false }
            do {
                try await workspace.unpublish(page.slug)
                slug = ""
                await device.refresh()
            } catch {
                failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
    }
}
