// A workspace's history, as the screens show it: a note's versions, one
// version read back, the moments of a whole folder, and what was deleted
// from it — read off this iPhone's version stores through the engine. Every
// restore is the engine's own write, which keeps what it replaces as one
// more version first; so an undo is one more restore, and history never
// branches. The engine then says `versions-applied`, and every screen of the
// workspace reads its files again.
//
// Each section keeps a store of its own — Library, Private, each restricted
// folder — and the workspace's root, which holds them, keeps none. What this
// iPhone's stores hold starts when it joined; a note's versions also include
// those other devices sent up.

import Foundation
import Observation

/// One version, opened from a note's history — or the last of a deleted
/// document, opened from Recently deleted.
public struct OpenVersion: Hashable, Sendable {
    /// The store that holds it: what reading, comparing and restoring it name.
    public let store: String
    /// The document now, workspace-relative: where a restore writes.
    public let path: String
    public let version: FileVersion
    /// The version one step newer, which its changes are compared with; nil
    /// for the newest, compared with the note as it is now.
    public let newer: FileVersion?
    /// Set when this is what a deleted document last held.
    public let deleted: DeletedDocument?
}

extension Workspaces {
    /// The version stores of a workspace: Library's, then each other section's.
    public func stores(of workspace: Workspace) -> [String] {
        let library = workspace.libraryStore
        return [library] + versions.map(\.root).filter { $0.hasPrefix(workspace.root + "/") && $0 != library }.sorted()
    }
}

extension Workspace {
    /// The version store of Library, the section everyone has: where its
    /// history is read, and where its restores land.
    public var libraryStore: String { files.absolute(TreeModel.libraryFolder) }

    /// What a person calls the folder a store keeps: Library, Private, or a
    /// restricted folder by its name.
    public func storeName(_ store: String) -> String {
        let folder = relative(store) ?? store
        return status?.spaces.first { $0.path.lowercased() == folder.lowercased() }?.name ?? DocLinks.name(of: folder)
    }

    /// A store-relative path as a path of this workspace.
    public func path(_ path: String, in store: String) -> String {
        relative("\(store)/\(path)") ?? path
    }
}

private func words(_ error: Error) -> String {
    (error as? DoklinError)?.message ?? error.localizedDescription
}

/* ---------- A note's versions ---------- */

@MainActor
@Observable
public final class NoteHistory {
    public let workspace: Workspace
    /// The note, workspace-relative.
    public let path: String
    public private(set) var history: FileHistory?
    public private(set) var phase: LoadPhase = .idle

    public init(workspace: Workspace, path: String) {
        self.workspace = workspace
        self.path = path
    }

    public var versions: [FileVersion] { history?.versions ?? [] }

    /// Read the versions. What was typed since the last one is kept first,
    /// so the newest row is the note as it is now.
    public func load() async {
        if history == nil { phase = .loading }
        try? await Engine.shared.run("versions_flush", ["ms": 2000])
        do {
            history = try await Engine.shared.call("versions_history", ["path": .string(workspace.files.absolute(path))])
            phase = .loaded
        } catch {
            phase = .failed(words(error))
        }
    }

    /// How far back this goes, and from where: "Every change since 3 Jun ·
    /// 4 here · 2 in the cloud".
    public func trust(_ dates: HistoryDates) -> String {
        guard let oldest = versions.last else { return "No versions yet" }
        let cloud = versions.filter { $0.source != "local" }.count
        let since = "Every change since \(dates.since(oldest.ts))"
        return cloud == 0 ? since : "\(since) · \(versions.count - cloud) here · \(cloud) in the cloud"
    }

    /// A version, to read: with the one a step newer, which its changes are
    /// compared with.
    public func open(_ version: FileVersion) -> OpenVersion? {
        guard let history, let index = history.versions.firstIndex(of: version) else { return nil }
        let newer = index > 0 ? history.versions[index - 1] : nil
        return OpenVersion(store: history.root, path: path, version: version, newer: newer, deleted: nil)
    }

    /// Name the note's section as it is now. The name shows on that row here
    /// and in the section's history, and a named version is never thinned out.
    public func name(_ label: String) async throws {
        let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty, let store = history?.root else { return }
        try await Engine.shared.run(
            "versions_capture_now", ["root": .string(store), "reason": "manual", "label": .string(label)]
        )
        await load()
    }
}

/* ---------- One version, read back ---------- */

@MainActor
@Observable
public final class VersionReader {
    public let workspace: Workspace
    public let opened: OpenVersion
    /// What the version says.
    public private(set) var text: String?
    /// A note's version, read into blocks.
    public private(set) var document: MarkdownDocument?
    public private(set) var phase: LoadPhase = .idle
    /// What changed from this version to the next, once asked.
    public private(set) var changes: [DiffLine]?
    public private(set) var changesProblem: String?

    public init(workspace: Workspace, opened: OpenVersion) {
        self.workspace = workspace
        self.opened = opened
    }

    public var kind: FileKind { FileKind.of(opened.path) }

