// A folder of the workspace, as a screen shows it: what it holds, and the
// changes a person makes from a list — a new note, a rename, a move, a removal.

import Foundation
import Observation

/// One row of a folder.
public enum FolderEntry: Hashable, Identifiable, Sendable {
    case folder(String)
    case document(DocRow)
    case file(FileRow)

    /// The path a call names it by: a folder's or a file's own, a document's stem.
    public var path: String {
        switch self {
        case .folder(let path): return path
        case .document(let row): return row.path
        case .file(let row): return row.path
        }
    }

    public var name: String { DocLinks.name(of: path) }

    public var id: String {
        switch self {
        case .folder: return "folder:\(path)"
        case .document: return "document:\(path)"
        case .file: return "file:\(path)"
        }
    }

    /// Every address it is public at.
    public var addresses: [String] {
        switch self {
        case .folder: return []
        case .document(let row): return row.public ?? []
        case .file(let row): return row.public ?? []
        }
    }

    public var changed: Date? {
        let ms: Double?
        switch self {
        case .folder: ms = nil
        case .document(let row): ms = row.changed
        case .file(let row): ms = row.changed
        }
        return ms.map { Date(timeIntervalSince1970: $0 / 1000) }
    }
}

@MainActor
@Observable
public final class FolderModel {
    public let session: Session
    /// `""` is the workspace itself.
    public let dir: String
    public private(set) var listing: Listing?
    public private(set) var phase: LoadPhase = .idle
    /// Said above the list when what is shown is a kept copy.
    public private(set) var notice: String?

    public init(session: Session, dir: String) {
        self.session = session
        self.dir = dir
    }

    private var cacheKey: String { "tree:\(dir.lowercased())" }

    public var title: String { dir.isEmpty ? session.account.workspace : DocLinks.name(of: dir) }

    /// Folders, then documents, then files — each already in name order.
    public var entries: [FolderEntry] {
        guard let listing else { return [] }
        return listing.folders.map(FolderEntry.folder) + listing.documents.map(FolderEntry.document) + listing.files.map(FolderEntry.file)
    }

    public func load() async {
        if listing == nil, let kept = session.cache.load(Listing.self, for: cacheKey) {
            listing = kept
            phase = .loaded
        } else if listing == nil {
            phase = .loading
        }
        do {
            let fresh = try await session.client.tree(dir)
            listing = fresh
            notice = nil
            phase = .loaded
            session.cache.store(fresh, for: cacheKey)
        } catch let error as DoklinError where error.kind == .notFound && !dir.isEmpty {
            // A folder is there only while something is in it.
            listing = Listing(dir: dir, folders: [], documents: [], files: [], notListed: nil)
            notice = nil
            phase = .loaded
            session.cache.remove(cacheKey)
        } catch {
            guard let message = session.explain(error) else { return }
            if listing != nil, (error as? DoklinError)?.kind == .unreachable {
                notice = "Offline — this is the list as it was last read."
                phase = .loaded
            } else if listing == nil {
                phase = .failed(message)
            } else {
                notice = message
            }
        }
    }

    /// Why a name cannot be given to something new, or nil when it can.
    public static func nameProblem(_ name: String) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "Give it a name." }
        if trimmed.contains("/") || trimmed.contains("\\") { return "A name cannot contain a slash." }
        if trimmed.hasPrefix(".") { return "A name cannot begin with a dot — Doklin does not sync hidden files." }
        if trimmed.count > 80 { return "That name is too long — a name may be 80 characters." }
        return nil
    }

    private func path(for name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return dir.isEmpty ? trimmed : "\(dir)/\(trimmed)"
    }

    /// Make a note here and answer its path. It must be new: a name already
    /// taken is refused, never written over.
    public func createNote(named name: String) async throws -> String {
        if let problem = FolderModel.nameProblem(name) { throw DoklinError(.refused, problem) }
        var title = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.lowercased().hasSuffix(".md") { title = String(title.dropLast(3)) }
        // The markdown version, said outright: a name with a dot in it
        // ("v1.2 notes") would otherwise be read as a plain file.
        let answer = try await session.client.write(path(for: title), Data(MarkdownEditing.newNote(named: title).utf8), version: .md, expect: .new)
        session.changed()
        await load()
        return answer.path
    }

    public func remove(_ entry: FolderEntry) async throws -> RemoveAnswer {
        if case .folder = entry {
            throw DoklinError(.refused, "A folder goes when the last thing in it does — remove or move what is inside.")
        }
        let answer = try await session.client.remove(entry.path)
        session.changed()
        await load()
        return answer
    }

    /// Rename in place. A document keeps its versions and comments; a file keeps its extension as typed.
    public func rename(_ entry: FolderEntry, to name: String) async throws {
        if let problem = FolderModel.nameProblem(name) { throw DoklinError(.refused, problem) }
        let folder = DocLinks.directory(of: entry.path)
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = try await session.client.move(from: entry.path, to: folder.isEmpty ? trimmed : "\(folder)/\(trimmed)")
        session.changed()
        await load()
    }

    /// Move into another folder (`""` is the top of the workspace), and
    /// answer the addresses that stopped being public because of it.
    public func move(_ entry: FolderEntry, into folder: String) async throws -> [String] {
        let from: String
        if case .folder = entry { from = entry.path + "/" } else { from = entry.path }
        // Into the workspace itself is a destination with the same name at the top.
        let to = folder.isEmpty ? entry.name : "\(folder)/"
        let answer = try await session.client.move(from: from, to: to)
        session.changed()
        await load()
        return answer.unpublished ?? []
    }

    /// Every folder of the workspace, for choosing where something goes.
    public func everyFolder() async throws -> [String] {
        let all = try await session.client.tree("", deep: true)
        return all.folders
    }
}

/// What kind of thing a plain file is, by its name — which is all a listing knows.
public enum FileKind: Equatable, Sendable {
    case image, pdf, text, other

    public static func of(_ path: String) -> FileKind {
        let ext = path.split(separator: ".").last.map { $0.lowercased() } ?? ""
        switch ext {
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "avif": return .image
        case "pdf": return .pdf
        case "txt", "json", "jsonl", "csv", "yaml", "yml", "toml", "xml", "log", "css", "js", "ts", "py", "rs", "sh", "swift": return .text
        default: return .other
        }
    }
}
