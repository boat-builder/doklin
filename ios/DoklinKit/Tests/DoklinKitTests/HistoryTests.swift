// How the history screens lay a history out and what they say: days and
// times in a fixed language and time zone, the words for a version and a
// moment, a comparison read line by line, and where a deleted document comes
// back. No engine: what it answers is written out here as it would answer.

import XCTest
@testable import DoklinKit

final class HistoryTests: XCTestCase {
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    /// Milliseconds for a moment in UTC.
    private func ms(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 12, _ minute: Int = 0) -> Int {
        let date = utc.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
        return Int(date.timeIntervalSince1970 * 1000)
    }

    /// Wednesday 3 September 2025, 10:00 UTC, read in British English.
    private var dates: HistoryDates {
        HistoryDates(now: Date(timeIntervalSince1970: Double(ms(2025, 9, 3, 10)) / 1000), calendar: utc, locale: Locale(identifier: "en_GB"))
    }

    private func version(_ ts: Int, reason: String = "interval", source: String = "local") -> FileVersion {
        FileVersion(ts: ts, hash: "h\(ts)", size: 1, by: "Ada's iPhone", reason: reason, label: nil, pinned: false,
                    restoredFrom: nil, path: "Scratch.md", source: source, current: false)
    }

    func testDaysAndTimesReadAsTheMacWritesThem() {
        XCTAssertEqual(dates.day(ms(2025, 9, 3, 9)), "Today")
        XCTAssertEqual(dates.day(ms(2025, 9, 2, 23)), "Yesterday")
        XCTAssertEqual(dates.day(ms(2025, 9, 1)), "Mon 1 Sep")
        XCTAssertEqual(dates.day(ms(2024, 12, 25)), "25 Dec 2024")
        XCTAssertEqual(dates.time(ms(2025, 9, 1, 14, 32)), "14:32")
        XCTAssertEqual(dates.moment(ms(2025, 9, 1, 14, 32)), "Mon 1 Sep, 14:32")
        XCTAssertEqual(dates.since(ms(2025, 6, 3)), "3 Jun")

        let now = ms(2025, 9, 3, 10)
        XCTAssertEqual(Clock.ago(now - 10_000, now: now), "just now")
        XCTAssertEqual(Clock.ago(now - 5 * 60_000, now: now), "5 min ago")
        XCTAssertEqual(Clock.ago(now - 3 * 3_600_000, now: now), "3 h ago")
        XCTAssertEqual(Clock.ago(now - 2 * 86_400_000, now: now), "2 d ago")
    }

    func testAHistoryFallsIntoDaysAndOnlyTheLastTwoStayOpen() {
        let versions = [
            version(ms(2025, 9, 3, 9)), version(ms(2025, 9, 3, 8)),
            version(ms(2025, 9, 2, 20)),
            version(ms(2025, 9, 1, 12)), version(ms(2025, 9, 1, 11)),
        ]
        let groups = dates.groups(versions)
        XCTAssertEqual(groups.map(\.label), ["Today", "Yesterday", "Mon 1 Sep"])
        XCTAssertEqual(groups.map(\.recent), [true, true, false])
        XCTAssertEqual(groups.map(\.items.count), [2, 1, 2])
    }

    func testACopyIsNamedForItsMomentWithADotInTheTime() {
        let ts = ms(2025, 9, 2, 14, 32)
        XCTAssertEqual(dates.copyName(of: "Notes/plan.md", ts: ts), "Notes/plan (version 2 Sep 14.32).md")
        XCTAssertEqual(dates.copyName(of: "Notes/plan.md", ts: ts, n: 2), "Notes/plan (version 2 Sep 14.32 2).md")
        XCTAssertEqual(dates.copyName(of: "README", ts: ts), "README (version 2 Sep 14.32)")
    }

