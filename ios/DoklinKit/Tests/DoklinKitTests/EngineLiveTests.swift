// The engine itself, linked into this process, against the real worker —
// the harness worker over the seed workspace, started by
// verify-harness/drive-ios.mjs, which also mints the device code this joins
// with. Skipped when run without it.
//
// One journey, because the engine is one per process and a device code
// works once: join as a device through the models the screens use, hold the
// whole workspace locally — its shared files in `Library/` — sync a change
// up, and leave.

import XCTest
@testable import DoklinKit

@MainActor
final class EngineLiveTests: XCTestCase {
    /// The line a person would paste: `doklin-invite <address> <code>`.
    private func line() throws -> String {
        guard let line = ProcessInfo.processInfo.environment["DOKLIN_TEST_DEVICE_LINE"], !line.isEmpty else {
            throw XCTSkip("no worker to talk to — run verify-harness/drive-ios.mjs")
        }
        return line
    }

    /// Wait until the workspace at `root` has synced after `after`, and is idle.
    private func synced(_ device: Workspaces, _ root: String, after: Int = 0, within seconds: Double = 60) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            await device.refresh()
            if let status = device.status(root), status.phase == .idle, (status.lastSyncMs ?? 0) > after { return }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        XCTFail("the workspace did not finish syncing: \(String(describing: device.status(root)))")
    }

    func testJoinAsADeviceHoldTheWorkspaceSyncAndLeave() async throws {
        let line = try line()
        let fm = FileManager.default
        // The app's container, as iOS would hand it over.
        let container = fm.temporaryDirectory.appendingPathComponent("doklin-engine-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: container) }
        let data = container.appendingPathComponent("Library/Application Support/Doklin")
        let keychain = MemorySecretStore()
        let remembered = try XCTUnwrap(UserDefaults(suiteName: "doklin-test-\(UUID().uuidString)"))
        let device = Workspaces(remembered: remembered)
        device.start(EngineSetup(
            secrets: keychain,
            dataDirectory: data,
            workspacesDirectory: container.appendingPathComponent("Documents"),
            anchor: container,
            client: "ios/drive",
            deviceName: "iPhone (engine drive)",
            deviceKind: "iPhone"
        ))
        await device.refresh()
        XCTAssertNil(device.failure)

        // Nothing is connected on a device that has never joined.
        XCTAssertTrue(device.statuses.isEmpty)

        // What is not a line, and a line cut short, are refused in sentences.
        do {
            try await device.join(pasted: "hello there")
            XCTFail("a line that is no line was taken")
        } catch let error as DoklinError {
            XCTAssertTrue(error.message.hasPrefix("That is not a line from Doklin."), error.message)
        }
        let endpointOnly = line.split(separator: " ").dropLast().joined(separator: " ")
        do {
            try await device.join(pasted: endpointOnly)
            XCTFail("half a line was taken")
        } catch let error as DoklinError {
            XCTAssertTrue(error.message.contains("cut short"), error.message)
        }

        // Join, from the whole message the line came in: the code becomes
        // this device's own sign-in, and the whole workspace comes down.
        let root = try await device.join(pasted: "Here you go:\n\(line)\n")
        XCTAssertTrue(root.hasPrefix(container.appendingPathComponent("Documents").path), root)
        XCTAssertEqual(device.selected, root)
        let workspace = device.workspace(root)

        // What everyone has is in Library; nothing shared is at the top.
        let home = try workspace.files.text("Library/Home.md")
        XCTAssertTrue(home.hasPrefix("# Home"), home)
        XCTAssertTrue(workspace.files.exists("Library/Projects/Roadmap/Ship the boat.md"))
        XCTAssertEqual(try workspace.files.list("").filter { TreeSection.of(top: $0) == .nowhere }, [], "a stray at the top")
        try await synced(device, root)

        // The sign-in is in the keeper, by workspace id, and nowhere on disk;
        // what is written down holds no absolute path, since iOS moves the
        // container.
        let status = try XCTUnwrap(device.status(root))
        XCTAssertEqual(keychain.keys, [status.wsId])
        let cloud = try String(contentsOf: data.appendingPathComponent("cloud.json"), encoding: .utf8)
        XCTAssertFalse(cloud.contains(container.path), cloud)
        XCTAssertTrue(cloud.contains("\"Documents/"), cloud)
        XCTAssertTrue(cloud.contains("\"token\": \"\""), cloud)
        XCTAssertFalse(cloud.contains(try XCTUnwrap(keychain.secret(for: status.wsId))), cloud)

        // A folder reads as the Mac's sidebar shows it: a page beside its
        // note is that note's, and comment files are nobody's row.
        let projects = try workspace.files.list("Library/Projects")
        XCTAssertTrue(projects.contains(.folder("Library/Projects/Roadmap")))
        let plan = projects.first { $0.path == "Library/Projects/plan.md" }
        guard case .document(let row) = plan else { return XCTFail("the plan is not a document: \(projects)") }
        XCTAssertEqual(row.html, "Library/Projects/plan.html")
        XCTAssertFalse(try workspace.files.list("Library").contains { $0.path.hasSuffix(".meta.jsonl") })

        // What links to documents resolve against: every document, by id,
        // the page beside a note part of it (`cloud_documents`).
        await workspace.loadDocuments()
        let listed = workspace.documents.documents.map(\.path)
        XCTAssertNotNil(workspace.documents.document(at: "Library/Projects/plan.md")?.fileId, "\(listed)")
        XCTAssertFalse(listed.contains("Library/Projects/plan.html"), "the page is the note's: \(listed)")
        XCTAssertFalse(listed.contains { $0.hasSuffix(".meta.jsonl") }, "\(listed)")
        XCTAssertEqual(listed, listed.sorted(), "by path")
        if let home = workspace.documents.document(at: "Library/Home.md")?.fileId {
            XCTAssertEqual(workspace.documents.document(id: home)?.path, "Library/Home.md")
        } else {
            XCTFail("Home has no id: \(listed)")
        }

        // A note made here reaches the domain: write it, say so, sync. New
        // things land in Library, where everyone sees them.
        let before = try XCTUnwrap(device.status(root)?.lastSyncMs)
        let folder = FolderModel(workspace: workspace, dir: TreeModel.libraryFolder)
        XCTAssertEqual(folder.whoSeesNew, "Everyone in \(workspace.name) will see it.")
        let untitled = try await folder.createNote()
        XCTAssertEqual(untitled, "Library/Untitled.md")
        let note = DocumentModel(workspace: workspace, path: untitled)
        note.load()
        // Named by its title: the file is renamed.
        try await note.rename(to: "From the phone")
        let made = note.path
        XCTAssertEqual(made, "Library/From the phone.md")
        try await note.save("Written on a device.\n\n- [ ] a box to tick\n", over: "")
        await note.toggleTask(line: 2)
        XCTAssertEqual(note.text, "Written on a device.\n\n- [x] a box to tick\n")
        await device.syncNow(root)
        try await synced(device, root, after: before)

        // Search reads this copy.
        let search = SearchModel(workspace: workspace)
        await search.run("written on a device")
        XCTAssertEqual(search.results.map(\.path), [made])
        XCTAssertEqual(search.inText.map(\.path), [made], "found by its words, not its name")

        // Home: what changed, newest first — the note made here, by this
        // person — and the seed's documents, by the people who wrote them.
        let recent = RecentModel(workspace: workspace)
        await recent.load()
        let mine = try XCTUnwrap(recent.all.first { $0.path == made }, "the note made here, among what changed")
        XCTAssertEqual(mine.who, "You")
        XCTAssertTrue(mine.byMe)
        XCTAssertFalse(mine.unread, "your own change is never unread")
        XCTAssertTrue(recent.all.contains { $0.path == "Library/Projects/plan.md" && $0.html == "Library/Projects/plan.html" }, "the plan and its page, one row")
        XCTAssertEqual(recent.all.map(\.changed), recent.all.map(\.changed).sorted(by: >), "newest first")
        await note.shown()
        XCTAssertNotNil(workspace.lastRead(made).seen, "shown, so read")

        // A link to that note opens it again, through the call iOS hands a
        // tapped link to; a link into a workspace this device is not in
        // says which one.
        let link = try await workspace.link(to: made)
        XCTAssertTrue(link.url.hasPrefix("https://doklin.cc/open#d="), link.url)
        XCTAssertTrue(link.who.hasPrefix("Everyone in "), link.who)
        XCTAssertTrue(Workspaces.isPageLink(try XCTUnwrap(URL(string: link.url))))
        let handedOn = link.url.replacingOccurrences(of: "https://doklin.cc/open", with: "doklin://open")
        await device.follow(try XCTUnwrap(URL(string: handedOn)))
        XCTAssertNil(device.linkProblem)
        let opening = try XCTUnwrap(device.opening)
        XCTAssertEqual(opening.root, root)
        XCTAssertEqual(opening.path, made)
        device.opened(opening)
        XCTAssertNil(device.opening)
        await device.follow(try XCTUnwrap(URL(string: "https://doklin.cc/open#d=elsewhere.example.com&w=w-000000000000&f=f-000000000000")))
        XCTAssertEqual(device.linkProblem, LinkWords.notJoined(domain: "elsewhere.example.com", kind: "iPhone"))
        XCTAssertNil(device.arrivingPage, "a workspace not joined waits for nothing")
        device.dismissLinkProblem()

        // This device is one of its person's, and can add another.
        let people: People = try await Engine.shared.call("cloud_people", ["root": .string(root)])
        XCTAssertEqual(people.role, "superadmin")
        XCTAssertTrue(people.can.contains("devices.own"))
        XCTAssertTrue(people.devices.contains { $0.deviceName == "iPhone (engine drive)" }, "\(people.devices.map(\.deviceName))")
        let another: DeviceCode = try await Engine.shared.call("cloud_device_code", ["root": .string(root)])
        XCTAssertTrue(another.blob.hasPrefix("doklin-invite "), another.blob)

        // People, agents and a restricted folder, through the models their
        // screens use: each change made, and the list read back.
        let roster = PeopleModel(workspace: workspace)
        await roster.load()
        XCTAssertTrue(roster.people?.members.contains { $0.email == "sherin@example.com" && $0.isSuperadmin } ?? false, "\(String(describing: roster.people))")
        let invited = await roster.invite(email: "kit@example.com", name: " Kit ", days: 1)
        XCTAssertTrue(invited, roster.problem ?? "")
        XCTAssertTrue(roster.invited?.blob.hasPrefix("doklin-invite ") ?? false)
        let waiting = try XCTUnwrap(roster.people?.invites.first { $0.email == "kit@example.com" })
        XCTAssertEqual(waiting.name, "Kit")
        await roster.withdraw(waiting)
        XCTAssertNil(roster.problem)
        XCTAssertNil(roster.invited)
        XCTAssertFalse(roster.people?.invites.contains { $0.id == waiting.id } ?? true)

        let agents = AgentsModel(workspace: workspace)
        let added = await agents.add(name: "Kit bot", scopes: AgentScope.usual)
        XCTAssertTrue(added, agents.problem ?? "")
        XCTAssertNil(agents.problem)
        XCTAssertTrue(agents.login?.login.line.hasPrefix("doklin login ") ?? false)
        let bot = try XCTUnwrap(agents.mine.first { $0.name == "Kit bot" })
        XCTAssertEqual(bot.scopes, ["read", "comment", "edit"])
        await agents.remove(bot)
        XCTAssertFalse(agents.mine.contains { $0.id == bot.id })

        let making = RestrictedFolderModel(workspace: workspace, source: .new)
        let restricted = await making.create(name: "Kit", members: [])
        let folderPath = try XCTUnwrap(restricted, making.problem ?? "")
        XCTAssertTrue(workspace.files.exists(folderPath), folderPath)
        await device.refresh()
        let space = try XCTUnwrap(workspace.restrictedFolder(at: folderPath))
        let access = SpaceAccessModel(workspace: workspace, id: space.id)
        await access.delete()
        XCTAssertNil(access.problem)
        XCTAssertFalse(workspace.files.exists(folderPath))

        // Library has a history of its own; the workspace's root, which
        // holds the sections, has none.
        XCTAssertTrue(device.versions.contains { $0.root == workspace.libraryStore && $0.snapshots >= 1 }, "\(device.versions.map(\.root))")
        XCTAssertFalse(device.versions.contains { $0.root == root }, "\(device.versions.map(\.root))")
        XCTAssertEqual(device.stores(of: workspace).first, workspace.libraryStore)

        // A note's history keeps what was typed here once it is opened; an
        // older version reads, compares and goes back, and the restore undoes.
        let history = NoteHistory(workspace: workspace, path: made)
        await history.load()
        let kept = history.versions.count
        XCTAssertGreaterThanOrEqual(kept, 1, "\(history.versions)")
        try await note.save("A second thought.\n", over: try workspace.files.text(made))
        await history.load()
        XCTAssertEqual(history.versions.count, kept + 1, "\(history.versions)")
        XCTAssertTrue(history.versions[0].current)
        let older = try XCTUnwrap(history.open(history.versions[1]))
        let reader = VersionReader(workspace: workspace, opened: older)
        await reader.load()
        XCTAssertEqual(reader.text, "Written on a device.\n\n- [x] a box to tick\n")
        await reader.compare()
        XCTAssertTrue(reader.changes?.contains { $0.kind == .added && $0.text == "A second thought." } ?? false, "\(String(describing: reader.changes))")
        let outcome = try await reader.restore()
        XCTAssertEqual(try workspace.files.text(made), reader.text)
        try await VersionReader.undo(outcome, of: older, in: workspace)
        XCTAssertEqual(try workspace.files.text(made), "A second thought.\n")

        // Library's moments start where this device joined; restoring that
        // one would take away the note made since. A moment's paths are
        // Library's own, without its name.
        let library = workspace.libraryStore
        let inLibrary = "From the phone.md"
        XCTAssertEqual(workspace.path(inLibrary, in: library), made)
        let timeline = WorkspaceTimeline(workspace: workspace, store: library)
        await timeline.load()
        let joined = try XCTUnwrap(timeline.moments.last)
        XCTAssertEqual(joined.reason, "seed")
        let restoring = MomentPlan(workspace: workspace, store: library, moment: joined)
        await restoring.load()
        XCTAssertTrue(restoring.rows.contains(PlanRow(path: inLibrary, kind: .isRemoved)), "\(restoring.rows)")

        // Restoring that row alone removes the note outright — this device
        // has no Trash — and keeps the moment before it for good, so the note
        // stays under Recently deleted; the undo brings it back as it was.
        for row in restoring.rows where row.path != inLibrary { restoring.toggle(row.path) }
        XCTAssertEqual(restoring.scope(all: false), [PlanRow(path: inLibrary, kind: .isRemoved)])
        XCTAssertEqual(restoring.question(all: false), "Remove 1?")
        let (report, paths) = try await restoring.restore(all: false)
        XCTAssertEqual(report.trashed, 1)
        XCTAssertEqual(report.written, 0)
        XCTAssertEqual(paths, [inLibrary])
        XCTAssertFalse(workspace.files.exists(made))
        let preRestore = try XCTUnwrap(report.preRestoreTs)
        await timeline.load()
        XCTAssertTrue(timeline.moments.contains { $0.ts == preRestore && $0.pinned }, "\(timeline.moments)")
        let removed = RecentlyDeleted(workspace: workspace)
        await removed.load(stores: device.stores(of: workspace))
        XCTAssertTrue(removed.documents.contains { $0.store == library && $0.primary.path == inLibrary }, "\(removed.documents)")
        try await MomentPlan.undo(report, paths: paths, store: library)
        XCTAssertEqual(try workspace.files.text(made), "A second thought.\n")

        // A note removed here is under Recently deleted, and comes back where
        // it was: into Library, the store's own folder.
        let ideas = try XCTUnwrap(try workspace.files.list("Library").first { $0.path == "Library/Ideas.md" })
        try await folder.remove(ideas)
        let deleted = RecentlyDeleted(workspace: workspace)
        await deleted.load(stores: device.stores(of: workspace))
        let gone = try XCTUnwrap(deleted.documents.first { $0.primary.path == "Ideas.md" }, "\(deleted.documents)")
        XCTAssertEqual(deleted.place(of: gone), "Library")
        let back = try await gone.bringBack(in: workspace)
        XCTAssertEqual(back, "Library/Ideas.md")
        XCTAssertTrue(try workspace.files.text("Library/Ideas.md").hasPrefix("# Ideas"))

        // Leaving ends the sign-in and takes the copy, and the keeper's
        // sign-in, with it.
        try await device.leave(root)
        XCTAssertFalse(fm.fileExists(atPath: root))
        XCTAssertTrue(device.statuses.isEmpty)
        XCTAssertTrue(keychain.keys.isEmpty, "\(keychain.keys)")
    }
}
