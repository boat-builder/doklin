// A document's comment threads on this iPhone: read off its files, and
// changed by writing them — the markdown when a thread starts or goes, the
// `<stem>.meta.jsonl` beside it always. Sync carries both to every other
// device and merges the meta file line by line with what they wrote, which
// is why each change starts from the files as they are now.

import Foundation
import Observation

@MainActor
@Observable
public final class CommentsModel {
    public let workspace: Workspace
    /// The document: a note's markdown, or a page's html.
    public let path: String
    public private(set) var threads: [CommentThread] = []
    /// A change is being written.
    public private(set) var busy = false

    public init(workspace: Workspace, path: String) {
        self.workspace = workspace
        self.path = path
    }

    private var files: WorkspaceFiles { workspace.files }
    private var isNote: Bool { FileKind.of(path) == .markdown }
    private var metaPath: String { DocLinks.metaFile(of: path) }

    /// The page: the document itself, or a note's rendition beside it.
    private var pagePath: String? {
        if FileKind.of(path) == .html { return path }
        let rendition = MetaFile.stem(of: path) + ".html"
        return files.exists(rendition) ? rendition : nil
    }

    /// The threads on one form of the document, in the order they are listed.
    public func threads(on version: CommentVersion) -> [CommentThread] {
        threads.filter { $0.version == version }
    }

    /// Whether a change of the workspace's files is this document's comments'.
    public func isAffected(by changed: Set<String>) -> Bool {
        [path, metaPath, pagePath].compactMap { $0?.lowercased() }.contains { changed.contains($0) }
    }

    /// The files as they are now, and what the meta file said.
    private func read() throws -> (document: DocumentComments, meta: String?) {
        let meta = files.exists(metaPath) ? try files.text(metaPath) : nil
        let md = isNote ? try files.text(path) : nil
        let html = try pagePath.map { try files.text($0) }
        return (DocumentComments(md: md, meta: meta, html: html), meta)
    }

    /// Read the threads again. A document that cannot be read has none to show.
    public func load() {
        threads = (try? read().document.threads) ?? []
    }

    /* ---------- Changing ---------- */

    /// Start a thread on `words` of the note.
    public func start(on words: String, saying body: String) async throws {
        try await change { document, author, now, random in
            try document.start(on: words, body: body, author: author, at: now, id: document.freshId(using: &random))
        }
    }

    public func reply(to id: String, saying body: String) async throws {
        try await change { document, author, now, _ in
            try document.reply(to: id, body: body, author: author, at: now)
        }
    }

    /// Remove a thread: the conversation goes, the words it was on stay.
    public func remove(_ id: String) async throws {
        try await change { document, _, _, _ in try document.remove(id) }
    }

    /// Delete a reply: `entry`, shown at `index` of the thread.
    public func deleteReply(of id: String, entry: CommentEntry, at index: Int) async throws {
        try await change { document, _, _, _ in try document.deleteReply(of: id, entry: entry, at: index) }
    }

    /// The name comments written here are signed with: this device's, as a
    /// Mac signs with its own (the engine's `device_name`).
    private func author() async -> String {
        (try? await Engine.shared.call("device_name", as: String.self)) ?? "This iPhone"
    }

    private func change(_ edit: (inout DocumentComments, String, Double, inout SystemRandomNumberGenerator) throws -> Void) async throws {
        busy = true
        defer { busy = false }
        let author = await author()
        let (before, metaText) = try read()
        var document = before
        var random = SystemRandomNumberGenerator()
        do {
            try edit(&document, author, (Date().timeIntervalSince1970 * 1000).rounded(.down), &random)
        } catch let refusal as CommentRefusal {
            throw DoklinError(refusal.message)
        }
        // Only what changed is written: a file written for nothing is one
        // more change for every other device to take.
        var changed: [String] = []
        if let md = document.md, let disk = before.disk, md != JSString(disk) {
            changed += try files.write(path, Data(md.string.utf8))
        }
        if let text = document.metaText(fileExists: metaText != nil), metaText.map(JSText.key) != JSText.key(text) {
            changed += try files.write(metaPath, Data(text.utf8))
        }
        if !changed.isEmpty { await workspace.wrote(changed) }
        load()
    }
}
