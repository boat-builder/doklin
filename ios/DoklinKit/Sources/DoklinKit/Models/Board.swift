// A folder shown as a board on this iPhone (the rules are
// Markdown/Boards.swift's): its `boards.json`, every document directly in
// it as a card, each note's tags read off this iPhone's copy, and what a
// person does on it — a card moved, "+ New", the board grouped by another
// tag, the folder shown as a folder again.
//
// A card moved to another column is a write of its note first (its tag, as
// a chip sets it), then of `boards.json`; moved up or down, only of
// `boards.json`. Each write of the file is made on the file as it is just
// then: what sync brought meanwhile is kept, and the change is made on top.
// Sync merges it with other devices' by its records (engine/src/boards.rs).

import Foundation
import Observation

/// A folder's board as read off the disk, at one moment.
struct BoardRead: Sendable {
    /// The folder is still here.
    let exists: Bool
    /// Every document directly in the folder.
    let rows: [DocumentRow]
    /// Each one's file name, its card's: its markdown, or its html when it
    /// has none.
    var names: [String] { rows.map { DocLinks.name(of: $0.path) } }
    /// The `boards.json` as the folder spells it, and its text.
    let file: (path: String, text: String)?
    /// Each note's keyed lines, by its name in lower case.
    let pairs: [String: [KeyedLine]]

    static func of(_ dir: String, in files: WorkspaceFiles) -> BoardRead {
        guard let entries = try? files.list(dir) else { return BoardRead(exists: false, rows: [], file: nil, pairs: [:]) }
        let rows = entries.compactMap { entry -> DocumentRow? in
            if case .document(let row) = entry { return row }
            return nil
        }
        let file = files.boardsFile(in: dir).flatMap { path in (try? files.text(path)).map { (path: path, text: $0) } }
        var pairs: [String: [KeyedLine]] = [:]
        if file != nil {
            for row in rows where !row.isHTML {
                if let text = try? files.text(row.path) { pairs[DocLinks.name(of: row.path).lowercased()] = Tags.keyedLines(text) }
            }
        }
        return BoardRead(exists: true, rows: rows, file: file, pairs: pairs)
    }
}

@MainActor
@Observable
public final class BoardModel {
    /// What the board can show.
    public enum State: Equatable {
        case loading
        /// The folder isn't on this iPhone any more.
        case missing
        /// It has no `boards.json`: shown as a folder, here or elsewhere.
        case noFile
        case newer
        case unreadable
        /// Grouped by a tag the list doesn't have (any more).
        case noTag(String)
        case shown
    }

    public let workspace: Workspace
    public let dir: String
    public private(set) var state: State = .loading
    public private(set) var board: Board?
    /// The tag it is grouped by, as the list has it.
    public private(set) var def: TagDef?
    public private(set) var columns: [BoardColumn] = []
    /// A write is on its way: nothing else starts until it is done.
    public private(set) var busy = false
    /// Something a person should read; the view shows it and sets it back.
    public var problem: String?

    @ObservationIgnored private var read: BoardRead?
    /// Values a card was just moved to, shown before its note is read again.
    @ObservationIgnored private var moving: [String: String?] = [:]
    @ObservationIgnored private var ticket = 0

    public init(workspace: Workspace, dir: String) {
        self.workspace = workspace
        self.dir = dir
    }

    /// The folder's name.
    public var name: String { DocLinks.name(of: dir) }
    /// Whether this person may change it here.
    public var mayChange: Bool { workspace.may("work") }

    /// Read it all again, off the main thread.
    public func load() {
        Task { await reload() }
    }

    func reload() async {
        ticket += 1
        let mine = ticket
        let files = workspace.files
        let dir = dir
        let read = await Task.detached(priority: .userInitiated) { BoardRead.of(dir, in: files) }.value
        guard mine == ticket else { return }
        moving = [:]
        apply(read)
    }

