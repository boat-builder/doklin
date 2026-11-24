import DoklinKit
import SwiftUI
import UIKit

/// What a tap or a long press inside a note can ask for. Nil means the
/// person may not, and the control is not offered.
struct MarkdownActions {
    /// Tick or untick the task on a line of the source.
    var toggleTask: ((Int) -> Void)?
    /// Start a comment on the block that begins on a line of the source.
    var comment: ((Int) -> Void)?
    /// Edit the note here, at the top-level block of this index: a double tap.
    var edit: ((Int) -> Void)?
}

/// What is laid over a note as it is read: the words a search found, with
/// the one the find bar is on, and what changed since it was last read.
struct ReaderMarks {
    var find: FindResult?
    var current: Int?
    var changes: ChangeMarks?

    func marks(_ container: String) -> [(range: Range<Int>, mark: RunMark)] {
        (find?.marks(in: container, current: current) ?? []) + (changes?.words[container]?.marks ?? [])
    }

    func removals(_ container: String) -> [Removal] {
        changes?.words[container]?.removed ?? []
    }
}

extension EnvironmentValues {
    @Entry var readerMarks = ReaderMarks()
}

/// A link inside a note, as the URL a tap on it carries. A web address is
/// itself; anything else — a path to another note, a `#heading`, the words a
/// comment is on, a link that opens nothing here — rides in a URL of the
/// app's own, read back by `tap`.
enum NoteLink {
    private static let scheme = "doklin-note"

    enum Tap {
        case href(String)
        case thread(String)
        case closed
    }

    static func url(href: String) -> URL? {
        if let url = URL(string: href), let scheme = url.scheme?.lowercased(), ["http", "https", "mailto", "tel"].contains(scheme) {
            return url
        }
        return make("link", href)
    }

    static func url(thread: String) -> URL? {
        make("thread", thread)
    }

    /// A link to a document this person can't open (`Inline.closedLink`).
    static var closed: URL? { make("closed", "") }

    private static func make(_ host: String, _ value: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = scheme
        parts.host = host
        parts.queryItems = [URLQueryItem(name: "v", value: value)]
        return parts.url
    }

    static func tap(_ url: URL) -> Tap? {
        guard url.scheme == scheme, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let value = parts.queryItems?.first?.value ?? ""
        switch parts.host {
        case "thread": return .thread(value)
        case "closed": return .closed
        default: return .href(value)
        }
    }
}

/// A note, read: the blocks the parser found, drawn natively.
struct MarkdownView: View {
    let document: MarkdownDocument
    /// The file the markdown is from: links and pictures are relative to it.
    let file: String
    let workspace: Workspace
    var actions = MarkdownActions()
    /// Shown under the note's title (its first heading, when it starts with
    /// one), above the rest: who made it, what changed.
    var underTitle: AnyView?

    @Environment(\.readerMarks) private var marks

    /// Whether the note starts with a title of its own.
    static func hasTitle(_ document: MarkdownDocument) -> Bool {
        if case .heading(1, _)? = document.blocks.first?.block { return true }
        return false
    }

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 16) {
            let titled = Self.hasTitle(document)
            if titled, let first = document.blocks.first {
                block(first, at: 0)
            }
            if let underTitle { underTitle }
            if let frontmatter = document.frontmatter {
                FrontmatterView(text: frontmatter)
            }
            ForEach(Array(document.blocks.enumerated()).dropFirst(titled ? 1 : 0), id: \.element.id) { index, node in
                block(node, at: index)
            }
            if let gone = marks.changes?.removedAtEnd, !gone.isEmpty {
                RemovedBlocks(texts: gone)
            }
        }
        // Its blocks are what a scroll position names: where Edit starts.
        .scrollTargetLayout()
    }

    private func block(_ node: BlockNode, at index: Int) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let gone = marks.changes?.removedBefore[node.id] {
                RemovedBlocks(texts: gone)
            }
            BlockView(node: node, file: file, workspace: workspace, actions: actions)
                .overlay(alignment: .leading) {
                    if let kind = marks.changes?.blocks[node.id] {
                        ChangeBar(kind: kind)
                    }
                }
        }
        .id(node.id)
        .contentShape(Rectangle())
        .simultaneousGesture(TapGesture(count: 2).onEnded { actions.edit?(index) }, including: actions.edit == nil ? .subviews : .all)
        .contextMenu {
            Button {
                UIPasteboard.general.string = node.plainText
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            if let comment = actions.comment {
                Button {
                    comment(node.line)
                } label: {
                    Label("Comment", systemImage: "bubble.left")
                }
            }
            if let edit = actions.edit {
                Button {
                    edit(index)
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
            }
        }
    }
}

