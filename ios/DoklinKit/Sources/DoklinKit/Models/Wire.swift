// The document API's answers, as the worker writes them
// (cloud-worker/README.md, "Document API"). Every optional here is a field
// the worker leaves out when it has nothing to say.

import Foundation

public struct WorkspaceRef: Codable, Hashable, Sendable {
    public let id: String
    public let name: String
}

public struct NamedRef: Codable, Hashable, Sendable {
    public let id: String
    public let name: String
}

/// What an agent may do. `read` is always among them.
public enum Scope: String, CaseIterable, Sendable {
    case read, comment, edit, publish
}

public enum DocVersion: String, Codable, Hashable, Sendable {
    case md, html
}

/// `POST login` — the one answer that carries a token.
public struct LoginAnswer: Decodable, Sendable {
    public let token: String
    public let agent: NamedRef
    public let scopes: [String]
    public let workspace: WorkspaceRef?
    public let version: Int
    public let features: [String]
}

/// `GET me`.
public struct Me: Codable, Hashable, Sendable {
    public let agent: NamedRef
    public let person: NamedRef?
    public let scopes: [String]
    /// Where it can work besides the shared workspace, as folders.
    public let sections: [String]
    public let workspace: WorkspaceRef?
    public let version: Int
    public let features: [String]

    public func may(_ scope: Scope) -> Bool { scopes.contains(scope.rawValue) }
}

/// One version of a document: the file behind it.
public struct VersionInfo: Codable, Hashable, Sendable {
    /// The file's own name, extension included.
    public let file: String
    public let rev: Int
    public let size: Int
    /// When its content last changed, epoch ms.
    public let changed: Double?
    /// Who changed it: a member or agent id.
    public let by: String?
    /// Their name — only where the worker resolves it (`info=1`).
    public let byName: String?
}

/// A document as a listing shows it: one name, up to two versions.
public struct DocRow: Codable, Hashable, Identifiable, Sendable {
    /// The path without an extension.
    public let path: String
    public let md: VersionInfo?
    public let html: VersionInfo?
    /// The html version is older than the markdown it was made from.
    public let htmlBehind: Bool?
    /// Every address it is public at.
    public let `public`: [String]?
    /// How many comment threads it has — only from `info=1`.
    public let comments: Int?

    public var id: String { path }
    public var changed: Double? { md?.changed ?? html?.changed }
    public var versions: [DocVersion] { (md == nil ? [] : [.md]) + (html == nil ? [] : [.html]) }
}

/// A plain file: anything that is not a document.
public struct FileRow: Codable, Hashable, Identifiable, Sendable {
    public let path: String
    public let rev: Int
    public let size: Int
    public let changed: Double?
    public let by: String?
    public let byName: String?
    public let `public`: [String]?

    public var id: String { path }
}

/// `GET tree` — what a folder holds. Folders and files are full paths.
public struct Listing: Codable, Hashable, Sendable {
    public let dir: String
    public let folders: [String]
    public let documents: [DocRow]
    public let files: [FileRow]
    /// Sections a deep listing did not open.
    public let notListed: [String]?

    public var isEmpty: Bool { folders.isEmpty && documents.isEmpty && files.isEmpty }
}

/// `GET doc` — a document's or a file's bytes, with what the headers say.
public struct DocContent: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable { case document, file }

    public let kind: Kind
    /// A document's stem, or a file's full path.
    public let path: String
    /// The path of the file the bytes are from.
    public let file: String
    public let rev: Int
    public let version: DocVersion?
    public let htmlBehind: Bool
    public let contentType: String?
    public let data: Data

    public var text: String? { String(data: data, encoding: .utf8) }
}

/// `PUT doc`.
public struct WriteAnswer: Decodable, Sendable {
    public let kind: String
    public let path: String
    public let version: DocVersion?
    public let rev: Int
    public let size: Int
    public let created: Bool
    public let unchanged: Bool?
    public let htmlBehind: Bool?
}

/// `DELETE doc`.
public struct RemoveAnswer: Decodable, Sendable {
    public let kind: String
    public let path: String
    public let versions: [String]?
    /// Addresses that still point at what was removed: a page outlives its document.
    public let stillPublic: [String]?
    public let threadsRemoved: Int?
}

/// `POST move`.
public struct MoveAnswer: Decodable, Sendable {
    public let kind: String
    public let from: String
    public let to: String
    public let files: Int
    /// Addresses that stopped answering because the move crossed sections.
    public let unpublished: [String]?
}

public struct CommentEntry: Codable, Hashable, Sendable {
    public let author: String
    /// Epoch ms; 0 when unknown.
    public let at: Double
    public let body: String
}

public struct CommentThread: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let version: DocVersion
    /// The text it is anchored on: the marked words, or the start of the element.
    public let on: String
    /// Markdown only: the line its marker is on, 1-based.
    public let line: Int?
    /// Html only: the element it is on.
    public let tag: String?
    /// Its anchor is gone.
    public let orphaned: Bool?
    public let comments: [CommentEntry]
}

/// `GET comments`.
public struct CommentsAnswer: Codable, Hashable, Sendable {
    public let path: String
    public let threads: [CommentThread]
}

/// `POST comments` — a thread started, or one answered.
public struct CommentedAnswer: Decodable, Sendable {
    public let path: String
    public let thread: String
    public let version: DocVersion
}

public struct SearchMatch: Codable, Hashable, Sendable {
    /// Markdown only, 1-based.
    public let line: Int?
    public let text: String
}

public struct SearchResult: Codable, Hashable, Identifiable, Sendable {
    public let path: String
    public let version: DocVersion
    public let matches: [SearchMatch]
    public let moreLines: Int?
    /// Found in a comment, on no line of the text.
    public let inComments: Bool?

    public var id: String { "\(path)#\(version.rawValue)" }

    /// A matching line as a reader would see it. The worker answers with the
    /// line of the source, so a markdown one is read the way the note is:
    /// its marks dropped, its links as their words.
    public func shown(_ match: SearchMatch) -> String {
        guard version == .md else { return match.text }
        let words = MarkdownDocument.parse(match.text).blocks.map(\.plainText).joined(separator: " ")
        return words.trimmingCharacters(in: .whitespaces).isEmpty ? match.text : words
    }
}

/// `GET search`.
public struct SearchAnswer: Codable, Hashable, Sendable {
    public let query: String
    public let dir: String
    public let results: [SearchResult]
    public let total: Int
    public let truncated: Bool?
    /// Documents too large to search.
    public let notSearched: [String]?
    public let sectionsNotSearched: [String]?
}

/// One public address.
public struct Page: Codable, Hashable, Identifiable, Sendable {
    public let slug: String
    public let url: String
    /// `document`, `file` or `folder`.
    public let kind: String
    public let path: String
    public let title: String?
    public let desc: String?
    public let home: Bool?
    public let byName: String?
    public let at: Double?
    /// Its file is gone: the address answers 404 until the file is back.
    public let missing: Bool?

    public var id: String { slug }
}

/// `GET pages`.
public struct PagesAnswer: Codable, Hashable, Sendable {
    public let pages: [Page]
    public let notListed: [String]?
}

/// `PUT pages`.
public struct PublishedAnswer: Decodable, Sendable {
    public let slug: String
    public let url: String
    public let kind: String
    public let path: String
    public let created: Bool
}

/// `DELETE pages`.
public struct StoppedAnswer: Decodable, Sendable {
    public struct Address: Decodable, Sendable {
        public let slug: String
        public let url: String
    }
    public let stopped: [Address]
}
