// Tags on this iPhone, as the Mac keeps them (App.tsx): the workspace's tag
// list, read from its note in Library, and every change of a tag as a write
// of the note it is on — a note's line, the list's lines, and a rename's
// notes. The rules are Markdown/Tags.swift's.
//
// A rename puts the new name or value in the list beside the old, rewrites
// every note on this iPhone that has it, and only then takes the old out:
// one that stops part-way leaves nothing reading as wrong. Removing a value
// or a tag rewrites nothing.

import Foundation

/// The workspace's tag list: its note, and the tags it lists.
public struct TagList: Equatable, Sendable {
    /// Where its note is, or would be made: `Library/Tags.md`, whatever its
    /// case on disk.
    public let path: String
    public let exists: Bool
    public let tags: [TagDef]

    public static func read(_ files: WorkspaceFiles) -> TagList {
        let dir = TreeModel.libraryFolder
        let names = (try? FileManager.default.contentsOfDirectory(atPath: files.absolute(dir))) ?? []
        let name = names.first { $0.lowercased() == Tags.note.lowercased() }
        let path = "\(dir)/\(name ?? Tags.note)"
        let text = name == nil ? nil : try? files.text(path)
        return TagList(path: path, exists: name != nil, tags: text.map(Tags.parseList) ?? [])
    }

    /// Whether `path` is the list's own note.
    public func isNote(_ path: String) -> Bool { path.lowercased() == self.path.lowercased() }

    public func tag(_ name: String) -> TagDef? { tags.first { Tags.same($0.name, name) } }

    /// What a note's *Frontmatter* disclosure shows: the block as the reader
    /// set it aside, unless the block holds the note's tags alone.
    public func frontmatter(of text: String, reader block: String?) -> String? {
        guard let block else { return nil }
        // A block only the reader sees (one closed by `...`) shows as it is.
        guard !Frontmatter.split(text).head.isEmpty else { return block }
        return Tags.hasOtherFrontmatter(text, list: tags) ? block : nil
    }
}

/// What *Edit* saves: the tag that was `from`, now `def`, with values
/// renamed old → new.
public struct TagEdit: Equatable, Sendable {
    public struct Rename: Equatable, Sendable {
        public let from: String
        public let to: String

        public init(from: String, to: String) {
            self.from = from
            self.to = to
        }
    }

    public let from: String
    public let def: TagDef
    public let renames: [Rename]

    public init(from: String, def: TagDef, renames: [Rename]) {
        self.from = from
        self.def = def
        self.renames = renames
    }

    public var renamesTag: Bool { def.name != from }
    /// The notes that have it are rewritten to match.
    public var rewritesNotes: Bool { renamesTag || !renames.isEmpty }
}

/// What a rename did to the notes.
public struct TagRenamed: Equatable, Sendable {
    public let changed: Int
    /// Why each note it couldn't write wasn't written, in a sentence.
    public let failed: [String]
    /// Why the list couldn't take the old name or values out.
    public let listLeft: String?

    /// What it did, in a sentence.
    public var words: String {
        if let first = failed.first {
            let more = failed.count - 1
            return more > 0 ? "\(first) \(more) more \(more == 1 ? "note wasn't" : "notes weren't") changed either." : first
        }
        return "\(changed == 1 ? "One note" : "\(changed) notes") changed to match."
    }
}

extension Workspace {
    /// Read the list again, from its note as the disk has it.
    func readTags() {
        let next = TagList.read(files)
        if next != tagList { tagList = next }
    }

    /// Change a note's text where it is: read, changed, and written over
    /// what was read — read once more when sync wrote it in between. With
    /// `create`, a note that isn't there is made. Answers why it couldn't
    /// be written, in a sentence, and what was written.
    private func rewriting(_ path: String, create: Bool, _ change: (String) -> String) -> (problem: String?, wrote: [String]) {
        let name = DocLinks.stem(of: DocLinks.name(of: path))
        for _ in 0..<2 {
            var read: String?
            if files.exists(path) {
                do {
                    read = try files.text(path)
                } catch {
                    return ((error as? DoklinError)?.message ?? "\(name) could not be read.", [])
                }
            } else if !create {
                return ("\(name) is no longer on this iPhone — moved or removed on another device.", [])
            }
            let next = change(read ?? "")
            if let read, next == read { return (nil, []) }
            let now = files.exists(path) ? try? files.text(path) : nil
            guard now == read else { continue }
            do {
                return (nil, try files.write(path, Data(next.utf8)))
            } catch {
                return ((error as? DoklinError)?.message ?? error.localizedDescription, [])
            }
        }
        return ("\(name) kept changing while its tags were saved. Try again in a moment.", [])
    }

