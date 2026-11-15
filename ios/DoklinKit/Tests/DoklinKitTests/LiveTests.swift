// The client and the models against the real worker — the harness worker
// over the seed workspace, started by verify-harness/drive-ios.mjs, which
// also adds the agents these log in as. Skipped when run without it.

import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import DoklinKit

@MainActor
final class LiveTests: XCTestCase {
    private var root: URL!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("doklinkit-live-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var endpoint: String? { ProcessInfo.processInfo.environment["DOKLIN_TEST_ENDPOINT"] }

    private func code(_ agent: String) throws -> String {
        guard endpoint != nil, let raw = ProcessInfo.processInfo.environment["DOKLIN_TEST_CODES"],
              let codes = try? JSONDecoder().decode([String: String].self, from: Data(raw.utf8)), let code = codes[agent]
        else { throw XCTSkip("no worker to talk to — run verify-harness/drive-ios.mjs") }
        return code
    }

    private func makeStore(_ secrets: SecretStore = MemorySecretStore()) -> AccountStore {
        AccountStore(directory: root.appendingPathComponent("data"), cacheDirectory: root.appendingPathComponent("cache"), secrets: secrets, clientName: "ios/drive")
    }

    /// Log in as one of the drive's agents — by the line a person would paste.
    private func signIn(_ agent: String, secrets: SecretStore = MemorySecretStore()) async throws -> (AccountStore, Session) {
        let code = try code(agent)
        let line = try XCTUnwrap(LoginLine.find(in: "doklin login \(endpoint ?? "") \(code)"))
        let store = makeStore(secrets)
        try await store.signIn(address: line.address, code: line.code, host: "iPhone (drive)")
        let session = try XCTUnwrap(store.current)
        await session.refresh()
        return (store, session)
    }

    func testBrowseReadEditMoveRemove() async throws {
        let (store, session) = try await signIn("phone")
        XCTAssertEqual(store.accounts.first?.agent, "phone (iOS drive)")
        XCTAssertEqual(session.me?.scopes, ["read", "comment", "edit", "publish"])
        XCTAssertNotNil(session.me?.workspace)

        // The workspace itself.
        let top = FolderModel(session: session, dir: "")
        await top.load()
        XCTAssertEqual(top.phase, .loaded)
        XCTAssertTrue(top.entries.contains(.folder("Projects")))
        let names = top.entries.map(\.name)
        for expected in ["Home", "Ideas", "Comments", "Scratch"] { XCTAssertTrue(names.contains(expected), "\(expected) in \(names)") }
        // A sidecar is never a row of its own.
        XCTAssertFalse(names.contains { $0.hasSuffix(".meta.jsonl") })
        let home = try XCTUnwrap(top.entries.first { $0.name == "Home" })
        XCTAssertFalse(home.addresses.isEmpty)

        // A folder: a document with two versions, a deeper folder, a picture a level down.
        let projects = FolderModel(session: session, dir: "Projects")
        await projects.load()
        XCTAssertTrue(projects.entries.contains(.folder("Projects/Roadmap")))
        guard case .document(let plan)? = projects.entries.first(where: { $0.name == "plan" }) else { return XCTFail("no plan") }
        XCTAssertEqual(plan.versions, [.md, .html])

        // Reading: markdown by default, html when asked for.
        let doc = DocumentModel(session: session, path: "Projects/plan")
        await doc.load()
        XCTAssertEqual(doc.phase, .loaded)
        XCTAssertEqual(doc.version, .md)
        XCTAssertEqual(doc.document?.title, "The plan")
        XCTAssertEqual(doc.info?.versions, [.md, .html])
        XCTAssertTrue(doc.canEdit)
        await doc.load(version: .html)
        XCTAssertEqual(doc.version, .html)
        XCTAssertTrue(doc.text?.contains("Rendered by hand.") ?? false)
        XCTAssertNil(doc.document)
        XCTAssertFalse(doc.canEdit)
        await doc.load(version: .md)

        // A link written in the note leads to another document of the workspace.
        let file = try XCTUnwrap(doc.content?.file)
        XCTAssertEqual(DocLinks.target(of: "../Ideas.md", from: file), .document("Ideas.md"))
        let ideas = DocumentModel(session: session, path: "Ideas.md")
        await ideas.load()
        XCTAssertEqual(ideas.document?.title, "Ideas")

        // A plain file is its bytes.
        let picture = DocumentModel(session: session, path: "Projects/assets/pic.png")
        await picture.load()
        XCTAssertEqual(picture.content?.kind, .file)
        XCTAssertEqual(picture.content?.data.prefix(4), Data([0x89, 0x50, 0x4E, 0x47]))
        XCTAssertFalse(picture.canEdit)

        // A new note, here; a second of the same name is refused.
        let path = try await projects.createNote(named: "From the phone")
        XCTAssertEqual(path, "Projects/From the phone")
        XCTAssertTrue(projects.entries.map(\.name).contains("From the phone"))
        _ = await assertThrows(.conflict) { try await projects.createNote(named: "From the phone") }

        // Saving over the revision that was read; then over one that is stale.
        let note = DocumentModel(session: session, path: path)
        await note.load()
        XCTAssertEqual(note.text, "# From the phone\n\n")
        let firstRev = try XCTUnwrap(note.content?.rev)
        try await note.save("# From the phone\n\nTyped with thumbs.\n")
        XCTAssertEqual(note.content?.rev, firstRev + 1)
        let stale = await assertThrows(.conflict) { try await note.save("lost?", over: firstRev) }
        XCTAssertEqual(stale?.rev, firstRev + 1)
        let again = DocumentModel(session: session, path: path)
        await again.load()
        XCTAssertEqual(again.text, "# From the phone\n\nTyped with thumbs.\n")

        // Rename, move into another folder, move to the top, remove.
        let entry = try XCTUnwrap(projects.entries.first { $0.name == "From the phone" })
        try await projects.rename(entry, to: "Renamed")
        let renamed = try XCTUnwrap(projects.entries.first { $0.name == "Renamed" })
        let folders = try await projects.everyFolder()
        XCTAssertTrue(folders.contains("Projects/Roadmap"))
        _ = try await projects.move(renamed, into: "Projects/Roadmap")
        let roadmap = FolderModel(session: session, dir: "Projects/Roadmap")
        await roadmap.load()
        let moved = try XCTUnwrap(roadmap.entries.first { $0.name == "Renamed" })
        _ = try await roadmap.move(moved, into: "")
        await top.load()
        let atTop = try XCTUnwrap(top.entries.first { $0.name == "Renamed" })
        XCTAssertEqual(atTop.path, "Renamed")
        _ = try await top.remove(atTop)
        XCTAssertFalse(top.entries.map(\.name).contains("Renamed"))
        let gone = DocumentModel(session: session, path: "Renamed")
        await gone.load()
        guard case .failed = gone.phase else { return XCTFail("\(gone.phase)") }
    }

    func testTickingABoxInARealNote() async throws {
        let (_, session) = try await signIn("tasks")
        let top = FolderModel(session: session, dir: "")
        let path = try await top.createNote(named: "Groceries")
        let doc = DocumentModel(session: session, path: path)
        await doc.load()
        try await doc.save("# Groceries\n\n- [ ] milk\n- [ ] eggs\n  - [ ] free range\n")
        guard case .list(let list)? = doc.document?.blocks.last?.block else { return XCTFail("no list") }
        XCTAssertEqual(list.items.map(\.task), [false, false])
        guard case .list(let inner)? = list.items[1].blocks.last?.block else { return XCTFail("no nested list") }

        await doc.toggleTask(line: inner.items[0].line)
        XCTAssertNil(doc.problem)
        await doc.toggleTask(line: list.items[0].line)
        XCTAssertNil(doc.problem)

        // What the domain holds is what a Mac will sync down.
        let read = try await session.client.read(path)
        XCTAssertEqual(read.text, "# Groceries\n\n- [x] milk\n- [ ] eggs\n  - [x] free range\n")

        // A tick over a note that changed elsewhere is not written; the note is read again.
        _ = try await session.client.write(path, Data("# Groceries\n\n- [ ] bread\n".utf8), version: .md, expect: .anything)
        await doc.toggleTask(line: list.items[1].line)
        XCTAssertNotNil(doc.problem)
        XCTAssertEqual(doc.text, "# Groceries\n\n- [ ] bread\n")
        _ = try await top.remove(.document(try await session.client.info(path)))
    }

    func testCommentThreads() async throws {
        let (_, session) = try await signIn("comments")

        // A thread a Mac left: the marker in the text, the conversation beside it.
        let seeded = DocumentModel(session: session, path: "Comments")
        await seeded.load()
        XCTAssertEqual(seeded.threads.first?.on, "a highlighted phrase")
        XCTAssertEqual(seeded.threads.first?.version, .md)

        let top = FolderModel(session: session, dir: "")
        let path = try await top.createNote(named: "Review me")
        let doc = DocumentModel(session: session, path: path)
        await doc.load()
        try await doc.save("# Review me\n\nWe ship the beta next week, weather permitting.\n\n- We ship the beta\n\nAgain and again and again.\n")

        // Words the phone offers for the paragraph are words the worker accepts.
        let words = try XCTUnwrap(doc.commentAnchor(line: 2))
        XCTAssertEqual(words, "We ship the beta next")
        try await doc.startThread(on: words, body: "Which week?")
        XCTAssertEqual(doc.threads.count, 1)
        let thread = try XCTUnwrap(doc.threads.first)
        XCTAssertEqual(thread.on, words)
        XCTAssertEqual(thread.comments.map(\.body), ["Which week?"])
        XCTAssertEqual(thread.comments.first?.author, "comments (iOS drive)")
        // The marker is in the text now, and reads as words under a thread.
        XCTAssertTrue(doc.text?.contains("{==\(words)==}{>>#\(thread.id)<<}") ?? false)
        guard case .paragraph(let inlines)? = doc.document?.blocks.dropFirst().first?.block else { return XCTFail("no paragraph") }
        XCTAssertEqual(inlines.threads, [thread.id])

        // Words that are in two places are refused in the worker's own sentence.
        let twice = await assertThrows(.conflict) { try await doc.startThread(on: "again", body: "?") }
        XCTAssertEqual(twice?.code, "anchor")

        try await doc.reply(to: thread.id, body: "The one after the regatta.")
        XCTAssertEqual(doc.threads.first?.comments.map(\.body), ["Which week?", "The one after the regatta."])

        // An edit that keeps the marker saves; one that drops it is refused, whatever the revision.
        let text = try XCTUnwrap(doc.text)
        try await doc.save(text + "\nMore.\n")
        let dropped = await assertThrows(.refused) { try await doc.save("# Review me\n\nNo marker left.\n") }
        XCTAssertEqual(dropped?.code, "comments")

        try await doc.removeThread(thread.id)
        XCTAssertTrue(doc.threads.isEmpty)
        XCTAssertFalse(doc.text?.contains("{==") ?? true)
        _ = try await top.remove(.document(try await session.client.info(path)))
    }

    func testSearch() async throws {
        let (_, session) = try await signIn("searcher")
        let search = SearchModel(session: session)
        await search.run("ship it by june")
        XCTAssertEqual(search.phase, .loaded)
        XCTAssertEqual(search.answer?.results.map(\.path), ["Projects/plan"])
        XCTAssertEqual(search.answer?.results.first?.matches.first?.line, 3)
        await search.run("   ")
        XCTAssertNil(search.answer)
        XCTAssertEqual(search.phase, .idle)
        await search.run("no such words anywhere zzz")
        XCTAssertEqual(search.answer?.results.count, 0)
    }

    func testAnAgentThatMayOnlyReadIsToldSo() async throws {
        let (_, session) = try await signIn("reader")
        XCTAssertFalse(session.may(.edit))
        let doc = DocumentModel(session: session, path: "Scratch")
        await doc.load()
        XCTAssertEqual(doc.phase, .loaded)
        XCTAssertFalse(doc.canEdit)
        let refused = await assertThrows(.notPermitted) { try await session.client.write("Scratch", Data("x".utf8), expect: .anything) }
        XCTAssertTrue(refused?.message.contains("may not change documents") ?? false)
        _ = await assertThrows(.notPermitted) { try await doc.publish() }
        _ = await assertThrows(.notPermitted) { try await doc.startThread(on: "Not public", body: "?") }
    }

    func testPublishingGivesAnAddressThatAnswers() async throws {
        let (_, session) = try await signIn("publisher")
        let doc = DocumentModel(session: session, path: "Scratch")
        await doc.load()
        XCTAssertTrue(doc.addresses.isEmpty)
        let url = try await doc.publish()
        XCTAssertEqual(doc.addresses, [url])

        // Anyone can open it — no token.
        let (body, response) = try await URLSession.shared.data(from: try XCTUnwrap(URL(string: url)))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertTrue(String(decoding: body, as: UTF8.self).contains("Not public."))

        let pages = PagesModel(session: session)
        await pages.load()
        let page = try XCTUnwrap(pages.pages.first { $0.url == url })
        XCTAssertEqual(page.path, "Scratch")
        XCTAssertEqual(page.kind, "document")
        // A page whose file is gone says so.
        XCTAssertEqual(pages.pages.first { $0.slug == "ghost" }?.missing, true)

        try await doc.unpublish()
        XCTAssertTrue(doc.addresses.isEmpty)
        let (_, after) = try await URLSession.shared.data(from: try XCTUnwrap(URL(string: url)))
        XCTAssertEqual((after as? HTTPURLResponse)?.statusCode, 404)

        // The list stops one by its address too.
        let second = try await doc.publish()
        await pages.load()
        try await pages.stop(try XCTUnwrap(pages.pages.first { $0.url == second }))
        XCTAssertFalse(pages.pages.contains { $0.url == second })
    }

    func testLoggingOutRevokesTheToken() async throws {
        let secrets = MemorySecretStore()
        let (store, session) = try await signIn("leaving", secrets: secrets)
        let endpoint = session.account.endpoint
        let token = try XCTUnwrap(secrets.secret(for: endpoint))
        _ = try await session.client.tree("")

        await store.signOut(session.account)
        XCTAssertTrue(store.accounts.isEmpty)
        XCTAssertNil(secrets.secret(for: endpoint))
        // The token is no good to anyone who kept it.
        let kept = DoklinClient(endpoint: endpoint, token: token, clientName: "ios/drive")
        _ = await assertThrows(.loggedOut) { try await kept.tree("") }
    }

    func testACodeWorksOnce() async throws {
        let code = try code("twice")
        let store = makeStore()
        try await store.signIn(address: try XCTUnwrap(endpoint), code: code, host: "iPhone (drive)")
        let again = await assertThrows(.refused) { try await store.signIn(address: self.endpoint ?? "", code: code, host: "iPhone (drive)") }
        XCTAssertTrue(again?.message.hasPrefix("That login code is not valid") ?? false)
        // The first login stands.
        XCTAssertEqual(store.accounts.count, 1)
        let session = try XCTUnwrap(store.current)
        _ = try await session.client.me()
        let wrong = await assertThrows(.refused) { try await store.signIn(address: self.endpoint ?? "", code: "not a code", host: "iPhone (drive)") }
        XCTAssertTrue(wrong?.message.contains("not a Doklin login code") ?? false)
    }
}
