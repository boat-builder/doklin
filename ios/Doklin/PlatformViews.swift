// The two things shown through a system view rather than drawn: a PDF, and
// a document's html version. Everything here is UIKit, PDFKit and WebKit.

import PDFKit
import SwiftUI
import UIKit
import WebKit

/// A PDF, paged and zoomable — or nil when the bytes are not one.
struct PDFPages: UIViewRepresentable {
    private let document: PDFDocument

    init?(data: Data) {
        guard let document = PDFDocument(data: data) else { return nil }
        self.document = document
    }

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.document = document
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        if view.document !== document { view.document = document }
    }
}

/// A document's html version: the page an agent made from the note. It is
/// shown as the Mac app shows it — its scripts run, in a page with no origin
/// and no stored data, so nothing in it can reach the workspace or the
/// token. A link in it opens in the system, never in place.
struct HTMLView: UIViewRepresentable {
    let html: String

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .white
        context.coordinator.shown = html
        view.loadHTMLString(html, baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.shown != html else { return }
        context.coordinator.shown = html
        view.loadHTMLString(html, baseURL: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var shown = ""

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url else { return .allow }
            if url.scheme == "https" || url.scheme == "http" || url.scheme == "mailto" {
                _ = await UIApplication.shared.open(url)
            }
            return .cancel
        }
    }
}
