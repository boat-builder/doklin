import DoklinKit
import SwiftUI

/// Editing a note as its markdown. A save says which revision was read, so a
/// note that changed on a Mac meanwhile is never written over without a
/// person choosing to — and what is typed is kept on the device until it is
/// saved or thrown away.
struct EditorView: View {
    let model: DocumentModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var text: String
    @State private var baseRev: Int
    @State private var restored: Bool
    @State private var controller = SourceEditorController()
    @State private var conflict: String?
    @State private var failure: String?
    @State private var confirmingDiscard = false
    /// Saved or thrown away: closing the sheet keeps no draft.
    @State private var settled = false

    init(model: DocumentModel) {
        self.model = model
        let draft = model.draft
        _text = State(initialValue: draft?.text ?? model.text ?? "")
        _baseRev = State(initialValue: draft?.rev ?? model.content?.rev ?? 0)
        _restored = State(initialValue: draft != nil)
    }

    private var changed: Bool { text != model.text }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if restored {
                    Label("These are changes you had not saved.", systemImage: "arrow.uturn.backward.circle")
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Theme.sunken)
                }
                SourceEditor(text: $text, controller: controller)
            }
            .background(Theme.sheet)
            .navigationTitle(model.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if changed { confirmingDiscard = true } else { close(discarding: true) }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.busy {
                        ProgressView()
                    } else {
                        Button("Save") { save() }
                            .disabled(!changed)
                    }
                }
            }
            .interactiveDismissDisabled(changed)
            .onChange(of: scenePhase) { _, phase in
                if phase != .active, !settled { model.keepDraft(text, over: baseRev) }
            }
            .onDisappear {
                if !settled { model.keepDraft(text, over: baseRev) }
            }
            .confirmationDialog("Throw away your changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
                Button("Throw away", role: .destructive) { close(discarding: true) }
                Button("Keep editing", role: .cancel) {}
            }
            .confirmationDialog("This note changed somewhere else", isPresented: conflictShown, titleVisibility: .visible) {
                Button("Replace it with mine", role: .destructive) { overwrite() }
                Button("Keep theirs, throw mine away", role: .destructive) { takeTheirs() }
                Button("Keep editing", role: .cancel) { conflict = nil }
            } message: {
                Text(conflict ?? "")
            }
            .alert("Not saved", isPresented: failureShown) {
                Button("OK", role: .cancel) { failure = nil }
            } message: {
                Text(failure ?? "")
            }
        }
    }

    private var conflictShown: Binding<Bool> {
        Binding(get: { conflict != nil }, set: { if !$0 { conflict = nil } })
    }

    private var failureShown: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    private func close(discarding: Bool) {
        settled = true
        if discarding { model.discardDraft() }
        dismiss()
    }

    private func save() {
        let typed = text
        Task {
            do {
                try await model.save(typed, over: baseRev)
                close(discarding: false)
            } catch let error as DoklinError where error.kind == .conflict {
                conflict = "Someone saved it after you opened it here. Replacing it writes your text over theirs; a Mac's version history keeps both."
            } catch let error as DoklinError where error.code == "comments" {
                // The worker's sentence names a command; this is the same rule for a person.
                failure = "A comment's marker — the {==words==}{>>#…<<} around commented words — was changed or removed. Put it back as it was, or remove the comment first, then save."
            } catch {
                failure = model.session.explain(error)
            }
        }
    }

    private func overwrite() {
        let typed = text
        conflict = nil
        Task {
            do {
                try await model.overwrite(typed)
                close(discarding: false)
            } catch let error as DoklinError where error.code == "comments" {
                failure = "A comment's marker — the {==words==}{>>#…<<} around commented words — was changed or removed. Put it back as it was, or remove the comment first, then save."
            } catch {
                failure = model.session.explain(error)
            }
        }
    }

    private func takeTheirs() {
        conflict = nil
        close(discarding: true)
        Task { await model.load() }
    }
}