    func testTheWordsOfAVersionAndAMoment() {
        XCTAssertEqual(
            ["interval", "closing", "seed", "pre-restore", "restore", "manual", "", "from-elsewhere"].map(HistoryWords.reason),
            ["while editing", "end of session", "first seen", "before a restore", "restored", "marked", "", ""]
        )
        func moment(_ delta: SnapshotDelta?, files: Int = 3) -> SnapshotMeta {
            SnapshotMeta(ts: 1, reason: "interval", files: files, bytes: 10, pinned: false, label: nil, restoredFrom: nil, delta: delta)
        }
        XCTAssertEqual(HistoryWords.delta(moment(SnapshotDelta(added: 2, removed: 1, changed: 5))), "+2 −1 ~5")
        XCTAssertEqual(HistoryWords.delta(moment(SnapshotDelta(added: 0, removed: 0, changed: 1))), "~1")
        XCTAssertEqual(HistoryWords.delta(moment(SnapshotDelta(added: 0, removed: 0, changed: 0))), "no change")
        XCTAssertEqual(HistoryWords.delta(moment(nil, files: 1)), "1 file")
        XCTAssertEqual(HistoryWords.delta(moment(nil, files: 12)), "12 files")
    }

    func testARestoreAsksWithItsCountsAndSaysWhatItDid() {
        XCTAssertEqual(HistoryWords.restoreQuestion(write: 2, back: 1, remove: 1), "Write 2 files, bring back 1, remove 1?")
        XCTAssertEqual(HistoryWords.restoreQuestion(write: 1, back: 0, remove: 0), "Write 1 file?")
        XCTAssertEqual(HistoryWords.restoreQuestion(write: 0, back: 3, remove: 0), "Bring back 3?")
        XCTAssertEqual(HistoryWords.restoreQuestion(write: 0, back: 0, remove: 0), "Nothing is ticked.")

        XCTAssertEqual(HistoryWords.restored(RestoreReport(written: 3, trashed: 1, preRestoreTs: 1)), "Restored — 3 files written, 1 removed.")
        XCTAssertEqual(HistoryWords.restored(RestoreReport(written: 1, trashed: 0, preRestoreTs: 1)), "Restored — 1 file written.")
        XCTAssertEqual(HistoryWords.restored(RestoreReport(written: 0, trashed: 0, preRestoreTs: nil)), "Nothing needed changing.")

        let diff = SnapshotDiff(
            changed: [ChangedFile(path: "a.md", thenHash: "1", nowHash: "2")],
            added: ["new.md"],
            missing: ["gone.md", "Projects/old.md"]
        )
        let plan = PlanRow.plan(diff)
        XCTAssertEqual(plan.map(\.path), ["a.md", "gone.md", "Projects/old.md", "new.md"])
        XCTAssertEqual(plan.map(\.word), ["changes", "comes back", "comes back", "is removed"])
    }

    func testAnEngineRefusalReadsAsASentence() {
        XCTAssertEqual(DoklinError.sentence("there's no version to restore"), "There's no version to restore.")
        XCTAssertEqual(DoklinError.sentence("That folder isn't connected."), "That folder isn't connected.")
        XCTAssertEqual(
            HistoryWords.failed("Couldn't restore that version", DoklinError("That version couldn't be read.")),
            "Couldn't restore that version. That version couldn't be read."
        )
    }

    func testAComparisonReadsLineByLine() {
        // What versions_diff answers: diffy's unified patch, whose empty
        // context lines carry no space.
        let patch = "--- original\n+++ modified\n@@ -1,3 +1,5 @@\n # Scratch\n\n Not public.\n+\n+A line for history.\n"
        let lines = DiffLine.read(patch)
        XCTAssertEqual(lines.map(\.kind), [.starts(line: 1), .same, .same, .same, .added, .added])
        XCTAssertEqual(lines.map(\.text), ["", "# Scratch", "", "Not public.", "", "A line for history."])

        let removal = DiffLine.read("--- original\n+++ modified\n@@ -3 +3 @@\n-old line\n+new line\n\\ No newline at end of file\n")
        XCTAssertEqual(removal.map(\.kind), [.starts(line: 3), .removed, .added])
        XCTAssertEqual(removal.map(\.text), ["", "old line", "new line"])

        // The same text both sides: the two file lines and nothing else.
        XCTAssertEqual(DiffLine.read("--- original\n+++ modified\n"), [])
    }

