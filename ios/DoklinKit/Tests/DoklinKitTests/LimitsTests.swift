// What the day's Cloudflare limits do to the sync line, and the question
// about many new documents: read off a status as the engine sends one, in
// the Mac's words (src/cloud.ts). No engine, no worker.

import XCTest
@testable import DoklinKit

final class LimitsTests: XCTestCase {
    private let english = Locale(identifier: "en_US")

    private func status(phase: String = "idle", pendingAdds: Int = 0, usage: String) throws -> CloudStatus {
        let json = """
        {"root":"/w","domain":"notes.example.com","endpoint":"https://notes.example.com","wsId":"w1","name":"Notes",
         "phase":"\(phase)","lastSyncMs":1000,"error":null,"pendingDeletes":0,"pendingAdds":\(pendingAdds),
         "usage":\(usage),"me":"Ada","meId":"m1","can":["work"],"superadmin":null,"workerVersion":20,
         "public":[],"tags":[],"presence":[],"leases":[],"spaces":[]}
        """
        return try JSONDecoder().decode(CloudStatus.self, from: Data(json.utf8))
    }

    private func usage(
        mode: String = "normal", cause: String = "null", plan: String = "\"free\"", resumesAt: String = "null",
        waiting: Int = 0, liftable: Bool = false, lifted: Bool = false
    ) -> String {
        """
        {"mode":"\(mode)","cause":\(cause),"today":1240,"fleetToday":8900,"cap":100000,"plan":\(plan),
         "resumesAt":\(resumesAt),"waiting":\(waiting),"liftable":\(liftable),"lifted":\(lifted)}
        """
    }

    func testTheUsageAsTheEngineWritesIt() throws {
        let read = try status(phase: "pending-adds", pendingAdds: 212, usage: usage(
            mode: "bulk-waits", cause: "\"device\"", plan: "\"paid\"", resumesAt: "86400000", waiting: 412, liftable: true
        ))
        XCTAssertEqual(read.phase, .pendingAdds)
        XCTAssertEqual(read.pendingAdds, 212)
        XCTAssertEqual(read.usage, CloudUsage(
            mode: .bulkWaits, cause: .device, today: 1240, fleetToday: 8900, cap: 100_000, plan: .paid,
            resumesAt: 86_400_000, waiting: 412, liftable: true, lifted: false
        ))
        XCTAssertEqual(try status(phase: "limited", usage: usage(plan: "null")).phase, .limited)
        XCTAssertNil(try status(usage: usage(plan: "null")).usage.plan)
    }

    func testWhatTheLimitsHoldBack() throws {
        XCTAssertNil(try status(usage: usage()).hold)
        XCTAssertEqual(
            try status(usage: usage(mode: "bulk-waits", cause: "\"device\"", resumesAt: "5", waiting: 412, liftable: true)).hold,
            .waiting(412, until: 5, liftable: true)
        )
        XCTAssertEqual(
            try status(phase: "syncing", usage: usage(mode: "bulk-waits", cause: "\"fleet\"", resumesAt: "5", waiting: 3)).hold,
            .waiting(3, until: 5, liftable: false)
        )
        // Nothing waiting is nothing to say.
        XCTAssertNil(try status(usage: usage(mode: "bulk-waits", cause: "\"device\"", resumesAt: "5", liftable: true)).hold)
        XCTAssertEqual(try status(usage: usage(waiting: 40, lifted: true)).hold, .sending(40))
        XCTAssertNil(try status(usage: usage(lifted: true)).hold)
        XCTAssertEqual(try status(usage: usage(mode: "slow", cause: "\"device\"", resumesAt: "5", waiting: 9)).hold, .slow)
        // Any other phase says more.
        XCTAssertNil(try status(phase: "offline", usage: usage(mode: "slow", cause: "\"device\"", resumesAt: "5")).hold)
        XCTAssertNil(try status(phase: "limited", usage: usage(mode: "slow", cause: "\"fleet\"", resumesAt: "5")).hold)
    }

