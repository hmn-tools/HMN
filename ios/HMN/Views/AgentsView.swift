import SwiftUI

struct AgentsView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dynamicTypeSize) private var dynamicType
    @State private var proposals: [Proposal] = []
    @State private var message: String?
    @State private var editing = false
    @State private var title = ""
    @State private var due = ""
    @State private var reason = ""
    @State private var linkTo = ""
    @State private var linkRel = "about"
    @State private var loaded = false
    @State private var working = false
    @State private var decided: Decided?
    /// The last decision on a list from Review all. Its approvals can be taken back together.
    @State private var batch: BatchOutcome?

    /// The last decision on this screen.
    private struct Decided {
        var id: String
        var title: String
        var approved: Bool
    }

    /// The queue: what the owner can read first, then the Sealed proposals, so a closed vault blocks nothing.
    private var queue: [Proposal] { proposals.filter { !$0.redacted } + proposals.filter(\.redacted) }
    private var current: Proposal? { queue.first }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Review").font(Theme.title).tracking(-0.6)
                    Spacer()
                    SmallLabel(text: waitingLabel)
                }
                .padding(.horizontal, 4)
                if let proposal = current, proposal.redacted {
                    VStack(alignment: .leading, spacing: 12) {
                        SmallLabel(text: "\(proposal.agentName) · Sealed")
                        Text("Sealed").font(Theme.heading)
                        Text("It waits at the end of the queue. Open the vault to read it, then decide.")
                            .font(Theme.text).foregroundStyle(Theme.graphite)
                        Button("Open the vault") { Task { await openVault() } }
                            .buttonStyle(PillButtonStyle())
                    }
                    .card(padding: 20)
                } else if let proposal = current {
                    proposalCard(proposal)
                    HStack(spacing: 10) {
                        Button("Decline") { Task { await decide(proposal, approve: false) } }
                            .buttonStyle(PillButtonStyle(kind: .secondary))
                        Button("Approve") { Task { await decide(proposal, approve: true) } }
                            .buttonStyle(PillButtonStyle())
                    }
                    .disabled(working)
                } else if loaded {
                    EmptyState(title: "All clear.", text: "A new proposal shows here.")
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                }
                if let decided { decidedLine(decided) }
                if let batch { batchLine(batch) }
                if let message { MessageLine(text: message, isError: true) }
                HStack {
                    if let proposal = current, !proposal.redacted {
                        Button("Edit first") {
                            title = proposal.payload?.entity?.title ?? ""
                            due = proposal.payload?.entity?.dueAt ?? ""
                            reason = proposal.reason ?? ""
                            editing = true
                        }
                        .buttonStyle(TextButtonStyle())
                    }
                    Spacer()
                    // The queue stays one proposal at a time. A long queue from one source can be read as a list.
                    ForEach(groups, id: \.source) { group in
                        NavigationLink("Review all \(group.count)") {
                            BatchView(source: group.source, name: group.name) { outcome in
                                batch = outcome
                                decided = nil
                            }
                        }
                        .buttonStyle(TextButtonStyle())
                        .accessibilityLabel("Review all \(group.count) from \(group.name)")
                    }
                }
                .padding(.horizontal, 4)
                HStack(spacing: 24) {
                    NavigationLink("Activity") { ActivityView() }
                    NavigationLink("Rules") { RulesView() }
                    Spacer()
                }
                .buttonStyle(TextButtonStyle())
                .padding(.horizontal, 4)
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 16)
        }
        .background(Theme.ground.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .onAppear { Task { await reload() } }
        .refreshable { await reload() }
        .sheet(isPresented: $editing) { editSheet.themed() }
    }

    private var waitingLabel: String {
        current == nil ? "Nothing waiting" : "\(proposals.count) waiting"
    }

    /** Each source that has two or more waiting proposals, in the order of the queue. */
    private var groups: [(source: String, name: String, count: Int)] {
        var order: [String] = []
        var names: [String: String] = [:]
        var counts: [String: Int] = [:]
        for proposal in proposals {
            guard let source = proposal.source else { continue }
            if counts[source] == nil { order.append(source); names[source] = proposal.agentName }
            counts[source, default: 0] += 1
        }
        return order.filter { (counts[$0] ?? 0) > 1 }.map { (source: $0, name: names[$0] ?? $0, count: counts[$0] ?? 0) }
    }

    /// "Trip helper · new task", "Trip helper · change", "Trip helper · removal", "Trip helper · link".
    private func headline(_ proposal: Proposal) -> String {
        switch proposal.op {
        case "create": return "\(proposal.agentName) · new \(proposal.payload?.entity?.type.map { Words.type($0).lowercased() } ?? "item")"
        case "update": return "\(proposal.agentName) · change"
        case "delete": return "\(proposal.agentName) · removal"
        default: return "\(proposal.agentName) · link"
        }
    }

    private func proposalCard(_ proposal: Proposal) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                SmallLabel(text: headline(proposal))
                Spacer()
                SmallLabel(text: ReviewText.shortDate(proposal.createdAt))
            }
            Text(proposal.summary?.title ?? proposal.payload?.entity?.title ?? ReviewText.operation(proposal.op).capitalized)
                .font(Theme.heading)
                .tracking(-0.4)
            // The server says what an approval writes: the item, and each field that changes.
            if let summary = proposal.summary {
                ForEach(Array(summary.lines.enumerated()), id: \.offset) { _, line in
                    labeled(line.label) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(words(line.text, for: line.label)).font(Theme.text)
                            if let was = line.was {
                                Text("Was: \(words(was, for: line.label))").font(Theme.small).foregroundStyle(Theme.stone)
                            }
                        }
                    }
                }
                if let warning = summary.warning {
                    Text(warning)
                        .font(Theme.sans(14, weight: .semibold))
                        .foregroundStyle(Theme.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if let due = proposal.payload?.entity?.dueAt {
                labeled("Due") { Text(When.day(due)).font(Theme.text) }
            }
            if proposal.summary == nil, let links = proposal.payload?.links, !links.isEmpty {
                labeled("Links") {
                    HStack(spacing: 6) {
                        ForEach(Array(links.enumerated()), id: \.offset) { _, link in
                            Text(link.toId ?? "").font(Theme.small)
                                .padding(.horizontal, 10).padding(.vertical, 3)
                                .background(link.toType == "person" ? Theme.tealTint : Theme.ground)
                                .foregroundStyle(link.toType == "person" ? Theme.tealDark : Theme.ink)
                                .clipShape(Capsule())
                        }
                    }
                }
            }
            if let reason = proposal.reason {
                labeled("Why") { Text(reason).font(Theme.text).foregroundStyle(Theme.graphite) }
            }
            if let summary = proposal.readSet?.summary {
                labeled("Read") { Text(summary).font(Theme.text).foregroundStyle(Theme.graphite) }
            }
            if let journalId = proposal.readSet?.journalId {
                NavigationLink("Journal") { JournalView(id: journalId) }
                    .buttonStyle(TextButtonStyle())
            }
        }
        .card(padding: 18)
    }

    /// A stored value in words: a tier, a status, or a kind as a word, and a date as the app writes dates.
    private func words(_ text: String, for label: String) -> String {
        switch label.lowercased() {
        case "tier", "status", "kind", "area", "type": return Words.id(text)
        case "due", "date", "starts", "ends": return When.day(text)
        default: return text
        }
    }

    /// The label sits beside its value. At the largest text sizes it sits above, so that no word splits.
    private func labeled<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        Group {
            if dynamicType >= .accessibility1 {
                VStack(alignment: .leading, spacing: 4) {
                    SmallLabel(text: label)
                    value()
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    SmallLabel(text: label).frame(width: 66, alignment: .leading)
                    value()
                }
            }
        }
    }

    /// The result of the last decision. An approval can be taken back here.
    private func decidedLine(_ item: Decided) -> some View {
        HStack(spacing: 12) {
            Text("\(item.approved ? "Approved" : "Declined"): \(item.title)").font(Theme.text).lineLimit(1)
            Spacer(minLength: 0)
            if item.approved {
                Button("Undo") { Task { await undo(item) } }
                    .font(Theme.sans(13, weight: .semibold))
                    .foregroundStyle(Theme.tealDark)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(Theme.card)
                    .clipShape(Capsule())
            }
        }
        .padding(.leading, 18)
        .padding(.trailing, item.approved ? 4 : 18)
        .frame(minHeight: 52)
        .background(Theme.tealTint)
        .clipShape(Capsule())
    }

    /// "4 approved." with Undo all, after a list from Review all.
    private func batchLine(_ outcome: BatchOutcome) -> some View {
        HStack(spacing: 12) {
            Text(outcome.label).font(Theme.text).lineLimit(2)
            Spacer(minLength: 0)
            if outcome.approved && !outcome.ids.isEmpty {
                Button(working ? "Undoing" : "Undo all") { Task { await undoAll(outcome) } }
                    .font(Theme.sans(13, weight: .semibold))
                    .foregroundStyle(Theme.tealDark)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(Theme.card)
                    .clipShape(Capsule())
                    .disabled(working)
            }
        }
        .padding(.leading, 18)
        .padding(.trailing, outcome.approved ? 4 : 18)
        .frame(minHeight: 52)
        .background(Theme.tealTint)
        .clipShape(Capsule())
    }

    private var editSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    editField("Title", text: $title)
                    VStack(alignment: .leading, spacing: 6) {
                        SmallLabel(text: "Due")
                        DateField(value: $due)
                    }
                    editField("Reason", text: $reason)
                    if let message { MessageLine(text: message, isError: true) }
                }
                .padding(16)
            }
            .navigationTitle("Edit first")
            .background(Theme.ground.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { editing = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await saveEdit() } }
                }
            }
        }
    }

    private func editField(_ label: String, text: Binding<String>, hint: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SmallLabel(text: label)
            TextField(hint: hint ?? label, text: text, axis: .vertical).textFieldStyle(FieldStyle())
        }
    }

    private func reload() async {
        do {
            proposals = try await session.client().proposals().filter { $0.status == "pending" }
            session.waiting = proposals.filter { !$0.redacted }.count
            message = nil
        } catch is URLError {
            message = "Your HMN did not answer."
        } catch {
            message = error.localizedDescription
        }
        loaded = true
    }

    private func undo(_ item: Decided) async {
        do {
            try await session.client().undo(item.id)
            decided = nil
            await reload()
            await session.refreshToday()
        } catch {
            message = error.localizedDescription
        }
    }

    private func openVault() async {
        do {
            try await session.openVault()
            await reload()
        } catch {
            message = error.localizedDescription
        }
    }

    /// Take back each approval of the last list. One that cannot change says so.
    private func undoAll(_ outcome: BatchOutcome) async {
        guard !working else { return }
        working = true
        defer { working = false }
        var failed = 0
        for id in outcome.ids {
            do { try await session.client().undo(id) } catch { failed += 1 }
        }
        batch = nil
        message = failed == 0 ? nil : "\(failed) could not be taken back. Activity has each one."
        await reload()
        await session.refreshToday()
    }

    private func decide(_ proposal: Proposal, approve: Bool) async {
        // One decision at a time, so that a second tap does not decide the next proposal.
        guard !working else { return }
        working = true
        defer { working = false }
        do {
            if approve { _ = try await session.client().approve(proposal.id) }
            else { _ = try await session.client().reject(proposal.id) }
            decided = Decided(id: proposal.id, title: proposal.summary?.title ?? proposal.payload?.entity?.title ?? ReviewText.operation(proposal.op), approved: approve)
            await reload()
            await session.refreshToday()
        } catch {
            message = error.localizedDescription
        }
    }

    private func saveEdit() async {
        guard let proposal = current else { return }
        do {
            var links = proposal.payload?.links?.map { ["rel": $0.rel ?? "about", "to_type": $0.toType ?? "", "to_id": $0.toId ?? ""] } ?? []
            if !linkTo.isEmpty { links.append(["rel": linkRel, "to_type": "note", "to_id": linkTo]) }
            _ = try await session.client().editProposal(proposal.id, title: title, due: due, reason: reason, links: links)
            editing = false
            await reload()
        } catch {
            message = error.localizedDescription
        }
    }
}

