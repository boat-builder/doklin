import SwiftUI

/// A line along the bottom of a workspace saying what just happened, with
/// the one thing to do about it — "Undo", "Open" — as the Mac's toasts do.
/// One at a time: a new one takes the place of the last. One with an action
/// stays until it is dismissed; one without goes after nine seconds.
@MainActor
@Observable
final class Toaster {
    struct Toast: Identifiable {
        enum Tone { case done, info, error }

        let id = UUID()
        let text: String
        let tone: Tone
        let action: Action?
    }

    struct Action {
        let label: String
        let run: () -> Void
    }

    private(set) var shown: Toast?

    func show(_ text: String, tone: Toast.Tone = .done, action: Action? = nil) {
        let toast = Toast(text: text, tone: tone, action: action)
        shown = toast
        guard action == nil else { return }
        Task {
            try? await Task.sleep(nanoseconds: 9_000_000_000)
            if shown?.id == toast.id { shown = nil }
        }
    }

    func dismiss() {
        shown = nil
    }
}

struct ToastBar: View {
    let toaster: Toaster

    var body: some View {
        if let toast = toaster.shown {
            HStack(spacing: 12) {
                Image(systemName: symbol(toast.tone))
                    .foregroundStyle(tint(toast.tone))
                    .accessibilityHidden(true)
                Text(toast.text)
                    .font(.footnote)
                    .foregroundStyle(Theme.text1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("toast")
                if let action = toast.action {
                    Button(action.label) {
                        toaster.dismiss()
                        action.run()
                    }
                    .font(.footnote.weight(.semibold))
                }
                Button {
                    toaster.dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.footnote)
                }
                .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Theme.sunken)
            .overlay(alignment: .top) {
                Rectangle().fill(Theme.border).frame(height: 0.5)
            }
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    private func symbol(_ tone: Toaster.Toast.Tone) -> String {
        switch tone {
        case .done: return "checkmark.circle"
        case .info: return "info.circle"
        case .error: return "exclamationmark.triangle"
        }
    }

    private func tint(_ tone: Toaster.Toast.Tone) -> Color {
        switch tone {
        case .done: return Theme.live
        case .info: return Theme.text2
        case .error: return Theme.errorInk
        }
    }
}
