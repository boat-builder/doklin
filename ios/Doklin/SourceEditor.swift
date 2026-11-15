// The one screen SwiftUI has no control for: a text view whose caret the
// buttons above the keyboard can reach. Everything here is UIKit.

import SwiftUI
import UIKit

/// The buttons above the keyboard, and the text view they act on.
@MainActor
final class SourceEditorController: NSObject {
    weak var view: UITextView?
    var changed: ((String) -> Void)?

    private func report() {
        if let view { changed?(view.text) }
    }

    /// Put `mark` on both sides of the selection — or of the caret, which is left between them.
    private func wrap(_ mark: String) {
        guard let view, let range = view.selectedTextRange else { return }
        let selected = view.text(in: range) ?? ""
        view.replace(range, withText: mark + selected + mark)
        if selected.isEmpty, let caret = view.selectedTextRange,
           let inside = view.position(from: caret.start, offset: -mark.count) {
            view.selectedTextRange = view.textRange(from: inside, to: inside)
        }
        report()
    }

    /// Put `prefix` at the start of the line the caret is on.
    private func prefixLine(_ prefix: String) {
        guard let view else { return }
        let text = view.text as NSString
        let line = text.lineRange(for: NSRange(location: view.selectedRange.location, length: 0))
        guard let start = view.position(from: view.beginningOfDocument, offset: line.location),
              let range = view.textRange(from: start, to: start) else { return }
        view.replace(range, withText: prefix)
        report()
    }

    @objc func heading() { prefixLine("# ") }
    @objc func bold() { wrap("**") }
    @objc func italic() { wrap("*") }
    @objc func code() { wrap("`") }
    @objc func bullet() { prefixLine("- ") }
    @objc func task() { prefixLine("- [ ] ") }

    @objc func link() {
        guard let view, let range = view.selectedTextRange else { return }
        let selected = view.text(in: range) ?? ""
        view.replace(range, withText: "[\(selected)]()")
        // The caret goes where the address is typed.
        if let caret = view.selectedTextRange, let inside = view.position(from: caret.start, offset: -1) {
            view.selectedTextRange = view.textRange(from: inside, to: inside)
        }
        report()
    }

    @objc func done() {
        view?.resignFirstResponder()
    }

    func toolbar() -> UIToolbar {
        let bar = UIToolbar(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
        func item(_ symbol: String, _ label: String, _ action: Selector) -> UIBarButtonItem {
            let item = UIBarButtonItem(image: UIImage(systemName: symbol), style: .plain, target: self, action: action)
            item.accessibilityLabel = label
            return item
        }
        let gap = { UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil) }
        bar.items = [
            item("number", "Heading", #selector(heading)), gap(),
            item("bold", "Bold", #selector(bold)), gap(),
            item("italic", "Italic", #selector(italic)), gap(),
            item("list.bullet", "List", #selector(bullet)), gap(),
            item("checklist", "Task", #selector(task)), gap(),
            item("link", "Link", #selector(link)), gap(),
            item("chevron.left.forwardslash.chevron.right", "Code", #selector(code)), gap(),
            item("keyboard.chevron.compact.down", "Hide keyboard", #selector(done)),
        ]
        bar.sizeToFit()
        return bar
    }
}

/// The markdown as plain text in a system text view: nothing is restyled,
/// and nothing "smart" rewrites what was typed — a note's quotes and dashes
/// are its own.
struct SourceEditor: UIViewRepresentable {
    @Binding var text: String
    let controller: SourceEditorController
    /// False while another device holds the note: it can be read, not typed in.
    var editable = true

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 15, weight: .regular))
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 14, left: 14, bottom: 14, right: 14)
        view.alwaysBounceVertical = true
        view.keyboardDismissMode = .interactive
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.smartInsertDeleteType = .no
        view.autocapitalizationType = .sentences
        view.text = text
        view.isEditable = editable
        // Typing that starts before any tap goes on at the end of the note, not in front of its title.
        view.selectedRange = NSRange(location: (text as NSString).length, length: 0)
        controller.view = view
        let binding = $text
        controller.changed = { binding.wrappedValue = $0 }
        view.inputAccessoryView = controller.toolbar()
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
        if view.isEditable != editable { view.isEditable = editable }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        private let text: Binding<String>

        init(text: Binding<String>) {
            self.text = text
        }

        func textViewDidChange(_ textView: UITextView) {
            text.wrappedValue = textView.text
        }
    }
}
