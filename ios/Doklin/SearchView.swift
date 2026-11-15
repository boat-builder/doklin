import DoklinKit
import SwiftUI

/// Searching every section this person is in — the text of notes and pages,
/// and what was said in comments.
struct SearchView: View {
    @State private var model: SearchModel
    @State private var query = ""

    init(session: Session) {
        _model = State(initialValue: SearchModel(session: session))
    }

    var body: some View {
        List {
            if let caveat = model.caveat {
                Section {
                    Text(caveat)
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                }
            }
            ForEach(model.answer?.results ?? []) { result in
                NavigationLink(value: Route.document(result.path)) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(DocLinks.name(of: result.path))
                            .foregroundStyle(Theme.text1)
                        let folder = DocLinks.directory(of: result.path)
                        if !folder.isEmpty {
                            Text(folder)
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                        }
                        ForEach(Array(result.matches.prefix(3).enumerated()), id: \.offset) { _, match in
                            Text(result.shown(match))
                                .font(.footnote)
                                .foregroundStyle(Theme.text2)
                                .lineLimit(2)
                        }
                        if result.inComments == true {
                            Label("In a comment", systemImage: "bubble.left")
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                        } else if let more = result.moreLines, more > 0 {
                            Text("and \(more) more")
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .overlay { state }
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Words in a note or a comment")
        .textInputAutocapitalization(.never)
        .task(id: query) {
            // Not a request a keystroke: wait until the typing pauses.
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            await model.run(query)
        }
    }

    @ViewBuilder private var state: some View {
        switch model.phase {
        case .idle:
            ContentUnavailableView("Search the workspace", systemImage: "magnifyingglass", description: Text("Type a few words that are in what you are looking for."))
        case .loading where model.answer == nil:
            ProgressView()
        case .failed(let message):
            ContentUnavailableView("Search did not finish", systemImage: "exclamationmark.triangle", description: Text(message))
        case .loaded where model.answer?.results.isEmpty == true:
            ContentUnavailableView.search(text: query)
        default:
            EmptyView()
        }
    }
}
