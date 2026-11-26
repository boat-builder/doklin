import SwiftUI

/// A version a release marked mandatory: a domain's worker turns this app
/// away, so this covers every screen until a newer build is installed. An app
/// can't update itself here — TestFlight does it, so the one button opens
/// TestFlight. What is under the cover stays as it was, so an edit on its way
/// is still saved.
struct UpdateRequiredView: View {
    /// The domains turning this app away.
    let domains: [String]

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(spacing: 16) {
            Text("Update Doklin")
                .font(.system(.title2, design: .serif))
                .foregroundStyle(Theme.text1)
            Text("This version of Doklin (\(AppVersion.shown)) no longer works with \(domains.joined(separator: " and ")). Update it from TestFlight to keep going: everything you wrote stays as it is.")
                .font(.callout)
                .foregroundStyle(Theme.text2)
                .multilineTextAlignment(.center)
            Button("Open TestFlight") {
                if let testFlight = URL(string: "itms-beta://") { openURL(testFlight) }
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("open-testflight")
        }
        .padding(32)
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.canvas.ignoresSafeArea())
        .accessibilityIdentifier("update-required")
    }
}
