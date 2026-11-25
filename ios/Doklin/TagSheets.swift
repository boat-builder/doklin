import DoklinKit
import SwiftUI

/// Which tag sheet is up over a note.
enum TagSheet: Identifiable {
    /// *New tag*; `forNote`: the open note gets one of its values.
    case new(forNote: Bool)
    /// *Edit*, of the tag called so.
    case edit(String)

    var id: String {
        switch self {
        case .new(let forNote): return "new-\(forNote)"
        case .edit(let name): return "edit-\(name)"
        }
    }
}

/// *New tag*: a name, the values one per line, and (from a note) which value
/// the note gets — as the Mac asks (src/TagDialogs.tsx). The sheet only asks
/// and says what's wrong with what was typed; `create` writes, and answers
/// why it couldn't in a sentence.
struct NewTagSheet: View {
    let list: [TagDef]
    let forNote: Bool
    let create: (TagDef, String?) async -> String?

    @State private var name = ""
    @State private var valuesText = ""
    @State private var chosen: String?
    @State private var tried = false
    @State private var failure: String?
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss

    private var values: [String] {
        valuesText.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }
    private var problem: String? { Tags.tagProblem(name: trimmedName, values: values, list: list) }
    /// The note gets the first value until another is picked.
    private var gets: String? { chosen.flatMap { values.contains($0) ? $0 : nil } ?? values.first }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                } header: {
                    Intro("A tag is a name and the values a note can have, one at a time. Everyone in the workspace sees the same tags.")
                }
                Section("Name") {
                    TextField("Status", text: $name)
                        .autocorrectionDisabled()
                        .disabled(busy)
                        .accessibilityIdentifier("tag-name")
                }
                Section("Values, one per line") {
                    TextField("Todo\nDoing\nDone", text: $valuesText, axis: .vertical)
                        .lineLimit(3...)
                        .autocorrectionDisabled()
                        .disabled(busy)
                        .accessibilityIdentifier("tag-values")
                }
                if forNote, !values.isEmpty {
                    Section {
                        Picker("This note gets", selection: Binding(get: { gets ?? "" }, set: { chosen = $0 })) {
                            ForEach(values, id: \.self) { Text($0).tag($0) }
                        }
                        .disabled(busy)
                        .accessibilityIdentifier("tag-gets")
                    }
                }
                Section {
                    Button {
                        submit()
                    } label: {
                        HStack {
                            Text(busy ? "Making it…" : "Create")
                            if busy {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("tag-create")
                } footer: {
                    if let shown = failure ?? (tried ? problem : nil) {
                        Text(shown).foregroundStyle(Theme.errorInk)
                    }
                }
            }
            .navigationTitle("New tag")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(busy)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(busy)
                }
            }
        }
    }

    private func submit() {
        tried = true
        guard problem == nil, !busy else { return }
        busy = true
        failure = nil
        let def = TagDef(name: trimmedName, values: values)
        let value = forNote ? gets : nil
        Task {
            let failed = await create(def, value)
            busy = false
            if let failed { failure = failed } else { dismiss() }
        }
    }
}

/// *Edit Status*: rename the tag; rename, add, remove and reorder its
/// values; or delete it. A rename changes every note on this iPhone that
/// has it, once the sheet is down: `save` writes the list and answers why
/// it couldn't in a sentence; the notes are its caller's.
struct EditTagSheet: View {
    let def: TagDef
    let list: [TagDef]
    let save: (TagEdit) async -> String?
    let delete: () async -> String?

    /// A value as the sheet holds it: what it was (nil for one added here)
    /// and what it is now.
    private struct Row: Identifiable {
        let id = UUID()
        let from: String?
        var value: String
    }

    @State private var name: String
    @State private var rows: [Row]
    @State private var adding = ""
    @State private var deleting = false
    @State private var tried = false
    @State private var failure: String?
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss

    init(def: TagDef, list: [TagDef], save: @escaping (TagEdit) async -> String?, delete: @escaping () async -> String?) {
        self.def = def
        self.list = list
        self.save = save
        self.delete = delete
        _name = State(initialValue: def.name)
        _rows = State(initialValue: def.values.map { Row(from: $0, value: $0) })
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }
    private var values: [String] { rows.map { $0.value.trimmingCharacters(in: .whitespaces) } }
    private var problem: String? { Tags.tagProblem(name: trimmedName, values: values, list: list, except: def.name) }
    private var renames: [TagEdit.Rename] {
        rows.compactMap { row in
            let now = row.value.trimmingCharacters(in: .whitespaces)
            guard let from = row.from, from != now else { return nil }
            return TagEdit.Rename(from: from, to: now)
        }
    }
    private var renamesTag: Bool { trimmedName != def.name }
    private var removed: [String] { def.values.filter { value in !rows.contains { $0.from == value } } }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField(def.name, text: $name)
                        .autocorrectionDisabled()
                        .disabled(busy)
                        .accessibilityIdentifier("tag-edit-name")
                }
                Section {
                    ForEach($rows) { $row in
                        TextField("Value", text: $row.value)
                            .autocorrectionDisabled()
                            .disabled(busy)
                            .accessibilityIdentifier("tag-value-\(rows.firstIndex { $0.id == row.id } ?? 0)")
                    }
                    .onMove { rows.move(fromOffsets: $0, toOffset: $1) }
                    .onDelete { rows.remove(atOffsets: $0) }
                    TextField("Add a value", text: $adding)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit(add)
                        .disabled(busy)
                        .accessibilityIdentifier("tag-add-value")
                } header: {
                    Text("Values")
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        if renamesTag || !renames.isEmpty {
                            Text("Every note you can open with \(renamesTag ? "a \(def.name) tag" : renames.map(\.from).joined(separator: " or ")) is changed to match.")
                                .accessibilityIdentifier("tag-edit-effect")
                        }
                        if !removed.isEmpty {
                            Text("Notes that have \(removed.joined(separator: " or ")) keep it, shown as a value that isn't one of \(trimmedName.isEmpty ? def.name : trimmedName)’s.")
                        }
                        if let shown = failure ?? (tried ? problem : nil) {
                            Text(shown).foregroundStyle(Theme.errorInk)
                        }
                    }
                }
                Section {
                    Button(role: .destructive) {
                        deleting = true
                    } label: {
                        Text("Delete \(def.name)")
                    }
                    .disabled(busy)
                    .accessibilityIdentifier("tag-delete")
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle("Edit \(def.name)")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(busy)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Saving…" : "Save") { submit() }
                        .fontWeight(.semibold)
                        .disabled(busy)
                        .accessibilityIdentifier("tag-save")
                }
            }
            .confirmationDialog("Delete \(def.name)?", isPresented: $deleting, titleVisibility: .visible) {
                Button("Delete \(def.name)", role: .destructive) { remove() }
            } message: {
                Text("\(def.name) leaves the list. Notes keep their \(def.name) line, which becomes plain frontmatter.")
            }
        }
    }

    private func add() {
        let value = adding.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { return }
        rows.append(Row(from: nil, value: value))
        adding = ""
    }

    private func submit() {
        add()
        tried = true
        guard problem == nil, !busy else { return }
        busy = true
        failure = nil
        let edit = TagEdit(from: def.name, def: TagDef(name: trimmedName, values: values), renames: renames)
        Task {
            let failed = await save(edit)
            busy = false
            if let failed { failure = failed } else { dismiss() }
        }
    }

    private func remove() {
        busy = true
        failure = nil
        Task {
            let failed = await delete()
            busy = false
            if let failed { failure = failed } else { dismiss() }
        }
    }
}
