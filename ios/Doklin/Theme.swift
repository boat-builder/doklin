import DoklinKit
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

    /// A figure's colour: the drawing palette (`--dg-*`), or the page it is drawn on.
    static func figure(_ paint: FlowchartScene.Paint) -> Color {
        switch paint {
        case .ink: return Color("dg-ink")
        case .ink2: return Color("dg-ink-2")
        case .rule: return Color("dg-rule")
        case .grid: return Color("dg-grid")
        case .accent: return Color("dg-accent")
        case .good: return Color("dg-good")
        case .warn: return Color("dg-warn")
        case .bad: return Color("dg-bad")
        case .sheet: return sheet
        }
    }

    /// A callout's ink — its title and icon, 4.5:1 or better on its tint.
    static func calloutInk(_ kind: CalloutKind) -> Color {
        switch kind {
        case .note: return Color("callout-note")
        case .tip: return Color("callout-tip")
        case .important: return Color("callout-important")
        case .warning: return Color("callout-warning")
        case .caution: return Color("callout-caution")
        }
    }

    /// A callout's tint: its box.
    static func calloutTint(_ kind: CalloutKind) -> Color {
        switch kind {
        case .note: return Color("callout-note-tint")
        case .tip: return Color("callout-tip-tint")
        case .important: return Color("callout-important-tint")
        case .warning: return Color("callout-warning-tint")
        case .caution: return Color("callout-caution-tint")
        }
    }
}

extension Font {
    /// A heading of a note, as the Mac app sets them: H1 and H2 in the serif
    /// at a medium weight, H3 and below in the text face at semibold — big
    /// enough to scan a note by. The editor's sheet (src/ios-editor/editor.css)
    /// sets the same sizes: change both.
    static func docHeading(_ level: Int) -> Font {
        switch level {
        case 1: return .system(.largeTitle, design: .serif).weight(.medium)
        case 2: return .system(.title, design: .serif).weight(.medium)
        case 3: return .system(.title3).weight(.semibold)
        case 4: return .system(.headline)
        default: return .system(.subheadline).weight(.semibold)
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
    case document(String)
    /// A folder shown as a board (`BoardView`).
    case board(String)
    /// A note just made: it opens to be named, the caret in its title.
    case made(String)
    /// A note opened at the first place a search's words are in it — or, when
    /// they span its markup, at the source line the search found.
    case match(String, query: String, line: Int?)
    /// A followed link's page, on its way to this iPhone.
    case arriving
    case settings
    case history(HistoryPlace)
    case people
    case devices
    case agents
    case hereNow
    case publishedPages
    case tags
}
