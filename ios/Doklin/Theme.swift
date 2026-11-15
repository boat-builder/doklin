import SwiftUI

/// The app's palette: the Mac app's own tokens (src/styles/tokens.css), light
/// and dark. The colour sets are written into Assets.xcassets by
/// scripts/ios-colors.mjs — a value is never typed here, and every name used
/// below must be one that script writes (`--check` says when one is not).
enum Theme {
    static let canvas = Color("canvas")
    static let sheet = Color("sheet")
    static let sunken = Color("sunken")
    static let border = Color("border")
    static let text1 = Color("text-1")
    static let text2 = Color("text-2")
    static let text3 = Color("text-3")
    static let accent = Color("accent")
    static let accentWash = Color("accent-wash")
    static let codeBg = Color("code-bg")
    static let codeInlineBg = Color("code-inline-bg")
    static let quoteBar = Color("quote-bar")
    static let tableRule = Color("table-rule")
    static let tableHead = Color("table-head")
    static let mark = Color("mark")
    static let warnInk = Color("warn-ink")
    static let errorInk = Color("error-ink")
    static let live = Color("live")
}

extension Font {
    /// A heading of a note: serif, as the Mac app sets them by default.
    static func docHeading(_ level: Int) -> Font {
        switch level {
        case 1: return .system(.largeTitle, design: .serif)
        case 2: return .system(.title2, design: .serif)
        case 3: return .system(.title3, design: .serif)
        case 4: return .system(.headline, design: .serif)
        default: return .system(.subheadline, design: .serif).weight(.semibold)
        }
    }

    static let docCode = Font.system(.footnote, design: .monospaced)
}

/// A line above a note: why it cannot be changed here right now.
struct NoticeBar: View {
    let text: String
    var symbol = "lock"

    var body: some View {
        Label(text, systemImage: symbol)
            .font(.footnote)
            .foregroundStyle(Theme.warnInk)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Theme.sunken)
    }
}

/// Where a tap in the app can lead.
enum Route: Hashable {
    case folder(String)
    case document(String)
    case search
    case history(HistoryPlace)
}
