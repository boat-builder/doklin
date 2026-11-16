// What the People, Devices, Agents and restricted-folder screens say and
// offer, worked out from answers of the engine's shape: no engine, no worker.

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
        XCTAssertTrue(prompt.hasSuffix("Then run `doklin help agent` to see what you can do."), prompt)
    }

    /// A workspace in sections: Ada's Private, and Finance with Ada and Cy.
    private func status() throws -> CloudStatus {
        try decode(CloudStatus.self, """
        {"root":"/w","domain":"notes.example.com","endpoint":"https://notes.example.com","wsId":"ws-1","name":"Acme",
         "phase":"idle","lastSyncMs":null,"error":null,"pendingDeletes":0,"pendingAdds":0,
         "usage":{"mode":"normal","cause":null,"today":0,"fleetToday":null,"cap":null,"plan":null,"resumesAt":null,"waiting":0,"liftable":false,"lifted":false},
         "me":"Ada","meId":"m-ada","can":[],
         "workerVersion":17,"public":[],"presence":[],"leases":[],
         "spaces":[
          {"id":"p-ada","kind":"private","name":"Private","path":"Private","by":"Ada","members":["m-ada"]},
          {"id":"s-fin","kind":"restricted","name":"Finance","path":"Restricted/Finance","by":"Ada","members":["m-ada","m-cy"]},
          {"id":"s-solo","kind":"restricted","name":"Solo","path":"Restricted/Solo","by":"Ada","members":["m-ada"]}]}
        """)
    }

    func testAMoveAsksOnlyWhenSomebodyNewWillSeeIt() throws {
        let status = try status()
        XCTAssertNil(Sections.wider(in: status, from: "Ideas.md", to: "Private"), "from the shared workspace nothing widens")
        XCTAssertNil(Sections.wider(in: status, from: "Ideas.md", to: "Restricted/Finance"))
        XCTAssertEqual(Sections.wider(in: status, from: "Private/a.md", to: ""), "Everyone in Acme will be able to see it.")
        XCTAssertEqual(Sections.wider(in: status, from: "Private/a.md", to: "Restricted/Finance/Q1"), "Both people in “Finance” will be able to see it.")
        XCTAssertNil(Sections.wider(in: status, from: "Private/a.md", to: "Restricted/Solo"), "nobody but you gains it")
        XCTAssertNil(Sections.wider(in: status, from: "Restricted/Finance/a.md", to: "Restricted/finance/Q1"), "within one folder")
        XCTAssertNil(Sections.wider(in: status, from: "Restricted/Finance/a.md", to: "Private"), "narrowing")
        XCTAssertEqual(Sections.wider(in: status, from: "Restricted/Loose/a.md", to: "Restricted/Finance"), "Both people in “Finance” will be able to see it.")
        XCTAssertEqual(Sections.space(holding: "restricted/finance/x.md", in: status)?.id, "s-fin")
        XCTAssertNil(Sections.space(holding: "Restricted", in: status))
        XCTAssertNil(Sections.space(holding: "Restricted/Financed/x.md", in: status))
    }

    func testAMovesQuestionNamesWhoWillSeeIt() throws {
        let status = try status()
        XCTAssertEqual(Sections.moveTitle("plan", to: "", in: status), "Move “plan” to the workspace?")
        XCTAssertEqual(Sections.moveTitle("plan", to: "Projects/Q1", in: status), "Move “plan” to the workspace?", "a folder everyone has is the workspace")
        XCTAssertEqual(Sections.moveTitle("plan", to: "Restricted/Finance/Q1", in: status), "Move “plan” to “Finance”?", "the folder whose people gain it")
    }

    /// The engine deleted a restricted folder's copy here and said so: what
    /// was open in it closes, and is never written into the folder again.
    @MainActor
    func testANoteInAFolderThatLeftIsNotWrittenAgain() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("doklin-left-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }
        let folder = root.appendingPathComponent("Restricted/Finance")
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("# Q3\n".utf8).write(to: folder.appendingPathComponent("Q3.md"))
        let device = Workspaces(remembered: UserDefaults(suiteName: "doklin-test-\(UUID().uuidString)")!)
        let workspace = device.workspace(root.path)
        let note = DocumentModel(workspace: workspace, path: "Restricted/Finance/Q3.md")
        note.load()
        XCTAssertNil(workspace.left)

        try fm.removeItem(at: folder)
        workspace.lost("Restricted/Finance")
        let left = try XCTUnwrap(workspace.left)
        XCTAssertEqual(left.count, 1)
        XCTAssertTrue(left.holds("restricted/finance/Q3.md"))
        XCTAssertTrue(left.holds("Restricted/Finance"))
        XCTAssertFalse(left.holds("Restricted/Financed/a.md"))
        XCTAssertTrue(note.isAffected(by: workspace.lastChanged), "the note hears its folder go")
        do {
            try await note.save("# Q3\n\nTyped as it went.\n", over: "# Q3\n")
            XCTFail("a note was saved into a folder that left")
        } catch let error as DoklinError {
            XCTAssertTrue(error.message.hasPrefix("Q3 was not saved: it is no longer on this iPhone"), error.message)
        }
        XCTAssertFalse(fm.fileExists(atPath: folder.path), "saving made the folder again")

        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        workspace.lost("Restricted/Finance")
        XCTAssertEqual(workspace.left?.count, 2, "the same folder leaving again is heard again")
    }

    func testARestrictedFolderIsMadeFromNothingAFolderOrANote() {
        XCTAssertEqual(RestrictedSource.new.title, "New restricted folder")
        XCTAssertEqual(RestrictedSource.folder("Projects/Roadmap").title, "Restrict access to “Roadmap”")
        XCTAssertEqual(RestrictedSource.note("Private/Pay rise.md").title, "Share “Pay rise”")
        XCTAssertEqual(RestrictedSource.folder("Projects/Roadmap").prefill, "Roadmap")
        XCTAssertEqual(RestrictedSource.note("Private/Pay rise.md").prefill, "Pay rise")
        XCTAssertEqual(RestrictedSource.note("Private/Pay rise.md").nameLabel, "Folder name")
        XCTAssertEqual(RestrictedSource.new.button, "Create folder")
        XCTAssertTrue(RestrictedSource.new.ready(name: "Finance", picked: 0), "a folder may start with only you")
        XCTAssertFalse(RestrictedSource.new.ready(name: "  ", picked: 2))
        XCTAssertFalse(RestrictedSource.note("Private/a.md").ready(name: "a", picked: 0), "a note is shared with somebody")
        XCTAssertTrue(RestrictedSource.note("Private/a.md").ready(name: "a", picked: 1))
        XCTAssertEqual(RestrictedSource.whoWillHave([]), "Only you will have it. People can be added later.")
        XCTAssertEqual(RestrictedSource.whoWillHave(["Bea", "Cy"]), "You and Bea, Cy will have it. People can be added later.")
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