    private func apply(_ read: BoardRead) {
        self.read = read
        guard read.exists else { return settle(.missing, nil) }
        guard let file = read.file else { return settle(.noFile, nil) }
        switch Boards.parse(file.text) {
        case .newer: settle(.newer, nil)
        case .unreadable: settle(.unreadable, nil)
        case .board(let board): show(board)
        }
    }

    private func settle(_ state: State, _ board: Board?) {
        self.state = state
        self.board = board
        def = nil
        columns = []
    }

    /// `board` as it is to be shown, with the cards just moved where they went.
    private func show(_ board: Board) {
        self.board = board
        def = workspace.tag(named: board.tag)
        guard let def, let read else {
            state = .noTag(board.tag)
            columns = []
            return
        }
        let notes = read.names.map { BoardNote(name: $0, value: value(of: $0, for: def, in: read)) }
        columns = Boards.columns(board, def: def, notes: notes)
        state = .shown
    }

    private func value(of name: String, for def: TagDef, in read: BoardRead) -> String? {
        if let moved = moving[name] { return moved }
        return read.pairs[name.lowercased()]?.first { Tags.same($0.key, def.name) }?.value
    }

    /// The column "No Status" is called, for the tag it is grouped by.
    public var noValue: String { "No \(def?.name ?? board?.tag ?? "")" }

    /// A note's other tags, in the list's order, as its chips show them.
    public func chips(_ card: String) -> [NoteTag] {
        guard let def, let pairs = read?.pairs[card.lowercased()] else { return [] }
        return workspace.tagList.filter { !Tags.same($0.name, def.name) }.compactMap { tag in
            guard let pair = pairs.first(where: { Tags.same($0.key, tag.name) }), let value = pair.value, !value.isEmpty else { return nil }
            let listed = tag.values.first { Tags.same($0, value) }
            return NoteTag(name: tag.name, value: listed ?? value, known: listed != nil)
        }
    }

    /// The card's note, workspace-relative.
    public func path(of card: String) -> String { dir.isEmpty ? card : "\(dir)/\(card)" }

    /// The card's document, as the folder lists it: what its menu acts on.
    public func entry(_ card: String) -> FolderEntry? {
        let lower = card.lowercased()
        return read?.rows.first { DocLinks.name(of: $0.path).lowercased() == lower }.map(FolderEntry.document)
    }

    /// Why a card can't change columns, in a sentence, or nil when it can.
    /// Reordering it is still fine: that writes only `boards.json`.
    public func fixed(_ card: String) -> String? {
        guard FileKind.of(card) == .markdown else { return "An html document has no tags, so it stays here." }
        if let lease = workspace.lease(of: path(of: card)) {
            return lease.own
                ? "It’s open on your other device, \(lease.device), so it can’t change columns for now."
                : "\(lease.name) is editing it, so it can’t change columns for now."
        }
        return nil
    }

    /// Whether `card` may be dropped in `column`: its own, or another
    /// listed one (or "No …") when it may change columns.
    public func takes(_ card: String, in column: BoardColumn) -> Bool {
        guard mayChange, !busy else { return false }
        if column.cards.contains(card) { return true }
        return (column.known || column.value == nil) && fixed(card) == nil
    }

    /// The column a card is in now.
    public func column(of card: String) -> BoardColumn? { columns.first { $0.cards.contains(card) } }

    /// `card` dropped at `index` among the other cards of `column`.
    public func move(_ card: String, to column: BoardColumn, at index: Int) async {
        guard let board, let def, takes(card, in: column) else { return }
        let others = column.cards.filter { $0 != card }
        let moved = column.cards.contains(card) == false
        if !moved, column.cards.firstIndex(of: card) == index { return }
        let change = { (board: Board) in Boards.drop(card, at: index, in: others, on: board) }
        if moved { moving[card] = .some(column.value) }
        show(change(board))
        busy = true
        // The note first: a board that says a card moved when its note
        // didn't would be wrong; a rank for a card that didn't move is only
        // a rank.
        let failed: String?
        if moved {
            failed = await workspace.rewrite(path(of: card)) {
                Tags.writeTag($0, at: def.name, tag: column.value.map { (name: def.name, value: $0) })
            }
        } else {
            failed = nil
        }
        if let failed {
            problem = failed
        } else if let refused = await write(change) {
            problem = refused
        }
        busy = false
        await reload()
    }

