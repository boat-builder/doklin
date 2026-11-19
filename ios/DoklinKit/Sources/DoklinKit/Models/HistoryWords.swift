// How the history screens lay a history out and what they say about it:
// days and times, why a version was kept, what restoring a moment would do,
// a comparison read line by line, and where a deleted file comes back. The
// Mac's rules and words (src/HistoryRail.tsx, VersionPreview.tsx,
// WorkspaceHistory.tsx, RecentlyDeleted.tsx), with one difference: a phone
// has no Trash, so what a restore would move there on a Mac is removed here —
// and stays in the history, under Recently deleted.

import Foundation

/// Anything kept at a moment: a version of a note, a moment of a folder.
public protocol Moment {
    /// Milliseconds since 1970.
    var ts: Int { get }
}

extension FileVersion: Moment {}
extension SnapshotMeta: Moment {}

// Hashable, so a screen can be a place to go: by what names each one.
extension FileVersion: Hashable {
    public func hash(into hasher: inout Hasher) {
        hasher.combine(ts)
        hasher.combine(hash)
        hasher.combine(source)
    }
}

extension SnapshotMeta: Hashable {
    public func hash(into hasher: inout Hasher) {
        hasher.combine(ts)
    }
}

extension DeletedFile: Hashable {
    public func hash(into hasher: inout Hasher) {
        hasher.combine(path)
        hasher.combine(hash)
    }
}

/// One day of a history, newest first.
public struct DayGroup<Item: Moment>: Identifiable {
    /// The day's first instant.
    public let day: Date
    /// `Today`, `Yesterday`, `Tue 2 Sep`, `2 Sep 2025`.
    public let label: String
    /// Today or yesterday: shown open, since that is where the version a
    /// person is looking for usually is. Older days fold to a count.
    public let recent: Bool
    public internal(set) var items: [Item]

    public var id: Date { day }
}

/// Dates and times as the history screens write them, in this person's
/// language and time zone — the Mac's `dayLabel`, `timeLabel` and the rest.
public struct HistoryDates {
    public let now: Date
    public let calendar: Calendar
    private let dayFormat: DateFormatter
    private let yearFormat: DateFormatter
    private let timeFormat: DateFormatter
    private let shortFormat: DateFormatter

    public init(now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) {
        self.now = now
        self.calendar = calendar
        func formatter(_ template: String) -> DateFormatter {
            let formatter = DateFormatter()
            formatter.locale = locale
            formatter.calendar = calendar
            formatter.timeZone = calendar.timeZone
            formatter.setLocalizedDateFormatFromTemplate(template)
            return formatter
        }
        dayFormat = formatter("EEEdMMM")
        yearFormat = formatter("dMMMy")
        timeFormat = formatter("jmm")
        shortFormat = formatter("dMMM")
    }

    private func date(_ ms: Int) -> Date {
        Date(timeIntervalSince1970: Double(ms) / 1000)
    }

    private func daysAgo(_ ms: Int) -> Int {
        let then = calendar.startOfDay(for: date(ms))
        return calendar.dateComponents([.day], from: then, to: calendar.startOfDay(for: now)).day ?? 0
    }

    /// The heading a day of versions sits under: `Today`, `Yesterday`,
    /// `Tue 2 Sep` this year, `2 Sep 2025` before it.
    public func day(_ ms: Int) -> String {
        let days = daysAgo(ms)
        if days <= 0 { return "Today" }
        if days == 1 { return "Yesterday" }
        let sameYear = calendar.component(.year, from: date(ms)) == calendar.component(.year, from: now)
        return (sameYear ? dayFormat : yearFormat).string(from: date(ms))
    }

    /// `14:32`, or `2:32 PM`: the hour and minute, as this person reads them.
    public func time(_ ms: Int) -> String {
        timeFormat.string(from: date(ms))
    }

    /// The date a trust line names: "Every change since 3 Jun".
    public func since(_ ms: Int) -> String {
        shortFormat.string(from: date(ms))
    }

    /// `Tue 2 Sep, 14:32`: one moment, on its own.
    public func moment(_ ms: Int) -> String {
        "\(dayFormat.string(from: date(ms))), \(time(ms))"
    }

    /// Newest first, in days. The history comes newest first, so a day's
    /// rows are already together.
    public func groups<Item: Moment>(_ items: [Item]) -> [DayGroup<Item>] {
        var groups: [DayGroup<Item>] = []
        for item in items {
            let day = calendar.startOfDay(for: date(item.ts))
            if groups.last?.day == day {
                groups[groups.count - 1].items.append(item)
            } else {
                groups.append(DayGroup(day: day, label: self.day(item.ts), recent: daysAgo(item.ts) <= 1, items: [item]))
            }
        }
        return groups
    }

