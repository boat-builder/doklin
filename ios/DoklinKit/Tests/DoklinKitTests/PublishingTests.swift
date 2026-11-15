// Where a page stands and how it is said: the Mac's rules (src/cloud.ts),
// read off a status as the engine sends one. No engine, no worker.

import XCTest
@testable import DoklinKit

final class PublishingTests: XCTestCase {
    private func status(phase: String = "idle", lastSyncMs: Int? = 1_000, me: String = "Ada", pages: String = "[]") throws -> CloudStatus {
        let json = """
        {"root":"/w","domain":"notes.example.com","endpoint":"https://notes.example.com","wsId":"w1","name":"Notes",
         "phase":"\(phase)","lastSyncMs":\(lastSyncMs.map(String.init) ?? "null"),"error":null,"pendingDeletes":0,"me":"\(me)",
         "meId":"m1","can":["work"],"workerVersion":17,"public":\(pages),"presence":[],"leases":[],"spaces":[],"sections":true}
        """
        return try JSONDecoder().decode(CloudStatus.self, from: Data(json.utf8))
    }

    private let pages = """
    [{"slug":"plan","kind":"file","path":"Projects/plan.md","title":null,"desc":null,"by":"Ada","at":1000,"alive":true,"root":false},
     {"slug":"projects","kind":"dir","path":"Projects","title":"Our projects","desc":null,"by":"Bo","at":0,"alive":true,"root":false},
     {"slug":"all","kind":"dir","path":"","title":null,"desc":null,"by":"","at":0,"alive":true,"root":true},
     {"slug":"gone","kind":"file","path":"Old.md","title":null,"desc":null,"by":"Ada","at":1000,"alive":false,"root":false}]
    """

    func testWhereAPageStands() throws {
        let idle = try status(pages: pages)
        let plan = Publishing.page(for: "Projects/plan.md", kind: .file, in: idle)
        let gone = Publishing.page(for: "Old.md", kind: .file, in: idle)
        XCTAssertEqual(Publishing.state(of: nil, in: idle, pending: false), .unpublished)
        XCTAssertEqual(Publishing.state(of: plan, in: idle, pending: false), .live)
        XCTAssertEqual(Publishing.state(of: plan, in: idle, pending: true), .updating)
        XCTAssertEqual(Publishing.state(of: gone, in: idle, pending: false), .offline)
        XCTAssertEqual(Publishing.state(of: plan, in: try status(phase: "paused", pages: pages), pending: true), .stale)
        XCTAssertEqual(Publishing.state(of: plan, in: try status(phase: "revoked", pages: pages), pending: false), .offline)
        XCTAssertNil(Publishing.reason(.live, in: idle, now: 0))
        XCTAssertEqual(Publishing.reason(.offline, in: idle, now: 0), "The page answers Not found until this note is synced.")
        XCTAssertEqual(
            Publishing.reason(.offline, in: try status(phase: "revoked"), now: 0),
            "notes.example.com doesn’t accept this iPhone’s sign-in, so it can’t update the page."
        )
        XCTAssertEqual(
            Publishing.reason(.stale, in: try status(phase: "offline", lastSyncMs: 0), now: 180_000),
            "Offline, so the page keeps what it had (synced 3 min ago)."
        )
        XCTAssertEqual(PageState.updating.label, "Updating")
        XCTAssertEqual(PageState.stale.heading, "isn’t updating")
    }

    func testAddresses() throws {
        let s = try status(pages: pages)
        let projects = try XCTUnwrap(Publishing.page(for: "Projects", kind: .dir, in: s))
        XCTAssertEqual(Publishing.url(of: projects, in: s), "https://notes.example.com/projects")
        XCTAssertEqual(
            Publishing.url(of: "Projects/Roadmap/Ship the boat.MD", inside: projects, in: s),
            "https://notes.example.com/projects/Roadmap/Ship%20the%20boat"
        )
        // A note is public on its own page first, then inside each folder, the closest first.
        XCTAssertEqual(Publishing.places(of: "Projects/plan.md", in: s).map(\.url), [
            "https://notes.example.com/plan",
            "https://notes.example.com/projects/plan",
            "https://notes.example.com/all/Projects/plan",
        ])
        XCTAssertEqual(Publishing.places(of: "Projects/plan.md", in: s).map(\.nested), [false, true, true])
    }

    func testHowAPageIsSaid() throws {
        let s = try status(pages: pages)
        let plan = try XCTUnwrap(Publishing.page(for: "Projects/plan.md", kind: .file, in: s))
        let projects = try XCTUnwrap(Publishing.page(for: "Projects", kind: .dir, in: s))
        let all = try XCTUnwrap(Publishing.page(for: "", kind: .dir, in: s))
        XCTAssertEqual(Publishing.name(of: plan, workspace: "Notes"), "plan")
        XCTAssertEqual(Publishing.name(of: projects, workspace: "Notes"), "Our projects")
        XCTAssertEqual(Publishing.name(of: all, workspace: "Notes"), "Notes")
        XCTAssertEqual(Publishing.byline(of: plan, in: s, now: 61_000), "Published 1 min ago by you")
        XCTAssertEqual(Publishing.byline(of: projects, in: s, now: 61_000), "Published by Bo")
        XCTAssertEqual(Publishing.detail(of: plan, now: 61_000), "Projects/plan.md · /plan · Ada · 1 min ago")
        XCTAssertEqual(Publishing.detail(of: all, now: 61_000), "the whole workspace · /all · someone")
        XCTAssertEqual(Publishing.slug(typed: "  My-Page \n"), "my-page")
        XCTAssertNil(Publishing.slug(typed: "   "))
    }

    func testTimeAgo() {
        XCTAssertEqual(Publishing.timeAgo(0, now: 44_000), "just now")
        XCTAssertEqual(Publishing.timeAgo(0, now: 90_000), "2 min ago")
        XCTAssertEqual(Publishing.timeAgo(0, now: 3 * 3_600_000), "3 h ago")
        XCTAssertEqual(Publishing.timeAgo(0, now: 30 * 3_600_000), "1 d ago")
        XCTAssertEqual(Publishing.timeAgo(5_000, now: 0), "just now")
    }

    func testWhenACommentWasWritten() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let locale = Locale(identifier: "en_US")
        let now = 1_784_020_353_000.0 // 2026-07-14
        let words = { (ago: Double) in CommentTime.words(now - ago, now: now, calendar: calendar, locale: locale) }
        XCTAssertNil(CommentTime.words(0, now: now))
        XCTAssertEqual(words(30_000), "just now")
        XCTAssertEqual(words(5 * 60_000), "5m ago")
        XCTAssertEqual(words(3 * 3_600_000), "3h ago")
        XCTAssertEqual(words(2 * 86_400_000), "2d ago")
        XCTAssertEqual(words(30 * 86_400_000), "Jun 14")
        XCTAssertEqual(words(400 * 86_400_000), "Jun 9, 2025")
    }
}
