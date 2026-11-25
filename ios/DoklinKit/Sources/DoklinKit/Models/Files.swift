// A workspace's files on this device, as the screens see them: what a
// folder holds, read and written, made, renamed, moved, removed and searched
// — by the rules the Mac's sidebar keeps, so both show one folder the same.
//
// Paths in and out are workspace-relative (`Projects/plan.md`). A document
// is a stem: its markdown file, its html rendition, or both, and the
// `<stem>.meta.jsonl` beside them (its comment threads) goes wherever they
// go. Nothing here talks to the engine; `Workspace.wrote` tells it what
// changed.

import Foundation

/// The names no listing, search or sync ever looks at: the engine's own rule
/// (`is_hidden_or_ignored`, engine/src/lib.rs), which the worker mirrors as
/// `IGNORED_NAMES` (cloud-worker/src/documents.ts) — change all three.
public func isHiddenOrIgnored(_ name: String) -> Bool {
    name.hasPrefix(".") || ["node_modules", "target", "dist", "build", "__pycache__"].contains(name)
}

/// What kind of file a name is, by its extension.
public enum FileKind: Equatable, Sendable {
    case markdown, html, image, pdf, text, other

    public static func of(_ path: String) -> FileKind {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "md", "markdown", "mdown", "mkd": return .markdown
        case "html": return .html
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "avif": return .image
        case "pdf": return .pdf
        case "txt", "json", "jsonl", "csv", "yaml", "yml", "toml", "xml", "log", "css", "js", "ts", "py", "rs", "sh", "swift": return .text
        default: return .other
        }
    }
}

/// A note or a page: the files that are one document.
public struct DocumentRow: Hashable, Sendable {
    /// The file it opens as: its markdown, or its html when it has none.
    public let path: String
    /// Its html rendition, beside the markdown.
    public let html: String?
    public let modified: Date?

    public var isHTML: Bool { FileKind.of(path) == .html }
}

public struct FileRow: Hashable, Sendable {
    public let path: String
    public let size: Int
    public let modified: Date?
}

/// One row of a folder.
public enum FolderEntry: Hashable, Identifiable, Sendable {
    case folder(String)
    case document(DocumentRow)
    case file(FileRow)

    public var path: String {
        switch self {
        case .folder(let path): return path
        case .document(let row): return row.path
        case .file(let row): return row.path
        }
    }

    /// The name a person sees: a document's without its extension.
    public var name: String {
        switch self {
        case .document(let row): return DocLinks.stem(of: DocLinks.name(of: row.path))
        default: return DocLinks.name(of: path)
        }
    }

    public var id: String { path.lowercased() }

    public var modified: Date? {
        switch self {
        case .folder: return nil
        case .document(let row): return row.modified
        case .file(let row): return row.modified
        }
    }
}

/// One line of a note a search found.
public struct SearchHit: Hashable, Sendable {
    /// 0-based, frontmatter counted.
    public let line: Int
    public let preview: String
}

public struct SearchResult: Hashable, Identifiable, Sendable {
    public let path: String
    public let hits: [SearchHit]

    public var id: String { path }
    public var name: String { DocLinks.stem(of: DocLinks.name(of: path)) }
}

public struct WorkspaceFiles: Sendable {
    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    public func url(_ path: String) -> URL {
        path.isEmpty ? root : root.appendingPathComponent(path)
    }

    public func absolute(_ path: String) -> String {
        url(path).path
    }

    private func join(_ dir: String, _ name: String) -> String {
        dir.isEmpty ? name : "\(dir)/\(name)"
    }

    /* ---------- Reading ---------- */

