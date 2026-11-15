import DoklinKit
import SwiftUI
import UIKit

/// A word beside a name: "you", "owner", "this iPhone".
struct Tag: View {
    let word: String

    init(_ word: String) {
        self.word = word
    }

    var body: some View {
        Text(word)
            .font(.caption2.weight(.medium))
            .foregroundStyle(Theme.text2)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Theme.sunken, in: Capsule())
    }
}

/// The first line of a row: a name and the tags it carries.
struct NameLine: View {
    let name: String
    var tags: [String] = []

    var body: some View {
        HStack(spacing: 6) {
            Text(name)
                .foregroundStyle(Theme.text1)
                .lineLimit(1)
            ForEach(tags, id: \.self) { Tag($0) }
        }
    }
}

/// What a screen is about, above everything on it.
struct Intro: View {
    let words: String

    init(_ words: String) {
        self.words = words
    }

    var body: some View {
        Text(words)
            .textCase(nil)
            .font(.footnote)
            .foregroundStyle(Theme.text2)
            .padding(.top, 4)
    }
}

/// Grey words under a name.
struct Hint: View {
    let words: String

    init(_ words: String) {
        self.words = words
    }

    var body: some View {
        Text(words)
            .font(.footnote)
            .foregroundStyle(Theme.text3)
    }
}

/// Something made once and shown once — an invite's line, another device's
/// line, an agent's login. The domain kept only its fingerprint, so once
/// this is gone nobody can show it again: copying and sharing it come
/// straight after it, before what is said about it.
struct OnceCard: View {
    let title: String
    /// What is said before it, when something must be.
    var lead: String?
    /// What to send, as it is shown and copied.
    let shown: String
    /// Long enough to want smaller type.
    var long = false
    /// The button that copies it.
    let copyLabel: String
    /// A second button that copies part of it.
    var alsoCopy: (label: String, text: String)?
    let words: [String]
    let done: () -> Void

    @State private var copied: String?

    var body: some View {
        Section {
            // The title is in the card, not over it, so the card scrolled to
            // the top of the list shows what it is.
            VStack(alignment: .leading, spacing: 10) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Theme.text1)
                if let lead { Hint(lead) }
                Text(shown)
                    .font(.system(long ? .caption : .footnote, design: .monospaced))
                    .foregroundStyle(Theme.text1)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Theme.codeBg, in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityIdentifier("once-shown")
            }
            .padding(.vertical, 4)
            Button(copied == copyLabel ? "Copied ✓" : copyLabel) { copy(shown, as: copyLabel) }
                .accessibilityIdentifier("once-copy")
            if let alsoCopy {
                Button(copied == alsoCopy.label ? "Copied ✓" : alsoCopy.label) { copy(alsoCopy.text, as: alsoCopy.label) }
            }
            ShareLink(item: shown) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(words, id: \.self) { Hint($0) }
            }
            .padding(.vertical, 4)
            Button("Done", action: done)
                .accessibilityIdentifier("once-done")
        }
        .id(Self.anchor)
    }

    /// Where a list scrolls to bring the card into view.
    static let anchor = "once-card"

    private func copy(_ text: String, as label: String) {
        UIPasteboard.general.string = text
        copied = label
        Task {
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            if copied == label { copied = nil }
        }
    }
}

/// An "are you sure" with what it will do in words, and the buttons that
/// answer it.
struct Question: Identifiable {
    struct Choice: Identifiable {
        let label: String
        var destructive = true
        let act: () async -> Void

        var id: String { label }
    }

    let id = UUID()
    let title: String
    let message: String
    let choices: [Choice]

    init(_ title: String, _ message: String, choices: [Choice]) {
        self.title = title
        self.message = message
        self.choices = choices
    }

    init(_ title: String, _ message: String, button: String, destructive: Bool = true, act: @escaping () async -> Void) {
        self.init(title, message, choices: [Choice(label: button, destructive: destructive, act: act)])
    }
}

extension View {
    /// Ask `question` while it is set.
    func asking(_ question: Binding<Question?>) -> some View {
        confirmationDialog(
            question.wrappedValue?.title ?? "",
            isPresented: Binding(get: { question.wrappedValue != nil }, set: { if !$0 { question.wrappedValue = nil } }),
            titleVisibility: .visible,
            presenting: question.wrappedValue
        ) { asked in
            ForEach(asked.choices) { choice in
                Button(choice.label, role: choice.destructive ? .destructive : nil) {
                    Task { await choice.act() }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { asked in
            Text(asked.message)
        }
    }

    /// Say what the engine refused, in its words, while there is something to say.
    func refusal(_ problem: Binding<String?>) -> some View {
        alert(
            "That did not work",
            isPresented: Binding(get: { problem.wrappedValue != nil }, set: { if !$0 { problem.wrappedValue = nil } })
        ) {
            Button("OK", role: .cancel) { problem.wrappedValue = nil }
        } message: {
            Text(problem.wrappedValue ?? "")
        }
    }

    /// Keep `now` moving while the screen is up, so "runs out in 3 h" counts down.
    func ticking(_ now: Binding<Int>) -> some View {
        task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                now.wrappedValue = Clock.now
            }
        }
    }

    /// Bring the card shown once into view as `shown` — the code it shows —
    /// appears: the row that asked for it may be a screen further down, and
    /// a code scrolled out of sight is a code lost.
    func revealing(_ shown: String?, in proxy: ScrollViewProxy) -> some View {
        onChange(of: shown) { _, now in
            guard now != nil else { return }
            // Once the list has the card's rows.
            DispatchQueue.main.async {
                withAnimation { proxy.scrollTo(OnceCard.anchor, anchor: .top) }
            }
        }
    }
}

/// While a list is first asked for: the question, in words, or why it could
/// not be answered.
struct Asking: View {
    let phase: LoadPhase
    let words: String
    let retry: () async -> Void

    var body: some View {
        if case .failed(let message) = phase {
            ContentUnavailableView {
                Label("Could not ask", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await retry() } }
            }
        } else {
            ProgressView(words)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