    /// "+ New" in `column`: "Untitled" (then "Untitled 2", …) in the folder,
    /// with the column's value, at the column's end. Answers its path, to
    /// be opened and named.
    public func newCard(in column: BoardColumn) async -> String? {
        guard let def, mayChange, !busy else { return nil }
        busy = true
        let path = await making(in: column, as: def)
        busy = false
        await reload()
        return path
    }

    private func making(in column: BoardColumn, as def: TagDef) async -> String? {
        let path: String
        do {
            path = try workspace.files.createNote(in: dir)
        } catch {
            problem = "Couldn’t make a note here: \((error as? DoklinError)?.message ?? error.localizedDescription)"
            return nil
        }
        await workspace.wrote([path])
        if let value = column.value, let failed = await workspace.rewrite(path, { Tags.writeTag($0, at: def.name, tag: (name: def.name, value: value)) }) {
            problem = failed
            return path
        }
        let name = DocLinks.name(of: path)
        if let refused = await write({ Boards.drop(name, at: column.cards.count, in: column.cards, on: $0) }) { problem = refused }
        return path
    }

    /// Grouped by `tag` instead: the ranks stay.
    public func group(by tag: String) async {
        guard mayChange, !busy else { return }
        busy = true
        if let refused = await write({ Boards.regroup($0, by: tag) }) { problem = refused }
        busy = false
        await reload()
    }

    /// *Show as Folder*: the file goes — history keeps it, under Recently
    /// deleted — and the folder lists as it always did.
    public func showAsFolder() async {
        guard mayChange, !busy else { return }
        busy = true
        if let refused = await workspace.removeBoard(in: dir) { problem = refused }
        busy = false
        await reload()
    }

    /// `change` made on the file as it is now, without the cards whose
    /// document is gone, and written. Nil when it was, else why not.
    private func write(_ change: (Board) -> Board) async -> String? {
        await workspace.changeBoard(in: dir, change)
    }
}

extension Workspace {
    /// `change` made on the folder's `boards.json` as the disk has it, and
    /// written over exactly that: read once more when sync wrote it in
    /// between. With `create`, a folder with no file gets a new board,
    /// grouped by that tag; a file this app can't read is never written
    /// over. Every write leaves out the cards whose document is no longer in
    /// the folder. Nil when it was written (or nothing changed), else why
    /// not, in a sentence.
    func changeBoard(in dir: String, create: String? = nil, _ change: (Board) -> Board) async -> String? {
        for _ in 0..<3 {
            let found = files.boardsFile(in: dir)
            let text = found.flatMap { try? files.text($0) }
            if found != nil, text == nil { return "This folder’s boards.json couldn’t be read. Try again in a moment." }
            let board: Board
            switch text.map(Boards.parse) {
            case .board(let read)?:
                board = read
            case .newer?:
                return "This folder’s board was made by a newer version of Doklin. Update Doklin to change it."
            case .unreadable?:
                return "This folder’s boards.json isn’t one Doklin can read, so it can’t be changed here."
            case nil:
                guard let tag = create else { return "This folder isn’t shown as a board any more." }
                board = Board(tag: tag)
            }
            let names = ((try? files.list(dir)) ?? []).compactMap { entry -> String? in
                if case .document(let row) = entry { return DocLinks.name(of: row.path) }
                return nil
            }
            let next = Boards.serialize(Boards.prune(change(board), to: names))
            if next == text { return nil }
            let path = found ?? (dir.isEmpty ? Boards.file : "\(dir)/\(Boards.file)")
            // Nothing came between the read and the write.
            guard (files.exists(path) ? try? files.text(path) : nil) == text else { continue }
            do {
                await wrote(try files.write(path, Data(next.utf8)))
                return nil
            } catch {
                return (error as? DoklinError)?.message ?? error.localizedDescription
            }
        }
        return "This folder’s board kept changing while it was saved. Try again in a moment."
    }

