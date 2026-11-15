import DoklinKit
import SwiftUI
import UIKit

/// A plain file — anything that is not a document — shown as what it is: a
/// picture, a PDF, text. Whatever it is, it can be handed to another app.
struct FileView: View {
    let path: String
    let data: Data

    var body: some View {
        Group {
            switch FileKind.of(path) {
            case .image:
                if let image = UIImage(data: data) {
                    ScrollView([.horizontal, .vertical]) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: image.size.width)
                            .padding(16)
                    }
                } else {
                    unshown
                }
            case .pdf:
                if let pages = PDFPages(data: data) {
                    pages
                } else {
                    unshown
                }
            default:
                if let text = String(data: data, encoding: .utf8) {
                    ScrollView {
                        Text(text)
                            .font(.docCode)
                            .foregroundStyle(Theme.text1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(16)
                    }
                } else {
                    unshown
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .toolbar {
            ToolbarItem(placement: .bottomBar) {
                if let url = exported {
                    ShareLink(item: url) {
                        Label("Share \(DocLinks.name(of: path))", systemImage: "square.and.arrow.up")
                    }
                }
            }
        }
    }

    private var unshown: some View {
        ContentUnavailableView(
            "This file cannot be shown here",
            systemImage: "doc",
            description: Text("Share it to open it in another app.")
        )
    }

    /// The file under its own name in the temporary folder, for the share sheet.
    private var exported: URL? {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("doklin-share", isDirectory: true)
        let url = folder.appendingPathComponent(DocLinks.name(of: path))
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            return nil
        }
    }
}
