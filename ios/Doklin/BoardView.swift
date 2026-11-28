import DoklinKit
import SwiftUI
import UniformTypeIdentifiers

/// A folder shown as a board (`BoardModel`): a column for each value of the
/// tag it is grouped by, side by side. The board scrolls sideways and each
/// column down on its own. On an iPhone a column is most of the screen, so
/// the next one shows at the edge; on an iPad several fit.
///
/// Tap a card to open its note. Hold it and move to drag it, within its
/// column or to another; near the screen's edge the board turns to the next
/// column. Hold it without moving for its menu: *Move to*, the way to move
/// it without dragging, and the folder list's own items for the file.
struct BoardView: View {
    let workspace: Workspace
    let dir: String
    @Binding var route: [Route]

    @State private var model: BoardModel
    @State private var acting = EntryActing()
    /// The card being dragged, while it is.
    @State private var dragging: String?
    /// Where it would land.
    @State private var target: BoardTarget?
    /// Where the board is scrolled to: the column at its leading edge.
    @State private var position = ScrollPosition(idType: String.self)
    @State private var frames = BoardFrames()
    @State private var paging: Task<Void, Never>?
    /// *New tag…*, from a board with no tags to group by.
    @State private var makingTag = false
    /// This screen showed the folder as a folder: it closes once it has.
    @State private var leaving = false

    init(workspace: Workspace, dir: String, route: Binding<[Route]>) {
        self.workspace = workspace
        self.dir = dir
        _route = route
        _model = State(initialValue: BoardModel(workspace: workspace, dir: dir))
    }

    var body: some View {
        content
            .navigationTitle(model.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if showsMenu {
                    ToolbarItem(placement: .topBarTrailing) { menu }
                }
            }
            .onAppear { model.load() }
            .onChange(of: workspace.changes) { model.load() }
            // The list is the engine's status, not a file: a tag renamed or
            // removed anywhere changes the columns.
            .onChange(of: workspace.tagList) { model.load() }
            .onChange(of: model.state) { _, state in
                if leaving, state == .noFile { close() }
            }
            .alert("That did not work", isPresented: problemShown) {
                Button("OK", role: .cancel) { model.problem = nil }
            } message: {
                Text(model.problem ?? "")
            }
            .sheet(isPresented: $makingTag) {
                NewTagSheet(list: workspace.tagList, forNote: false) { def, _ in
                    if let failed = await workspace.createTag(def, value: nil, on: nil) { return failed }
                    await model.group(by: def.name)
                    return nil
                }
            }
            .modifier(EntryActionsHost(workspace: workspace, acting: acting) { route.append($0) })
    }

    private var problemShown: Binding<Bool> {
        Binding(get: { model.problem != nil }, set: { if !$0 { model.problem = nil } })
    }

    /* ---------- What it shows ---------- */

    @ViewBuilder private var content: some View {
        switch model.state {
        case .loading:
            ProgressView()
        case .missing:
            said("This folder isn’t here any more.", symbol: "questionmark.folder")
        case .noFile:
            said("This folder isn’t shown as a board any more.", symbol: "folder")
        case .newer:
            said("This board was made by a newer version of Doklin. Update Doklin to see it.", symbol: "arrow.up.circle")
        case .unreadable:
            said("This folder’s boards.json isn’t one Doklin can read, so it shows as a folder.", symbol: "exclamationmark.triangle")
        case .noTag(let tag):
            let tags = workspace.tagList
            ContentUnavailableView {
                Label("No columns", systemImage: "rectangle.split.3x1")
            } description: {
                Text(
                    tags.isEmpty
                        ? "The tag list has no tag called “\(tag)”, so there are no columns. Make a tag to group the notes by."
                        : "The tag list has no tag called “\(tag)” any more. Pick another to group the notes by."
                )
            } actions: {
                if model.mayChange {
                    if tags.isEmpty {
                        Button("New tag…") { makingTag = true }
                    } else {
                        groupBy
                    }
                }
            }
        case .shown:
            board
        }
    }

    private func said(_ sentence: String, symbol: String) -> some View {
        ContentUnavailableView(model.name, systemImage: symbol, description: Text(sentence))
    }

    /// The columns: "No …" only when it has cards, and while a card is
    /// dragged, as somewhere to put it.
    private var shown: [BoardColumn] {
        model.columns.filter { $0.value != nil || !$0.cards.isEmpty || dragging != nil }
    }

    /// A sideways scroll view runs under the bars above and below it but
    /// keeps none of its content clear of them: it is let run there, and its
    /// content is kept clear by the safe area measured outside it.
    private var board: some View {
        GeometryReader { space in
            columns(width: BoardFrames.width(of: space.size.width - 32), height: max(0, space.size.height - 16), under: space.safeAreaInsets)
                .ignoresSafeArea(.container, edges: .vertical)
        }
        .background(Theme.canvas)
    }

