// What the People, Devices, Agents and Share screens say and offer, worked
// out from answers of the engine's shape: no engine, no worker.

import XCTest
@testable import DoklinKit

final class PeopleTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private let minute = 60_000
    private let hour = 3_600_000
    private let day = 86_400_000

    private static let owner = ["work", "people.see", "people.invite", "people.remove", "people.roles", "devices.own", "agents.own"]

    /// Ada is the workspace's superadmin; this iPhone is one of her devices,
    /// unless `me` says it is somebody else's. Bea is invited and has never
    /// signed in; Cy has, on one device.
    private func people(me: String = "m-ada", can: [String] = PeopleTests.owner) throws -> People {
        let can = can.map { "\"\($0)\"" }.joined(separator: ",")
        return try decode(People.self, """
        {"role":"owner","me":"\(me)","can":[\(can)],"deviceId":"d-phone","tokenId":"t-phone",
         "members":[
          {"id":"m-ada","email":"ada@example.com","name":"Ada","role":"superadmin","createdAt":0,"lastSeenAt":null,"devices":1},
          {"id":"m-bea","email":"bea@example.com","name":"","role":"member","createdAt":0,"lastSeenAt":null,"devices":0},
          {"id":"m-cy","email":"cy@example.com","name":"Cy","role":"member","createdAt":0,"lastSeenAt":\(Int(1_000_000 - 3 * hour)),"devices":1}],
         "invites":[{"id":"i-1","memberId":"m-bea","email":"bea@example.com","name":"","createdAt":0,"expiresAt":\(1_000_000 + 7 * day)}],
         "devices":[
          {"id":"t-phone","memberId":"m-ada","email":"ada@example.com","deviceId":"d-phone","deviceName":"iPhone","createdAt":0},
          {"id":"t-cy","memberId":"m-cy","email":"cy@example.com","deviceId":"d-cy","deviceName":null,"createdAt":0}]}
        """)
    }

    func testTimesReadAsTheMacWritesThem() {
        let now = 1_000_000_000
        XCTAssertEqual(Clock.ago(now - 10_000, now: now), "just now")
        XCTAssertEqual(Clock.ago(now - 2 * minute, now: now), "2 min ago")
        XCTAssertEqual(Clock.ago(now - 3 * hour, now: now), "3 h ago")
        XCTAssertEqual(Clock.ago(now - 12 * day, now: now), "12 d ago")
        XCTAssertEqual(Clock.ago(now + minute, now: now), "just now")
        XCTAssertEqual(Clock.left(now + 30_000, now: now), "any moment now")
        XCTAssertEqual(Clock.left(now + 60 * minute, now: now), "1 h")
        XCTAssertEqual(Clock.left(now + 59 * minute, now: now), "59 min")
        XCTAssertEqual(Clock.left(now + 35 * hour, now: now), "35 h")
        XCTAssertEqual(Clock.left(now + 7 * day, now: now), "7 days")
        XCTAssertEqual(Clock.left(now + 36 * hour, now: now), "2 days")
        XCTAssertEqual(Clock.left(now - day, now: now), "any moment now")
        XCTAssertEqual(InviteDays.words(1), "1 day")
        XCTAssertEqual(InviteDays.words(30), "30 days")
    }

    func testEachPersonSaysHowTheyAreHere() throws {
        let people = try people()
        let now = 1_000_000
        let (ada, bea, cy) = (people.members[0], people.members[1], people.members[2])
        XCTAssertEqual(people.summary(of: ada, now: now), "1 device")
        XCTAssertEqual(people.superadmin?.id, "m-ada")
        XCTAssertEqual(people.summary(of: bea, now: now), "Invited — no device has traded the code in yet.")
        XCTAssertEqual(people.summary(of: cy, now: now), "1 device · seen 3 h ago")
        XCTAssertTrue(people.isYou(ada))
        XCTAssertEqual(people.devices(of: cy).map(\.id), ["t-cy"])
        XCTAssertEqual(people.mine.map(\.id), ["t-phone"])
        XCTAssertTrue(people.isThisDevice(people.mine[0]))
        XCTAssertEqual(people.name(of: "m-bea"), "bea@example.com")
        XCTAssertEqual(people.name(of: "m-cy"), "Cy")
    }

    func testADeviceWithNoNameIsCalledSo() throws {
        let people = try people()
        let (phone, cy) = (people.devices[0], people.devices[1])
        XCTAssertEqual(phone.label, "iPhone")
        XCTAssertEqual(phone.signOutTitle, "Sign out iPhone?")
        XCTAssertEqual(cy.label, "A device")
        XCTAssertEqual(cy.signOutTitle, "Sign out that device?", "never “this device”: this iPhone is not offered")
        let blank = try decode(DeviceRecord.self, """
        {"id":"t-x","memberId":"m-cy","email":"cy@example.com","deviceId":null,"deviceName":"","createdAt":0}
        """)
        XCTAssertNil(blank.named)
        XCTAssertEqual(blank.label, "A device")
    }

    func testNobodyChangesTheirOwnRowOrTheSuperadmins() throws {
        let people = try people()
        XCTAssertFalse(people.changeable(people.members[0]), "your own row")
        XCTAssertTrue(people.changeable(people.members[1]))
        let cy = try self.people(me: "m-cy")
        XCTAssertFalse(cy.changeable(cy.members[0]), "the superadmin's row, to another owner")
        XCTAssertTrue(cy.changeable(cy.members[1]))
        let member = try self.people(can: ["work", "people.see", "devices.own", "agents.own"])
        XCTAssertFalse(member.changeable(member.members[1]), "a member changes nobody")
    }

    func testOnlyTheSuperadminSignsOutADeviceOfTheirs() throws {
        let ada = try people()
        XCTAssertTrue(ada.signsOut(devicesOf: ada.members[0]), "her own")
        XCTAssertTrue(ada.signsOut(devicesOf: ada.members[2]))
        let cy = try people(me: "m-cy")
        XCTAssertFalse(cy.signsOut(devicesOf: cy.members[0]), "the superadmin's, to another owner")
        XCTAssertTrue(cy.signsOut(devicesOf: cy.members[2]), "his own")
    }

    func testANewCodeForSomebodySignedInIsTheirsOrTheSuperadmins() throws {
        let owner = try people()
        XCTAssertTrue(owner.mayInviteAgain("m-bea"), "nobody has signed in as Bea")
        XCTAssertFalse(owner.mayInviteAgain("m-cy"), "Cy has signed in")
        XCTAssertTrue(owner.mayInviteAgain("m-ada"), "a code for yourself")
        XCTAssertFalse(try people(me: "m-cy").mayInviteAgain("m-ada"), "the superadmin has signed in, by being it")
        XCTAssertTrue(try people(can: PeopleTests.owner + ["people.recover"]).mayInviteAgain("m-cy"), "the superadmin may")
        XCTAssertFalse(try people(can: ["work"]).mayInviteAgain("m-bea"), "whoever may not invite may not")
    }

    func testAnAgentsBoxesAndWhatItsRowSays() throws {
        XCTAssertEqual(AgentScope.ordered([.publish, .edit]), ["read", "edit", "publish"])
        XCTAssertEqual(AgentScope.ordered([]), ["read"])
        XCTAssertEqual(AgentScope.ordered(AgentScope.usual), ["read", "comment", "edit"])
        let now = 1_000_000
        let agent = try decode(AgentRecord.self, """
        {"id":"a-1","name":"Research bot","scopes":["read","edit","publish"],"createdAt":0,"lastUsedAt":\(now - 2 * minute),
         "memberId":"m-ada","mine":true,"machines":[{"id":"t-1","host":"build-box","createdAt":0}],
         "code":{"id":"c-1","createdAt":0,"expiresAt":\(now + 40 * minute)}}
        """)
        XCTAssertEqual(agent.scopeWords, "read · edit · publish")
        XCTAssertTrue(agent.canPublish)
        XCTAssertEqual(agent.picked, [.read, .edit, .publish])
        XCTAssertEqual(agent.summary(now: now), "Logged in on 1 machine · last used 2 min ago · a login code is waiting, for 40 min more")
        XCTAssertEqual(agent.summary(now: now + hour), "Logged in on 1 machine · last used 1 h ago", "a code run out waits for nobody")
    }

    func testTheAgentsLoginPromptCarriesBothCommands() {
        // 2026-11-15 09:30 UTC.
        let prompt = AgentPrompt.login(domain: "notes.example.com", line: "doklin login https://notes.example.com dkla-ABCDE", expiresAt: 1_794_735_000_000)
        XCTAssertTrue(prompt.contains("\n\n\(AgentPrompt.installLine)\ndoklin login https://notes.example.com dkla-ABCDE\n\n"), prompt)
        XCTAssertTrue(prompt.contains("notes.example.com is the workspace's address, and the code after it works once and expires at 2026-11-15 09:30 UTC."), prompt)
        // The Mac's `buildAgentLoginPrompt` says it word for word (verify-harness/cloudprompts.test.mjs): change both.
        XCTAssertTrue(prompt.contains("\n\nYou see what the person who gave you this sees. Every path starts with its section: `Library/` is what everyone sees, `My files/` is theirs, `Shared with me/` is what others shared with them. Put anything new under `My files/` unless they tell you where it goes, and put a path with a space in quotes.\n\n"), prompt)
        XCTAssertTrue(prompt.hasSuffix("Then run `doklin help agent` to see what you can do."), prompt)
    }

    /// A workspace as Ada's iPhone has it. In her My files: `Work/Finance`,
    /// shared with Cy, and in it the document `Plan`, shared with Bea as
    /// well; `Solo`, shared with nobody yet. Shared with her by Dee: the
    /// folder `Budget` (and with Cy), and the document `Memo`. Deleted, to
    /// be restored: `Old`, which was hers to place, and `Theirs`, which was
    /// not.
    private func status() throws -> CloudStatus {
        func space(_ id: String, _ kind: String, _ name: String, _ path: String, by: String = "Ada", owner: String = "m-ada",
                   parent: String?, members: [String], above: [String], deletedAt: Int? = nil) -> String {
            let list = { (ids: [String]) in ids.map { "\"\($0)\"" }.joined(separator: ",") }
            return """
            {"id":"\(id)","kind":"\(kind)","name":"\(name)","path":"\(path)","by":"\(by)","owner":"\(owner)",
             "parent":\(parent.map { "\"\($0)\"" } ?? "null"),"placed":\(kind == "private" || parent != nil),
             "members":[\(list(members))],"above":[\(list(above))],"deletedAt":\(deletedAt.map(String.init) ?? "null")}
            """
        }
        let spaces = [
            space("p-ada", "private", "My files", "My files", parent: nil, members: ["m-ada"], above: []),
            space("s-fin", "folder", "Finance", "My files/Work/Finance", parent: "p-ada", members: ["m-cy"], above: ["m-ada"]),
            space("s-plan", "document", "Plan", "My files/Work/Finance/Plan", parent: "s-fin", members: ["m-bea"], above: ["m-ada", "m-cy"]),
            space("s-solo", "folder", "Solo", "My files/Solo", parent: "p-ada", members: [], above: ["m-ada"]),
            space("s-bud", "folder", "Budget", "Shared with me/Budget", by: "Dee", owner: "m-dee", parent: nil, members: ["m-ada", "m-cy"], above: ["m-dee"]),
            space("s-memo", "document", "Memo", "Shared with me/Memo", by: "Dee", owner: "m-dee", parent: nil, members: ["m-ada"], above: ["m-dee"]),
            space("s-old", "folder", "Old", "", parent: "p-ada", members: ["m-cy"], above: ["m-ada"], deletedAt: 1_000_000 - 3 * day),
            space("s-theirs", "folder", "Theirs", "", by: "Dee", owner: "m-dee", parent: nil, members: ["m-ada"], above: ["m-dee"], deletedAt: 1_000_000 - day),
        ]
        return try decode(CloudStatus.self, """
        {"root":"/w","domain":"notes.example.com","endpoint":"https://notes.example.com","wsId":"ws-1","name":"Acme",
         "phase":"idle","lastSyncMs":null,"error":null,"pendingDeletes":0,"pendingAdds":0,
         "usage":{"mode":"normal","cause":null,"today":0,"fleetToday":null,"cap":null,"plan":null,"resumesAt":null,"waiting":0,"liftable":false,"lifted":false},
         "me":"Ada","meId":"m-ada","can":[],
         "workerVersion":35,"public":[],"tags":[],"presence":[],"leases":[],
         "spaces":[\(spaces.joined(separator: ","))]}
        """)
    }

    private func note(_ path: String) -> FolderEntry {
        .document(DocumentRow(path: path, html: nil, modified: nil))
    }

    /// The same status, as a workspace's screens read it.
    @MainActor
    private func workspace() throws -> Workspace {
        let device = Workspaces(remembered: UserDefaults(suiteName: "doklin-test-\(UUID().uuidString)")!)
        device.take([try status()])
        return device.workspace("/w")
    }

    func testAPathIsInTheDeepestSectionThatHoldsIt() throws {
        let status = try status()
        let space = { (id: String) in status.spaces.first { $0.id == id }! }
        let place = { (path: String) in Sections.place(of: path, in: status) }
        XCTAssertEqual(place("Library/Projects/plan.md"), .library)
        XCTAssertEqual(place("library"), .library)
        XCTAssertEqual(place("my files/diary.md"), .mine(space("p-ada")))
        XCTAssertEqual(place("My files/Work"), .mine(space("p-ada")), "a folder that holds something shared is not shared itself")
        XCTAssertEqual(place("My files/Work/Finance"), .share(space("s-fin")))
        XCTAssertEqual(place("my files/work/finance/Q1/q3.md"), .share(space("s-fin")))
        for file in ["Plan.md", "plan.HTML", "Plan.meta.jsonl"] {
            XCTAssertEqual(place("My files/Work/Finance/\(file)"), .share(space("s-plan")), "a shared document before the folder it sits in: \(file)")
        }
        XCTAssertEqual(place("My files/Work/Finance/Planning.md"), .share(space("s-fin")))
        for other in ["Plan.1", "Plan.png", "Plan.1/a.md"] {
            XCTAssertEqual(place("My files/Work/Finance/\(other)"), .share(space("s-fin")), "only begins like the document: \(other)")
        }
        XCTAssertEqual(place("Shared with me/Budget/x.md"), .share(space("s-bud")))
        XCTAssertEqual(place("Shared with me/Memo.md"), .share(space("s-memo")))
        // In no section: the top of the workspace and anything else there,
        // and what is under Shared with me that nobody shared.
        XCTAssertEqual(place(""), .nowhere)
        XCTAssertEqual(place("Projects/plan.md"), .nowhere)
        XCTAssertEqual(place("Shared with me"), .nowhere)
        XCTAssertEqual(place("Shared with me/Loose/a.md"), .nowhere)
        XCTAssertEqual(place("Shared with me/Budgets/a.md"), .nowhere)
        // Names are free inside Library.
        XCTAssertEqual(place("Library/Private/x.md"), .library)
        XCTAssertEqual(place("Library/My files/x.md"), .library)
        XCTAssertEqual(Sections.place(of: "anything", in: nil), .library)

        XCTAssertEqual(Sections.share(at: "My files/Work/Finance", isFolder: true, in: status)?.id, "s-fin")
        XCTAssertEqual(Sections.share(at: "my files/work/finance/plan.HTML", isFolder: false, in: status)?.id, "s-plan", "by any of its files")
        XCTAssertNil(Sections.share(at: "My files/Work/Finance/Plan", isFolder: true, in: status), "a document is no folder")
        XCTAssertNil(Sections.share(at: "My files/Work/Finance/Plan.png", isFolder: false, in: status), "a picture beside it is not the document")
        XCTAssertNil(Sections.share(at: "My files/Work/Finance/q3.md", isFolder: false, in: status), "in something shared is not itself shared")
        XCTAssertNil(Sections.share(at: "My files", isFolder: true, in: status), "My files is nobody's share")

        XCTAssertEqual(Sections.documentStem("a/b/Plan.md"), "a/b/Plan")
        XCTAssertEqual(Sections.documentStem("a/Plan.meta.jsonl"), "a/Plan")
        XCTAssertEqual(Sections.documentStem("a.b/Plan"), "a.b/Plan")
        XCTAssertEqual(Sections.documentStem("a/.hidden"), "a/.hidden")
    }

    func testWhoCanOpenAPlaceIsSaidInAFewWords() throws {
        let status = try status()
        let line = { (path: String) in Sections.audience(Sections.place(of: path, in: status), in: status) }
        XCTAssertEqual(line("Library/Ideas.md"), "Everyone in Acme")
        XCTAssertEqual(line("My files/diary.md"), "Only you")
        XCTAssertEqual(line("My files/Solo/a.md"), "Only you", "shared with nobody yet")
        XCTAssertEqual(line("My files/Work/Finance/q3.md"), "You and 1 other")
        XCTAssertEqual(line("My files/Work/Finance/Plan.md"), "You and 2 others", "the people it is shared with, and the folder's")
        XCTAssertEqual(line("Shared with me/Budget/x.md"), "You and 2 others")
        XCTAssertEqual(line("Scratch/a.md"), "Only on this device")
    }

    func testAMoveAsksOnlyWhenItChangesWhoCanOpenTheThing() throws {
        let status = try status()
        let wider = { (from: String, to: String) in
            Sections.wider(in: status, from: Sections.place(of: from, in: status), to: Sections.place(of: to, in: status))
        }
        XCTAssertNil(wider("Library/Ideas.md", "My files"), "from Library nothing widens")
        XCTAssertNil(wider("Library/Ideas.md", "My files/Work/Finance"))
        XCTAssertEqual(wider("My files/a.md", "Library"), "Everyone in Acme")
        XCTAssertEqual(wider("Ideas.md", "Library/Projects"), "Everyone in Acme", "out of no section")
        XCTAssertNil(wider("Library/Ideas.md", "Scratch"), "into no section, nobody gains it")
        XCTAssertEqual(wider("My files/a.md", "My files/Work/Finance/Q1"), "Both people who can open “Finance”")
        XCTAssertNil(wider("My files/a.md", "My files/Solo"), "nobody but you gains it")
        XCTAssertNil(wider("My files/Work/Finance/a.md", "My files/work/finance/Q1"), "within one share")
        XCTAssertNil(wider("My files/Work/Finance/a.md", "My files"), "narrowing")
        XCTAssertEqual(wider("My files/a.md", "Shared with me/Budget"), "All 3 people who can open “Budget”")
        XCTAssertEqual(wider("My files/Work/Finance/a.md", "Shared with me/Budget"), "All 3 people who can open “Budget”", "Dee gains it")

        let question = { (entry: FolderEntry, to: String) in Sections.moveQuestion(entry, into: to, in: status) }
        XCTAssertEqual(
            question(note("My files/a.md"), "Library/Projects"),
            ShareQuestion(title: "Move “a” to Library?", body: "Everyone in Acme will be able to open it.", button: "Move")
        )
        XCTAssertEqual(
            question(note("My files/a.md"), "My files/Work/Finance/Q1"),
            ShareQuestion(title: "Move “a” to “Finance”?", body: "Both people who can open “Finance” will be able to open it.", button: "Move"),
            "named for whose people gain it"
        )
        // Something shared taken into Library is everyone's, and no share of its own.
        XCTAssertEqual(
            question(note("My files/Work/Finance/Plan.md"), "Library")?.body,
            "Everyone in Acme will be able to open it. “Plan” stops being shared on its own."
        )
        XCTAssertEqual(
            question(.folder("My files/Work"), "Library")?.body,
            "Everyone in Acme will be able to open it. “Finance” and “Plan” stop being shared on their own.",
            "what is shared from inside a folder ends with it"
        )
        XCTAssertNil(question(.folder("My files/Work/Finance"), "My files"), "within My files it stays the share it is")
        XCTAssertNil(question(note("Library/Ideas.md"), "My files"))
        XCTAssertNil(question(note("My files/a.md"), "My files/Solo"))
        XCTAssertNil(Sections.moveQuestion(note("My files/a.md"), into: "Library", in: nil), "a workspace not known yet asks nothing")
    }

    func testSomethingSharedIsDeletedForEveryoneOrLeft() throws {
        let status = try status()
        let space = { (id: String) in status.spaces.first { $0.id == id }! }
        let kept = " It stays in Recently deleted for 30 days, where it can be restored with its people and its history."
        XCTAssertEqual(Sections.deleteQuestion(space("s-fin"), in: status), ShareQuestion(
            title: "Delete “Finance” for everyone?",
            body: "It is removed from your devices and from those of the other person who can open it." + kept,
            button: "Delete for everyone"
        ))
        XCTAssertEqual(
            Sections.deleteQuestion(space("s-plan"), inside: "Work", in: status).title, "“Plan” in “Work” is shared. Delete it for everyone?"
        )
        XCTAssertEqual(
            Sections.deleteQuestion(space("s-plan"), in: status).body,
            "It is removed from your devices and from those of the 2 other people who can open it." + kept
        )
        XCTAssertEqual(Sections.deleteQuestion(space("s-solo"), in: status).body, "It is removed from your devices." + kept)
        // Shared with her, and not hers to delete: she leaves it.
        XCTAssertEqual(Sections.deleteQuestion(space("s-bud"), in: status), ShareQuestion(
            title: "Leave “Budget”?", body: "It is removed from this iPhone and your other devices. The others keep theirs.", button: "Leave"
        ))

        // A folder is not removed around what is shared from inside it: the outermost of them go first.
        XCTAssertEqual(Sections.shares(inside: "My files/Work", in: status).map(\.id), ["s-fin"])
        XCTAssertEqual(Sections.shares(inside: "my files/work/finance", in: status).map(\.id), ["s-plan"])
        XCTAssertEqual(Sections.shares(inside: "My files", in: status).map(\.id), ["s-fin", "s-solo"])
        XCTAssertEqual(Sections.shares(inside: "Library", in: status), [])

        // What can be restored is what was hers to place.
        XCTAssertEqual(DeletedShare.listed(in: status).map(\.id), ["s-old"])
        let old = DeletedShare.listed(in: status)[0]
        XCTAssertEqual(old.words(now: 1_000_000), "shared folder · deleted 3 d ago · kept 27 more days")
        XCTAssertEqual(old.words(now: old.deletedAt + 29 * day + hour), "shared folder · deleted 29 d ago · kept 1 more day")
        XCTAssertEqual(old.words(now: old.deletedAt + 31 * day), "shared folder · deleted 31 d ago · kept 1 more day", "until the domain has erased it")
        XCTAssertEqual(old.restored, "“Old” is back, for everyone it was shared with.")
    }

    func testWhatSyncsNowhereSaysWhy() {
        XCTAssertEqual(Sections.notSyncedLine("Scratch"), "In no section, so it stays on this iPhone — move it into Library or My files")
        XCTAssertEqual(
            Sections.notSyncedLine("shared with me/Loose"),
            "Nobody shared this with you, so it stays on this iPhone — move it into Library or My files"
        )
    }

    /// ONE-TIME, to go with `Sections.fromLibraryLayout`.
    @MainActor
    func testAPathStoredUnderTheOldLayoutFollowsItsFolder() throws {
        XCTAssertEqual(Sections.fromLibraryLayout("Private/a/b.md"), "My files/a/b.md")
        XCTAssertEqual(Sections.fromLibraryLayout("private"), "My files")
        XCTAssertEqual(Sections.fromLibraryLayout("RESTRICTED/Finance/q.md"), "Shared with me/Finance/q.md")
        XCTAssertEqual(Sections.fromLibraryLayout("Library/Private/x.md"), "Library/Private/x.md")
        XCTAssertEqual(Sections.fromLibraryLayout("Privateer/x.md"), "Privateer/x.md")
        XCTAssertEqual(Sections.fromLibraryLayout("My files/a.md"), "My files/a.md", "asked again, it stays where it is")

        let defaults = try XCTUnwrap(UserDefaults(suiteName: "doklin-test-\(UUID().uuidString)"))
        defaults.set(["library/projects", "private/ideas", "restricted/finance/q1"], forKey: "tree-open-ws-1")
        TreeModel.moveFromLibraryLayout("ws-1", in: defaults)
        XCTAssertEqual(defaults.stringArray(forKey: "tree-open-ws-1"), ["library/projects", "my files/ideas", "shared with me/finance/q1"])

        let seen = SeenStore(file: nil)
        seen.saw("ws-1", [(key: SeenStore.key(fileId: nil, path: "Private/Draft.md"), hash: "d"), (key: SeenStore.key(fileId: "f-1", path: "Private/a.md"), hash: "a")])
        seen.moveFromLibraryLayout("ws-1")
        XCTAssertEqual(seen.hash("ws-1", SeenStore.key(fileId: nil, path: "My files/Draft.md")), "d")
        XCTAssertNil(seen.hash("ws-1", SeenStore.key(fileId: nil, path: "Private/Draft.md")))
        XCTAssertEqual(seen.hash("ws-1", "f-1"), "a", "a file with an id is kept by it, wherever it is")
    }

    /// The engine deleted something shared here and said so: what was open
    /// in it closes, and is never written into it again.
    @MainActor
    func testANoteInAFolderThatLeftIsNotWrittenAgain() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("doklin-left-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }
        let folder = root.appendingPathComponent("Shared with me/Budget")
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("# Q3\n".utf8).write(to: folder.appendingPathComponent("Q3.md"))
        let device = Workspaces(remembered: UserDefaults(suiteName: "doklin-test-\(UUID().uuidString)")!)
        let workspace = device.workspace(root.path)
        let note = DocumentModel(workspace: workspace, path: "Shared with me/Budget/Q3.md")
        note.load()
        XCTAssertNil(workspace.left)

        try fm.removeItem(at: folder)
        workspace.lost("Shared with me/Budget")
        let left = try XCTUnwrap(workspace.left)
        XCTAssertEqual(left.count, 1)
        XCTAssertTrue(left.holds("shared with me/budget/Q3.md"))
        XCTAssertTrue(left.holds("Shared with me/Budget"))
        XCTAssertFalse(left.holds("Shared with me/Budgets/a.md"))
        XCTAssertTrue(note.isAffected(by: workspace.lastChanged), "the note hears its folder go")
        do {
            try await note.save("# Q3\n\nTyped as it went.\n", over: "# Q3\n")
            XCTFail("a note was saved into a folder that left")
        } catch let error as DoklinError {
            XCTAssertTrue(error.message.hasPrefix("Q3 was not saved: it is no longer on this iPhone"), error.message)
        }
        XCTAssertFalse(fm.fileExists(atPath: folder.path), "saving made the folder again")

        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        workspace.lost("Shared with me/Budget")
        XCTAssertEqual(workspace.left?.count, 2, "the same folder leaving again is heard again")

        // A shared document that left is each of its files, and nothing beside them.
        let memo = ShareLeft(path: "Shared with me/Memo", count: 1)
        XCTAssertTrue(memo.holds("Shared with me/Memo.md"))
        XCTAssertTrue(memo.holds("shared with me/memo.meta.jsonl"))
        XCTAssertFalse(memo.holds("Shared with me/Memorial.md"))
    }

    /// Sync moved something shared on this iPhone, or renamed it: what is
    /// open from where it was is where it is.
    @MainActor
    func testWhatIsOpenFollowsSomethingSharedThatSyncMoved() async throws {
        // As the engine says it (`cloud-space-moved`): a folder as one move, a document as one for each of its files.
        let event = try decode(CloudSpaceMoved.self, """
        {"root":"/w","moves":[
          {"from":"Shared with me/Finance","to":"My files/Finance","dir":true},
          {"from":"Shared with me/Plan.md","to":"Shared with me/Budget plan.md","dir":false},
          {"from":"Shared with me/Plan.meta.jsonl","to":"Shared with me/Budget plan.meta.jsonl","dir":false}]}
        """)
        XCTAssertEqual(event.moves.first, SpaceMove(from: "Shared with me/Finance", to: "My files/Finance", dir: true))
        let moved = SharesMoved(moves: event.moves, count: 1)
        XCTAssertEqual(moved.now("shared with me/finance/Q1/a.md"), "My files/Finance/Q1/a.md")
        XCTAssertEqual(moved.now("Shared with me/Finance"), "My files/Finance")
        XCTAssertEqual(moved.now("Shared with me/Plan.md"), "Shared with me/Budget plan.md")
        XCTAssertNil(moved.now("Shared with me/Planning.md"))
        XCTAssertNil(moved.now("Shared with me/Financed/a.md"))
        // A version store is called by its folder, or by its document without an extension.
        XCTAssertEqual(moved.nowItem("Shared with me/Finance"), "My files/Finance")
        XCTAssertEqual(moved.nowItem("Shared with me/Plan"), "Shared with me/Budget plan")
        XCTAssertNil(moved.nowItem("Shared with me/Memo"))

        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("doklin-moved-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }
        try fm.createDirectory(at: root.appendingPathComponent("Shared with me"), withIntermediateDirectories: true)
        try Data("# Plan\n".utf8).write(to: root.appendingPathComponent("Shared with me/Budget plan.md"))
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "doklin-test-\(UUID().uuidString)"))
        let workspace = Workspaces(remembered: defaults).workspace(root.path)
        let tree = TreeModel(workspace: workspace, defaults: defaults)
        tree.toggle("Shared with me/Finance")
        tree.toggle("Shared with me/Finance/Q1")
        let open = DocumentModel(workspace: workspace, path: "Shared with me/Plan.md")
        XCTAssertNil(workspace.relocated)

        workspace.relocate(moved.moves)
        let heard = try XCTUnwrap(workspace.relocated)
        XCTAssertTrue(workspace.lastChanged.contains("shared with me/plan.md") && workspace.lastChanged.contains("my files/finance"))
        tree.follow(heard.moves)
        XCTAssertTrue(tree.isOpen("My files/Finance") && tree.isOpen("My files/Finance/Q1"), "the folders open in it are open where it is")
        XCTAssertFalse(tree.isOpen("Shared with me/Finance"))
        XCTAssertTrue(open.follow(heard))
        XCTAssertEqual(open.path, "Shared with me/Budget plan.md")
        XCTAssertEqual(open.title, "Budget plan")
        XCTAssertFalse(open.follow(heard), "followed once")
        open.load()
        XCTAssertEqual(open.text, "# Plan\n", "it is read where it is now")
        XCTAssertEqual(workspace.store(root.path + "/Shared with me/Plan", after: heard), root.path + "/Shared with me/Budget plan")
    }

    func testTheShareSheetSaysWhatTheMacsDialogSays() throws {
        let status = try status()
        let space = { (id: String) in status.spaces.first { $0.id == id }! }
        XCTAssertEqual(ShareWords.title("Pay rise"), "Share “Pay rise”")
        let stays = "It stays where it is. The people you pick find it under Shared with me, and can read it, edit it and share it with others."
        XCTAssertEqual(ShareWords.unsharedHint(around: .mine(space("p-ada"))), stays)
        XCTAssertEqual(ShareWords.unsharedHint(around: .share(space("s-fin"))), stays + " Everyone who can open “Finance” can open it already.")
        XCTAssertEqual(
            ShareWords.insideHint(["Plan"]),
            "“Plan” inside it is shared already, and stays shared as it is. The people you pick will be able to open that too."
        )
        XCTAssertEqual(
            ShareWords.insideHint(["A", "B", "C"]),
            "“A”, “B” and “C” inside it are shared already, and stay shared as they are. The people you pick will be able to open those too."
        )
        XCTAssertEqual(ShareWords.alone(in: "Acme"), "Nobody else is in Acme yet. Invite somebody from People, then share this with them.")
        XCTAssertEqual(
            ShareWords.sharedHint(space("s-fin"), owner: "Ada", what: "folder"),
            "It stays where it is. The people it is shared with find it under Shared with me. Everyone here can read it, edit it and share it with others."
        )
        XCTAssertEqual(
            ShareWords.sharedHint(space("s-memo"), owner: "Dee", what: "document"),
            "Dee shared this document with you. It sits in their files, so only they move it or delete it. Everyone here can read it, edit it and share it with others."
        )
        XCTAssertEqual(ShareWords.count(1), "1 person can open it")
        XCTAssertEqual(ShareWords.count(3), "3 people can open it")
        XCTAssertEqual(ShareWords.everyoneOn(in: "Acme"), "Everyone in Acme can open it already.")
        // The mark on a row.
        XCTAssertEqual(ShareWords.mark(space("s-fin")), "Shared with 1 person")
        XCTAssertEqual(ShareWords.mark(space("s-solo")), "Shared with nobody yet")
        XCTAssertEqual(ShareWords.mark(space("s-bud")), "Shared with you")
    }

    @MainActor
    func testShareShowsWhoCanOpenSomethingAndWhatThisPersonMayDoAboutIt() throws {
        let workspace = try workspace()
        // Hers, in a folder she shares: its owner, whoever has the folder, then whom it is shared with.
        let plan = ShareModel(workspace: workspace, target: ShareTarget(path: "My files/Work/Finance/Plan.md", isFolder: false))
        XCTAssertEqual(plan.id, "s-plan")
        XCTAssertEqual(plan.title, "Share “Plan”")
        XCTAssertEqual(plan.people.map(\.id), ["m-ada", "m-cy", "m-bea"])
        XCTAssertEqual(plan.people.map(\.tags), [["you", "owner"], ["has the folder it is in"], []])
        XCTAssertEqual(plan.people.map(\.direct), [false, false, true], "only somebody it is shared with stops being shared with")
        XCTAssertEqual(plan.people[0].name, "Ada", "this person by the name the status has, until the list says")
        XCTAssertTrue(plan.mayDelete)
        XCTAssertFalse(plan.mayLeave)
        XCTAssertEqual(plan.deleteQuestion?.button, "Delete the document")
        XCTAssertFalse(plan.gone)

        // Shared with her: she may leave it, and not delete it.
        let budget = ShareModel(workspace: workspace, target: ShareTarget(path: "Shared with me/Budget", isFolder: true))
        XCTAssertEqual(budget.people.map(\.id), ["m-dee", "m-ada", "m-cy"])
        XCTAssertEqual(budget.people.map(\.tags), [["owner"], ["you"], []])
        XCTAssertTrue(budget.mayLeave)
        XCTAssertFalse(budget.mayDelete)
        XCTAssertNil(budget.deleteQuestion)

        // Not shared yet: a folder that holds shares says so, and something in a shared folder who has it already.
        let work = ShareModel(workspace: workspace, target: ShareTarget(path: "My files/Work", isFolder: true))
        XCTAssertNil(work.id)
        XCTAssertNil(work.space)
        XCTAssertEqual(work.name, "Work")
        XCTAssertEqual(work.insideHint, ShareWords.insideHint(["Finance", "Plan"]))
        let inFinance = ShareModel(workspace: workspace, target: ShareTarget(path: "My files/Work/Finance/q3.md", isFolder: false))
        XCTAssertNil(inFinance.insideHint)
        XCTAssertTrue(inFinance.unsharedHint.hasSuffix("Everyone who can open “Finance” can open it already."))
        XCTAssertEqual(inFinance.name, "q3")

        // Where Share is offered at all.
        let offered = { (path: String, isFolder: Bool) in workspace.shareable(ShareTarget(path: path, isFolder: isFolder)) }
        XCTAssertTrue(offered("My files/diary.md", false))
        XCTAssertTrue(offered("My files/Work", true))
        XCTAssertTrue(offered("Shared with me/Budget/x.html", false), "anyone who can open a share shares what is in it")
        XCTAssertFalse(offered("Library/Projects", true), "nothing in Library is shared separately")
        XCTAssertFalse(offered("My files", true))
        XCTAssertFalse(offered("My files/pic.png", false), "only documents sync")
        XCTAssertFalse(offered("Shared with me/Loose", true))
        XCTAssertNil(ShareTarget(.file(FileRow(path: "My files/pic.png", size: 1, modified: nil))))
        XCTAssertEqual(ShareTarget(note("My files/diary.md"))?.name, "diary")
    }

    @MainActor
    func testWhatIsSharedWithThisPersonIsNotTheirsToMove() throws {
        let workspace = try workspace()
        let top = FolderModel(workspace: workspace, dir: "Shared with me")
        let mine = FolderModel(workspace: workspace, dir: "My files/Work")
        XCTAssertFalse(top.movable(.folder("Shared with me/Budget")))
        XCTAssertFalse(top.movable(note("Shared with me/Memo.md")))
        XCTAssertTrue(top.copiesToMyFiles(.folder("Shared with me/Budget")))
        XCTAssertTrue(mine.movable(.folder("My files/Work/Finance")), "what she shares is hers to move")
        XCTAssertFalse(mine.copiesToMyFiles(.folder("My files/Work/Finance")))
        XCTAssertTrue(mine.movable(note("My files/Work/a.md")))
        XCTAssertFalse(FolderModel(workspace: workspace, dir: "").movable(.folder("My files")), "the three folders stay where they are")
        XCTAssertTrue(FolderModel(workspace: workspace, dir: "").isSection(.folder("shared with me")))

        // Where a move can go: a folder of a section, never straight under Shared with me.
        let work = FolderEntry.folder("My files/Work")
        let root = FolderModel(workspace: workspace, dir: "My files")
        XCTAssertFalse(root.takes(work, in: "My files"), "where it is")
        XCTAssertFalse(root.takes(work, in: "My files/Work/Finance"), "inside itself")
        XCTAssertFalse(root.takes(work, in: "Shared with me"))
        XCTAssertTrue(root.takes(work, in: "Shared with me/Budget"))
        XCTAssertTrue(root.takes(work, in: "Library"))
        XCTAssertFalse(root.takes(work, in: "Scratch"), "nowhere that syncs nothing")

        // Who will see something made in a folder.
        XCTAssertEqual(FolderModel(workspace: workspace, dir: "Library/Projects").whoSeesNew, "Everyone in Acme will see it.")
        XCTAssertEqual(root.whoSeesNew, "Only you will see it.")
        XCTAssertEqual(FolderModel(workspace: workspace, dir: "My files/Work/Finance").whoSeesNew, "Everyone who can open “Finance” will see it.")
        XCTAssertNil(FolderModel(workspace: workspace, dir: "Scratch").whoSeesNew)
        XCTAssertFalse(top.canHoldNotes, "nothing is made straight under Shared with me")
        XCTAssertTrue(root.canHoldNotes)
        XCTAssertEqual(workspace.myFiles?.id, "p-ada")
        XCTAssertEqual(workspace.audience(of: "My files/Work/Finance/Plan.md"), "You and 2 others")
    }

    func testAnotherDeviceHereSaysWhatItIsDoing() throws {
        let now = 1_000_000
        let mine = try decode(PresenceDevice.self, """
        {"deviceId":"d-mac","memberId":"m-ada","name":"MacBook Air","device":"MacBook Air","path":"Projects/plan.md","ts":\(now - 2 * minute)}
        """)
        XCTAssertEqual(mine.words(now: now), "editing Projects/plan.md · 2 min ago")
        let theirs = try decode(PresenceDevice.self, """
        {"deviceId":"d-cy","memberId":"m-cy","name":"Cy","device":"Cy's iMac","path":null,"ts":\(now)}
        """)
        XCTAssertEqual(theirs.words(now: now), "on Cy's iMac · here, idle · just now")
    }
}
