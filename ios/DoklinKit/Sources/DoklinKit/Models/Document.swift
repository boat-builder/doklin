// One document, open: its text, its comments, where it is public — and the
// changes a person makes to it from the phone.
//
// Nothing here overwrites silently. A save says which revision was read
// (`if-rev`), and a document that changed meanwhile is a conflict the person
// settles, exactly as `doklin write --if-rev` leaves it to an agent.

import Foundation
import Observation

/// Text typed and not yet saved, with the revision it was typed over.
public struct Draft: Codable, Equatable, Sendable {
    public let text: String
    public let rev: Int
}

@MainActor
@Observable
public final class DocumentModel {
    public let session: Session
    /// The path it was opened by: a document's stem, or a file's full path.
    public let path: String
    public private(set) var content: DocContent?
    /// The markdown, read into blocks — nil for an html version or a plain file.
    public private(set) var document: MarkdownDocument?
    /// Its versions and public addresses — documents only.
    public private(set) var info: DocRow?
    public private(set) var threads: [CommentThread] = []
    public private(set) var phase: LoadPhase = .idle
    /// Said above the text when what is shown is a kept copy.
    public private(set) var notice: String?
    /// A change is on its way to the domain.
    public private(set) var busy = false
    /// Something a person should read; the view shows it and sets it back to nil.
    public var problem: String?

    public init(session: Session, path: String) {
        self.session = session
        self.path = path
    }

    private var cacheKey: String { "doc:\(path.lowercased())" }
    private var draftKey: String { "draft:\(path.lowercased())" }

    /// The path every call about this document names it by.
    private var name: String { content?.path ?? path }

    public var title: String { DocLinks.name(of: name) }
    public var isDocument: Bool { content?.kind == .document }
    public var version: DocVersion? { content?.version }
    public var text: String? { content?.text }
    /// Whether the text shown can be edited here: a document's markdown.
    public var canEdit: Bool { isDocument && version == .md && text != nil && session.may(.edit) && notice == nil }
    public var addresses: [String] { info?.public ?? [] }
    /// The threads on the version being shown.
    public var shownThreads: [CommentThread] { threads.filter { $0.version == (version ?? .md) } }

    private func show(_ fresh: DocContent) {
        content = fresh
        document = fresh.kind == .document && fresh.version == .md ? fresh.text.map(MarkdownDocument.parse) : nil
    }

    /// Read the document: the kept copy at once, then the domain's.
    public func load(version asked: DocVersion? = nil) async {
        let wanted = asked ?? version
        if content == nil, let kept = session.cache.load(DocContent.self, for: cacheKey), asked == nil || kept.version == asked {
            show(kept)
            phase = .loaded
        } else if content == nil {
            phase = .loading
        }
        do {
            let fresh = try await session.client.read(path, version: wanted)
            show(fresh)
            notice = nil
            phase = .loaded
            // A large file is read again when it is opened again.
            if fresh.data.count <= 2_000_000 { session.cache.store(fresh, for: cacheKey) }
        } catch {
            guard let message = session.explain(error) else { return }
            let kind = (error as? DoklinError)?.kind
            if content != nil, kind == .unreachable {
                notice = "Offline — this is the copy from the last time it was read."
                phase = .loaded
            } else if content != nil, kind != .notFound {
                problem = message
            } else {
                content = nil
                document = nil
                session.cache.remove(cacheKey)
                phase = .failed(message)
            }
            return
        }
        await loadDetails()
    }

    /// What is known beside the text: versions, addresses, comments.
    private func loadDetails() async {
        guard isDocument else { return }
        async let row = session.client.info(name)
        async let comments = session.client.comments(name)
        if let row = try? await row { info = row }
        if let comments = try? await comments { threads = comments.threads }
    }

    /* ---------- Writing ---------- */

    private func wrote(_ text: String, _ answer: WriteAnswer) {
        guard let was = content else { return }
        let fresh = DocContent(
            kind: was.kind, path: was.path, file: was.file, rev: answer.rev, version: was.version,
            htmlBehind: answer.htmlBehind ?? false, contentType: was.contentType, data: Data(text.utf8)
        )
        show(fresh)
        session.cache.store(fresh, for: cacheKey)
        session.drafts.remove(draftKey)
        session.changed()
    }

    /// Save the markdown over the revision that was read. A `.conflict` is
    /// thrown when it changed meanwhile; nothing was written then.
    public func save(_ text: String, over rev: Int? = nil) async throws {
        guard let content, content.version == .md else {
            throw DoklinError(.refused, "Only a document's markdown can be edited here.")
        }
        busy = true
        defer { busy = false }
        do {
            let answer = try await session.client.write(content.path, Data(text.utf8), version: .md, expect: .rev(rev ?? content.rev))
            wrote(text, answer)
        } catch {
            session.explain(error)
            throw error
        }
        await loadDetails()
    }

