import DoklinKit
import SwiftUI

/// Editing a note as its markdown, saved as it is typed. While it is open,
/// other devices see it being edited here and open it view-only; one that
/// holds it already makes it view-only here, until this iPhone takes over.
/// Sync merges what was typed here with what changed elsewhere meanwhile —
/// unless both changed while this editor held unsaved text: then the person
/// chooses, as on a Mac.
struct EditorView: View {
    let model: DocumentModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var text: String
    /// What the file holds, as far as this editor knows.
    @State private var saved: String
    /// What is being written right now.
    @State private var writing: String?
    @State private var controller = SourceEditorController()
    /// The file changed elsewhere while something typed here was unsaved.
    @State private var changedElsewhere = false
    @State private var takingOver = false
    @State private var failure: String?
    @State private var pending: Task<Void, Never>?

    init(model: DocumentModel) {
        self.model = model
        _text = State(initialValue: model.text ?? "")
        _saved = State(initialValue: model.text ?? "")
    }

    private var lease: LeaseHolder? { model.lease }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let lease {
                    banner(LeaseWords.line(lease), symbol: "lock") {
                        Button(takingOver ? "Taking over…" : "Take over") { takeOver() }
                            .disabled(takingOver)
                            .accessibilityHint(LeaseWords.takeOverHint(lease))
                    }
                }
                if changedElsewhere {
                    banner("This note changed on another device while you were typing.", symbol: "exclamationmark.triangle") {
                        Button("Reload") { reload() }
                        Button("Keep mine") { keepMine() }
                    }
                }
                SourceEditor(text: $text, controller: controller, editable: lease == nil && !changedElsewhere)
                    .accessibilityIdentifier("editor")
            }
            .background(Theme.sheet)
            .navigationTitle(model.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { close() }
                        .accessibilityIdentifier("done")
                }
            }
            .onChange(of: text) { schedule() }
            .onChange(of: model.workspace.changes) { heardChange() }
            .onChange(of: lease) { takingOver = false }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { Task { await save() } }
            }
            .task { await model.editing(true) }
            .alert("Not saved", isPresented: failureShown) {
                Button("OK", role: .cancel) { failure = nil }
            } message: {
                Text(failure ?? "")
            }
        }
    }

    private var failureShown: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    private func banner<Actions: View>(_ words: String, symbol: String, @ViewBuilder actions: () -> Actions) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(words, systemImage: symbol)
                .font(.footnote)
                .foregroundStyle(Theme.text1)
            HStack(spacing: 16) { actions() }
                .font(.footnote.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Theme.sunken)
    }

    /// Save once the typing pauses.
    private func schedule() {
        pending?.cancel()
        guard text != saved, !changedElsewhere else { return }
        pending = Task {
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard !Task.isCancelled else { return }
            await save()
        }
    }

    /// Write what was typed. True when the file now holds it.
    @discardableResult
    private func save() async -> Bool {
        let typed = text
        if typed == saved { return true }
        guard !changedElsewhere else { return false }
        writing = typed
        defer { writing = nil }
        do {
            try await model.save(typed, over: saved)
            saved = typed
            return true
        } catch is DocumentModel.ChangedElsewhere {
            pending?.cancel()
            changedElsewhere = true
        } catch {
            failure = (error as? DoklinError)?.message ?? error.localizedDescription
        }
        return false
    }

    /// Files of the workspace changed: when this note is one of them and
    /// not by this editor's hand, take the new text — or, with unsaved
    /// typing here, ask.
    private func heardChange() {
        guard model.isAffected(by: model.workspace.lastChanged) else { return }
        if !model.exists {
            // Moved or removed on another device, or its folder left this
            // iPhone: there is nothing here to save into.
            pending?.cancel()
            saved = text
            Task {
                await model.editing(false)
                dismiss()
            }
            return
        }
        guard let disk = try? model.workspace.files.text(model.path),
              disk != saved, disk != writing
        else { return }
        if text == saved {
            text = disk
            saved = disk
        } else {
            pending?.cancel()
            changedElsewhere = true
        }
    }

    private func reload() {
        guard let disk = try? model.workspace.files.text(model.path) else { return }
        changedElsewhere = false
        text = disk
        saved = disk
    }

    private func keepMine() {
        changedElsewhere = false
        // What the other device wrote stays in the note's history.
        saved = (try? model.workspace.files.text(model.path)) ?? saved
        Task { await save() }
    }

    private func takeOver() {
        takingOver = true
        Task { await model.takeOver() }
    }

    /// Close once what was typed is in the file — never over typing that
    /// is not: the banner or the alert says why, and the editor stays.
    private func close() {
        pending?.cancel()
        Task {
            guard await save() else { return }
            await model.editing(false)
            model.load()
            dismiss()
        }
    }
}