/// The bar beside a block that changed since the note was last read.
private struct ChangeBar: View {
    let kind: ChangeMarks.Kind

    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(kind == .inserted ? Theme.accent : Theme.accent.opacity(0.6))
            .frame(width: 4)
            .padding(.vertical, 2)
            .offset(x: -12)
            .accessibilityLabel(kind == .inserted ? "New since you read it" : "Changed since you read it")
    }
}

/// Blocks gone since the note was last read: a line saying so, which opens
/// to show what they said.
private struct RemovedBlocks: View {
    let texts: [String]
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation { open.toggle() }
            } label: {
                HStack(spacing: 10) {
                    dash
                    Text("\(texts.count) \(texts.count == 1 ? "paragraph" : "paragraphs") removed · \(open ? "Hide" : "Show")")
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                        .fixedSize()
                    dash
                }
            }
            .buttonStyle(.plain)
            if open {
                ForEach(Array(texts.enumerated()), id: \.offset) { _, text in
                    Text(text)
                        .strikethrough()
                        .foregroundStyle(Theme.text2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private var dash: some View {
        Rectangle()
            .fill(Theme.accent.opacity(0.45))
            .frame(height: 1.5)
            .frame(maxWidth: .infinity)
    }
}

/// The YAML block at the top of a note, as it is: shown, never interpreted.
private struct FrontmatterView: View {
    let text: String
    @State private var open = false

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            Text(text)
                .font(.docCode)
                .foregroundStyle(Theme.text2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 6)
        } label: {
            Text("Frontmatter")
                .font(.footnote)
                .foregroundStyle(Theme.text3)
        }
        .padding(12)
        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: 8))
    }
}

struct BlockView: View {
    let node: BlockNode
    let file: String
    let workspace: Workspace
    let actions: MarkdownActions

    var body: some View {
        switch node.block {
        case .heading(let level, let content):
            InlineText(content, container: Find.container(node.id))
                .font(.docHeading(level))
                // Room above a heading, none over the note's first block —
                // as the editor's sheet sets it (src/ios-editor/editor.css).
                .padding(.top, node.id == 0 ? 0 : level <= 2 ? 18 : 10)
        case .paragraph(let content):
            InlineText(content, container: Find.container(node.id))
                .font(.body)
                .lineSpacing(3)
        case .blockquote(let blocks):
            VStack(alignment: .leading, spacing: 10) {
                ForEach(blocks) { inner in
                    BlockView(node: inner, file: file, workspace: workspace, actions: actions)
                }
            }
            .padding(.leading, 15)
            .overlay(alignment: .leading) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Theme.quoteBar)
                    .frame(width: 3)
            }
        case .callout(let kind, let blocks):
            CalloutView(kind: kind) {
                ForEach(blocks) { inner in
                    BlockView(node: inner, file: file, workspace: workspace, actions: actions)
                }
            }
        case .list(let list):
            ListView(list: list, file: file, workspace: workspace, actions: actions)
        case .code(let language, let text):
            switch language?.lowercased() {
            case "mermaid":
                FlowchartBlock(source: text, container: Find.container(node.id))
            case "svg":
                // A drawing is drawn on a Mac and on its public page; here it is its source.
                CodeView(note: "A drawing, shown here as its source", text: text, container: Find.container(node.id))
            default:
                CodeView(text: text, container: Find.container(node.id))
            }
        case .table(let table):
            TableView(table: table, id: node.id)
        case .image(let source, let alt):
            DocImage(source: source, alt: alt, file: file, workspace: workspace)
        case .html(let text):
            Text(text)
                .font(.docCode)
                .foregroundStyle(Theme.text3)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .thematicBreak:
            Divider()
                .padding(.vertical, 4)
        }
    }
}

