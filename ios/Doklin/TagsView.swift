import DoklinKit
import SwiftUI

/// Settings' *Tags*: the workspace's tags, each with its values and what
/// they mean, as everyone in it sees them — the Mac's Settings › Tags
/// (src/TagsSettings.tsx). A tag opens its *Edit*, and *New tag* makes one,
/// for whoever may work here; anybody else reads them.
struct TagsView: View {
    let workspace: Workspace

    @Environment(Toaster.self) private var toaster
    @State private var sheet: TagSheet?

    private var mayChange: Bool { workspace.may("work") }

    var body: some View {
        List {
            Section {
                if workspace.tagList.isEmpty {
                    Text("No tags yet.")
                        .foregroundStyle(Theme.text3)
                        .accessibilityIdentifier("tags-none")
                }
                ForEach(workspace.tagList, id: \.name) { def in
                    if mayChange {
                        Button {
                            sheet = .edit(def)
                        } label: {
                            TagListRow(def: def)
                        }
                        .accessibilityHint("Edits \(def.name)")
                        .accessibilityIdentifier("tags-edit-\(def.name)")
                    } else {
                        TagListRow(def: def)
                            .accessibilityIdentifier("tags-row-\(def.name)")
                    }
                }
            } footer: {
                Text("Everyone in the workspace sees the same tags, and a note has one value of each. Agents read what the values mean.")
            }
            if mayChange {
                Section {
                    Button {
                        sheet = .new(note: nil)
                    } label: {
                        Label("New tag", systemImage: "plus")
                    }
                    .accessibilityIdentifier("tags-new")
                }
            }
        }
        .navigationTitle("Tags")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $sheet) { TagSheetView(sheet: $0, workspace: workspace, toaster: toaster) }
    }
}

/// A tag as the list shows it: its name, its values, and what they mean.
private struct TagListRow: View {
    let def: TagDef

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(def.name)
                .font(.body.weight(.semibold))
                .foregroundStyle(Theme.text1)
            ChipFlow {
                ForEach(def.values, id: \.self) { value in
                    Text(value)
                        .font(.subheadline)
                        .foregroundStyle(Theme.text1)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Theme.sunken, in: Capsule())
                }
            }
            if let desc = def.desc {
                Text(desc)
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
