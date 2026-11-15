// The document API, one method a route. What each sends and what comes back
// is cloud-worker/README.md, "Document API"; a path is always the one the
// person's Mac has on disk — `Private/…`, `Restricted/<folder>/…`, or shared.

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension DoklinClient {
    private static func json(_ object: [String: Any]) -> RequestBody {
        // The values are strings and booleans this file wrote: it cannot fail.
        .json((try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8))
    }

    /* ---------- Logging in ---------- */

    /// Trade a login code for this device's own token. The code is sent as it
    /// was typed: the worker is the one that knows what a code looks like.
    public static func login(endpoint: String, code: String, host: String, clientName: String, session: URLSession? = nil) async throws -> LoginAnswer {
        let client = DoklinClient(endpoint: endpoint, token: nil, clientName: clientName, session: session)
        let reply = try await client.send("POST", "login", body: json(["code": code, "host": host]))
        let answer = try reply.decode(LoginAnswer.self)
        guard !answer.token.isEmpty else {
            throw DoklinError(.other, "\(client.domain) did not answer with a login — is it a Doklin workspace?")
        }
        return answer
    }

    /// Revoke the token this client holds.
    public func logout() async throws {
        _ = try await send("DELETE", "login")
    }

    public func me() async throws -> Me {
        try await send("GET", "me").decode(Me.self)
    }

    /* ---------- Reading ---------- */

    /// What a folder holds; `""` is the workspace itself. A folder with
    /// nothing in it does not exist, so that is a `.notFound`.
    public func tree(_ dir: String = "", deep: Bool = false) async throws -> Listing {
        var query = [("dir", dir)]
        if deep { query.append(("deep", "1")) }
        return try await send("GET", "tree", query: query).decode(Listing.self)
    }

    /// A document's text or a file's bytes. Markdown comes with its comment
    /// markers unless `clean`: a write has to hand them back as they were.
    public func read(_ path: String, version: DocVersion? = nil, clean: Bool = false) async throws -> DocContent {
        var query = [("path", path)]
        if let version { query.append(("v", version.rawValue)) }
        if clean { query.append(("clean", "1")) }
        let reply = try await send("GET", "doc", query: query)
        return DocContent(
            kind: reply.headers["x-doklin-kind"] == "file" ? .file : .document,
            path: reply.headers["x-doklin-path"] ?? path,
            file: reply.headers["x-doklin-file"] ?? path,
            rev: Int(reply.headers["x-doklin-rev"] ?? "") ?? 0,
            version: reply.headers["x-doklin-version"].flatMap(DocVersion.init(rawValue:)),
            htmlBehind: reply.headers["x-doklin-html-behind"] == "1",
            contentType: reply.contentType,
            data: reply.data
        )
    }

    /// Everything known about a document without reading its text.
    public func info(_ path: String) async throws -> DocRow {
        try await send("GET", "doc", query: [("path", path), ("info", "1")]).decode(DocRow.self)
    }

    public func comments(_ path: String) async throws -> CommentsAnswer {
        try await send("GET", "comments", query: [("path", path)]).decode(CommentsAnswer.self)
    }

    private struct Indexing: Decodable {
        let indexing: Bool?
    }

    /// Search every section the person is in, or one folder. A domain that is
    /// still catching up answers `202`; it is asked again, as the CLI does.
    public func search(_ text: String, dir: String = "", limit: Int = 30) async throws -> SearchAnswer {
        let query = [("q", text), ("dir", dir), ("limit", String(limit))]
        for attempt in 0..<12 {
            let reply = try await send("GET", "search", query: query)
            if reply.status != 202 { return try reply.decode(SearchAnswer.self) }
            try await Task.sleep(nanoseconds: UInt64(min(400 + attempt * 200, 1500)) * 1_000_000)
        }
        throw DoklinError(.busy, "\(domain) is still reading the workspace for search. Try again in a moment.")
    }

    public func pages() async throws -> PagesAnswer {
        try await send("GET", "pages").decode(PagesAnswer.self)
    }

    /* ---------- Changing ---------- */

    /// How a write says what it expects to find there.
    public enum Expect: Sendable {
        /// Nothing: this must be a new document.
        case new
        /// The revision that was read.
        case rev(Int)
        /// Whatever is there, replace it.
        case anything
    }

    /// Write a document's version, or a plain file. Never a silent overwrite:
    /// `.rev` is refused with a `.conflict` when it changed after it was read.
    public func write(_ path: String, _ data: Data, version: DocVersion? = nil, expect: Expect) async throws -> WriteAnswer {
        var query = [("path", path)]
        if let version { query.append(("v", version.rawValue)) }
        var headers: [(String, String)] = []
        switch expect {
        case .new: headers.append(("if-rev", "*"))
        case .rev(let rev): headers.append(("if-rev", String(rev)))
        case .anything: query.append(("force", "1"))
        }
        return try await send("PUT", "doc", query: query, headers: headers, body: .bytes(data)).decode(WriteAnswer.self)
    }

    /// Remove a document — both versions and its comments — or a plain file.
    public func remove(_ path: String) async throws -> RemoveAnswer {
        try await send("DELETE", "doc", query: [("path", path)]).decode(RemoveAnswer.self)
    }

    /// Move or rename a document, a file or a folder. `to` ending in `/` means into that folder.
    public func move(from: String, to: String) async throws -> MoveAnswer {
        try await send("POST", "move", body: DoklinClient.json(["from": from, "to": to])).decode(MoveAnswer.self)
    }

    /// Start a thread on words of a document.
    public func comment(_ path: String, on words: String, body: String, version: DocVersion? = nil) async throws -> CommentedAnswer {
        var object = ["path": path, "on": words, "body": body]
        if let version { object["v"] = version.rawValue }
        return try await send("POST", "comments", body: DoklinClient.json(object)).decode(CommentedAnswer.self)
    }

    /// Answer a thread.
    public func reply(_ path: String, thread: String, body: String) async throws -> CommentedAnswer {
        try await send("POST", "comments", body: DoklinClient.json(["path": path, "thread": thread, "body": body])).decode(CommentedAnswer.self)
    }

    /// Remove a thread; the words it was on stay.
    public func removeThread(_ path: String, thread: String) async throws {
        _ = try await send("DELETE", "comments", query: [("path", path), ("thread", thread)])
    }

    /// Give a document, a picture, a PDF or a folder (`Folder/`) a public address.
    public func publish(_ path: String) async throws -> PublishedAnswer {
        try await send("PUT", "pages", body: DoklinClient.json(["path": path])).decode(PublishedAnswer.self)
    }

    /// Stop publishing what is at a path.
    public func unpublish(path: String) async throws -> StoppedAnswer {
        try await send("DELETE", "pages", query: [("path", path)]).decode(StoppedAnswer.self)
    }

    /// Stop publishing an address.
    public func unpublish(slug: String) async throws -> StoppedAnswer {
        try await send("DELETE", "pages", query: [("slug", slug)]).decode(StoppedAnswer.self)
    }
}