/// A callout (`> [!NOTE]`), as the Mac draws it: a tinted box with a hairline
/// edge in its kind's colour, the kind's icon and name over the body, which
/// keeps the text's own size and colour. The editor's sheet draws the same box
/// (src/ios-editor/editor.css — change both).
private struct CalloutView<Content: View>: View {
    let kind: CalloutKind
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: kind.symbol)
                Text(kind.name)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.calloutInk(kind))
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 10) {
                content
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.calloutTint(kind), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Theme.calloutInk(kind).opacity(0.13), lineWidth: 1)
        }
    }
}

private extension CalloutKind {
    /// The SF Symbol of the Mac's icon (src/calloutTypes.ts): the same shapes.
    var symbol: String {
        switch self {
        case .note: return "info.circle"
        case .tip: return "lightbulb"
        case .important: return "exclamationmark.bubble"
        case .warning: return "exclamationmark.triangle"
        case .caution: return "exclamationmark.octagon"
        }
    }
}

/// A run of styled text. Links are live: a web address opens in the system,
/// the rest reach the document view through `openURL`. What the reader's
/// marks say of its container — a word found, a word written since it was
/// read — is drawn over it.
struct InlineText: View {
    let content: [Inline]
    var container: String?

    @Environment(\.readerMarks) private var marks

    init(_ content: [Inline], container: String? = nil) {
        self.content = content
        self.container = container
    }

    var body: some View {
        Text(InlineText.attributed(content.runs, marks: container.map(marks.marks) ?? [], removals: container.map(marks.removals) ?? []))
            .foregroundStyle(Theme.text1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    static func attributed(
        _ runs: [InlineRun], marks: [(range: Range<Int>, mark: RunMark)] = [], removals: [Removal] = []
    ) -> AttributedString {
        var out = AttributedString()
        for marked in RunMarks.apply(runs, marks: marks, removals: removals) {
            let run = marked.run
            var piece = AttributedString(run.text)
            var intent: InlinePresentationIntent = []
            if run.bold { intent.insert(.stronglyEmphasized) }
            if run.italic { intent.insert(.emphasized) }
            if run.strike { intent.insert(.strikethrough) }
            if run.code { intent.insert(.code) }
            if !intent.isEmpty { piece.inlinePresentationIntent = intent }
            if run.code { piece.backgroundColor = Theme.codeInlineBg }
            if let href = run.link, let url = NoteLink.url(href: href) {
                piece.link = url
            }
            if run.closed {
                // A link to a document this person can't open: its words,
                // greyed, and a tap says so.
                piece.link = NoteLink.closed
                piece.foregroundColor = Theme.text3
            }
            if run.highlighted {
                // Words under a comment: marked, and a tap opens the thread.
                piece.backgroundColor = Theme.mark
                if run.link == nil, !run.closed, let thread = run.thread, let url = NoteLink.url(thread: thread) {
                    piece.link = url
                    piece.foregroundColor = Theme.text1
                }
            }
            switch marked.mark {
            case .found?:
                piece.backgroundColor = Theme.mark
            case .current?:
                piece.backgroundColor = Theme.mark
                piece.underlineStyle = Text.LineStyle(pattern: .solid, color: Theme.warnInk)
            case .added?:
                piece.backgroundColor = Theme.accentWash
            case .removed?:
                piece.strikethroughStyle = Text.LineStyle(pattern: .solid, color: Theme.text2)
                piece.foregroundColor = Theme.text2
            case nil:
                break
            }
            out.append(piece)
        }
        return out
    }
}

private struct ListView: View {
    let list: ListBlock
    let file: String
    let workspace: Workspace
    let actions: MarkdownActions

    @Environment(\.readerMarks) private var marks

    var body: some View {
        VStack(alignment: .leading, spacing: list.tight ? 6 : 12) {
            ForEach(Array(list.items.enumerated()), id: \.element.id) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    marker(item, index)
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(item.blocks) { inner in
                            BlockView(node: inner, file: file, workspace: workspace, actions: actions)
                        }
                    }
                }
                .overlay(alignment: .leading) {
                    if let kind = marks.changes?.items[item.line] {
                        ChangeBar(kind: kind)
                    }
                }
            }
        }
    }

    @ViewBuilder private func marker(_ item: ListItem, _ index: Int) -> some View {
        if let done = item.task {
            Button {
                actions.toggleTask?(item.line)
            } label: {
                Image(systemName: done ? "checkmark.square.fill" : "square")
                    .font(.title3)
                    .foregroundStyle(done ? Theme.accent : Theme.text3)
                    // A box is small; what a thumb has to hit is not.
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(actions.toggleTask == nil)
            .accessibilityLabel(done ? "Done" : "Not done")
        } else if list.ordered {
            Text("\(list.start + index).")
                .font(.body)
                .monospacedDigit()
                .foregroundStyle(Theme.text2)
        } else {
            Text("•")
                .font(.body)
                .foregroundStyle(Theme.text2)
        }
    }
}