    /// What a copy of a version is called: `plan (version 2 Sep 14.32).md`,
    /// then ` 2`, ` 3` — a dot in the time, as the Mac's copies have, since
    /// a colon is not a file name on every disk.
    public func copyName(of path: String, ts: Int, n: Int = 1) -> String {
        let (stem, ext) = HistoryWords.split(path)
        let parts = calendar.dateComponents([.hour, .minute], from: date(ts))
        let time = String(format: "%02d.%02d", parts.hour ?? 0, parts.minute ?? 0)
        let suffix = "version \(since(ts)) \(time)" + (n > 1 ? " \(n)" : "")
        return "\(stem) (\(suffix))\(ext)"
    }
}

public enum HistoryWords {
    /// The small word a version or a moment wears: why it was kept. The
    /// Mac's `versionReasonWord` (src/versions.ts) — change both.
    public static func reason(_ reason: String) -> String {
        switch reason {
        case "interval": return "while editing"
        case "closing": return "end of session"
        case "seed": return "first seen"
        case "pre-restore": return "before a restore"
        case "restore": return "restored"
        case "manual": return "marked"
        default: return ""
        }
    }

    /// `+2 −1 ~5`: what a moment changed against the one before. The oldest
    /// has nothing before it and says how many files it holds.
    public static func delta(_ moment: SnapshotMeta) -> String {
        guard let delta = moment.delta else { return "\(moment.files) file\(moment.files == 1 ? "" : "s")" }
        let parts = [
            delta.added > 0 ? "+\(delta.added)" : nil,
            delta.removed > 0 ? "−\(delta.removed)" : nil,
            delta.changed > 0 ? "~\(delta.changed)" : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? "no change" : parts.joined(separator: " ")
    }

    /// The question a restore of a moment asks, with the counts a person is
    /// about to live with, in the order the restore does them.
    public static func restoreQuestion(write: Int, back: Int, remove: Int) -> String {
        let parts = [
            write > 0 ? "Write \(write) file\(write == 1 ? "" : "s")" : nil,
            back > 0 ? "bring back \(back)" : nil,
            remove > 0 ? "remove \(remove)" : nil,
        ].compactMap { $0 }
        guard !parts.isEmpty else { return "Nothing is ticked." }
        let sentence = parts.joined(separator: ", ")
        return sentence.prefix(1).uppercased() + sentence.dropFirst() + "?"
    }

    /// What a restore of a moment did.
    public static func restored(_ report: RestoreReport) -> String {
        let parts = [
            report.written > 0 ? "\(report.written) file\(report.written == 1 ? "" : "s") written" : nil,
            report.trashed > 0 ? "\(report.trashed) removed" : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? "Nothing needed changing." : "Restored — \(parts.joined(separator: ", "))."
    }


    /// `Couldn't restore that version. There's no version to restore.`
    public static func failed(_ lead: String, _ error: Error) -> String {
        let words = (error as? DoklinError)?.message ?? error.localizedDescription
        return "\(lead). \(DoklinError.sentence(words))"
    }

    /// A file name in two: before its extension, and the extension — which
    /// for a document's comments is the whole `.meta.jsonl`.
    static func split(_ path: String) -> (stem: String, ext: String) {
        if path.lowercased().hasSuffix(".meta.jsonl"), DocLinks.name(of: path).count > ".meta.jsonl".count {
            return (String(path.dropLast(".meta.jsonl".count)), String(path.suffix(".meta.jsonl".count)))
        }
        let name = DocLinks.name(of: path)
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return (path, "") }
        let ext = String(name[dot...])
        return (String(path.dropLast(ext.count)), ext)
    }
}

/* ---------- What restoring a moment would do ---------- */

/// One file a restore of a moment would touch.
public struct PlanRow: Identifiable, Hashable, Sendable {
    public enum Kind: Sendable {
        /// Different now: the moment's version is written over it.
        case changes
        /// Gone now: it comes back.
        case comesBack
        /// Made since: it is removed — this iPhone has no Trash.
        case isRemoved
    }

    /// Store-relative, as the engine names it.
    public let path: String
    public let kind: Kind

    public var id: String { path }

    public var word: String {
        switch kind {
        case .changes: return "changes"
        case .comesBack: return "comes back"
        case .isRemoved: return "is removed"
        }
    }

