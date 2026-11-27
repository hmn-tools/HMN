import SwiftUI

/**
 One key for each agent, and one for each view. An agent key reads up to Personal and can only propose.
 A view key reads, and it cannot propose. Private is a grant for one agent key, and it has an end date.
 */
struct KeysView: View {
    @EnvironmentObject private var session: Session
    @State private var keys: [AgentKey] = []
    @State private var maxDays = 90
    @State private var message: String?
    @State private var name = ""
    @State private var isView = false
    @State private var working = false
    @State private var loaded = false
    @State private var revoking: AgentKey?
    @State private var ending: AgentKey?
    @State private var granting: AgentKey?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if !loaded && message == nil { LoadingState() }
                if let message { MessageLine(text: message) }
                if loaded && active.isEmpty { EmptyState(title: "No keys yet.") }
                ForEach(active) { key in card(key) }
                SmallLabel(text: "New key").padding(.top, 10)
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 6) {
                        Button("Agent") { isView = false }.buttonStyle(ChipButtonStyle(selected: !isView))
                            .accessibilityAddTraits(!isView ? [.isSelected] : [])
                        Button("View") { isView = true }.buttonStyle(ChipButtonStyle(selected: isView))
                            .accessibilityAddTraits(isView ? [.isSelected] : [])
                    }
                    Text(isView ? "Reads Public only. For a screen." : "Reads up to Personal, and proposes.")
                        .font(Theme.small).foregroundStyle(Theme.stone)
                    TextField(hint: isView ? "kitchen" : "research", text: $name)
                        .textFieldStyle(FieldStyle())
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Make the key") { Task { await create() } }
                        .buttonStyle(PillButtonStyle())
                        .disabled(name.isEmpty || working)
                }
                .card()
            }
            .padding(16)
        }
        .background(Theme.ground.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: Binding(get: { granting != nil }, set: { if !$0 { granting = nil } })) {
            if let key = granting { GrantView(key: key, maxDays: maxDays) }
        }
        .confirmationDialog("Revoke this key?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
            Button("Revoke", role: .destructive) {
                if let key = revoking { Task { await revoke(key) } }
                revoking = nil
            }
            Button("Cancel", role: .cancel) { revoking = nil }
        } message: {
            Text("\(revoking.map(shown) ?? "The key") stops at once.")
        }
        .confirmationDialog("End Private now?", isPresented: Binding(get: { ending != nil }, set: { if !$0 { ending = nil } }), titleVisibility: .visible) {
            Button("End Private", role: .destructive) {
                if let key = ending { Task { await endPrivate(key) } }
                ending = nil
            }
            Button("Cancel", role: .cancel) { ending = nil }
        } message: {
            Text("\(ending?.name ?? "The agent") reads up to Personal again.")
        }
        .onAppear { Task { await load() } }
    }

    /// A revoked or ended key is history, and it is not listed.
    private var active: [AgentKey] { keys.filter { $0.state == "active" } }

    private func card(_ key: AgentKey) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                NavigationLink {
                    AgentPageView(key: key)
                } label: {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(shown(key)).font(Theme.row).foregroundStyle(Theme.ink)
                            Text(line(key)).font(Theme.small).foregroundStyle(Theme.stone)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Menu {
                    if !readsOnly(key) {
                        if key.ceiling == "private" {
                            Button("End Private") { ending = key }
                        } else if key.ceiling == "personal" {
                            Button("Give Private for a time") { granting = key }
                        }
                    }
                    Button(key.freeBusy == true ? "Stop busy times" : "Give busy times") { Task { await setFreeBusy(key) } }
                    Button("Revoke", role: .destructive) { revoking = key }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.ink)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Actions for \(shown(key))")
            }
            if key.ceiling == "private" {
                Text("Private until \(ReviewText.day(key.privateUntil))").font(Theme.small).foregroundStyle(Theme.tealDark)
            }
            if let maker = key.madeBy {
                Text("Made by \(maker.name)").font(Theme.small).foregroundStyle(Theme.stone)
            }
        }
        .card()
    }

    /// The server puts `external:` before the name of an outside client. The line under the name says where the key runs.
    private func shown(_ key: AgentKey) -> String {
        key.name.hasPrefix("external:") ? String(key.name.dropFirst("external:".count)) : key.name
    }

    private func readsOnly(_ key: AgentKey) -> Bool { key.scope == "read" }

    private func line(_ key: AgentKey) -> String {
        // The kind of key, the tier it reads, its end, and its last use. A local agent key needs no kind word.
        var parts: [String] = []
        if readsOnly(key) { parts.append("View") } else if key.guest == true { parts.append("Guest") } else if key.outside { parts.append("Outside") }
        parts.append(Words.id(key.ceiling))
        if key.freeBusy == true { parts.append("busy times") }
        if key.state != "active" { parts.append(key.state) }
        else if let ends = key.expiresAt { parts.append("ends \(ReviewText.day(ends))") }
        parts.append(key.lastUsedAt.map { "used \(ReviewText.shortDate($0))" } ?? "not used yet")
        return parts.joined(separator: " · ")
    }

    private func load() async {
        do {
            let list = try await session.client().agentKeys()
            keys = list.keys
            maxDays = list.privateDaysMax
            loaded = true
        } catch {
            message = error.localizedDescription
        }
    }

    private func create() async {
        working = true
        defer { working = false }
        do {
            let made = try await session.client().createAgentKey(name: name.trimmingCharacters(in: .whitespaces).lowercased(), view: isView)
            message = made.keychainItem.map { "Made. Saved as \($0)." } ?? "Made."
            name = ""
            isView = false
            await load()
        } catch {
            message = error.localizedDescription
        }
    }

    private func endPrivate(_ key: AgentKey) async {
        do {
            _ = try await session.client().endPrivate(key.id)
            message = "\(shown(key)) reads up to Personal again."
            await load()
        } catch {
            message = error.localizedDescription
        }
    }

    private func setFreeBusy(_ key: AgentKey) async {
        let next = !(key.freeBusy ?? false)
        do {
            _ = try await session.client().changeKey(key.id, fields: ["free_busy": next])
            message = next
                ? "\(shown(key)) sees when you are busy."
                : "\(shown(key)) no longer sees when you are busy."
            await load()
        } catch {
            message = error.localizedDescription
        }
    }

    private func revoke(_ key: AgentKey) async {
        do {
            try await session.client().revokeConnection(key.id)
            message = "\(shown(key)) is revoked."
            await load()
        } catch {
            message = error.localizedDescription
        }
    }
}

