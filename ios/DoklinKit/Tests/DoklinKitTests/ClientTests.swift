import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import DoklinKit

/// A domain that answers from a closure: no network, and "offline" on demand.
final class StubProtocol: URLProtocol {
    struct Answer {
        var status = 200
        var headers: [String: String] = ["content-type": "application/json"]
        var body = Data()

        static func json(_ text: String, status: Int = 200, headers: [String: String] = [:]) -> Answer {
            Answer(status: status, headers: ["content-type": "application/json"].merging(headers) { $1 }, body: Data(text.utf8))
        }
    }

    struct Seen {
        let method: String
        let path: String
        let query: String
        let headers: [String: String]
        let body: Data
    }

    private static let lock = NSLock()
    private static var _handler: ((Seen) -> Answer?)?
    private static var _seen: [Seen] = []

    /// What answers; nil from it means the domain cannot be reached.
    static var handler: ((Seen) -> Answer?)? {
        get { lock.withLock { _handler } }
        set { lock.withLock { _handler = newValue; _seen = [] } }
    }

    static var seen: [Seen] { lock.withLock { _seen } }

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 16 * 1024)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                body.append(buffer, count: n)
            }
            stream.close()
        }
        var headers: [String: String] = [:]
        for (name, value) in request.allHTTPHeaderFields ?? [:] { headers[name.lowercased()] = value }
        let url = request.url!
        let seen = Seen(method: request.httpMethod ?? "GET", path: url.path, query: url.query ?? "", headers: headers, body: body)
        StubProtocol.lock.withLock { StubProtocol._seen.append(seen) }
        guard let answer = StubProtocol.handler?(seen) else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: answer.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.body)
        client?.urlProtocolDidFinishLoading(self)
    }
}

func assertThrows<T>(_ kind: DoklinError.Kind, file: StaticString = #filePath, line: UInt = #line, _ body: () async throws -> T) async -> DoklinError? {
    do {
        _ = try await body()
        XCTFail("nothing was thrown", file: file, line: line)
        return nil
    } catch let error as DoklinError {
        XCTAssertEqual(error.kind, kind, error.message, file: file, line: line)
        return error
    } catch {
        XCTFail("threw \(error)", file: file, line: line)
        return nil
    }
}

final class PureTests: XCTestCase {
    func testEndpointIsNormalized() throws {
        XCTAssertEqual(try Endpoint.normalize("notes.example.com"), "https://notes.example.com")
        XCTAssertEqual(try Endpoint.normalize("  HTTPS://Notes.Example.com/  "), "https://notes.example.com")
        XCTAssertEqual(try Endpoint.normalize("https://notes.example.com/some/page"), "https://notes.example.com")
        XCTAssertEqual(try Endpoint.normalize("http://localhost:8787"), "http://localhost:8787")
        XCTAssertEqual(Endpoint.domain(of: "http://localhost:8787"), "localhost:8787")
        XCTAssertThrowsError(try Endpoint.normalize(""))
        XCTAssertThrowsError(try Endpoint.normalize("ftp://notes.example.com"))
        XCTAssertThrowsError(try Endpoint.normalize("notes example com"))
        // Plain http is this machine's own worker, or nothing: iOS would refuse it anyway.
        XCTAssertThrowsError(try Endpoint.normalize("http://notes.example.com")) { error in
            XCTAssertTrue((error as? DoklinError)?.message.contains("https://") ?? false)
        }
    }

    func testLoginLineIsFoundInWhatWasPasted() {
        XCTAssertEqual(
            LoginLine.find(in: "doklin login https://notes.example.com dkla-K7QM2-9XVR4-8TBHN-3WGYD"),
            LoginLine(address: "https://notes.example.com", code: "dkla-K7QM2-9XVR4-8TBHN-3WGYD")
        )
        // The whole prompt the Mac app copies (`buildAgentLoginPrompt`, src/cloudPrompts.ts).
        let prompt = """
        Doklin is a workspace of markdown and HTML documents. Its command line, `doklin`, lets you read, write, search, comment on and publish them over the network, with no copy of the folder.

        The first command below installs `doklin` (skip it if it is already installed). The second logs you in: notes.example.com is the workspace's address, and the code after it works once and expires at 2026-11-15 06:00 UTC.

        curl -fsSL https://github.com/boat-builder/doklin/releases/latest/download/install-doklin.sh | sh
        doklin login https://notes.example.com dkla-K7QM2-9XVR4-8TBHN-3WGYD

        You see what the person who gave you this sees.

        Then run `doklin help agent` to see what you can do.
        """
        XCTAssertEqual(LoginLine.find(in: prompt), LoginLine(address: "https://notes.example.com", code: "dkla-K7QM2-9XVR4-8TBHN-3WGYD"))
        XCTAssertEqual(LoginLine.find(in: "`doklin login notes.example.com dkla-AAAAA-BBBBB-CCCCC-DDDDD`")?.code, "dkla-AAAAA-BBBBB-CCCCC-DDDDD")
        XCTAssertNil(LoginLine.find(in: "run doklin help agent"))
        XCTAssertNil(LoginLine.find(in: "doklin login"))
    }

