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
}

/// A link inside a note, as the URL a tap on it carries. A web address is
/// itself; anything else — a path to another note, a `#heading`, the words a
/// comment is on — rides in a URL of the app's own, read back by `tap`.
enum NoteLink {
    private static let scheme = "doklin-note"

    enum Tap {
        case href(String)
        case thread(String)
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
        return parts.host == "thread" ? .thread(value) : .href(value)
    }
}

/// A note, read: the blocks the parser found, drawn natively.
struct MarkdownView: View {
    let document: MarkdownDocument
    /// The file the markdown is from: links and pictures are relative to it.
    let file: String
    let session: Session
    var actions = MarkdownActions()

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 16) {
            if let frontmatter = document.frontmatter {
                FrontmatterView(text: frontmatter)
            }
            ForEach(document.blocks) { node in
                BlockView(node: node, file: file, session: session, actions: actions)
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
                    }
            }
        }
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
    let session: Session
    let actions: MarkdownActions

    var body: some View {
        switch node.block {
        case .heading(let level, let content):
            InlineText(content)
                .font(.docHeading(level))
                .padding(.top, level <= 2 ? 8 : 2)
        case .paragraph(let content):
            InlineText(content)
                .font(.body)
                .lineSpacing(3)
        case .blockquote(let blocks):
            VStack(alignment: .leading, spacing: 10) {
                ForEach(blocks) { inner in
                    BlockView(node: inner, file: file, session: session, actions: actions)
                }
            }
            .padding(.leading, 15)
            .overlay(alignment: .leading) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Theme.quoteBar)
                    .frame(width: 3)
            }
        case .list(let list):
            ListView(list: list, file: file, session: session, actions: actions)
        case .code(let language, let text):
            CodeView(language: language, text: text)
        case .table(let table):
            TableView(table: table)
        case .image(let source, let alt):
            DocImage(source: source, alt: alt, file: file, session: session)
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

/// A run of styled text. Links are live: a web address opens in the system,
/// the rest reach the document view through `openURL`.
struct InlineText: View {
    private let text: AttributedString

    init(_ content: [Inline]) {
        text = InlineText.attributed(content.runs)
    }

    var body: some View {
        Text(text)
            .foregroundStyle(Theme.text1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    static func attributed(_ runs: [InlineRun]) -> AttributedString {
        var out = AttributedString()
        for run in runs {
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
            if run.highlighted {
                // Words under a comment: marked, and a tap opens the thread.
                piece.backgroundColor = Theme.mark
                if run.link == nil, let thread = run.thread, let url = NoteLink.url(thread: thread) {
                    piece.link = url
                    piece.foregroundColor = Theme.text1
                }
            }
            out.append(piece)
        }
        return out
    }
}

private struct ListView: View {
    let list: ListBlock
    let file: String
    let session: Session
    let actions: MarkdownActions

    var body: some View {
        VStack(alignment: .leading, spacing: list.tight ? 6 : 12) {
            ForEach(Array(list.items.enumerated()), id: \.element.id) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    marker(item, index)
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(item.blocks) { inner in
                            BlockView(node: inner, file: file, session: session, actions: actions)
                        }
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

private struct CodeView: View {
    let language: String?
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let note {
                Label(note, systemImage: "rectangle.3.group")
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.docCode)
                    .foregroundStyle(Theme.text1)
                    .padding(12)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.codeBg, in: RoundedRectangle(cornerRadius: 8))
        }
    }

    /// A diagram is drawn on a Mac and on its public page; here it is its source.
    private var note: String? {
        switch language?.lowercased() {
        case "mermaid": return "A diagram, shown here as its source"
        case "svg": return "A drawing, shown here as its source"
        default: return nil
        }
    }
}

private struct TableView: View {
    let table: TableBlock

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(table.header.enumerated()), id: \.offset) { column, cell in
                        cellView(cell, column)
                            .fontWeight(.semibold)
                    }
                }
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                    Rectangle()
                        .fill(Theme.tableRule)
                        .frame(height: 1)
                        .gridCellUnsizedAxes(.horizontal)
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                            cellView(cell, column)
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

    private func cellView(_ content: [Inline], _ column: Int) -> some View {
        Text(InlineText.attributed(content.runs))
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

/// A picture a note shows: one of the workspace's own files, read through
/// the document API, or one on the web.
private struct DocImage: View {
    let source: String
    let alt: String
    let file: String
    let session: Session

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
                data = try await session.client.read(path).data
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