    private func columns(width: CGFloat, height: CGFloat, under bars: EdgeInsets) -> some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(shown) { column in
                    BoardColumnView(
                        column: column,
                        model: model,
                        frames: frames,
                        dragging: dragging,
                        target: $target,
                        open: { route.append(.document(model.path(of: $0))) },
                        make: { make(in: column) },
                        lifted: lifted,
                        heard: heard
                    )
                    .frame(width: width, height: height)
                    .id(column.id)
                }
            }
            .padding(.top, bars.top + 8)
            .padding(.bottom, bars.bottom + 8)
            .scrollTargetLayout()
        }
        .contentMargins(.horizontal, 16, for: .scrollContent)
        .scrollTargetBehavior(.viewAligned)
        .scrollPosition($position, anchor: .leading)
        .scrollIndicators(.hidden)
        .coordinateSpace(.named(BoardFrames.board))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { frames.width = $0 }
        .onChange(of: dragging) { _, now in
            if now == nil { stopPaging() }
        }
    }

    /* ---------- The board's menu ---------- */

    private var showsMenu: Bool {
        guard model.mayChange else { return false }
        switch model.state {
        case .loading, .missing, .noFile: return false
        default: return true
        }
    }

    private var menu: some View {
        Menu {
            if model.state == .shown { groupBy }
            Button {
                leaving = true
                Task { await model.showAsFolder() }
            } label: {
                Label("Show as Folder", systemImage: "folder")
            }
        } label: {
            Label("Board", systemImage: "ellipsis.circle")
        }
        .disabled(model.busy)
        .accessibilityIdentifier("board-menu")
    }

    /// *Group by ▸*: the list's tags, the board's checked.
    private var groupBy: some View {
        Menu {
            ForEach(workspace.tagList, id: \.name) { tag in
                Button {
                    Task { await model.group(by: tag.name) }
                } label: {
                    if tag.name.lowercased() == model.board?.tag.lowercased() {
                        Label(tag.name, systemImage: "checkmark")
                    } else {
                        Text(tag.name)
                    }
                }
            }
        } label: {
            Label("Group by", systemImage: "rectangle.split.3x1")
        }
        .accessibilityIdentifier("board-group")
    }

    /* ---------- What it does ---------- */

    /// "+ New": the note is made in the column and opens to be named.
    private func make(in column: BoardColumn) {
        Task {
            if let path = await model.newCard(in: column) { route.append(.made(path)) }
        }
    }

    /// Shown as a folder from here: back to where the board was opened from.
    private func close() {
        leaving = false
        if let at = route.lastIndex(of: .board(dir)) { route.removeSubrange(at...) }
    }

    /* ---------- A drag ---------- */

    /// A card was lifted. Nothing shows it yet: a card held for its menu is
    /// lifted too, and a change under an open menu would be drawn into it.
    /// The drag shows once a column hears it.
    private func lifted(_ card: String) {
        frames.lifted = card
    }

    /// "No …" shows while a card is dragged, at the front: the column at
    /// the board's leading edge stays there as it comes and goes, so the
    /// card's own column never slides out from under it.
    private func keepingLeading(_ change: () -> Void) {
        let keep = position.viewID(type: String.self) ?? nearest()
        change()
        if let keep { position.scrollTo(id: keep, anchor: .leading) }
    }

    /// What a column heard of the drag over it.
    private func heard(_ event: BoardDragEvent) {
        switch event {
        case .over(let column, let index, let x):
            frames.ending?.cancel()
            if dragging == nil, let card = frames.lifted { keepingLeading { dragging = card } }
            let next = BoardTarget(column: column, index: index)
            if target != next { target = next }
            edge(x)
        case .left(let column):
            if target?.column == column { target = nil }
            edge(-.infinity)
            endUnheard()
        case .dropped:
            frames.lifted = nil
            keepingLeading { dragging = nil }
        }
    }

    /// A drag no column hears for a moment was put down somewhere else, or
    /// given up: the board stops showing one.
    private func endUnheard() {
        frames.ending?.cancel()
        frames.ending = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1200))
            guard !Task.isCancelled else { return }
            frames.lifted = nil
            keepingLeading { dragging = nil }
        }
    }

    /// A card dragged at `x` across the board: held near an edge, the
    /// board turns a column that way, and on while it stays there.
    private func edge(_ x: CGFloat) {
        let zone: CGFloat = 44
        let way = !x.isFinite ? 0 : x < zone ? -1 : x > frames.width - zone ? 1 : 0
        guard way != frames.paging else { return }
        frames.paging = way
        paging?.cancel()
        guard way != 0 else { return }
        paging = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                guard !Task.isCancelled, frames.paging == way else { return }
                turn(way)
            }
        }
    }

    /// The drag is over: the board settles on the column nearest its
    /// leading edge — iOS scrolls it a little of its own accord while a
    /// card is held near the edge, and "No …" goes once it is empty.
    private func stopPaging() {
        frames.paging = 0
        paging?.cancel()
        paging = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled, let nearest = nearest() else { return }
            withAnimation(.snappy) { position.scrollTo(id: nearest, anchor: .leading) }
        }
        target = nil
    }

    /// The column whose leading edge is nearest the board's.
    private func nearest() -> String? {
        shown.map(\.id).min { abs((frames.columns[$0] ?? .infinity) - 16) < abs((frames.columns[$1] ?? .infinity) - 16) }
    }

    private func turn(_ way: Int) {
        let ids = shown.map(\.id)
        guard !ids.isEmpty else { return }
        let now = (position.viewID(type: String.self) ?? nearest()).flatMap { ids.firstIndex(of: $0) } ?? 0
        let next = min(max(now + way, 0), ids.count - 1)
        guard next != now else { return }
        withAnimation(.snappy) { position.scrollTo(id: ids[next], anchor: .leading) }
    }
}