    /// The three lists as one, in the order they read: what changes, what
    /// comes back, what goes.
    public static func plan(_ diff: SnapshotDiff) -> [PlanRow] {
        diff.changed.map { PlanRow(path: $0.path, kind: .changes) }
            + diff.missing.map { PlanRow(path: $0, kind: .comesBack) }
            + diff.added.map { PlanRow(path: $0, kind: .isRemoved) }
    }
}

/* ---------- A comparison, line by line ---------- */

/// One line of a comparison between two versions of a note.
public struct DiffLine: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// Where a run of changes starts, by its line in the newer text.
        case starts(line: Int)
        case added
        case removed
        /// Unchanged, around what changed.
        case same
    }

    public let id: Int
    public let kind: Kind
    /// The line itself, without the mark the patch puts before it.
    public let text: String

    /// Read a unified patch, as `versions_diff` answers one: its two file
    /// lines first, then each run of changes under an `@@ -a,b +c,d @@`.
    /// The note a patch adds about a missing last newline is left out.
    public static func read(_ patch: String) -> [DiffLine] {
        var lines = patch.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        if lines.count >= 2, lines[0].hasPrefix("--- "), lines[1].hasPrefix("+++ ") { lines.removeFirst(2) }
        var out: [DiffLine] = []
        for line in lines {
            let kind: Kind
            let text: String
            if line.hasPrefix("@@") {
                // "@@ -3,7 +3,8 @@": the run starts at line 3 of the newer text.
                let newer = line.split(separator: " ").first { $0.hasPrefix("+") }
                let start = newer.flatMap { Int($0.dropFirst().split(separator: ",").first ?? "") } ?? 1
                kind = .starts(line: max(start, 1))
                text = ""
            } else if line.hasPrefix("\\") {
                continue
            } else if line.hasPrefix("+") {
                kind = .added
                text = String(line.dropFirst())
            } else if line.hasPrefix("-") {
                kind = .removed
                text = String(line.dropFirst())
            } else {
                kind = .same
                text = line.hasPrefix(" ") ? String(line.dropFirst()) : line
            }
            out.append(DiffLine(id: out.count, kind: kind, text: text))
        }
        return out
    }
}

/* ---------- Recently deleted ---------- */

/// One row of Recently deleted: a file the history holds and the folder
/// does not — or a note or page, whose files (its markdown, its html, its
/// comments) went together and come back together.
public struct DeletedDocument: Identifiable, Hashable, Sendable {
    /// The version store that holds it, absolute: its section's.
    public let store: String
    /// The file it opens as: a note's markdown, else its page.
    public let primary: DeletedFile
    /// The rest of the document's files.
    public let companions: [DeletedFile]

    public var id: String { "\(store)\u{0}\(primary.path.lowercased())" }
    public var files: [DeletedFile] { [primary] + companions }
    public var lastSeenMs: Int { files.map(\.lastSeenMs).max() ?? primary.lastSeenMs }

    /// The name a person knows it by: a document's without its extension.
    public var name: String {
        let kind = FileKind.of(primary.path)
        let name = DocLinks.name(of: primary.path)
        return kind == .markdown || kind == .html ? DocLinks.stem(of: name) : name
    }

    /// The deleted files of one store, as rows, the most recently seen first.
    public static func group(_ files: [DeletedFile], store: String) -> [DeletedDocument] {
        var order: [String] = []
        var byKey: [String: [DeletedFile]] = [:]
        for file in files {
            let key = documentKey(file.path) ?? "file\u{0}\(file.path)"
            if byKey[key] == nil { order.append(key) }
            byKey[key, default: []].append(file)
        }
        let rank = { (file: DeletedFile) -> Int in
            switch FileKind.of(file.path) {
            case .markdown: return 0
            case .html: return 1
            default: return 2
            }
        }
        return order
            .compactMap { key -> DeletedDocument? in
                let members = (byKey[key] ?? []).sorted { rank($0) < rank($1) }
                guard let primary = members.first else { return nil }
                return DeletedDocument(store: store, primary: primary, companions: Array(members.dropFirst()))
            }
            .sorted { $0.lastSeenMs > $1.lastSeenMs }
    }

    /// The folder and stem a note, a page or comments are one document by.
    private static func documentKey(_ path: String) -> String? {
        let name = DocLinks.name(of: path)
        let stem: String
        if name.lowercased().hasSuffix(".meta.jsonl") {
            stem = String(name.dropLast(".meta.jsonl".count))
        } else if [.markdown, .html].contains(FileKind.of(name)) {
            stem = DocLinks.stem(of: name)
        } else {
            return nil
        }
        return "doc\u{0}\(DocLinks.directory(of: path).lowercased())/\(stem.lowercased())"
    }

    /// Where each file comes back, absolute: where it was, unless something
    /// lives there now — then beside it as `name (restored).md`, numbered
    /// when that is taken too. A document's files stay one name.
    public func targets(exists: (String) -> Bool) -> [(file: DeletedFile, path: String)] {
        func at(_ n: Int) -> [(file: DeletedFile, path: String)] {
            files.map { file in
                let (stem, ext) = HistoryWords.split(file.path)
                let name = n == 0 ? file.path : "\(stem) (restored\(n > 1 ? " \(n)" : ""))\(ext)"
                return (file, "\(store)/\(name)")
            }
        }
        for n in 0..<100 {
            let candidate = at(n)
            if !candidate.contains(where: { exists($0.path) }) { return candidate }
        }
        return at(lastSeenMs)
    }
}