    /// Read it: from this iPhone's store, or from the cloud when another
    /// device kept it.
    public func load() async {
        guard text == nil else { return }
        phase = .loading
        do {
            let read: String = try await Engine.shared.call(
                "versions_read", ["root": .string(opened.store), "hash": .string(opened.version.hash)]
            )
            text = read
            if kind == .markdown { document = MarkdownDocument.parse(read) }
            phase = .loaded
        } catch {
            phase = .failed(words(error))
        }
    }

    /// Compare it with the version after it, or with the note now.
    public func compare() async {
        guard changes == nil else { return }
        changesProblem = nil
        do {
            let patch: String = try await Engine.shared.call("versions_diff", [
                "root": .string(opened.store),
                "path": .string(workspace.files.absolute(opened.path)),
                "from": .string(opened.version.hash),
                "to": .optional(opened.newer?.hash),
            ])
            changes = DiffLine.read(patch)
        } catch {
            changesProblem = words(error)
        }
    }

    /// Whether the comparison found anything at all.
    public var changed: Bool {
        changes?.contains { $0.kind == .added || $0.kind == .removed } ?? false
    }

    /// Put this version back as the note. A version another device kept
    /// goes back as the text read here: this iPhone's store has no copy.
    public func restore() async throws -> RestoreOutcome {
        let local = opened.version.source == "local"
        return try await Engine.shared.call("versions_restore_file", [
            "root": .string(opened.store),
            "path": .string(workspace.files.absolute(opened.path)),
            "ts": .int(opened.version.ts),
            "hash": local ? .string(opened.version.hash) : .null,
            "text": local ? .null : .optional(text),
        ])
    }

    /// Take a restore back: put back what the note said before it.
    public static func undo(_ outcome: RestoreOutcome, of opened: OpenVersion, in workspace: Workspace) async throws {
        guard let hash = outcome.preRestoreHash else { return }
        try await Engine.shared.run("versions_restore_file", [
            "root": .string(opened.store),
            "path": .string(workspace.files.absolute(opened.path)),
            "ts": outcome.preRestoreTs.map(JSONValue.int) ?? .null,
            "hash": .string(hash),
        ])
    }

    /// Write this version out beside the note as a note of its own, and
    /// answer its path.
    public func copy(_ dates: HistoryDates) async throws -> String {
        guard let text else { throw DoklinError("That version is still being read.") }
        var target = dates.copyName(of: opened.path, ts: opened.version.ts)
        for n in 2..<50 where workspace.files.exists(target) {
            target = dates.copyName(of: opened.path, ts: opened.version.ts, n: n)
        }
        let changed = try workspace.files.write(target, Data(text.utf8))
        await workspace.wrote(changed)
        return target
    }
}

/* ---------- The moments of a folder ---------- */

@MainActor
@Observable
public final class WorkspaceTimeline {
    public let workspace: Workspace
    /// The store being looked at: Library's, or another section's.
    public private(set) var store: String
    public private(set) var moments: [SnapshotMeta] = []
    public private(set) var phase: LoadPhase = .idle

    public init(workspace: Workspace, store: String) {
        self.workspace = workspace
        self.store = store
    }

    public func load() async {
        let asked = store
        if moments.isEmpty { phase = .loading }
        do {
            let read: [SnapshotMeta] = try await Engine.shared.call("versions_snapshots", ["root": .string(asked)])
            // Another folder was picked while this one was read: its own
            // load answers for it.
            guard asked == store else { return }
            moments = read
            phase = .loaded
        } catch {
            guard asked == store else { return }
            moments = []
            phase = .failed(words(error))
        }
    }

    /// Look at another store's moments.
    public func show(_ store: String) async {
        guard store != self.store else { return }
        self.store = store
        moments = []
        await load()
    }
}

/// One moment of a folder: what restoring it would change, and the restore.
@MainActor
@Observable
public final class MomentPlan {
    public let workspace: Workspace
    public let store: String
    public let moment: SnapshotMeta
    public private(set) var rows: [PlanRow] = []
    /// The rows a restore of the selected ones takes: every one, to begin with.
    public private(set) var ticked: Set<String> = []
    public private(set) var phase: LoadPhase = .idle

    public init(workspace: Workspace, store: String, moment: SnapshotMeta) {
        self.workspace = workspace
        self.store = store
        self.moment = moment
    }

    /// Compare the moment with the folder now.
    public func load() async {
        if rows.isEmpty { phase = .loading }
        do {
            let diff: SnapshotDiff = try await Engine.shared.call(
                "versions_snapshot_diff", ["root": .string(store), "ts": .int(moment.ts)]
            )
            rows = PlanRow.plan(diff)
            ticked = Set(rows.map(\.path))
            phase = .loaded
        } catch {
            phase = .failed(words(error))
        }
    }

    public func toggle(_ path: String) {
        if ticked.contains(path) { ticked.remove(path) } else { ticked.insert(path) }
    }

    /// The rows a restore takes: every one, or the ticked ones.
    public func scope(all: Bool) -> [PlanRow] {
        all ? rows : rows.filter { ticked.contains($0.path) }
    }

