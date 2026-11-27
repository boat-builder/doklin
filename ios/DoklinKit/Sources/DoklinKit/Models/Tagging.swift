// Tags on this iPhone, as the Mac keeps them (App.tsx): the workspace's tag
// list, which is the engine's status's, changed through the engine — shown
// at once and sent with the next sync — and a note's tag, and a rename's
// notes, as writes of the notes they are on. The rules are
// Markdown/Tags.swift's.
//
// A rename puts the new name or value in the list beside the old, rewrites
// every note on this iPhone that has it, and only then takes the old out:
// one that stops part-way leaves nothing reading as wrong. Removing a value
// or a tag rewrites nothing.

import Foundation

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
    /// The workspace's tags, in order, as the engine last said
    /// (`CloudStatus.tags`): none until it has.
    public var tagList: [TagDef] { status?.tags ?? [] }

    /// The list's tag called `name`, whatever its case.
    public func tag(named name: String) -> TagDef? { tagList.first { Tags.same($0.name, name) } }

    /// What a note's *Frontmatter* disclosure shows: the block as the reader
    /// set it aside, unless the block holds the note's tags alone.
    public func otherFrontmatter(of text: String, reader block: String?) -> String? {
        guard let block else { return nil }
        // A block only the reader sees (one closed by `...`) shows as it is.
        guard !Frontmatter.split(text).head.isEmpty else { return block }
        return Tags.hasOtherFrontmatter(text, list: tagList) ? block : nil
    }

    /// Change a note's text where it is: read, changed, and written over
    /// what was read — read once more when sync wrote it in between. Answers
    /// why it couldn't be written, in a sentence, and what was written.
    private func rewriting(_ path: String, _ change: (String) -> String) -> (problem: String?, wrote: [String]) {
        let name = DocLinks.stem(of: DocLinks.name(of: path))
        for _ in 0..<2 {
            guard files.exists(path) else {
                return ("\(name) is no longer on this iPhone — moved or removed on another device.", [])
            }
            let read: String
            do {
                read = try files.text(path)
            } catch {
                return ((error as? DoklinError)?.message ?? "\(name) could not be read.", [])
            }
            let next = change(read)
            if next == read { return (nil, []) }
            guard (try? files.text(path)) == read else { continue }
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
    public func rewrite(_ path: String, _ change: (String) -> String) async -> String? {
        let (problem, wrote) = rewriting(path, change)
        if !wrote.isEmpty { await self.wrote(wrote) }
        return problem
    }

    /// The tag that was `at` — or a new one at the end, when none is called
    /// that — is now `def`.
    private func setTag(at: String, _ def: TagDef) async throws {
        var fields: [String: JSONValue] = ["name": .string(def.name), "values": .strings(def.values)]
        if let desc = def.desc { fields["desc"] = .string(desc) }
        try await Engine.shared.run("cloud_set_tag", ["root": .string(root), "at": .string(at), "def": .object(fields)])
    }

    private func removeTag(_ name: String) async throws {
        try await Engine.shared.run("cloud_remove_tag", ["root": .string(root), "name": .string(name)])
    }

    /// Changes of the list, by the engine, which refuses one the worker
    /// would; then the status, which shows them. Nil when they were made,
    /// else why not, in a sentence.
    private func changeList(_ change: () async throws -> Void) async -> String? {
        var failed: String?
        do {
            try await change()
        } catch {
            failed = (error as? DoklinError)?.message ?? error.localizedDescription
        }
        await refreshStatus()
        return failed
    }

    /// *New tag*: the tag goes at the end of the list, then, when it was
    /// made from a note, that note gets `value`.
    public func createTag(_ def: TagDef, value: String?, on note: String?) async -> String? {
        if let failed = await changeList({ try await setTag(at: def.name, def) }) { return failed }
        guard let note, let value else { return nil }
        return await rewrite(note) { Tags.writeTag($0, at: def.name, tag: (name: def.name, value: value)) }
    }

    /// *Delete tag*: it leaves the list, and notes keep their line, which
    /// becomes plain frontmatter.
    public func deleteTag(_ name: String) async -> String? {
        await changeList { try await removeTag(name) }
    }

    /// *Edit*'s save, as far as the list: an edit that renames nothing is the
    /// tag as it is now. One that renames puts the new name or values in, the
    /// old beside them — an old name at the end, while the list has room —
    /// for `renameInNotes` to finish. Nil when it was saved, else why not.
    public func saveTagEdit(_ edit: TagEdit) async -> String? {
        guard edit.rewritesNotes else {
            return await changeList { try await setTag(at: edit.from, edit.def) }
        }
        let both = edit.def.values.flatMap { value -> [String] in
            guard let old = edit.renames.first(where: { $0.to == value })?.from, !Tags.same(old, value) else { return [value] }
            return [old, value]
        }
        let twoNames = edit.renamesTag && !Tags.same(edit.from, edit.def.name)
        return await changeList {
            try await setTag(at: edit.from, TagDef(name: edit.def.name, values: both, desc: edit.def.desc))
            // The engine refuses a tag more than a list holds: then the old
            // name goes now.
            if twoNames { try? await setTag(at: edit.from, TagDef(name: edit.from, values: both)) }
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
                let (problem, written) = rewriting(result.path) { text in
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
        // The old name, when `saveTagEdit` kept it beside the new.
        let oldKept = edit.renamesTag && !Tags.same(from, def.name) && tag(named: from) != nil
        let left = await changeList {
            if oldKept { try await removeTag(from) }
            try await setTag(at: def.name, def)
        }
        return TagRenamed(changed: changed, failed: failed, listLeft: left)
    }
}
