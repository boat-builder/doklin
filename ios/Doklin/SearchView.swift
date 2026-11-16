import DoklinKit
import SwiftUI

/// Searching the names of the documents this iPhone holds, and the text of its notes.
struct SearchView: View {
    @State private var model: SearchModel
    @State private var query = ""

    init(workspace: Workspace) {
        _model = State(initialValue: SearchModel(workspace: workspace))
    }

    var body: some View {
        List {
            ForEach(model.results) { result in
                NavigationLink(value: Route.document(result.path)) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(result.name)
                            .foregroundStyle(Theme.text1)
                        let folder = DocLinks.directory(of: result.path)
                        if !folder.isEmpty {
                            Text(folder)
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                        }
                        ForEach(result.hits.prefix(3), id: \.line) { hit in
                            Text(hit.preview)
                                .font(.footnote)
                                .foregroundStyle(Theme.text2)
                                .lineLimit(2)
                        }
                        if result.hits.count > 3 {
                            Text("and \(result.hits.count - 3) more")
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .accessibilityIdentifier("result-\(result.name)")
            }
        }
        .overlay { state }
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "A name, or words in a note")
        .textInputAutocapitalization(.never)
        .task(id: query) {
            // Not a search a keystroke: wait until the typing pauses.
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            await model.run(query)
        }
    }

    @ViewBuilder private var state: some View {
        switch model.phase {
        case .idle:
            ContentUnavailableView("Search the workspace", systemImage: "magnifyingglass", description: Text("Type part of a name, or a few words that are in what you are looking for."))
        case .loading where model.results.isEmpty:
            ProgressView()
        case .loaded where model.results.isEmpty:
            ContentUnavailableView.search(text: query)
        default:
            EmptyView()
        }
    }
}