struct CodeView: View {
    /// A line over the code, when it stands for a figure: why it is shown as its source.
    var note: String?
    let text: String
    let container: String

    @Environment(\.readerMarks) private var marks

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let note {
                Label(note, systemImage: "rectangle.3.group")
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(InlineText.attributed([InlineRun(text)], marks: marks.marks(container)))
                    .font(.docCode)
                    .foregroundStyle(Theme.text1)
                    .padding(12)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.codeBg, in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

private struct TableView: View {
    let table: TableBlock
    let id: Int

    @Environment(\.readerMarks) private var marks

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(table.header.enumerated()), id: \.offset) { column, cell in
                        cellView(cell, column, row: -1)
                            .fontWeight(.semibold)
                    }
                }
                ForEach(Array(table.rows.enumerated()), id: \.offset) { number, row in
                    Rectangle()
                        .fill(Theme.tableRule)
                        .frame(height: 1)
                        .gridCellUnsizedAxes(.horizontal)
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                            cellView(cell, column, row: number)
                        }
                    }
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Theme.tableRule, lineWidth: 1)
            }
        }
    }

    private func cellView(_ content: [Inline], _ column: Int, row: Int) -> some View {
        Text(InlineText.attributed(content.runs, marks: marks.marks(Find.container(table: id, row: row, column: column))))
            .font(.callout)
            .foregroundStyle(Theme.text1)
            .multilineTextAlignment(textAlignment(column))
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(minWidth: 56, maxWidth: 260, alignment: frameAlignment(column))
            .gridColumnAlignment(horizontal(column))
    }

    private func alignment(_ column: Int) -> TableBlock.Alignment {
        column < table.alignments.count ? table.alignments[column] : .leading
    }

    private func textAlignment(_ column: Int) -> TextAlignment {
        switch alignment(column) {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    private func frameAlignment(_ column: Int) -> Alignment {
        switch alignment(column) {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    private func horizontal(_ column: Int) -> HorizontalAlignment {
        switch alignment(column) {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}

/// A picture a note shows: one of the workspace's own files on this iPhone,
/// or one on the web.
private struct DocImage: View {
    let source: String
    let alt: String
    let file: String
    let workspace: Workspace

    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: image.size.width)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .accessibilityLabel(alt)
            } else if failed {
                Label(alt.isEmpty ? source : alt, systemImage: "photo")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 80)
            }
        }
        .task(id: source) { await load() }
    }

    private func load() async {
        do {
            let data: Data
            switch DocLinks.target(of: source, from: file) {
            case .document(let path):
                data = try workspace.files.read(path)
            case .external(let address):
                guard let url = URL(string: address), url.scheme == "https" else {
                    failed = true
                    return
                }
                data = try await URLSession.shared.data(from: url).0
            case .heading, .nowhere:
                failed = true
                return
            }
            if let decoded = UIImage(data: data) {
                image = decoded
            } else {
                failed = true
            }
        } catch {
            failed = true
        }
    }
}