/// Where a dragged card would land: the column, and how many of its other
/// cards sit above it.
struct BoardTarget: Equatable {
    let column: String
    let index: Int
}

/// What a column hears of a drag.
enum BoardDragEvent {
    /// Over the column, where it would land, and where it is across the board.
    case over(column: String, index: Int, x: CGFloat)
    case left(column: String)
    case dropped
}

/// Where the board's columns and cards are, as they last laid out: read
/// while a card is dragged, never drawn from, so it is kept out of the
/// views' state.
final class BoardFrames {
    /// The board's own coordinate space: what it shows of its columns.
    static let board = "board"

    /// A column's width: most of an iPhone's screen, so the next one shows
    /// at its edge; a fixed one where several fit.
    static func width(of board: CGFloat) -> CGFloat {
        board < 600 ? board * 0.86 : 300
    }

    var width: CGFloat = 0
    /// Each card's frame, in its column's coordinate space.
    var cards: [String: CGRect] = [:]
    /// Each column's leading edge on the board.
    var columns: [String: CGFloat] = [:]
    /// Which way the board is turning while a card is held at its edge.
    var paging = 0
    /// Ends a drag no column has heard of for a moment.
    var ending: Task<Void, Never>?
    /// The card last lifted, until its drag ends.
    var lifted: String?
}

/// One column: its value and how many cards, the cards, and "+ New".
private struct BoardColumnView: View {
    let column: BoardColumn
    let model: BoardModel
    let frames: BoardFrames
    let dragging: String?
    @Binding var target: BoardTarget?
    let open: (String) -> Void
    let make: () -> Void
    /// A card of this column lifted to be dragged.
    let lifted: (String) -> Void
    let heard: (BoardDragEvent) -> Void

    private var title: String { column.value ?? model.noValue }

    var body: some View {
        let others = column.cards.filter { $0 != dragging }
        let at = target?.column == column.id ? target?.index : nil
        VStack(spacing: 0) {
            header
            ScrollView(.vertical) {
                LazyVStack(spacing: 8) {
                    ForEach(column.cards, id: \.self) { card in
                        if let at, at < others.count, others[at] == card { BoardDropLine() }
                        cardView(card)
                    }
                    if let at, at >= others.count { BoardDropLine() }
                    if model.mayChange, column.known || column.value == nil {
                        Button(action: make) {
                            Label("New", systemImage: "plus")
                                .font(.subheadline)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 8)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.text2)
                        .disabled(model.busy)
                        .accessibilityLabel("New note in \(title)")
                        .accessibilityIdentifier("board-new-\(column.value ?? "none")")
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
            }
            .scrollIndicators(.hidden)
        }
        .background(at != nil ? Theme.accentWash : Theme.sunken, in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            if !column.known {
                RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.text3, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
        }
        .coordinateSpace(.named(column.id))
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(BoardFrames.board)).minX } action: { frames.columns[column.id] = $0 }
        .onDrop(of: [.plainText], delegate: BoardColumnDrop(column: column, model: model, dragging: dragging, frames: frames, heard: heard))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(title), \(column.cards.count) \(column.cards.count == 1 ? "card" : "cards")")
        .accessibilityIdentifier("column-\(column.value ?? "none")")
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(column.known ? Theme.text1 : Theme.text2)
                .lineLimit(1)
            if !column.known {
                Image(systemName: "questionmark.circle")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .accessibilityLabel("Not one of its values")
            }
            Spacer(minLength: 0)
            Text("\(column.cards.count)")
                .font(.subheadline)
                .monospacedDigit()
                .foregroundStyle(Theme.text3)
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .accessibilityElement(children: .combine)
    }

