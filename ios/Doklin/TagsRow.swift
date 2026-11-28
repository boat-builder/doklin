import DoklinKit
import SwiftUI

/// What the tag controls can ask for. Nil where the note can't be changed
/// here: another device holds it, this person may not work, or it is a
/// version.
struct TagActions {
    /// Give the note a value for a tag, both spelled as the list spells
    /// them, or (nil) clear it.
    var set: (String, String?) -> Void
    /// *New tag…*, from a note: the note gets one of its values.
    var newTag: () -> Void
    /// *Edit Status…*: the tag's sheet.
    var edit: (String) -> Void
}

/// A note's tags, right below its title, as the Mac shows them
/// (src/TagsRow.tsx): a chip per tag in the list's order, then *Tag*. A
/// chip's menu sets the value, removes the tag or edits it; *Tag* offers the
/// tags the note lacks, and *New tag…*. A value the list lacks shows dashed.
/// A note with no tags has no row: *Add tag* is in its More menu.
struct TagsRow: View {
    let tags: [NoteTag]
    let list: [TagDef]
    var actions: TagActions?

    var body: some View {
        if !tags.isEmpty {
            ChipFlow {
                ForEach(tags, id: \.name) { tag in
                    if let actions, let def = list.first(where: { $0.name == tag.name }) {
                        Menu {
                            TagMenus.values(of: def, current: tag, actions: actions)
                        } label: {
                            TagChip(tag: tag)
                        }
                        .accessibilityIdentifier("tag-\(tag.name)")
                    } else {
                        TagChip(tag: tag)
                            .accessibilityIdentifier("tag-\(tag.name)")
                    }
                }
                if let actions {
                    Menu {
                        TagMenus.add(list.filter { def in !tags.contains { $0.name == def.name } }, actions: actions)
                    } label: {
                        Label("Tag", systemImage: "plus")
                            .font(.subheadline)
                            .foregroundStyle(Theme.text2)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .overlay { Capsule().strokeBorder(Theme.border) }
                    }
                    .accessibilityLabel("Add a tag")
                    .accessibilityIdentifier("tag-add")
                }
            }
        }
    }
}

/// One tag, as a chip: its name muted, then its value.
struct TagChip: View {
    let tag: NoteTag

    var body: some View {
        HStack(spacing: 5) {
            Text(tag.name).foregroundStyle(Theme.text3)
            Text(tag.value).foregroundStyle(Theme.text1)
        }
        .font(.subheadline)
        .lineLimit(1)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Theme.sunken, in: Capsule())
        .overlay {
            if !tag.known {
                Capsule().strokeBorder(Theme.text3, style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(tag.known ? "\(tag.name), \(tag.value)" : "\(tag.name), \(tag.value), not one of its values")
    }
}

/// The tag menus' items, for a chip, for *Tag*, and for the More menu's
/// *Add tag*.
enum TagMenus {
    /// A chip's: the tag's values with the note's checked, *Remove*, and
    /// *Edit*.
    @ViewBuilder static func values(of def: TagDef, current: NoteTag, actions: TagActions) -> some View {
        if !current.known {
            Button {} label: {
                Label("\(current.value) — not one of its values", systemImage: "checkmark")
            }
            .disabled(true)
        }
        Picker(def.name, selection: Binding<String?>(
            get: { current.known ? current.value : nil },
            set: { if let value = $0 { actions.set(def.name, value) } }
        )) {
            ForEach(def.values, id: \.self) { value in
                Text(value).tag(Optional(value))
            }
        }
        .pickerStyle(.inline)
        Divider()
        Button(role: .destructive) {
            actions.set(def.name, nil)
        } label: {
            Label("Remove", systemImage: "minus.circle")
        }
        Button {
            actions.edit(def.name)
        } label: {
            Label("Edit \(def.name)…", systemImage: "pencil")
        }
    }

    /// *Tag*'s, and *Add tag*'s: the tags the note lacks, each opening its
    /// values, then *New tag…*.
    @ViewBuilder static func add(_ missing: [TagDef], actions: TagActions) -> some View {
        ForEach(missing, id: \.name) { def in
            Menu(def.name) {
                ForEach(def.values, id: \.self) { value in
                    Button(value) { actions.set(def.name, value) }
                }
            }
        }
        if !missing.isEmpty { Divider() }
        Button {
            actions.newTag()
        } label: {
            Label("New tag…", systemImage: "plus")
        }
    }
}

/// Chips in rows that wrap: as many to a row as fit.
struct ChipFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = self.rows(subviews, width: proposal.width ?? .infinity)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        let widest = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? widest, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.items {
                let size = subviews[index].sizeThatFits(.unspecified)
                let width = min(size.width, bounds.width)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(width: width, height: size.height))
                x += width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var items: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func rows(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = row.items.isEmpty ? size.width : row.width + spacing + size.width
            if !row.items.isEmpty, needed > width {
                rows.append(row)
                row = Row()
            }
            row.width = row.items.isEmpty ? min(size.width, width) : row.width + spacing + size.width
            row.height = max(row.height, size.height)
            row.items.append(index)
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}