    /// The question to confirm a restore with, in real counts.
    public func question(all: Bool) -> String {
        let rows = scope(all: all)
        return HistoryWords.restoreQuestion(
            write: rows.filter { $0.kind == .changes }.count,
            back: rows.filter { $0.kind == .comesBack }.count,
            remove: rows.filter { $0.kind == .isRemoved }.count
        )
    }

    /// Whether a restore would remove anything — which a phone cannot put in a Trash.
    public func removes(all: Bool) -> Bool {
        scope(all: all).contains { $0.kind == .isRemoved }
    }

    /// Restore every file, or the ticked ones. Answers what it did and the
    /// paths it was asked about. "Every file" names none to the engine: the
    /// moment is the intent, and the folder may have moved on since.
    public func restore(all: Bool) async throws -> (report: RestoreReport, paths: [String]) {
        let paths = scope(all: all).map(\.path)
        let report: RestoreReport = try await Engine.shared.call("versions_restore_snapshot", [
            "root": .string(store),
            "ts": .int(moment.ts),
            "paths": all ? .null : .strings(paths),
        ])
        await Self.keep(report, store: store)
        await load()
        return (report, paths)
    }

    /// Take a restore back: restore the moment it kept first, for the paths
    /// it was asked about and no others — an undo tapped later must not
    /// remove what reached the folder since, another person's note say.
    public static func undo(_ report: RestoreReport, paths: [String], store: String) async throws {
        guard let before = report.preRestoreTs, !paths.isEmpty else { return }
        let undone: RestoreReport = try await Engine.shared.call("versions_restore_snapshot", [
            "root": .string(store),
            "ts": .int(before),
            "paths": .strings(paths),
        ])
        await keep(undone, store: store)
    }

    /// A restore that removed files keeps the moment before it for good. A
    /// Mac's restore moves them to the Trash; this iPhone's removes them,
    /// and that moment is then their only copy — which the thinning would
    /// drop for the restore's own once the hour is out.
    private static func keep(_ report: RestoreReport, store: String) async {
        guard report.trashed > 0, let before = report.preRestoreTs else { return }
        // The restore has landed either way: a moment that could not be
        // pinned is still kept as long as the thinning keeps it.
        try? await Engine.shared.run("versions_set_pinned", ["root": .string(store), "ts": .int(before), "pinned": true])
    }
}

/* ---------- Recently deleted ---------- */

@MainActor
@Observable
public final class RecentlyDeleted {
    public let workspace: Workspace
    /// Across the workspace's sections, the most recently seen first.
    public private(set) var documents: [DeletedDocument] = []
    public private(set) var phase: LoadPhase = .idle

    public init(workspace: Workspace) {
        self.workspace = workspace
    }

    /// Read what every store of the workspace holds that its folders do not.
    public func load(stores: [String]) async {
        if documents.isEmpty { phase = .loading }
        var found: [DeletedDocument] = []
        var problem: String?
        var read = 0
        for store in stores {
            do {
                let files: [DeletedFile] = try await Engine.shared.call("versions_deleted", ["root": .string(store)])
                found += DeletedDocument.group(files, store: store)
                read += 1
            } catch {
                problem = problem ?? words(error)
            }
        }
        documents = found.sorted { $0.lastSeenMs > $1.lastSeenMs }
        phase = read == 0 ? .failed(problem ?? "This workspace has no history on this iPhone yet.") : .loaded
    }

    /// Where it was, in words: its folder, which starts with its section.
    public func place(of document: DeletedDocument) -> String {
        DocLinks.directory(of: workspace.path(document.primary.path, in: document.store))
    }

    /// Its last version, to read.
    public func open(_ document: DeletedDocument) -> OpenVersion {
        let file = document.primary
        let version = FileVersion(
            ts: file.lastSeenMs, hash: file.hash, size: file.size, by: "", reason: "", label: nil, pinned: false,
            restoredFrom: nil, path: file.path, source: "local", current: false
        )
        return OpenVersion(
            store: document.store, path: workspace.path(file.path, in: document.store), version: version, newer: nil,
            deleted: document
        )
    }
}

extension DeletedDocument {
    /// Bring every file of it back, where it was or beside it, and answer the
    /// workspace-relative path it opens as now.
    @MainActor
    public func bringBack(in workspace: Workspace) async throws -> String {
        let targets = targets { FileManager.default.fileExists(atPath: $0) }
        // The sidecar first, as a save writes it: the note on disk always
        // finds the records it uses.
        let sidecarFirst = targets.filter { $0.path.lowercased().hasSuffix(".meta.jsonl") }
            + targets.filter { !$0.path.lowercased().hasSuffix(".meta.jsonl") }
        for (file, path) in sidecarFirst {
            try await Engine.shared.run("versions_restore_file", [
                "root": .string(store),
                "path": .string(path),
                "ts": .int(file.lastSeenMs),
                "hash": .string(file.hash),
            ])
        }
        return targets.first.flatMap { workspace.relative($0.path) } ?? primary.path
    }
}