    func testADeletedNoteComesBackWithItsPageAndComments() {
        let files = [
            DeletedFile(path: "Comments.md", lastSeenMs: 100, hash: "c", size: 1),
            DeletedFile(path: "pic.png", lastSeenMs: 50, hash: "p", size: 1),
            DeletedFile(path: "Comments.meta.jsonl", lastSeenMs: 100, hash: "cm", size: 1),
            DeletedFile(path: "Projects/plan.html", lastSeenMs: 200, hash: "ph", size: 1),
            DeletedFile(path: "Notes/a.meta.jsonl", lastSeenMs: 10, hash: "a", size: 1),
        ]
        let rows = DeletedDocument.group(files, store: "/ws")
        XCTAssertEqual(rows.map(\.name), ["plan", "Comments", "pic.png", "a.meta.jsonl"])
        XCTAssertEqual(rows[1].primary.path, "Comments.md")
        XCTAssertEqual(rows[1].companions.map(\.path), ["Comments.meta.jsonl"])

        // Where it was, when that is free.
        let comments = rows[1]
        XCTAssertEqual(comments.targets { _ in false }.map(\.path), ["/ws/Comments.md", "/ws/Comments.meta.jsonl"])
        // Beside it, one name for all its files, when something lives there now.
        var taken: Set<String> = ["/ws/Comments.md"]
        XCTAssertEqual(
            comments.targets { taken.contains($0) }.map(\.path),
            ["/ws/Comments (restored).md", "/ws/Comments (restored).meta.jsonl"]
        )
        taken.insert("/ws/Comments (restored).meta.jsonl")
        XCTAssertEqual(
            comments.targets { taken.contains($0) }.map(\.path),
            ["/ws/Comments (restored 2).md", "/ws/Comments (restored 2).meta.jsonl"]
        )
        XCTAssertEqual(rows[2].targets { $0 == "/ws/pic.png" }.map(\.path), ["/ws/pic (restored).png"])
    }

    @MainActor
    func testASectionsStoreIsNamedAndItsPathsAreTheWorkspaces() {
        let device = Workspaces(remembered: UserDefaults(suiteName: "doklin-history-\(UUID().uuidString)")!)
        let workspace = device.workspace("/phone/Documents/Team")
        // Library keeps a store of its own, as each section does; the root, which holds them, none.
        XCTAssertEqual(workspace.libraryStore, "/phone/Documents/Team/Library")
        XCTAssertEqual(device.stores(of: workspace), ["/phone/Documents/Team/Library"], "Library's, before the engine has listed any")
        XCTAssertEqual(workspace.storeName("/phone/Documents/Team/Library"), "Library")
        XCTAssertEqual(workspace.storeName("/phone/Documents/Team/Private"), "Private")
        XCTAssertEqual(workspace.path("Ideas.md", in: "/phone/Documents/Team/Library"), "Library/Ideas.md")
        XCTAssertEqual(workspace.path("Mine/plan.md", in: "/phone/Documents/Team/Private"), "Private/Mine/plan.md")

        let deleted = RecentlyDeleted(workspace: workspace)
        let row = DeletedDocument.group([DeletedFile(path: "Mine/plan.md", lastSeenMs: 5, hash: "p", size: 3)], store: "/phone/Documents/Team/Private")[0]
        XCTAssertEqual(deleted.place(of: row), "Private/Mine")
        let opened = deleted.open(row)
        XCTAssertEqual(opened.path, "Private/Mine/plan.md")
        XCTAssertEqual(opened.store, "/phone/Documents/Team/Private")
        XCTAssertEqual(opened.version.hash, "p")
        XCTAssertNil(opened.newer)

        let top = DeletedDocument.group([DeletedFile(path: "Ideas.md", lastSeenMs: 5, hash: "i", size: 3)], store: workspace.libraryStore)[0]
        XCTAssertEqual(deleted.place(of: top), "Library")
        XCTAssertEqual(deleted.open(top).path, "Library/Ideas.md", "it comes back into Library")
    }
}