    public func exists(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: absolute(path))
    }

    public func read(_ path: String) throws -> Data {
        do {
            return try Data(contentsOf: url(path))
        } catch {
            throw DoklinError("\(DocLinks.name(of: path)) could not be read — it may have been moved or removed.")
        }
    }

    public func text(_ path: String) throws -> String {
        let data = try read(path)
        guard let text = String(data: data, encoding: .utf8) else {
            throw DoklinError("\(DocLinks.name(of: path)) is not text.")
        }
        return text
    }

    /// What a folder holds: folders, then documents, then other files, each
    /// in name order. Hidden names and comment files are left out, and an
    /// html file beside its markdown is that document's, not a row.
    public func list(_ dir: String) throws -> [FolderEntry] {
        let fm = FileManager.default
        let names: [String]
        do {
            names = try fm.contentsOfDirectory(atPath: absolute(dir))
        } catch {
            throw DoklinError("This folder could not be opened — it may have been moved or removed.")
        }
        var folders: [String] = []
        var markdown: [String] = []
        var html: [String: String] = [:]
        var others: [String] = []
        for name in names where !isHiddenOrIgnored(name) && !name.lowercased().hasSuffix(".meta.jsonl") {
            let path = join(dir, name)
            guard let kind = try? fm.attributesOfItem(atPath: absolute(path))[.type] as? FileAttributeType else { continue }
            if kind == .typeDirectory {
                folders.append(path)
            } else if kind == .typeRegular {
                switch FileKind.of(name) {
                case .markdown: markdown.append(path)
                case .html: html[DocLinks.stem(of: name)] = path
                default: others.append(path)
                }
            }
        }
        let byName = { (a: String, b: String) in
            DocLinks.name(of: a).localizedStandardCompare(DocLinks.name(of: b)) == .orderedAscending
        }
        // Every markdown file is a row. A page pairs with the one note of its
        // stem — `.md` first, as the Mac pairs them — and is a row of its own
        // when no note has its stem.
        let stemOf = { (path: String) in DocLinks.stem(of: DocLinks.name(of: path)) }
        let notes = markdown.sorted { a, b in
            let (aMd, bMd) = (a.lowercased().hasSuffix(".md"), b.lowercased().hasSuffix(".md"))
            return aMd != bMd ? aMd : byName(a, b)
        }
        var paired = Set<String>()
        var documents: [DocumentRow] = notes.map { path in
            let rendition = paired.insert(stemOf(path)).inserted ? html[stemOf(path)] : nil
            return DocumentRow(path: path, html: rendition, modified: modified(path))
        }
        documents += html.filter { !paired.contains($0.key) }.map { DocumentRow(path: $0.value, html: nil, modified: modified($0.value)) }
        documents.sort { byName($0.path, $1.path) }
        return folders.sorted(by: byName).map(FolderEntry.folder)
            + documents.map(FolderEntry.document)
            + others.sorted(by: byName).map { FolderEntry.file(FileRow(path: $0, size: size($0), modified: modified($0))) }
    }

    /// Every folder of the workspace, for choosing where something goes.
    public func everyFolder() -> [String] {
        var found: [String] = []
        func walk(_ dir: String, depth: Int) {
            guard depth < 12, let entries = try? list(dir) else { return }
            for case .folder(let path) in entries {
                found.append(path)
                walk(path, depth: depth + 1)
            }
        }
        walk("", depth: 0)
        return found
    }

    private func modified(_ path: String) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: absolute(path)))?[.modificationDate] as? Date
    }

    private func size(_ path: String) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: absolute(path)))?[.size] as? NSNumber)?.intValue ?? 0
    }

    /* ---------- Writing ---------- */

    /// Put a file down whole, in a folder that is there: a folder sync took
    /// away is never made again by a save. Answers the paths that changed,
    /// for `Workspace.wrote`.
    @discardableResult
    public func write(_ path: String, _ data: Data) throws -> [String] {
        guard exists(DocLinks.directory(of: path)) else {
            throw DoklinError("\(DocLinks.name(of: path)) was not saved: its folder is no longer on this iPhone.")
        }
        do {
            try data.write(to: url(path), options: .atomic)
        } catch {
            throw DoklinError("\(DocLinks.name(of: path)) could not be saved: \(error.localizedDescription)")
        }
        return [path]
    }

    /// Why a name cannot be given to something, or nil when it can.
    public static func nameProblem(_ name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "A name is required." }
        if trimmed.contains("/") || trimmed.contains("\\") || trimmed.contains(":") { return "Names can't contain /, \\ or :" }
        if trimmed.hasPrefix(".") { return "Names can't start with a dot." }
        if trimmed.utf8.count > 200 { return "That name is too long." }
        return nil
    }

    /// Why a folder in `dir` cannot be called `name`, or nil when it can: at
    /// the top of Library a section's own name is in no section, so nothing
    /// under it would sync.
    static func folderNameProblem(_ name: String, in dir: String) -> String? {
        guard dir.lowercased() == TreeModel.libraryFolder.lowercased(), TreeModel.isSectionName(name) else { return nil }
        return "A folder in Library can't be called Library, Private or Restricted."
    }

    /// Whether any file of a document called `stem` is already in `dir`.
    func stemTaken(_ stem: String, in dir: String) -> Bool {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: absolute(dir))) ?? []
        return names.contains { name in
            let kind = FileKind.of(name)
            return (kind == .markdown || kind == .html) && DocLinks.stem(of: name).lowercased() == stem.lowercased()
        }
    }

    /// Make a note in `dir`, with nothing in it, and answer its path. It is
    /// "Untitled" until it is named, by its title (`DocTitle`).
    public func createNote(in dir: String) throws -> String {
        let name = DocTitle.firstFree { stemTaken($0, in: dir) }
        let path = join(dir, name + ".md")
        try write(path, Data())
        return path
    }

    public func createFolder(in dir: String, named name: String) throws -> String {
        if let problem = Self.nameProblem(name) { throw DoklinError(problem) }
        let named = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let problem = Self.folderNameProblem(named, in: dir) { throw DoklinError(problem) }
        let path = join(dir, named)
        if exists(path) { throw DoklinError("A file or folder named “\(DocLinks.name(of: path))” already exists.") }
        do {
            try FileManager.default.createDirectory(at: url(path), withIntermediateDirectories: true)
        } catch {
            throw DoklinError("The folder could not be made: \(error.localizedDescription)")
        }
        return path
    }

    /// The files that are one entry, each with where it goes when the entry
    /// is renamed to `name` in `dir` (a document's name is its stem).
    private func moves(_ entry: FolderEntry, to dir: String, named name: String) -> [(String, String)] {
        switch entry {
        case .folder(let path):
            return [(path, join(dir, name))]
        case .file(let row):
            return [(row.path, join(dir, name))]
        case .document(let row):
            let ext = (row.path as NSString).pathExtension
            var pairs = [(row.path, join(dir, "\(name).\(ext)"))]
            if let html = row.html { pairs.append((html, join(dir, "\(name).html"))) }
            let meta = DocLinks.metaFile(of: row.path)
            if exists(meta) { pairs.append((meta, DocLinks.metaFile(of: pairs[0].1))) }
            return pairs
        }
    }

    private func relocate(_ pairs: [(String, String)]) throws -> [String] {
        let fm = FileManager.default
        for (from, to) in pairs where from.lowercased() != to.lowercased() && exists(to) {
            throw DoklinError("A file or folder named “\(DocLinks.name(of: to))” already exists there.")
        }
        var changed: [String] = []
        for (from, to) in pairs where from != to {
            do {
                try fm.createDirectory(at: url(to).deletingLastPathComponent(), withIntermediateDirectories: true)
                if from.lowercased() == to.lowercased() {
                    // A change of case only: the disk may see one name, so step aside first.
                    let aside = join(DocLinks.directory(of: to), ".doklin-rename-\(UUID().uuidString)")
                    try fm.moveItem(at: url(from), to: url(aside))
                    try fm.moveItem(at: url(aside), to: url(to))
                } else {
                    try fm.moveItem(at: url(from), to: url(to))
                }
            } catch {
                throw DoklinError("“\(DocLinks.name(of: from))” could not be moved: \(error.localizedDescription)")
            }
            changed += [from, to]
        }
        return changed
    }

    /// Rename in place. A document keeps its rendition and its comments; a
    /// file keeps the extension typed. Answers the new path and what changed.
    public func rename(_ entry: FolderEntry, to name: String) throws -> (path: String, changed: [String]) {
        if let problem = Self.nameProblem(name) { throw DoklinError(problem) }
        var newName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if case .document = entry, FileKind.of(newName) == .markdown || FileKind.of(newName) == .html {
            newName = DocLinks.stem(of: newName)
        }
        let dir = DocLinks.directory(of: entry.path)
        if case .folder = entry, let problem = Self.folderNameProblem(newName, in: dir) { throw DoklinError(problem) }
        let pairs = moves(entry, to: dir, named: newName)
        return (pairs[0].1, try relocate(pairs))
    }

    /// Move into another folder (`""` is the top of the workspace).
    public func move(_ entry: FolderEntry, into dir: String) throws -> (path: String, changed: [String]) {
        if case .folder(let own) = entry, dir == own || dir.hasPrefix(own + "/") {
            throw DoklinError("A folder can't go inside itself.")
        }
        if case .folder = entry, let problem = Self.folderNameProblem(entry.name, in: dir) { throw DoklinError(problem) }
        let name: String
        if case .document(let row) = entry { name = DocLinks.stem(of: DocLinks.name(of: row.path)) } else { name = entry.name }
        let pairs = moves(entry, to: dir, named: name)
        return (pairs[0].1, try relocate(pairs))
    }

    /// Remove for good from this iPhone, which has no Trash: the history of
    /// the workspace keeps it, under Recently deleted. Answers what went.
    public func remove(_ entry: FolderEntry) throws -> [String] {
        var gone = [entry.path]
        if case .document(let row) = entry {
            if let html = row.html { gone.append(html) }
            let meta = DocLinks.metaFile(of: row.path)
            if exists(meta) { gone.append(meta) }
        }
        for path in gone {
            do {
                try FileManager.default.removeItem(at: url(path))
            } catch {
                throw DoklinError("“\(DocLinks.name(of: path))” could not be removed: \(error.localizedDescription)")
            }
        }
        return gone
    }

    /// How many files are under a folder, for saying what removing it means.
    public func count(under dir: String) -> Int {
        var count = 0
        let walker = FileManager.default.enumerator(at: url(dir), includingPropertiesForKeys: [.isRegularFileKey])
        while let item = walker?.nextObject() as? URL {
            if (try? item.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true { count += 1 }
        }
        return count
    }

    /* ---------- Search ---------- */

    /// Every document under `folders` called something holding `query`, or
    /// whose text holds it, ignoring case — the ones named for it first:
    /// each line it is on, trimmed. A note is read for its text; a page is
    /// found by its name alone (the Mac's `search_workspace` and the worker's
    /// search match the same name). Not other files.
    public func search(_ query: String, in folders: [String], limit: Int = 2000) -> [SearchResult] {
        let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !wanted.isEmpty else { return [] }
        var named: [SearchResult] = []
        var others: [SearchResult] = []
        var documents: [DocumentRow] = []
        func walk(_ dir: String, depth: Int) {
            guard depth < 12, documents.count < limit, let entries = try? list(dir) else { return }
            for entry in entries {
                switch entry {
                case .folder(let path): walk(path, depth: depth + 1)
                case .document(let row): documents.append(row)
                default: break
                }
            }
        }
        for folder in folders { walk(folder, depth: 0) }
        for row in documents.prefix(limit) {
            var hits: [SearchHit] = []
            if !row.isHTML, let text = try? text(row.path) {
                for (number, line) in MarkdownLines.split(text).enumerated() where line.lowercased().contains(wanted) {
                    hits.append(SearchHit(line: number, preview: String(line.trimmingCharacters(in: .whitespaces).prefix(200))))
                    if hits.count == 200 { break }
                }
            }
            let result = SearchResult(path: row.path, hits: hits)
            if result.name.lowercased().contains(wanted) {
                named.append(result)
            } else if !hits.isEmpty {
                others.append(result)
            }
        }
        let byPath = { (a: SearchResult, b: SearchResult) in a.path.localizedStandardCompare(b.path) == .orderedAscending }
        return named.sorted(by: byPath) + others.sorted(by: byPath)
    }
}
