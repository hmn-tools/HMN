import SwiftUI

/** What was decided: approved, accepted by a rule, declined, expired, and undone. Newest first. */
struct ActivityView: View {
    @EnvironmentObject private var session: Session
    @State private var items: [ActivityItem] = []
    @State private var message: String?
    @State private var loaded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                SmallLabel(text: "Activity · \(items.count)")
                if let message { Text(message).font(Theme.font(12)).foregroundStyle(Theme.graphite) }
                if loaded && items.isEmpty {
                    Text("Nothing is decided yet.").font(Theme.font(14)).foregroundStyle(Theme.graphite).padding(.top, 8)
                }
                ForEach(items) { item in
                    InkCard {
                        Text(item.title ?? "\(ReviewText.operation(item.op).capitalized) by \(item.agentName)")
                            .font(Theme.font(14, weight: .medium))
                        Text(line(item)).font(Theme.font(11)).foregroundStyle(Theme.stone)
                        if let reason = item.reason, !reason.isEmpty {
                            Text(reason).font(Theme.font(12)).foregroundStyle(Theme.graphite)
                        }
                        if item.canUndo {
                            Button("Undo") { Task { await undo(item) } }
                                .font(Theme.font(13, weight: .medium)).foregroundStyle(Theme.tealDark)
                                .padding(.top, 2)
                        }
                        if item.canClear {
                            Button("Allow again") { Task { await clear(item) } }
                                .font(Theme.font(13, weight: .medium)).foregroundStyle(Theme.tealDark)
                                .padding(.top, 2)
                        }
                    }
                }
            }
            .padding(22)
        }
        .background(RuledPaper().ignoresSafeArea())
        .navigationTitle("Activity")
        .background(Theme.ground.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func line(_ item: ActivityItem) -> String {
        let when = ReviewText.shortDate(item.undoneAt ?? item.decidedAt)
        return [name(item), outcome(item), item.tier, when].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func name(_ item: ActivityItem) -> String {
        ReviewText.sourceName(item.source, key: item.sourceName, guest: item.sourceGuest ?? false)
    }

    private func outcome(_ item: ActivityItem) -> String {
        switch item.status {
        case "approved": return item.decidedBy == "policy" ? "accepted by a rule" : "approved"
        case "rejected": return "declined"
        case "expired": return "expired"
        case "undone": return "undone"
        default: return item.status
        }
    }

    private func load() async {
        do {
            items = try await session.client().activity()
            loaded = true
        } catch {
            message = error.localizedDescription
        }
    }

    private func undo(_ item: ActivityItem) async {
        do {
            try await session.client().undo(item.id)
            message = "Undone."
            await load()
            await session.refreshToday()
        } catch {
            message = error.localizedDescription
        }
    }

    private func clear(_ item: ActivityItem) async {
        do {
            try await session.client().clearDecline(item.id)
            message = "\(name(item)) can propose it again."
            await load()
        } catch {
            message = error.localizedDescription
        }
    }
}
