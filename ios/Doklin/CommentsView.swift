import DoklinKit
import SwiftUI

/// The threads on a document: reading them, answering, starting one,
/// removing one. A thread sits on words of the text; the worker places the
/// marker, so the phone only ever names the words.
struct CommentsView: View {
    let model: DocumentModel
    let start: CommentStart

    @Environment(\.dismiss) private var dismiss
    @State private var composing: Bool
    @State private var words: String
    @State private var bodyText = ""
    @State private var replyingTo: String?
    @State private var reply = ""
    @State private var removing: CommentThread?
    @State private var failure: String?

    init(model: DocumentModel, start: CommentStart) {
        self.model = model
        self.start = start
        _composing = State(initialValue: start.composing)
        _words = State(initialValue: start.words)
    }

    private var mayComment: Bool { model.session.may(.comment) && model.notice == nil }

    /// The thread the sheet was opened for comes first.
    private var threads: [CommentThread] {
        let all = model.shownThreads
        guard let first = start.thread, let found = all.first(where: { $0.id == first }) else { return all }
        return [found] + all.filter { $0.id != first }
    }

    var body: some View {
        NavigationStack {
            List {
                if composing {
                    Section {
                        TextField("The words it is about", text: $words, axis: .vertical)
                            .autocorrectionDisabled()
                        TextField("Comment", text: $bodyText, axis: .vertical)
                            .lineLimit(2...8)
                        Button("Add comment") { startThread() }
                            .disabled(model.busy || words.trimmingCharacters(in: .whitespaces).isEmpty || bodyText.trimmingCharacters(in: .whitespaces).isEmpty)
                    } header: {
                        Text("New comment")
                    } footer: {
                        Text("Quote a few plain words from one line of the note, exactly as they are written — enough of them that they occur once.")
                    }
                }
                ForEach(threads) { thread in
                    Section {
                        ForEach(Array(thread.comments.enumerated()), id: \.offset) { _, entry in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 6) {
                                    Text(entry.author.isEmpty ? "Someone" : entry.author)
                                        .font(.footnote.weight(.semibold))
                                        .foregroundStyle(Theme.text1)
                                    if entry.at > 0 {
                                        Text(Date(timeIntervalSince1970: entry.at / 1000), format: .relative(presentation: .named))
                                            .font(.footnote)
                                            .foregroundStyle(Theme.text3)
                                    }
                                }
                                Text(entry.body)
                                    .foregroundStyle(Theme.text1)
                            }
                            .padding(.vertical, 2)
                        }
                        if mayComment {
                            if replyingTo == thread.id {
                                TextField("Reply", text: $reply, axis: .vertical)
                                    .lineLimit(1...6)
                                Button("Send") { send(to: thread) }
                                    .disabled(model.busy || reply.trimmingCharacters(in: .whitespaces).isEmpty)
                            } else {
                                Button("Reply") {
                                    reply = ""
                                    replyingTo = thread.id
                                }
                            }
                        }
                    } header: {
                        Text(thread.orphaned == true ? "On words that are gone" : "On “\(thread.on)”")
                            .textCase(nil)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if mayComment {
                            Button(role: .destructive) {
                                removing = thread
                            } label: {
                                Label("Remove", systemImage: "trash")
                            }
                        }
                    }
                }
            }
            .overlay {
                if threads.isEmpty, !composing {
                    ContentUnavailableView(
                        "No comments",
                        systemImage: "bubble.left",
                        description: Text(mayComment ? "Start one with the plus above, or press and hold a paragraph of the note." : "Nobody has commented on this.")
                    )
                }
            }
            .navigationTitle("Comments")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                if mayComment {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            composing.toggle()
                        } label: {
                            Label("New comment", systemImage: "plus")
                        }
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

    private var removingShown: Binding<Bool> {
        Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
    }

    private var failureShown: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    private func startThread() {
        let on = words.trimmingCharacters(in: .whitespacesAndNewlines)
        let said = bodyText
        Task {
            do {
                try await model.startThread(on: on, body: said)
                composing = false
                words = ""
                bodyText = ""
            } catch {
                failure = model.session.explain(error)
            }
        }
    }

    private func send(to thread: CommentThread) {
        let said = reply
        Task {
            do {
                try await model.reply(to: thread.id, body: said)
                replyingTo = nil
                reply = ""
            } catch {
                failure = model.session.explain(error)
            }
        }
    }

    private func remove() {
        guard let thread = removing else { return }
        removing = nil
        Task {
            do {
                try await model.removeThread(thread.id)
            } catch {
                failure = model.session.explain(error)
            }
        }
    }
}
