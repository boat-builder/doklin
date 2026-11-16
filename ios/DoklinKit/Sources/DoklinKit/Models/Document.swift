// One document, open: read off this iPhone's copy, and written back to it.
// Sync carries a change to every other device and merges one made
// elsewhere meanwhile; a version store keeps every state, so nothing
// written here is ever the only copy of what it replaced.

import Foundation
import Observation

@MainActor
@Observable
public final class DocumentModel {
    /// A save that found the note changed under it — by sync, from another
    /// device — and wrote nothing.
    public struct ChangedElsewhere: Error {}

    public let workspace: Workspace
    /// The file it opened as: a note's markdown, a page's html, or any file.
    public let path: String
    public let kind: FileKind
    /// The markdown, as the file has it.
    public private(set) var text: String?
    /// The markdown, read into blocks.
    public private(set) var document: MarkdownDocument?
    /// The html: a page's own, or a note's rendition beside it.
    public private(set) var html: String?
    /// Any other file, as bytes.
    public private(set) var data: Data?
    public private(set) var phase: LoadPhase = .idle
    /// Something a person should read; the view shows it and sets it back.
    public var problem: String?
    /// What changed in the note since this person last read it here — nil
    /// when nothing did, it was their own change, or they never read it.
    public private(set) var sinceRead: ChangeMarks?
    /// When the version they read was kept, ms.
    public private(set) var readAt: Int?
    /// It changed since they read it, but that version is not kept here,
    /// so what changed can't be shown.
    public private(set) var changedUnmarked = false
    /// Made since this person last looked, and not read here until now.
    public private(set) var newToYou = false

    public init(workspace: Workspace, path: String) {
        self.workspace = workspace
        self.path = path
        self.kind = FileKind.of(path)
    }

    public var title: String { DocLinks.stem(of: DocLinks.name(of: path)) }
    public var isNote: Bool { kind == .markdown }
    /// A note with an html rendition beside it.
    public var htmlPath: String? {
        guard isNote else { return nil }
        let rendition = DocLinks.directory(of: path).isEmpty ? "\(title).html" : "\(DocLinks.directory(of: path))/\(title).html"
        return workspace.files.exists(rendition) ? rendition : nil
    }

    /// Who may change it here: this person's role allows work, and no other
    /// device holds it (`lease`).
    public var canEdit: Bool { isNote && text != nil && workspace.may("work") }

    /// The other device that has it open for editing.
    public var lease: LeaseHolder? { workspace.lease(of: path) }

    /// Whether a change of the workspace's files is this document's: one of
    /// its files, or a folder it is in.
    public func isAffected(by changed: Set<String>) -> Bool {
        let mine = [path, htmlPath, DocLinks.metaFile(of: path)].compactMap { $0?.lowercased() }
        let lower = path.lowercased()
        return mine.contains { changed.contains($0) } || changed.contains { lower.hasPrefix($0 + "/") }
    }

    /// Whether the note is still on this iPhone.
    public var exists: Bool { workspace.files.exists(path) }

    /// Read it off the disk.
    public func load() {
        do {
            switch kind {
            case .markdown:
                let source = try workspace.files.text(path)
                text = source
                document = MarkdownDocument.parse(source)
                html = try htmlPath.map { try workspace.files.text($0) }
            case .html:
                html = try workspace.files.text(path)
            default:
                data = try workspace.files.read(path)
            }
            phase = .loaded
        } catch let error as DoklinError {
            if phase == .loaded { problem = error.message } else { phase = .failed(error.message) }
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /* ---------- What was read ---------- */

    /// It is on screen: what changed since this person last read it here is
    /// worked out — against the version they read, when this device keeps
    /// it — and what it holds now is what they have read.
    public func shown() async {
        try? await workspace.loadRecent()
        let (seen, now) = workspace.lastRead(path)
        let me = workspace.recent?.me
        if let item = workspace.recentItem(path) { newToYou = item.created && item.unread }
        if isNote, let seen, let current = now?.hash, seen != current, now?.by != me, !(now?.by.isEmpty ?? true),
           let document {
            await compare(with: seen, now: document)
        }
        await workspace.markRead(path)
    }

    private func compare(with seen: String, now document: MarkdownDocument) async {
        do {
            let history: FileHistory = try await Engine.shared.call(
                "versions_history", ["path": .string(workspace.files.absolute(path))]
            )
            guard let version = history.versions.first(where: { $0.hash.hasPrefix(seen) }) else {
                changedUnmarked = true
                return
            }
            let read: String = try await Engine.shared.call(
                "versions_read", ["root": .string(history.root), "hash": .string(version.hash)]
            )
            let marks = ChangeMarks.between(MarkdownDocument.parse(read), document)
            sinceRead = marks.isEmpty ? nil : marks
            readAt = version.ts
        } catch {
            changedUnmarked = true
        }
    }

    /// Put the marks of what changed away.
    public func hideChanges() {
        sinceRead = nil
        changedUnmarked = false
    }

    /* ---------- Writing ---------- */

    /// Put new markdown down, as the person typed it over `expected` — what
    /// the file held when they started. When the file holds something else
    /// now, sync wrote it from another device: `ChangedElsewhere`, and
    /// nothing is written over it.
    public func save(_ source: String, over expected: String) async throws {
        guard isNote else { throw DoklinError("Only a note's markdown can be edited here.") }
        guard exists else {
            throw DoklinError("\(title) was not saved: it is no longer on this iPhone — moved or removed on another device, or its folder left.")
        }
        let now = try workspace.files.text(path)
        guard now == expected || now == source else { throw ChangedElsewhere() }
        try workspace.files.write(path, Data(source.utf8))
        text = source
        document = MarkdownDocument.parse(source)
        await workspace.wrote([path])
    }

    /// Tick or untick the task on a line of the source (0-based).
    public func toggleTask(line: Int) async {
        guard canEdit, let source = text else { return }
        guard let ticked = MarkdownEditing.togglingTask(in: source, line: line) else {
            // The line moved under the reader: read the note again.
            load()
            return
        }
        do {
            try await save(ticked, over: source)
        } catch is ChangedElsewhere {
            load()
            problem = "This note changed on another device, so it was read again. Tick the box once more."
        } catch {
            problem = (error as? DoklinError)?.message ?? error.localizedDescription
        }
    }

    /// Say which document this device is editing — or, with nil, that it is
    /// editing none. Other devices show it as being edited here, and open it
    /// view-only while this one holds it.
    public func editing(_ yes: Bool) async {
        let path: JSONValue = yes ? .string(workspace.files.absolute(self.path)) : .null
        try? await Engine.shared.run("cloud_set_activity", ["path": path])
    }

    /// Edit here instead of the device that holds it: that one goes
    /// view-only once it next hears from the domain.
    public func takeOver() async {
        try? await Engine.shared.run(
            "cloud_take_over", ["root": .string(workspace.root), "path": .string(workspace.files.absolute(path))]
        )
    }
}