    /// *Show as Board…*: the folder grouped by `tag` — a new board, or the
    /// one it has regrouped, its ranks kept. Nil when it was, else why not.
    public func showAsBoard(_ dir: String, by tag: String) async -> String? {
        await changeBoard(in: dir, create: tag) { Boards.regroup($0, by: tag) }
    }

    /// The folder's `boards.json` removed. No Trash here: history is the
    /// only copy, so what is pending goes into it first.
    public func removeBoard(in dir: String) async -> String? {
        guard let path = files.boardsFile(in: dir) else { return nil }
        try? await Engine.shared.run("versions_flush", ["ms": 2000])
        do {
            try FileManager.default.removeItem(at: files.url(path))
        } catch {
            return "The board couldn’t be removed: \(error.localizedDescription)"
        }
        await wrote([path])
        return nil
    }

    /// A rename of a document within its folder, made here: its card keeps
    /// its place on the folder's board. One moved to another folder arrives
    /// there with no rank, at the end of its column. Answers the files
    /// written, for the engine to hear with the move.
    func followCards(_ moves: WorkspaceFiles.Moved) -> [String] {
        var byFolder: [String: WorkspaceFiles.Moved] = [:]
        for move in moves where DocLinks.directory(of: move.from) == DocLinks.directory(of: move.to) {
            let kind = FileKind.of(move.from)
            guard kind == .markdown || kind == .html, !move.from.lowercased().hasSuffix(".meta.jsonl") else { continue }
            byFolder[DocLinks.directory(of: move.from), default: []].append(move)
        }
        var wrote: [String] = []
        for (dir, renames) in byFolder {
            guard let path = files.boardsFile(in: dir), let text = try? files.text(path), case .board(let board) = Boards.parse(text) else { continue }
            let next = renames.reduce(board) { Boards.rename(DocLinks.name(of: $1.from), to: DocLinks.name(of: $1.to), on: $0) }
            guard next != board, (try? files.write(path, Data(Boards.serialize(next).utf8))) != nil else { continue }
            wrote.append(path)
        }
        return wrote
    }

    /// Every board grouped by `from`, grouped by `to` instead: a tag's
    /// rename, after its notes and before the old name leaves the list.
    /// Answers why each it couldn't change wasn't, in a sentence.
    func regroupBoards(from: String, to: String) async -> [String] {
        let files = self.files
        let folders = await Task.detached(priority: .userInitiated) {
            files.everyFolder().filter { dir in
                guard let path = files.boardsFile(in: dir), let text = try? files.text(path), case .board(let board) = Boards.parse(text) else { return false }
                return Tags.same(board.tag, from)
            }
        }.value
        var failed: [String] = []
        for dir in folders {
            if let refused = await changeBoard(in: dir, { Boards.regroup($0, by: to) }) {
                failed.append("The board in \(DocLinks.name(of: dir)) still says \(from): \(refused)")
            }
        }
        return failed
    }
}

extension WorkspaceFiles {
    /// The folder's `boards.json` as the folder spells it, when it has one.
    public func boardsFile(in dir: String) -> String? {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: absolute(dir))) ?? []
        guard let name = names.first(where: { $0.lowercased() == Boards.file }) else { return nil }
        let path = dir.isEmpty ? name : "\(dir)/\(name)"
        var folder: ObjCBool = false
        guard FileManager.default.fileExists(atPath: absolute(path), isDirectory: &folder), !folder.boolValue else { return nil }
        return path
    }

    /// Whether the folder is shown as a board.
    public func isBoard(_ dir: String) -> Bool { boardsFile(in: dir) != nil }
}