    private func cardView(_ card: String) -> some View {
        BoardCardView(card: card, model: model, lifted: dragging == card) { open(card) }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(column.id)) } action: { frames.cards[card] = $0 }
            .draggable(lift(card))
            .contextMenu {
                if model.mayChange { moveTo(card) }
                if let entry = model.entry(card) { EntryMenu(entry: entry, workspace: model.workspace) }
            }
    }

    /// The card's name, as what is dragged: asked for as the drag begins.
    private func lift(_ card: String) -> String {
        lifted(card)
        return card
    }

    /// *Move to ▸*: the other listed values, and "No …".
    @ViewBuilder private func moveTo(_ card: String) -> some View {
        let fixed = model.fixed(card)
        Menu {
            if let fixed {
                Text(fixed)
            } else {
                ForEach(model.columns.filter { ($0.known || $0.value == nil) && !$0.cards.contains(card) }) { column in
                    Button(column.value ?? model.noValue) {
                        Task { await model.move(card, to: column, at: column.cards.count) }
                    }
                }
            }
        } label: {
            Label("Move to", systemImage: "arrow.right.square")
        }
    }
}

/// A column as somewhere a card is dropped: where it would land is said as
/// it moves over, and the drop is the move. A card that can't come here is
/// turned away (`BoardModel.takes`).
private struct BoardColumnDrop: DropDelegate {
    let column: BoardColumn
    let model: BoardModel
    let dragging: String?
    let frames: BoardFrames
    let heard: (BoardDragEvent) -> Void

    /// The card on its way: lifted here, in this app.
    private var card: String? { dragging ?? frames.lifted }

    private var takes: Bool { card.map { model.takes($0, in: column) } ?? false }

    /// How many of the column's other cards sit above `y`.
    private func index(at y: CGFloat) -> Int {
        column.cards.filter { $0 != card && (frames.cards[$0]?.midY ?? .infinity) < y }.count
    }

    private func over(_ info: DropInfo) {
        heard(.over(column: column.id, index: index(at: info.location.y), x: (frames.columns[column.id] ?? 0) + info.location.x))
    }

    func validateDrop(info: DropInfo) -> Bool { card != nil }

    func dropEntered(info: DropInfo) { over(info) }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        over(info)
        return DropProposal(operation: takes ? .move : .forbidden)
    }

    func dropExited(info: DropInfo) { heard(.left(column: column.id)) }

    func performDrop(info: DropInfo) -> Bool {
        let index = index(at: info.location.y)
        let moving = card
        let taken = takes
        heard(.left(column: column.id))
        heard(.dropped)
        guard let moving, taken else { return false }
        Task { await model.move(moving, to: column, at: index) }
        return true
    }
}

/// A card: the note's title, and its other tags as grey chips.
private struct BoardCardView: View {
    let card: String
    let model: BoardModel
    /// It is being dragged: what stays behind is dimmed.
    let lifted: Bool
    let open: () -> Void

    var body: some View {
        let title = DocLinks.stem(of: card)
        let chips = model.chips(card)
        Button(action: open) {
            VStack(alignment: .leading, spacing: 8) {
                Text(title)
                    .font(.body)
                    .foregroundStyle(Theme.text1)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !chips.isEmpty {
                    ChipFlow(spacing: 4) {
                        ForEach(chips, id: \.name) { BoardChip(tag: $0) }
                    }
                }
            }
            .padding(12)
            .background(Theme.sheet, in: RoundedRectangle(cornerRadius: 10))
            .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border) }
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .opacity(lifted ? 0.4 : 1)
        .contentShape(.dragPreview, RoundedRectangle(cornerRadius: 10))
        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 10))
        .accessibilityLabel(([title] + chips.map { "\($0.name) \($0.value)" }).joined(separator: ", "))
        .accessibilityHint(model.fixed(card) ?? "")
        .accessibilityIdentifier("card-\(title)")
    }
}

/// A card's other tag: its value, grey — marked when it isn't one of the
/// tag's values.
private struct BoardChip: View {
    let tag: NoteTag

    var body: some View {
        Text(tag.value)
            .font(.caption)
            .foregroundStyle(Theme.text2)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Theme.sunken, in: Capsule())
            .overlay {
                if !tag.known {
                    Capsule().strokeBorder(Theme.text3, style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                }
            }
    }
}

/// Where a dragged card would land.
private struct BoardDropLine: View {
    var body: some View {
        Capsule()
            .fill(Theme.accent)
            .frame(height: 3)
            .padding(.horizontal, 2)
            .accessibilityHidden(true)
    }
}
