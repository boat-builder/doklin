import DoklinKit
import SwiftUI

/// What the comments sheet opens on.
struct CommentStart: Identifiable {
    let id = UUID()
    /// The form of the document being read: its markdown, or its page.
    var version: CommentVersion
    /// A thread to show first.
    var thread: String?
    /// Words offered for a new thread.
    var words = ""
    /// Open straight into writing a new comment.
    var composing = false
}

/// The threads on a document: reading them, answering, starting one on
/// words of the note, removing one. Everything is written to the note's
/// files on this iPhone, and syncs from there.
struct CommentsView: View {
    let model: CommentsModel
    let start: CommentStart
    /// This person may write here now: their role allows it, and no other
    /// device holds the document.
    let mayComment: Bool

    @Environment(\.dismiss) private var dismiss
    @State private var composing: Bool
    @State private var words: String
    @State private var bodyText = ""
    @State private var replyingTo: String?
    @State private var reply = ""
    @State private var removing: CommentThread?
    @State private var failure: String?

    init(model: CommentsModel, start: CommentStart, mayComment: Bool) {
        self.model = model
        self.start = start
        self.mayComment = mayComment
        _composing = State(initialValue: start.composing && mayComment && start.version == .md)
        _words = State(initialValue: start.words)
    }

    /// Only a note's markdown takes a new thread here: one on a page is
    /// anchored to an element, which is chosen on a Mac.
    private var mayStart: Bool { mayComment && start.version == .md }

    /// The thread the sheet was opened for comes first.
    private var threads: [CommentThread] {
        let all = model.threads(on: start.version)
        guard let first = start.thread, let found = all.first(where: { $0.id == first }) else { return all }
        return [found] + all.filter { $0.id != first }
    }

    var body: some View {
        NavigationStack {
            List {
                if composing { composer }
                ForEach(threads) { thread in
                    section(thread)
                }
            }
            .accessibilityIdentifier("comments-list")
            .overlay {
                if threads.isEmpty, !composing {
                    ContentUnavailableView("No comments", systemImage: "bubble.left", description: Text(emptyWords))
                }
            }
            .navigationTitle("Comments")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                if mayStart {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            composing.toggle()
                        } label: {
                            Label("New comment", systemImage: "plus")
                        }
                        .accessibilityIdentifier("new-comment")
                    }
                }
            }
            .confirmationDialog("Remove this thread?", isPresented: removingShown, titleVisibility: .visible) {
                Button("Remove", role: .destructive) { remove() }
                Button("Cancel", role: .cancel) { removing = nil }
            } message: {
                Text("The whole conversation goes; the words it was on stay.")
            }
            .alert("That did not work", isPresented: failureShown) {
                Button("OK", role: .cancel) { failure = nil }
            } message: {
                Text(failure ?? "")
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var emptyWords: String {
        if start.version == .html { return "Nobody has commented on this page. A comment on a page is started on a Mac." }
        return mayStart ? "Start one with the plus above, or press and hold a paragraph of the note." : "Nobody has commented on this."
    }

    /* ---------- Writing a new one ---------- */

    private var composer: some View {
        Section {
            TextField("The words it is about", text: $words, axis: .vertical)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("comment-words")
            TextField("Comment", text: $bodyText, axis: .vertical)
                .lineLimit(2...8)
                .accessibilityIdentifier("comment-body")
            Button("Add comment") { startThread() }
                .disabled(model.busy || words.trimmingCharacters(in: .whitespaces).isEmpty || bodyText.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("add-comment")
        } header: {
            Text("New comment")
        } footer: {
            Text("Quote a few plain words from one line of the note, exactly as they are written — enough of them that they are there once.")
        }
    }

    /* ---------- A thread ---------- */

    private func heading(_ thread: CommentThread) -> String {
        if thread.orphaned { return thread.version == .md ? "On words that are gone" : "On part of the page that is gone" }
        return thread.on.isEmpty ? "On the page" : "On “\(thread.on)”"
    }

    private func section(_ thread: CommentThread) -> some View {
        Section {
            ForEach(Array(thread.comments.enumerated()), id: \.offset) { index, entry in
                CommentRow(entry: entry)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier(index == 0 ? "thread-\(thread.id)" : "reply-\(thread.id)-\(index)")
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if mayComment {
                            if index == 0 {
                                Button(role: .destructive) {
                                    removing = thread
                                } label: {
                                    Label("Remove", systemImage: "trash")
                                }
                            } else {
                                Button(role: .destructive) {
                                    deleteReply(entry, at: index, of: thread)
                                } label: {
                                    Label("Delete reply", systemImage: "trash")
                                }
                            }
                        }
                    }
            }
            if mayComment {
                if replyingTo == thread.id {
                    TextField("Reply", text: $reply, axis: .vertical)
                        .lineLimit(1...6)
                        .accessibilityIdentifier("reply-field")
                    Button("Send") { send(to: thread) }
                        .disabled(model.busy || reply.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier("send-reply")
                } else {
                    Button("Reply") {
                        reply = ""
                        replyingTo = thread.id
                    }
                    .accessibilityIdentifier("reply-to-\(thread.id)")
                }
            }
        } header: {
            Text(heading(thread))
                .textCase(nil)
        }
    }

    /* ---------- Doing ---------- */

    private var removingShown: Binding<Bool> {
        Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
    }

    private var failureShown: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    private func run(_ work: @escaping () async throws -> Void, then done: @escaping () -> Void = {}) {
        Task {
            do {
                try await work()
                done()
            } catch {
                failure = (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
    }

    private func startThread() {
        let on = words
        let said = bodyText
        run({ try await model.start(on: on, saying: said) }) {
            composing = false
            words = ""
            bodyText = ""
        }
    }

    private func send(to thread: CommentThread) {
        let said = reply
        run({ try await model.reply(to: thread.id, saying: said) }) {
            replyingTo = nil
            reply = ""
        }
    }

    private func deleteReply(_ entry: CommentEntry, at index: Int, of thread: CommentThread) {
        run { try await model.deleteReply(of: thread.id, entry: entry, at: index) }
    }

    private func remove() {
        guard let thread = removing else { return }
        removing = nil
        run { try await model.remove(thread.id) }
    }
}

/// One comment of a thread: who, when, what.
private struct CommentRow: View {
    let entry: CommentEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(entry.authorWords)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.text1)
                if let when = CommentTime.words(entry.at, now: Date().timeIntervalSince1970 * 1000) {
                    Text(when)
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                }
            }
            Text(entry.body.string)
                .foregroundStyle(Theme.text1)
        }
        .padding(.vertical, 2)
    }
}
