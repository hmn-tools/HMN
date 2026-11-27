import SwiftUI

/// The camera opened a pairing link. The app names the HMN it would pair with and asks first, because a QR code
/// can come from anywhere. On a paired phone, pairing again replaces the key it has.
struct PairLinkSheet: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    let link: PairLink
    @State private var working = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        SmallLabel(text: "Pair this phone")
                        Text(host).font(Theme.heading)
                        Text("The code works once.").font(Theme.small).foregroundStyle(Theme.stone)
                    }
                    .card()
                    if session.isPaired {
                        Text("This phone is paired already. Pairing again replaces its key.")
                            .font(Theme.font(13)).foregroundStyle(Theme.graphite)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if noAddress {
                        MessageLine(text: "This code has no address. Type the address in Settings first.", isError: true)
                    } else {
                        Button(working ? "Pairing" : "Pair") { Task { await pair() } }
                            .buttonStyle(PillButtonStyle())
                            .disabled(working)
                    }
                    if let message { MessageLine(text: message, isError: true) }
                }
                .padding(16)
            }
            .navigationTitle("Pair")
            .navigationBarTitleDisplayMode(.inline)
            .background(Theme.ground.ignoresSafeArea())
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private var noAddress: Bool { link.url == nil && session.serverURL.trimmingCharacters(in: .whitespaces).isEmpty }

    private var host: String {
        guard let url = URL(string: link.url ?? session.serverURL), let name = url.host else { return "Your HMN" }
        return url.port.map { "\(name):\($0)" } ?? name
    }

    private func pair() async {
        working = true
        defer { working = false }
        do {
            try await session.pair(with: link)
            dismiss()
        } catch {
            message = error.localizedDescription
        }
    }
}
