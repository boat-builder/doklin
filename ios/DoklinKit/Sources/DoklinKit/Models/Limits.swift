// What the day's Cloudflare limits do to a workspace's sync, and the
// many-new-documents question, in the Mac's words (the Cloud panel's and the
// footer tooltip's — `waitWords`, `usageWords`, src/cloud.ts) — change both.
// The sync line spans the screen, so it keeps the whole words the Mac's
// footer shortens. Every number is the engine's (`CloudStatus.usage`, from
// the domain's `limits`); none is typed here.

import Foundation

/// What the day's limits hold back right now.
public enum SyncHold: Equatable, Sendable {
    /// `count` changes wait until `until` (ms since 1970); `liftable` when
    /// this device may send them now.
    case waiting(Int, until: Int?, liftable: Bool)
    /// The wait was lifted, and `count` changes are on their way.
    case sending(Int)
    /// Sync is slower for the rest of the day; edits still go out.
    case slow
}

extension CloudStatus {
    /// What the day's limits hold back, while sync runs: any other phase
    /// says more than this.
    public var hold: SyncHold? {
        guard phase == .idle || phase == .syncing else { return nil }
        switch usage.mode {
        case .slow:
            return .slow
        case .bulkWaits where usage.waiting > 0:
            return .waiting(usage.waiting, until: usage.resumesAt, liftable: usage.liftable)
        default:
            return usage.lifted && usage.waiting > 0 ? .sending(usage.waiting) : nil
        }
    }
}

public enum LimitWords {
    /// A count as this person writes numbers: `412`, `1,240`.
    public static func count(_ n: Int, locale: Locale = .current) -> String {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: n)) ?? String(n)
    }

    /// The sync line while the limits hold something back: "412 changes
    /// wait until 05:30", "Sending 412 changes…". `time` writes a moment as
    /// a time of day (`HistoryDates.time`).
    public static func line(_ hold: SyncHold, time: (Int) -> String, locale: Locale = .current) -> String {
        switch hold {
        case .waiting(let n, let until, _):
            let wait = n == 1 ? "1 change waits" : "\(count(n, locale: locale)) changes wait"
            return until.map { "\(wait) until \(time($0))" } ?? wait
        case .sending(let n):
            return n == 1 ? "Sending 1 change…" : "Sending \(count(n, locale: locale)) changes…"
        case .slow:
            return "Sync is slower today — edits still go out."
        }
    }

    /// Why this device's big changes wait, asked before it sends them anyway.
    /// `device`: `iPhone`, `iPad`.
    public static func share(of device: String, until: String?) -> String {
        let after = until.map { "after \($0)" } ?? "tomorrow"
        return "This \(device) has sent its share of big changes for today. The rest go out \(after), so nothing else on this workspace slows down."
    }

    /// What a plan is called: `Free`, `Workers Paid`.
    public static func plan(_ plan: CloudPlan) -> String {
        switch plan {
        case .free: return "Free"
        case .paid: return "Workers Paid"
        }
    }

    /// What changes when the workspace's plan becomes `plan`, asked first.
    public static func planChange(to plan: CloudPlan) -> String {
        switch plan {
        case .free:
            return "Doklin paces sync to stay inside Cloudflare’s free daily requests: big changes may wait until the next day."
        case .paid:
            return "Doklin stops pacing sync for Cloudflare’s free daily requests. Choose this only once the account is on Workers Paid, or Cloudflare stops every request once today’s are used up."
        }
    }

    /// The sync line while new documents wait for a yes.
    public static func pendingAdds(_ n: Int, locale: Locale = .current) -> String {
        n == 1 ? "1 new document — Sync it?" : "\(count(n, locale: locale)) new documents — Sync them?"
    }

    /// The question about many new documents: "212 new documents appeared
    /// in Projects/foo. Sync them?". `folders` is the event's (at most a
    /// few, most first), empty when it has not been heard.
    public static func adds(_ n: Int, in folders: [AddedFolder], workspace: String, locale: Locale = .current) -> String {
        let what = n == 1 ? "1 new document" : "\(count(n, locale: locale)) new documents"
        let ask = n == 1 ? "Sync it?" : "Sync them?"
        guard let first = folders.first else { return "\(what) appeared. \(ask)" }
        let place: String
        if folders.reduce(0, { $0 + $1.count }) < n {
            place = "more than \(folders.count) folder\(folders.count == 1 ? "" : "s")"
        } else if folders.count > 1 {
            place = "\(folders.count) folders"
        } else {
            place = first.path.isEmpty ? workspace : first.path
        }
        return "\(what) appeared in \(place). \(ask)"
    }

    /// The yes to that question.
    public static func syncThem(_ n: Int) -> String {
        n == 1 ? "Sync it" : "Sync them"
    }
}