    /// Save over whatever is there now. Only ever after a person was told
    /// what it replaces.
    public func overwrite(_ text: String) async throws {
        guard let content, content.version == .md else {
            throw DoklinError(.refused, "Only a document's markdown can be edited here.")
        }
        busy = true
        defer { busy = false }
        do {
            let answer = try await session.client.write(content.path, Data(text.utf8), version: .md, expect: .anything)
            wrote(text, answer)
        } catch {
            session.explain(error)
            throw error
        }
        await loadDetails()
    }

    /// Tick or untick the task on a line of the source (0-based).
    public func toggleTask(line: Int) async {
        guard canEdit, !busy, let content, let text = content.text else { return }
        guard let changed = MarkdownEditing.togglingTask(in: text, line: line) else {
            await load()
            return
        }
        busy = true
        defer { busy = false }
        do {
            let answer = try await session.client.write(content.path, Data(changed.utf8), version: .md, expect: .rev(content.rev))
            wrote(changed, answer)
        } catch let error as DoklinError where error.kind == .conflict {
            await load()
            problem = "This note changed somewhere else, so it was read again. Tick the box once more."
        } catch {
            problem = session.explain(error)
        }
    }

    /* ---------- Drafts ---------- */

    public var draft: Draft? { session.drafts.load(Draft.self, for: draftKey) }

    /// Keep what is being typed, so leaving the app loses nothing.
    public func keepDraft(_ text: String, over rev: Int) {
        if text == content?.text {
            session.drafts.remove(draftKey)
        } else {
            session.drafts.store(Draft(text: text, rev: rev), for: draftKey)
        }
    }

    public func discardDraft() {
        session.drafts.remove(draftKey)
    }

    /* ---------- Comments ---------- */

    /// Words on a line of the source that a new comment can sit on.
    public func commentAnchor(line: Int) -> String? {
        text.flatMap { MarkdownEditing.commentAnchor(in: $0, line: line) }
    }

    private func afterComment() async {
        // A thread's marker is in the text, so the text has a new revision.
        await load()
    }

    public func startThread(on words: String, body: String) async throws {
        busy = true
        defer { busy = false }
        do {
            _ = try await session.client.comment(name, on: words, body: body, version: version)
        } catch {
            session.explain(error)
            throw error
        }
        session.changed()
        await afterComment()
    }

    public func reply(to thread: String, body: String) async throws {
        busy = true
        defer { busy = false }
        do {
            _ = try await session.client.reply(name, thread: thread, body: body)
        } catch {
            session.explain(error)
            throw error
        }
        await afterComment()
    }

    public func removeThread(_ thread: String) async throws {
        busy = true
        defer { busy = false }
        do {
            try await session.client.removeThread(name, thread: thread)
        } catch {
            session.explain(error)
            throw error
        }
        session.changed()
        await afterComment()
    }

    /* ---------- Publishing ---------- */

    /// Give it a public address, and answer the address.
    public func publish() async throws -> String {
        busy = true
        defer { busy = false }
        do {
            let answer = try await session.client.publish(name)
            session.changed()
            await loadDetails()
            return answer.url
        } catch {
            session.explain(error)
            throw error
        }
    }

    public func unpublish() async throws {
        busy = true
        defer { busy = false }
        do {
            _ = try await session.client.unpublish(path: name)
            session.changed()
            await loadDetails()
        } catch {
            session.explain(error)
            throw error
        }
    }
}

/// A search of the workspace.
@MainActor
@Observable
public final class SearchModel {
    public let session: Session
    public private(set) var answer: SearchAnswer?
    public private(set) var phase: LoadPhase = .idle

    public init(session: Session) {
        self.session = session
    }

    /// Search for `text`; an empty one clears what was found.
    public func run(_ text: String) async {
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            answer = nil
            phase = .idle
            return
        }
        phase = .loading
        do {
            let found = try await session.client.search(query)
            answer = found
            phase = .loaded
        } catch {
            guard let message = session.explain(error) else { return }
            answer = nil
            phase = .failed(message)
        }
    }

    /// What a search could not cover, as a sentence — or nil when it covered everything.
    public var caveat: String? {
        guard let answer else { return nil }
        var parts: [String] = []
        if answer.truncated == true { parts.append("Only the first \(answer.results.count) of \(answer.total) documents are shown.") }
        if let big = answer.notSearched, !big.isEmpty { parts.append("Too large to search: \(big.joined(separator: ", ")).") }
        if let left = answer.sectionsNotSearched, !left.isEmpty { parts.append("Not searched: \(left.joined(separator: ", ")).") }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }
}

/// Every public address this person can see.
@MainActor
@Observable
public final class PagesModel {
    public let session: Session
    public private(set) var pages: [Page] = []
    public private(set) var phase: LoadPhase = .idle

    public init(session: Session) {
        self.session = session
    }

    public func load() async {
        if pages.isEmpty { phase = .loading }
        do {
            pages = try await session.client.pages().pages
            phase = .loaded
        } catch {
            guard let message = session.explain(error) else { return }
            phase = .failed(message)
        }
    }

    public func stop(_ page: Page) async throws {
        do {
            _ = try await session.client.unpublish(slug: page.slug)
        } catch {
            session.explain(error)
            throw error
        }
        session.changed()
        await load()
    }
}