    func testTheSyncLine() {
        let time = { (_: Int) in "05:30" }
        XCTAssertEqual(LimitWords.line(.waiting(412, until: 1, liftable: true), time: time, locale: english), "412 changes wait until 05:30")
        XCTAssertEqual(LimitWords.line(.waiting(1, until: 1, liftable: false), time: time, locale: english), "1 change waits until 05:30")
        XCTAssertEqual(LimitWords.line(.waiting(12_400, until: nil, liftable: false), time: time, locale: english), "12,400 changes wait")
        XCTAssertEqual(LimitWords.line(.sending(412), time: time, locale: english), "Sending 412 changes…")
        XCTAssertEqual(LimitWords.line(.sending(1), time: time, locale: english), "Sending 1 change…")
        XCTAssertEqual(LimitWords.line(.slow, time: time, locale: english), "Sync is slower today — edits still go out.")
        XCTAssertEqual(
            LimitWords.share(of: "iPad", until: "05:30"),
            "This iPad has sent its share of big changes for today. The rest go out after 05:30, so nothing else on this workspace slows down."
        )
        XCTAssertEqual(LimitWords.pendingAdds(212, locale: english), "212 new documents — Sync them?")
        XCTAssertEqual(LimitWords.pendingAdds(1, locale: english), "1 new document — Sync it?")
    }

    func testTheQuestionAboutManyNewDocuments() {
        let one = [AddedFolder(path: "Library/Projects/foo", count: 212)]
        XCTAssertEqual(LimitWords.adds(212, in: one, locale: english), "212 new documents appeared in Library/Projects/foo. Sync them?")
        XCTAssertEqual(
            LimitWords.adds(212, in: [AddedFolder(path: "Library", count: 212)], locale: english),
            "212 new documents appeared in Library. Sync them?",
            "those directly in Library"
        )
        let three = [AddedFolder(path: "Library/a", count: 200), AddedFolder(path: "Library/b", count: 10), AddedFolder(path: "Private/c", count: 2)]
        XCTAssertEqual(LimitWords.adds(212, in: three, locale: english), "212 new documents appeared in 3 folders. Sync them?")
        // The event lists only the first few: more went elsewhere.
        XCTAssertEqual(LimitWords.adds(400, in: three, locale: english), "400 new documents appeared in more than 3 folders. Sync them?")
        XCTAssertEqual(LimitWords.adds(212, in: [], locale: english), "212 new documents appeared. Sync them?")
        XCTAssertEqual(LimitWords.adds(1, in: [AddedFolder(path: "Library/x", count: 1)]), "1 new document appeared in Library/x. Sync it?")
        XCTAssertEqual(LimitWords.syncThem(212), "Sync them")
        XCTAssertEqual(LimitWords.syncThem(1), "Sync it")
    }

    func testThePlan() {
        XCTAssertEqual(CloudPlan.allCases.map(LimitWords.plan), ["Free", "Workers Paid"])
    }

    func testWhereAPageStandsWhileTheLimitsHold() throws {
        let page = PublicPage(slug: "plan", kind: .file, path: "Library/plan.md", title: nil, desc: nil, by: "Ada", at: 1, alive: true, root: false)
        // New documents held for a yes hold nothing else: edits go out.
        let asking = try status(phase: "pending-adds", pendingAdds: 212, usage: usage())
        XCTAssertEqual(Publishing.state(of: page, in: asking, pending: true), .updating)
        let limited = try status(phase: "limited", usage: usage(resumesAt: "5"))
        XCTAssertEqual(Publishing.state(of: page, in: limited, pending: false), .stale)
        XCTAssertEqual(
            Publishing.reason(.stale, in: limited, now: 0),
            "Today’s Cloudflare requests are used up, so the page keeps what it had."
        )
    }
}
