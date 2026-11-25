// A document's title is its file's name, without the extension: the reader
// shows it above the note, the editor edits it there, and a new title
// renames the file. The Mac's rules (src/titleText.ts, src/Sidebar.tsx):
// change both.

import Foundation

public enum DocTitle {
    /// A name the app gave a document nobody has named — "Untitled",
    /// "Untitled 2" — which the title shows as its placeholder.
    public static func isUnnamed(_ name: String) -> Bool {
        name.range(of: #"^Untitled(?: \d+)?$"#, options: .regularExpression) != nil
    }

    /// What New note calls a note: "Untitled", else the first "Untitled N"
    /// that no document `taken` names.
    static func firstFree(taken: (String) -> Bool) -> String {
        var n = 1
        while true {
            let name = n == 1 ? "Untitled" : "Untitled \(n)"
            if !taken(name) { return name }
            n += 1
        }
    }
}
