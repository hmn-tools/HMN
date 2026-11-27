import SwiftUI

/** What was decided: approved, accepted by a rule, declined, expired, and undone. Newest first. */
struct ActivityView: View {
    @EnvironmentObject private var session: Session
    @State private var items: [ActivityItem] = []
    @State private var message: String?
    @State private var loaded = false
    @State private var failed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if !loaded && message == nil { LoadingState() }
                if loaded && items.isEmpty { EmptyState(title: "Nothing decided yet.") }
                if let message { MessageLine(text: message, isError: failed) }
                if !items.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(items) { item in
                            row(item)
                            if item.id != items.last?.id { Theme.hair.frame(height: 1).padding(.leading, Theme.Space.l) }
                        }
                    }
                    .card(padding: 0)
                }
            }
            .padding(16)
        }
        .navigationTitle("Activity")
        .background(Theme.ground.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    /// One decision: what it was, who sent it, what happened, and its undo when there is one.
    private func row(_ item: ActivityItem) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.title ?? "\(ReviewText.operation(item.op).capitalized) by \(item.agentName)").font(Theme.row)
            Text(line(item)).font(Theme.small).foregroundStyle(Theme.stone)
            if let reason = item.reason, !reason.isEmpty {
                Text(reason).font(Theme.small).foregroundStyle(Theme.graphite).fixedSize(horizontal: false, vertical: true)
            }
            if item.canUndo || item.canClear {
                HStack(spacing: 20) {
                    if item.canUndo { Button("Undo") { Task { await undo(item) } }.buttonStyle(TextButtonStyle()) }
                    if item.canClear { Button("Allow again") { Task { await clear(item) } }.buttonStyle(TextButtonStyle()) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, 12)
    }

    private func line(_ item: ActivityItem) -> String {
        let when = ReviewText.shortDate(item.undoneAt ?? item.decidedAt)
        return [name(item), outcome(item), Words.id(item.tier), when].filter { !$0.isEmpty }.joined(separator: " · ")
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
            failed = true
            loaded = true
        }
    }

    private func undo(_ item: ActivityItem) async {
        do {
            try await session.client().undo(item.id)
            message = "Undone."
            failed = false
            await load()
            await session.refreshToday()
        } catch {
            message = error.localizedDescription
            failed = true
        }
    }

    private func clear(_ item: ActivityItem) async {
        do {
            try await session.client().clearDecline(item.id)
            message = "\(name(item)) can propose it again."
            failed = false
            await load()
        } catch {
            message = error.localizedDescription
            failed = true
        }
    }
}
