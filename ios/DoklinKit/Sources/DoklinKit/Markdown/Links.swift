// Links from a note to other documents of the workspace, as the reader shows
// them. A note's sidecar files the id of the file each such link means (a
// `link` record, MetaFile.swift), so the link opens that file wherever it is
// now, and a link whose words are its destination's file name shows the
// file's name now. One whose file this person can't open is shown greyed,
// with its words as they were saved.
//
// A port of src/docLinks.ts's resolving (`linkKey`, `resolveLink`,
// `shownWords`): change both; verify-harness/links-fixture.json holds them
// to it.

import Foundation

/// The workspace's documents as links look them up: by file id and by path.
/// An id in two sections (a move between them half done) is the shared
/// section's, else the one in the lowest section id, as every device
/// answers (`indexDocuments`).
public struct DocumentIndex: Equatable, Sendable {
    public let documents: [WorkspaceDocument]
    private let byId: [String: WorkspaceDocument]
    private let byPath: [String: WorkspaceDocument]

    public init(_ documents: [WorkspaceDocument]) {
        self.documents = documents
        var byId: [String: WorkspaceDocument] = [:]
        var byPath: [String: WorkspaceDocument] = [:]
        for document in documents {
            byPath[document.path.lowercased()] = document
            guard let id = document.fileId else { continue }
            if let held = byId[id], (held.section ?? "") <= (document.section ?? "") { continue }
            byId[id] = document
        }
        self.byId = byId
        self.byPath = byPath
    }

    public func document(id: String) -> WorkspaceDocument? { byId[id] }
    public func document(at path: String) -> WorkspaceDocument? { byPath[path.lowercased()] }

    public static func == (a: DocumentIndex, b: DocumentIndex) -> Bool { a.documents == b.documents }
}

/// What a link opens. `record`: the note files it under one, and the id
/// decides, never its path; no document is a link that opens nothing here.
/// `path`: it has none and goes by its path, as every link did before.
public enum ResolvedLink: Equatable, Sendable {
    case record(key: String, document: WorkspaceDocument?)
    case path(key: String, path: String?, document: WorkspaceDocument?)

    public var key: String {
        switch self {
        case .record(let key, _), .path(let key, _, _): return key
        }
    }

    public var document: WorkspaceDocument? {
        switch self {
        case .record(_, let document), .path(_, _, let document): return document
        }
    }
}

public extension DocLinks {
    private static let documentExtensions = [".markdown", ".mdown", ".mkd", ".md", ".html"]
    private static let scheme = try! NSRegularExpression(pattern: "^[a-z][a-z0-9+.-]*:", options: .caseInsensitive)

    /// Whether a path names a document: markdown or html.
    static func isDocument(_ path: String) -> Bool {
        let lower = path.lowercased()
        return documentExtensions.contains { lower.hasSuffix($0) }
    }

    /// A document's name as a link to it says it: its file name without
    /// the extension.
    static func documentName(_ path: String) -> String {
        let name = name(of: path)
        let lower = name.lowercased()
        for ext in documentExtensions where lower.hasSuffix(ext) {
            return String(name.dropLast(ext.count))
        }
        return name
    }

    /// `.` and `..` folded out of a relative path; a `..` with nothing left
    /// to climb out of is kept.
    internal static func fold(_ path: String) -> String {
        var out: [Substring] = []
        for segment in path.split(separator: "/", omittingEmptySubsequences: true) {
            if segment == "." { continue }
            if segment == ".." {
                if let last = out.last, last != ".." { out.removeLast() } else { out.append(segment) }
                continue
            }
            out.append(segment)
        }
        return out.joined(separator: "/")
    }

    /// The key a link's record is filed under: its destination's path,
    /// decoded, with `.` and `..` folded. Nil for a link that is not to a
    /// document of the workspace: one with a scheme, a `#heading`, a path
    /// from a disk's root, or a file that is not a document.
    static func key(of href: String) -> String? {
        let raw = href.trimmingCharacters(in: .whitespacesAndNewlines)
        let whole = NSRange(location: 0, length: (raw as NSString).length)
        if raw.hasPrefix("//") || scheme.firstMatch(in: raw, range: whole) != nil { return nil }
        var path = String(raw.prefix { $0 != "#" && $0 != "?" })
        guard !path.isEmpty, !path.hasPrefix("/") else { return nil }
        path = path.removingPercentEncoding ?? path
        let key = fold(path)
        return !key.isEmpty && isDocument(key) ? key : nil
    }