    func testQueryValuesArePercentEncoded() {
        XCTAssertEqual(DoklinClient.encode("Projects/the plan & more.md"), "Projects%2Fthe%20plan%20%26%20more.md")
        XCTAssertEqual(DoklinClient.encode("Über/日本"), "%C3%9Cber%2F%E6%97%A5%E6%9C%AC")
        XCTAssertEqual(DoklinClient.decode("Projects%2F%C3%9Cber%20plan"), "Projects/Über plan")
    }

    func testASearchMatchIsShownAsTheNoteReads() throws {
        let json = ##"{"path":"Projects/plan","version":"md","matches":[{"line":3,"text":"Ship it by **June**. See the [status](./status.md)."},{"line":1,"text":"# The plan"},{"line":9,"text":"- [ ] call `Aisha`"},{"line":4,"text":"---"}]}"##
        let result = try JSONDecoder().decode(SearchResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.matches.map(result.shown), ["Ship it by June. See the status.", "The plan", "- [ ] call Aisha", "---"])
        // A page's line is already words.
        let page = try JSONDecoder().decode(SearchResult.self, from: Data(#"{"path":"a","version":"html","matches":[{"text":"2 * 3 * 4 [x]"}]}"#.utf8))
        XCTAssertEqual(page.shown(page.matches[0]), "2 * 3 * 4 [x]")
    }

    func testARefusalReadsAsASentence() {
        XCTAssertEqual(DoklinClient.sentence("there is no folder \"x\""), "There is no folder \"x\".")
        XCTAssertEqual(DoklinClient.sentence("Already one."), "Already one.")
        XCTAssertEqual(DoklinClient.sentence("remove it with `doklin comment rm x`"), "Remove it with `doklin comment rm x`")
    }
}

final class ClientTests: XCTestCase {
    private func client(token: String? = "dka_test") -> DoklinClient {
        DoklinClient(endpoint: "https://notes.example.com", token: token, clientName: "ios/test", session: StubProtocol.session())
    }

    func testEveryRequestSaysWhoItIs() async throws {
        StubProtocol.handler = { _ in .json(#"{"dir":"","folders":["Projects"],"documents":[],"files":[]}"#) }
        let listing = try await client().tree("")
        XCTAssertEqual(listing.folders, ["Projects"])
        let seen = try XCTUnwrap(StubProtocol.seen.first)
        XCTAssertEqual(seen.path, "/api/agent/tree")
        XCTAssertEqual(seen.headers["authorization"], "Bearer dka_test")
        XCTAssertEqual(seen.headers["x-doklin-client"], "ios/test")
    }

    func testAReadCarriesWhatTheHeadersSay() async throws {
        StubProtocol.handler = { _ in
            StubProtocol.Answer(
                headers: [
                    "content-type": "text/markdown; charset=utf-8", "x-doklin-kind": "document", "x-doklin-path": "Projects%2F%C3%9Cber%20plan",
                    "x-doklin-file": "Projects%2F%C3%9Cber%20plan.md", "x-doklin-rev": "7", "x-doklin-version": "md", "x-doklin-html-behind": "1",
                ],
                body: Data("# Über\n".utf8)
            )
        }
        let doc = try await client().read("Projects/Über plan")
        XCTAssertEqual(doc.kind, .document)
        XCTAssertEqual(doc.path, "Projects/Über plan")
        XCTAssertEqual(doc.file, "Projects/Über plan.md")
        XCTAssertEqual(doc.rev, 7)
        XCTAssertEqual(doc.version, .md)
        XCTAssertTrue(doc.htmlBehind)
        XCTAssertEqual(doc.text, "# Über\n")
        XCTAssertEqual(StubProtocol.seen.first?.query, "path=Projects%2F%C3%9Cber%20plan")
    }

    func testAWriteSaysWhatItExpectsToFind() async throws {
        StubProtocol.handler = { _ in .json(#"{"kind":"document","path":"a","version":"md","file":"a.md","rev":4,"size":3,"created":false}"#) }
        _ = try await client().write("a", Data("abc".utf8), version: .md, expect: .rev(3))
        _ = try await client().write("a", Data("abc".utf8), version: .md, expect: .new)
        _ = try await client().write("a", Data("abc".utf8), expect: .anything)
        let seen = StubProtocol.seen
        XCTAssertEqual(seen.map(\.method), ["PUT", "PUT", "PUT"])
        XCTAssertEqual(seen[0].headers["if-rev"], "3")
        XCTAssertEqual(seen[0].query, "path=a&v=md")
        XCTAssertEqual(seen[0].body, Data("abc".utf8))
        XCTAssertEqual(seen[1].headers["if-rev"], "*")
        XCTAssertNil(seen[2].headers["if-rev"])
        XCTAssertEqual(seen[2].query, "path=a&force=1")
    }

    func testRefusalsKeepTheWorkersWordsAndSayWhatKind() async {
        let c = client()
        StubProtocol.handler = { _ in .json(#"{"error":"unauthorized"}"#, status: 401) }
        let gone = await assertThrows(.loggedOut) { try await c.me() }
        XCTAssertTrue(gone?.message.contains("notes.example.com") ?? false)

        StubProtocol.handler = { _ in .json(#"{"error":"this agent may not change documents — its person can allow it in Doklin, under Agents","need":"edit","scopes":["read"]}"#, status: 403) }
        let refused = await assertThrows(.notPermitted) { try await c.remove("a") }
        XCTAssertEqual(refused?.message, "This agent may not change documents — its person can allow it in Doklin, under Agents.")

        StubProtocol.handler = { _ in .json(#"{"error":"the markdown version of a is at revision 9, not 3 — it changed after you read it. Read it again, then write.","rev":9}"#, status: 409) }
        let conflict = await assertThrows(.conflict) { try await c.write("a", Data(), expect: .rev(3)) }
        XCTAssertEqual(conflict?.rev, 9)

        StubProtocol.handler = { _ in .json(#"{"error":"there is no document or file at \"x\""}"#, status: 404) }
        _ = await assertThrows(.notFound) { try await c.read("x") }

        // A route the worker has never heard of is a worker that is behind, not a missing document.
        StubProtocol.handler = { _ in .json(#"{"error":"not found"}"#, status: 404) }
        _ = await assertThrows(.workerTooOld) { try await c.pages() }

        StubProtocol.handler = { _ in .json(#"{"error":"this write would remove the marker of comment #c7k2x9 (on \"x\")","code":"comments"}"#, status: 400) }
        let comments = await assertThrows(.refused) { try await c.write("a", Data(), expect: .rev(1)) }
        XCTAssertEqual(comments?.code, "comments")

        StubProtocol.handler = { _ in .json(#"{"error":"its content has not finished syncing — try again in a moment"}"#, status: 503) }
        _ = await assertThrows(.busy) { try await c.read("a") }

        StubProtocol.handler = { _ in nil }
        let offline = await assertThrows(.unreachable) { try await c.me() }
        XCTAssertTrue(offline?.message.hasPrefix("You are offline") ?? false)
    }

    func testALoginWithNoBearerOnAnOldWorkerSaysSo() async {
        StubProtocol.handler = { _ in .json(#"{"error":"unauthorized"}"#, status: 401) }
        _ = await assertThrows(.workerTooOld) {
            try await DoklinClient.login(endpoint: "https://notes.example.com", code: "dkla-x", host: "iPhone", clientName: "ios/test", session: StubProtocol.session())
        }
        StubProtocol.handler = { _ in .json(#"{"error":"that login code is not valid — it has been used already, or it ran out. Ask for a new one."}"#, status: 401) }
        let spent = await assertThrows(.refused) {
            try await DoklinClient.login(endpoint: "https://notes.example.com", code: "dkla-x", host: "iPhone", clientName: "ios/test", session: StubProtocol.session())
        }
        XCTAssertTrue(spent?.message.hasPrefix("That login code is not valid") ?? false)
    }

    func testASearchStillIndexingIsAskedAgain() async throws {
        let asked = Counter()
        StubProtocol.handler = { _ in
            asked.add() < 3
                ? .json(#"{"indexing":true,"pending":4}"#, status: 202)
                : .json(#"{"query":"plan","dir":"","results":[{"path":"Projects/plan","version":"md","matches":[{"line":1,"text":"The plan"}]}],"total":1}"#)
        }
        let found = try await client().search("plan")
        XCTAssertEqual(found.results.first?.path, "Projects/plan")
        XCTAssertEqual(asked.value, 3)
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    /// Count one more, and answer the count.
    func add() -> Int { lock.withLock { n += 1; return n } }
    var value: Int { lock.withLock { n } }
}

@MainActor
final class ModelTests: XCTestCase {
    private var root: URL!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("doklinkit-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func store(_ secrets: SecretStore = MemorySecretStore()) -> AccountStore {
        AccountStore(directory: root.appendingPathComponent("data"), cacheDirectory: root.appendingPathComponent("cache"), secrets: secrets, clientName: "ios/test", urlSession: StubProtocol.session())
    }

    private static let loginAnswer = #"{"token":"dka_one","agent":{"id":"a-00000001","name":"Sherin's iPhone"},"scopes":["read","comment","edit","publish"],"workspace":{"id":"w1","name":"Notes"},"version":15,"features":["agents"]}"#
    private static let meAnswer = #"{"agent":{"id":"a-00000001","name":"Sherin's iPhone"},"person":{"id":"m-00000001","name":"Sherin"},"scopes":["read","comment"],"sections":["Private","Restricted/Design"],"workspace":{"id":"w1","name":"Notes"},"version":15,"features":["agents"]}"#

    private func signedIn(_ secrets: SecretStore = MemorySecretStore()) async throws -> AccountStore {
        StubProtocol.handler = { _ in .json(ModelTests.loginAnswer, status: 201) }
        let store = store(secrets)
        try await store.signIn(address: "Notes.Example.com/", code: " dkla-K7QM2-9XVR4-8TBHN-3WGYD ", host: "iPhone")
        return store
    }

    func testSigningInKeepsTheTokenInTheSecretStoreOnly() async throws {
        let secrets = MemorySecretStore()
        let store = try await signedIn(secrets)
        let login = try XCTUnwrap(StubProtocol.seen.first)
        XCTAssertEqual(login.path, "/api/agent/login")
        XCTAssertNil(login.headers["authorization"])
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: login.body) as? [String: String])
        XCTAssertEqual(sent, ["code": "dkla-K7QM2-9XVR4-8TBHN-3WGYD", "host": "iPhone"])

        XCTAssertEqual(store.accounts.map(\.endpoint), ["https://notes.example.com"])
        XCTAssertEqual(store.accounts.first?.workspace, "Notes")
        XCTAssertEqual(secrets.secret(for: "https://notes.example.com"), "dka_one")
        let file = try String(contentsOf: root.appendingPathComponent("data/workspaces.json"), encoding: .utf8)
        XCTAssertFalse(file.contains("dka_one"))

        // The next launch finds the workspace again; one whose token is gone is not logged in.
        XCTAssertEqual(self.store(secrets).current?.account.agent, "Sherin's iPhone")
        XCTAssertNil(self.store(MemorySecretStore()).current)
    }

    func testWhatTheDomainSaysAboutThisDeviceIsFollowed() async throws {
        let store = try await signedIn()
        let session = try XCTUnwrap(store.current)
        XCTAssertTrue(session.may(.edit))
        StubProtocol.handler = { _ in .json(ModelTests.meAnswer) }
        await session.refresh()
        // Its person unticked "edit" on a Mac: the phone stops offering it.
        XCTAssertFalse(session.may(.edit))
        XCTAssertTrue(session.may(.comment))
        XCTAssertEqual(store.accounts.first?.scopes, ["read", "comment"])
        XCTAssertEqual(session.audience(of: "Private/todo"), .onlyYou)
        XCTAssertEqual(session.audience(of: "private"), .onlyYou)
        XCTAssertEqual(session.audience(of: "Restricted/Design/logo"), .folder("Design"))
        XCTAssertEqual(session.audience(of: "Restricted"), .folders)
        XCTAssertEqual(session.audience(of: "Projects/plan"), .everyone)
        XCTAssertEqual(session.audience(of: "Privateer/plan"), .everyone)
    }

    func testALoginTakenAwayEndsTheSession() async throws {
        let store = try await signedIn()
        let session = try XCTUnwrap(store.current)
        StubProtocol.handler = { _ in .json(#"{"error":"unauthorized"}"#, status: 401) }
        let folder = FolderModel(session: session, dir: "")
        await folder.load()
        XCTAssertNotNil(session.loggedOut)
        store.forget(session.account)
        XCTAssertTrue(store.accounts.isEmpty)
        XCTAssertNil(store.current)
    }

    func testAFolderReadOfflineIsTheKeptCopy() async throws {
        let store = try await signedIn()
        let session = try XCTUnwrap(store.current)
        StubProtocol.handler = { _ in .json(#"{"dir":"Projects","folders":["Projects/Roadmap"],"documents":[{"path":"Projects/plan","md":{"file":"plan.md","rev":2,"size":10,"changed":1757000000000,"by":"m-1"},"public":["https://notes.example.com/k7m2p9qx"]}],"files":[{"path":"Projects/chart.png","rev":1,"size":70,"changed":null,"by":null}]}"#) }
        let first = FolderModel(session: session, dir: "Projects")
        await first.load()
        XCTAssertEqual(first.entries.map(\.name), ["Roadmap", "plan", "chart.png"])
        XCTAssertEqual(first.entries[1].addresses, ["https://notes.example.com/k7m2p9qx"])
        XCTAssertNil(first.notice)

        StubProtocol.handler = { _ in nil }
        let again = FolderModel(session: session, dir: "Projects")
        await again.load()
        XCTAssertEqual(again.phase, .loaded)
        XCTAssertEqual(again.entries.count, 3)
        XCTAssertNotNil(again.notice)

        // With no copy kept there is only the sentence.
        let never = FolderModel(session: session, dir: "Elsewhere")
        await never.load()
        guard case .failed(let message) = never.phase else { return XCTFail("\(never.phase)") }
        XCTAssertTrue(message.hasPrefix("You are offline"))
    }

    func testAnEmptiedFolderIsEmptyNotAnError() async throws {
        let store = try await signedIn()
        let session = try XCTUnwrap(store.current)
        StubProtocol.handler = { _ in .json(#"{"error":"there is no folder \"Old\""}"#, status: 404) }
        let folder = FolderModel(session: session, dir: "Old")
        await folder.load()
        XCTAssertEqual(folder.phase, .loaded)
        XCTAssertTrue(folder.entries.isEmpty)
    }

    func testANewNoteIsNeverWrittenOverAnother() async throws {
        let store = try await signedIn()
        let session = try XCTUnwrap(store.current)
        StubProtocol.handler = { seen in
            seen.method == "PUT"
                ? .json(#"{"kind":"document","path":"Projects/v1.2 notes","version":"md","file":"v1.2 notes.md","rev":1,"size":14,"created":true}"#, status: 201)
                : .json(#"{"dir":"Projects","folders":[],"documents":[],"files":[]}"#)
        }
        let folder = FolderModel(session: session, dir: "Projects")
        let path = try await folder.createNote(named: " v1.2 notes.md ")
        XCTAssertEqual(path, "Projects/v1.2 notes")
        let put = try XCTUnwrap(StubProtocol.seen.first { $0.method == "PUT" })
        XCTAssertEqual(put.query, "path=Projects%2Fv1.2%20notes&v=md")
        XCTAssertEqual(put.headers["if-rev"], "*")
        XCTAssertEqual(String(data: put.body, encoding: .utf8), "# v1.2 notes\n\n")
        XCTAssertEqual(session.changes, 1)
        _ = await assertThrows(.refused) { try await folder.createNote(named: "a/b") }
        _ = await assertThrows(.refused) { try await folder.createNote(named: "  ") }
        _ = await assertThrows(.refused) { try await folder.createNote(named: ".hidden") }
    }

    private func documentAnswers(text: String, rev: Int) -> (StubProtocol.Seen) -> StubProtocol.Answer? {
        { seen in
            if seen.path == "/api/agent/comments" { return .json(#"{"path":"todo","threads":[]}"#) }
            if seen.query.contains("info=1") { return .json(#"{"kind":"document","path":"todo","md":{"file":"todo.md","rev":\#(rev),"size":9,"changed":1757000000000,"by":"m-1"},"comments":0}"#) }
            return StubProtocol.Answer(
                headers: ["content-type": "text/markdown", "x-doklin-kind": "document", "x-doklin-path": "todo", "x-doklin-file": "todo.md", "x-doklin-rev": String(rev), "x-doklin-version": "md"],
                body: Data(text.utf8)
            )
        }
    }

    func testTickingABoxWritesOneCharacterOverTheRevisionRead() async throws {
        let store = try await signedIn()
        let session = try XCTUnwrap(store.current)
        StubProtocol.handler = documentAnswers(text: "# Todo\n\n- [ ] milk\n- [ ] eggs\n", rev: 5)
        let doc = DocumentModel(session: session, path: "todo")
        await doc.load()
        XCTAssertTrue(doc.canEdit)
        guard case .list(let list)? = doc.document?.blocks.last?.block else { return XCTFail("no list") }

        StubProtocol.handler = { seen in
            seen.method == "PUT" ? .json(#"{"kind":"document","path":"todo","version":"md","file":"todo.md","rev":6,"size":28,"created":false}"#) : self.documentAnswers(text: "", rev: 6)(seen)
        }
        await doc.toggleTask(line: list.items[1].line)
        let put = try XCTUnwrap(StubProtocol.seen.first { $0.method == "PUT" })
        XCTAssertEqual(put.headers["if-rev"], "5")
        XCTAssertEqual(String(data: put.body, encoding: .utf8), "# Todo\n\n- [ ] milk\n- [x] eggs\n")
        XCTAssertEqual(doc.content?.rev, 6)
        XCTAssertEqual(doc.text, "# Todo\n\n- [ ] milk\n- [x] eggs\n")
        XCTAssertNil(doc.problem)
    }

    func testASaveOverSomethingThatChangedIsAConflictAndWritesNothing() async throws {
        let store = try await signedIn()
        let session = try XCTUnwrap(store.current)
        StubProtocol.handler = documentAnswers(text: "old", rev: 5)
        let doc = DocumentModel(session: session, path: "todo")
        await doc.load()
        doc.keepDraft("mine", over: 5)
        XCTAssertEqual(doc.draft, Draft(text: "mine", rev: 5))

        StubProtocol.handler = { seen in
            seen.method == "PUT" ? .json(#"{"error":"the markdown version of todo is at revision 6, not 5 — it changed after you read it. Read it again, then write.","rev":6}"#, status: 409) : nil
        }
        let conflict = await assertThrows(.conflict) { try await doc.save("mine") }
        XCTAssertEqual(conflict?.rev, 6)
        XCTAssertEqual(doc.text, "old")
        // What was typed is still there to be saved another way.
        XCTAssertEqual(doc.draft?.text, "mine")

        StubProtocol.handler = { seen in
            seen.method == "PUT" ? .json(#"{"kind":"document","path":"todo","version":"md","file":"todo.md","rev":7,"size":4,"created":false}"#) : self.documentAnswers(text: "mine", rev: 7)(seen)
        }
        try await doc.overwrite("mine")
        XCTAssertEqual(StubProtocol.seen.first { $0.method == "PUT" }?.query, "path=todo&v=md&force=1")
        XCTAssertEqual(doc.text, "mine")
        XCTAssertEqual(doc.content?.rev, 7)
        XCTAssertNil(doc.draft)
    }

    func testADocumentReadOfflineIsTheKeptCopyAndCannotBeEdited() async throws {
        let store = try await signedIn()
        let session = try XCTUnwrap(store.current)
        StubProtocol.handler = documentAnswers(text: "# Kept\n", rev: 2)
        await DocumentModel(session: session, path: "todo").load()

        StubProtocol.handler = { _ in nil }
        let doc = DocumentModel(session: session, path: "todo")
        await doc.load()
        XCTAssertEqual(doc.text, "# Kept\n")
        XCTAssertEqual(doc.document?.title, "Kept")
        XCTAssertNotNil(doc.notice)
        XCTAssertFalse(doc.canEdit)
    }
}
