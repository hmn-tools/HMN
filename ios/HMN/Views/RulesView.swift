import SwiftUI

/** Review is the default. A rule lets one worker or one plugin write with no review, or stops a source. */
struct RulesView: View {
    @EnvironmentObject private var session: Session
    @State private var policy: PolicyList?
    @State private var message: String?

    @State private var removing: PolicyRule?
    @State private var failed = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Review is the default.").font(Theme.heading)
                    Text("Auto lets a source write with no review. Undo is in Activity.")
                        .font(Theme.text).foregroundStyle(Theme.graphite)
                }
                .padding(.horizontal, 4)
                if let message { MessageLine(text: message, isError: failed) }
                if let policy {
                    VStack(spacing: 0) {
                        let sources = policy.sources.sorted { (ReviewText.rank($0.source), $0.source) < (ReviewText.rank($1.source), $1.source) }
                        ForEach(sources) { source in
                            sourceRow(source, policy)
                            if source.id != sources.last?.id { Theme.rule.frame(height: 1).padding(.leading, Theme.Space.l) }
                        }
                    }
                    .card(padding: 0)
                    let fine = policy.rules.filter { !isWhole($0) }
                    if !fine.isEmpty {
                        SmallLabel(text: "Other rules").padding(.top, 8)
                        VStack(spacing: 0) {
                            ForEach(fine) { rule in
                                HStack(alignment: .center) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("\(name(rule.source)) · \(rule.mode)").font(Theme.row)
                                        Text(scope(rule)).font(Theme.small).foregroundStyle(Theme.stone)
                                    }
                                    Spacer()
                                    Button("Remove") { removing = rule }.buttonStyle(TextButtonStyle(danger: true))
                                }
                                .padding(.horizontal, Theme.Space.l)
                                .frame(minHeight: 60)
                                if rule.id != fine.last?.id { Theme.rule.frame(height: 1).padding(.leading, Theme.Space.l) }
                            }
                        }
                        .card(padding: 0)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        SmallLabel(text: "Always waits for you")
                        Text("Removals, tier and area changes, Sealed data, outside agents.")
                            .font(Theme.small).foregroundStyle(Theme.graphite)
                    }
                    .padding(.horizontal, 4)
                    .padding(.top, 8)
                } else if message == nil {
                    LoadingState()
                }
            }
            .padding(22)
        }
        .navigationTitle("Rules")
        .background(Theme.ground.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .confirmationDialog("Remove this rule?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                if let rule = removing { Task { await remove(rule) } }
                removing = nil
            }
            Button("Cancel", role: .cancel) { removing = nil }
        } message: {
            Text("That source goes back to its other rules.")
        }
    }

    private func sourceRow(_ source: PolicySource, _ policy: PolicyList) -> some View {
        let current = mode(for: source.source, in: policy)
        return VStack(alignment: .leading, spacing: 6) {
            Text(name(source.source)).font(Theme.row)
            Text(note(source, policy)).font(Theme.small).foregroundStyle(Theme.stone).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                choice("Review", "review", current, source)
                if source.canAuto { choice("Auto", "auto", current, source) }
                choice("Deny", "deny", current, source)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, 12)
    }

    private func choice(_ label: String, _ value: String, _ current: String, _ source: PolicySource) -> some View {
        Button(label) { Task { await set(source.source, value) } }
            .buttonStyle(ChipButtonStyle(selected: current == value))
            .accessibilityValue(current == value ? "selected" : "")
    }

    /** A rule for the whole source: every operation, every type, every tier. */
    private func isWhole(_ rule: PolicyRule) -> Bool {
        rule.op == "*" && rule.entityType == "*" && rule.tier == "*" && rule.source != "*"
    }

    private func mode(for source: String, in policy: PolicyList) -> String {
        if let own = policy.rules.first(where: { $0.source == source && isWhole($0) }) { return own.mode }
        return policy.defaults.contains(where: { $0.source == source && $0.mode == "auto" }) ? "default" : "review"
    }

    private func note(_ source: PolicySource, _ policy: PolicyList) -> String {
        let kind = ReviewText.sourceKind(source.source)
        if mode(for: source.source, in: policy) == "default" {
            return "\(kind) · new and changed events are accepted with no review, unless you choose here"
        }
        return source.canAuto ? kind : "\(kind) · cannot be set to Auto"
    }

    private func scope(_ rule: PolicyRule) -> String {
        [rule.op == "*" ? "every operation" : ReviewText.operation(rule.op),
         rule.entityType == "*" ? "every type" : rule.entityType,
         rule.tier == "*" ? "every tier" : rule.tier].joined(separator: " · ")
    }

    /** The name of a source. For a key, the list from the server has the name that the owner gave it. */
    private func name(_ source: String) -> String {
        let known = policy?.sources.first { $0.source == source }
        return ReviewText.sourceName(source, key: known?.sourceName, guest: known?.sourceGuest ?? false)
    }

    private func load() async {
        do { policy = try await session.client().policy() }
        catch { message = error.localizedDescription; failed = true }
    }

    private func set(_ source: String, _ mode: String) async {
        do {
            try await session.client().setPolicy(source: source, mode: mode)
            message = "\(name(source)) is set to \(mode)."
            failed = false
            await load()
        } catch {
            message = error.localizedDescription
            failed = true
        }
    }

    private func remove(_ rule: PolicyRule) async {
        do {
            try await session.client().removePolicy(rule.id)
            message = "Removed."
            failed = false
            await load()
        } catch {
            message = error.localizedDescription
            failed = true
        }
    }
}