    /// Where a key leads from the note at `file`; nil when it climbs out of
    /// the workspace.
    static func keyTarget(_ key: String, from file: String) -> String? {
        let folder = directory(of: file)
        let path = fold(folder.isEmpty ? key : "\(folder)/\(key)")
        return path.isEmpty || path == ".." || path.hasPrefix("../") ? nil : path
    }

    /// The destination the note at `from` writes for the document at `to`:
    /// the path between their folders.
    static func relativePath(from: String, to: String) -> String {
        let mine = directory(of: from).split(separator: "/").map(String.init)
        let theirs = to.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        var same = 0
        while same < mine.count, same < theirs.count - 1, mine[same] == theirs[same] { same += 1 }
        return (Array(repeating: "..", count: mine.count - same) + theirs[same...]).joined(separator: "/")
    }

    /// What the link `href` in the note at `file` opens; nil for a link that
    /// is not to a document, which goes as it always did.
    static func resolve(_ href: String, from file: String, records: [LinkRecord], in documents: DocumentIndex) -> ResolvedLink? {
        guard let key = key(of: href) else { return nil }
        if let record = records.first(where: { $0.id.string == key }) {
            return .record(key: key, document: documents.document(id: record.file.string))
        }
        let path = keyTarget(key, from: file)
        return .path(key: key, path: path, document: path.flatMap { documents.document(at: $0) })
    }

    /// The words a link shows: a named link's are its document's name now,
    /// any other words are the author's.
    static func shownWords(_ words: String, _ resolved: ResolvedLink) -> String {
        guard let document = resolved.document, words == documentName(resolved.key) else { return words }
        return documentName(document.path)
    }

    /// The note at `file` as the reader shows it: each link with a record
    /// points where its file is now, a named one in its name now, and one
    /// whose file this person can't open is a closed link.
    static func resolving(_ document: MarkdownDocument, in file: String, records: [LinkRecord], documents: DocumentIndex) -> MarkdownDocument {
        guard !records.isEmpty else { return document }
        func inline(_ nodes: [Inline]) -> [Inline] {
            nodes.map { node in
                switch node {
                case .emphasis(let c): return .emphasis(inline(c))
                case .strong(let c): return .strong(inline(c))
                case .strikethrough(let c): return .strikethrough(inline(c))
                case .highlight(let thread, let c): return .highlight(thread: thread, children: inline(c))
                case .link(let destination, let children):
                    guard case .record(let key, let target)? = resolve(destination, from: file, records: records, in: documents) else {
                        return node
                    }
                    guard let target else { return .closedLink(children) }
                    let rest = destination.drop { $0 != "#" && $0 != "?" }
                    let words = shownWords(children.plainText, .record(key: key, document: target))
                    let shown = words == children.plainText ? children : [.text(words)]
                    return .link(destination: relativePath(from: file, to: target.path) + rest, children: shown)
                default:
                    return node
                }
            }
        }
        func blocks(_ nodes: [BlockNode]) -> [BlockNode] {
            nodes.map { node in
                let block: Block
                switch node.block {
                case .heading(let level, let content): block = .heading(level: level, content: inline(content))
                case .paragraph(let content): block = .paragraph(inline(content))
                case .blockquote(let inner): block = .blockquote(blocks(inner))
                case .callout(let kind, let inner): block = .callout(kind: kind, blocks: blocks(inner))
                case .list(let list):
                    block = .list(ListBlock(
                        ordered: list.ordered, start: list.start, tight: list.tight,
                        items: list.items.map { ListItem(line: $0.line, task: $0.task, blocks: blocks($0.blocks)) }
                    ))
                case .table(let table):
                    block = .table(TableBlock(alignments: table.alignments, header: table.header.map(inline), rows: table.rows.map { $0.map(inline) }))
                case .code, .image, .html, .thematicBreak:
                    return node
                }
                return BlockNode(id: node.id, line: node.line, block: block)
            }
        }
        return MarkdownDocument(frontmatter: document.frontmatter, blocks: blocks(document.blocks))
    }
}
