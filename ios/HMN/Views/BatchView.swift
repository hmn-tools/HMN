import SwiftUI

/** Every waiting proposal from one source, as a list. One decision covers the rows that are ticked. */
struct BatchView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    let source: String
    let name: String
    @State private var proposals: [Proposal] = []
    @State private var picked: Set<String> = []
    @State private var message: String?
    @State private var working = false
    @State private var loaded = false

    private var readable: [Proposal] { proposals.filter { !$0.redacted } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                SmallLabel(text: "\(name) · \(proposals.count) waiting")
                Text("Decide the list.").font(Theme.font(22, weight: .semibold))
                Text("Unticked items stay in the queue.")
                    .font(Theme.font(12)).foregroundStyle(Theme.graphite)
                if let message { Text(message).font(Theme.font(12)).foregroundStyle(Theme.graphite) }
                if loaded && proposals.isEmpty {
                    Text("Nothing is waiting from \(name).").font(Theme.font(14)).foregroundStyle(Theme.graphite).padding(.top, 8)
                }
                if readable.count > 1 {
                    Button(picked.count == readable.count ? "Untick all" : "Tick all") {
                        picked = picked.count == readable.count ? [] : Set(readable.map(\.id))
                    }
                    .font(Theme.font(13, weight: .medium)).foregroundStyle(Theme.tealDark)
                }
                VStack(spacing: 0) {
                    ForEach(proposals) { proposal in row(proposal) }
                }
                if !readable.isEmpty {
                    HStack(spacing: 12) {
                        Button("Decline \(picked.count)") { Task { await decide(approve: false) } }
                            .buttonStyle(InkButtonStyle(filled: false))
                        Button("Approve \(picked.count)") { Task { await decide(approve: true) } }
                            .buttonStyle(InkButtonStyle(filled: true))
                    }
                    .disabled(picked.isEmpty || working)
                    .opacity(picked.isEmpty || working ? 0.4 : 1)
                    .padding(.top, 8)
                }
            }
            .padding(22)
        }
        .background(RuledPaper().ignoresSafeArea())
        .navigationTitle("Review")
        .background(Theme.ground.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .task { await load(tickAll: true) }
    }

    private func row(_ proposal: Proposal) -> some View {
        Button {
            guard !proposal.redacted else { return }
            if picked.contains(proposal.id) { picked.remove(proposal.id) } else { picked.insert(proposal.id) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: proposal.redacted ? "lock" : picked.contains(proposal.id) ? "checkmark.square.fill" : "square")
                    .font(.system(size: 18))
                    .foregroundStyle(proposal.redacted ? Theme.stone : Theme.ink)
                VStack(alignment: .leading, spacing: 2) {
                    Text(proposal.redacted ? "A sealed proposal" : proposal.summary?.title ?? proposal.payload?.entity?.title ?? ReviewText.operation(proposal.op).capitalized)
                        .font(Theme.font(14, weight: .medium)).foregroundStyle(Theme.ink)
                        .multilineTextAlignment(.leading)
                    Text(detail(proposal)).font(Theme.font(11)).foregroundStyle(Theme.stone)
                        .multilineTextAlignment(.leading)
                    if let warning = proposal.summary?.warning, !proposal.redacted {
                        Text(warning).font(Theme.font(12, weight: .medium)).foregroundStyle(Theme.danger)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { Theme.hair.frame(height: 1) }
        }
        .accessibilityLabel(proposal.summary?.title ?? proposal.payload?.entity?.title ?? "Proposal")
        .accessibilityValue(picked.contains(proposal.id) ? "ticked" : "not ticked")
    }

    private func detail(_ proposal: Proposal) -> String {
        if proposal.redacted { return "Sealed. Open the vault to read it." }
        var parts = [ReviewText.operation(proposal.op), proposal.payload?.entity?.type].compactMap { $0 }
        if let summary = proposal.summary {
            // Each field that the approval writes, as the server names it.
            parts += summary.lines.map { line in
                line.was.map { "\(line.label.lowercased()) \(line.text) (was \($0))" } ?? "\(line.label.lowercased()) \(line.text)"
            }
        } else {
            parts.append(proposal.tier)
            if let due = proposal.payload?.entity?.dueAt { parts.append("due \(due.prefix(10))") }
        }
        return parts.joined(separator: " · ")
    }

    private func load(tickAll: Bool) async {
        do {
            proposals = try await session.client().pending(source: source)
            loaded = true
            let ids = Set(readable.map(\.id))
            // A new item starts with a tick. A change, a removal, and a link change start with none, so the owner reads each one.
            let additions = Set(readable.filter { $0.op == "create" || $0.op == "link" }.map(\.id))
            picked = tickAll ? additions : picked.intersection(ids)
        } catch {
            message = error.localizedDescription
        }
    }

    private func decide(approve: Bool) async {
        // The server takes at most 200 ids in one decision.
        let ids = Array(readable.map(\.id).filter { picked.contains($0) }.prefix(200))
        guard !ids.isEmpty else { return }
        working = true
        defer { working = false }
        do {
            let result = try await session.client().decideBatch(approve: approve, source: source, ids: ids)
            let verb = approve ? "approved" : "declined"
            message = result.failed == 0 ? "\(result.decided) \(verb)." : "\(result.decided) \(verb). \(result.failed) did not change."
            await load(tickAll: false)
            await session.refreshToday()
            if proposals.isEmpty { dismiss() }
        } catch {
            message = error.localizedDescription
        }
    }
}