/** The owner reads what Private adds, from the real graph, and then gives the grant with an end date. */
struct GrantView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    let key: AgentKey
    let maxDays: Int
    @State private var preview: KeyPreview?
    @State private var days = 30
    @State private var message: String?
    @State private var working = false

    private var choices: [Int] { [7, 30, 90].filter { $0 <= maxDays } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let preview {
                    VStack(alignment: .leading, spacing: 6) {
                        SmallLabel(text: "Private for \(key.name)")
                        Text(headline(preview)).font(Theme.heading)
                        Text(breakdown(preview)).font(Theme.text).foregroundStyle(Theme.graphite)
                        ForEach(Array(preview.examples.enumerated()), id: \.offset) { _, item in
                            Text("\(item.title) · \(Words.type(item.type))").font(Theme.text)
                        }
                    }
                    .card()
                    VStack(alignment: .leading, spacing: 6) {
                        SmallLabel(text: "Stays closed")
                        Text(ReviewText.list(preview.stillClosed) + ".").font(Theme.text).foregroundStyle(Theme.graphite)
                        SmallLabel(text: "Know this").padding(.top, 6)
                        ForEach(preview.warnings, id: \.self) { line in
                            Text(line).font(Theme.text)
                        }
                    }
                    .card()
                    HStack(spacing: 8) {
                        ForEach(choices, id: \.self) { value in
                            Button("\(value) days") { days = value }
                                .buttonStyle(ChipButtonStyle(selected: days == value))
                                .accessibilityValue(days == value ? "selected" : "")
                        }
                    }
                    Button("Give Private for \(days) days") { Task { await give() } }
                        .buttonStyle(PillButtonStyle())
                        .disabled(working)
                }
                if let message { Text(message).font(Theme.font(12)).foregroundStyle(Theme.graphite) }
            }
            .padding(16)
        }
        .navigationTitle("Give Private")
        .background(Theme.ground.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func headline(_ preview: KeyPreview) -> String {
        preview.adds == 1 ? "Private adds 1 row." : "Private adds \(preview.adds) rows."
    }

    private func breakdown(_ preview: KeyPreview) -> String {
        let parts = preview.byType.sorted { $0.value > $1.value || ($0.value == $1.value && $0.key < $1.key) }.map { ReviewText.counted($0.value, $0.key) }
        let now = "It reads \(preview.readsNow) rows now."
        return parts.isEmpty ? now : "\(parts.joined(separator: ", ")). \(now)"
    }

    private func load() async {
        do { preview = try await session.client().keyPreview(key.id) }
        catch { message = error.localizedDescription }
    }

    private func give() async {
        working = true
        defer { working = false }
        do {
            _ = try await session.client().grantPrivate(key.id, days: days)
            dismiss()
        } catch {
            message = error.localizedDescription
        }
    }
}