    /// Change a note that isn't open: read, changed, written over what was
    /// read. Nil when it was, else why not, in a sentence.
    public func rewrite(_ path: String, create: Bool = false, _ change: (String) -> String) async -> String? {
        let (problem, wrote) = rewriting(path, create: create, change)
        if !wrote.isEmpty { await self.wrote(wrote) }
        return problem
    }

    /// A change to the list: written to its note — made, with a sentence
    /// under its block, when there is none — and read back.
    private func changeList(_ change: (String) -> String) async -> String? {
        let failed = await rewrite(tagList.path, create: true, change)
        readTags()
        return failed
    }

    /// *New tag*: the tag goes in the list, then, when it was made from a
    /// note, that note gets `value`.
    public func createTag(_ def: TagDef, value: String?, on note: String?) async -> String? {
        if let failed = await changeList({ Tags.writeList($0, at: def.name, def: def) }) { return failed }
        guard let note, let value else { return nil }
        return await rewrite(note) { Tags.writeTag($0, at: def.name, tag: (name: def.name, value: value)) }
    }

    /// *Delete tag*: it leaves the list, and notes keep their line, which
    /// becomes plain frontmatter.
    public func deleteTag(_ name: String) async -> String? {
        await changeList { Tags.writeList($0, at: name, def: nil) }
    }

    /// *Edit*'s save, as far as the list: an edit that renames nothing is
    /// the list's new line. One that renames puts the new name or values in
    /// beside the old, for `renameInNotes` to finish. Nil when it was
    /// written, else why not.
    public func saveTagEdit(_ edit: TagEdit) async -> String? {
        guard edit.rewritesNotes else {
            return await changeList { Tags.writeList($0, at: edit.from, def: edit.def) }
        }
        let both = edit.def.values.flatMap { value -> [String] in
            guard let old = edit.renames.first(where: { $0.to == value })?.from, !Tags.same(old, value) else { return [value] }
            return [old, value]
        }
        let twoLines = edit.renamesTag && !Tags.same(edit.from, edit.def.name)
        return await changeList { text in
            twoLines
                ? Tags.writeList(
                    Tags.writeList(text, at: edit.from, def: TagDef(name: edit.from, values: both)),
                    at: edit.def.name, def: TagDef(name: edit.def.name, values: both), after: edit.from
                )
                : Tags.writeList(text, at: edit.from, def: TagDef(name: edit.def.name, values: both))
        }
    }

    /// The rest of a rename: the tag's line rewritten in every note on this
    /// iPhone that has it — its value renamed, or its name — and then the
    /// old name or values out of the list. `counting` hears how many notes
    /// are written so far.
    public func renameInNotes(_ edit: TagEdit, counting: (Int) -> Void) async -> TagRenamed {
        let from = edit.from
        let def = edit.def
        let renamed = Dictionary(edit.renames.map { ($0.from.lowercased(), $0.to) }, uniquingKeysWith: { first, _ in first })
        let queries: [[TagFilter]] = edit.renamesTag
            ? [[TagFilter(name: from, value: nil)]]
            : edit.renames.map { [TagFilter(name: from, value: $0.from)] }
        let files = self.files
        var tried = Set<String>()
        var failed: [String] = []
        var wrote: [String] = []
        var changed = 0
        for filters in queries {
            let found = await Task.detached(priority: .userInitiated) {
                files.search("", in: files.sectionFolders(), tags: filters)
            }.value
            for result in found where tried.insert(result.path.lowercased()).inserted {
                let (problem, written) = rewriting(result.path, create: false) { text in
                    guard let line = Tags.keyedLines(text).first(where: { Tags.same($0.key, from) }), let value = line.value else { return text }
                    let to = renamed[value.lowercased()]
                    if !edit.renamesTag && to == nil { return text }
                    let listed = def.values.first { Tags.same($0, value) }
                    return Tags.writeTag(text, at: from, tag: (name: def.name, value: to ?? listed ?? value))
                }
                if let problem {
                    failed.append(problem)
                } else {
                    changed += 1
                    wrote += written
                }
                counting(changed)
            }
        }
        // Every note at once: one word to the engine and the screens.
        if !wrote.isEmpty { await self.wrote(wrote) }
        let twoLines = edit.renamesTag && !Tags.same(from, def.name)
        let left = await changeList { text in
            let next = Tags.writeList(text, at: def.name, def: def)
            return twoLines ? Tags.writeList(next, at: from, def: nil) : next
        }
        return TagRenamed(changed: changed, failed: failed, listLeft: left)
    }
}
