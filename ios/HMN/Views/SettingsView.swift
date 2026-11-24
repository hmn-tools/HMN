import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var message: String?
    @State private var spend: ModelSpend?
    @State private var hidden = false
    @State private var showPairing = false
    private let graph = ["area", "goal", "note", "event", "place", "asset", "source", "habit"]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if session.isPaired && !showPairing {
                        // A paired phone needs no fields. The address shows, and the fields open on request.
                        VStack(alignment: .leading, spacing: 6) {
                            SmallLabel(text: "Your HMN")
                            Text(hostLabel).font(Theme.row)
                            Button("Pair again") { showPairing = true }.buttonStyle(TextButtonStyle())
                        }
                        .card()
                    } else {
                        field("Address of your HMN", text: $session.serverURL)
                        field("Certificate fingerprint", text: $session.fingerprint)
                        codeField
                        Button("Pair this phone") { Task { await pair() } }.buttonStyle(PillButtonStyle())
                    }
                    if let message { MessageLine(text: message, isError: true) }
                    if hidden { HiddenNote() }
                    // Before a pairing, nothing below can load. The screen is only the pairing.
                    if session.isPaired {
                    group("People and agents") {
                        row("Household") { HouseholdView() }
                        row("Agents and apps", last: true) { AgentsAndAppsView() }
                    }
                    Text(spendLine).font(Theme.small).foregroundStyle(Theme.stone).padding(.horizontal, 4)
                    group("Your record") {
                        row("Calendars") { CalendarsView() }
                        row("Areas and kinds", last: true) { AreasView() }
                    }
                    group("Privacy") {
                        row("Who sees what") { PrivacyView() }
                        row("Audit log", last: true) { AuditView() }
                    }
                    group("The graph") {
                        ForEach(graph, id: \.self) { type in
                            row(type.capitalized + "s", last: type == graph.last) {
                                BrowseView(type: type, title: type.capitalized + "s", empty: "Nothing here yet.")
                            }
                        }
                    }
                    }
                }
                .padding(22)
            }
            .navigationTitle("Settings")
            .background(Theme.ground.ignoresSafeArea())
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .onDisappear { session.persistConnection() }
            .task {
                spend = try? await session.client().modelSpend()
                hidden = (try? await session.client().me())?.credential.forcedCeiling != nil
            }
        }
    }

    private var hostLabel: String {
        guard let url = URL(string: session.serverURL), let host = url.host else { return session.serverURL }
        return url.port.map { "\(host):\($0)" } ?? host
    }

    /// A titled card of rows.
    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SmallLabel(text: title)
            VStack(spacing: 0) { content() }
                .card(padding: 0)
        }
        .padding(.top, 4)
    }

    /// One row that opens a screen. The last row of a card has no line under it.
    private func row<Destination: View>(_ title: String, last: Bool = false, @ViewBuilder destination: @escaping () -> Destination) -> some View {
        NavigationLink(destination: destination) {
            VStack(spacing: 0) {
                HStack {
                    Text(title).font(Theme.row).foregroundStyle(Theme.ink)
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.stone)
                }
                .padding(.horizontal, Theme.Space.l)
                .frame(minHeight: 52)
                if !last { Theme.rule.frame(height: 1).padding(.leading, Theme.Space.l) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var spendLine: String {
        guard let spend else { return "No cloud spend yet." }
        if let notice = spend.notice { return notice }
        return String(format: "This month · %d tokens · $%.2f of $%.2f.", spend.tokens, spend.usd, spend.capUsd)
    }

    /// The code is capitals and digits. The keyboard gives capitals, so what the person types matches what the mini shows.
    private var codeField: some View {
        VStack(alignment: .leading, spacing: 6) {
            SmallLabel(text: "Pairing code")
            TextField("Pairing code", text: $code)
                .textFieldStyle(FieldStyle())
                .textInputAutocapitalization(.characters).autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .submitLabel(.go)
                .onSubmit { Task { await pair() } }
        }
    }

    private func field(_ label: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SmallLabel(text: label)
            TextField(label, text: text)
                .textFieldStyle(FieldStyle())
                .textInputAutocapitalization(.never).autocorrectionDisabled()
        }
    }

    private func pair() async {
        do {
            _ = try ServerAddress.parse(session.serverURL)
            let result = try await session.client().pair(code: code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(), name: "iPhone")
            try session.savePairing(secret: result.secret)
            session.setMember(result.member)
            message = nil
            code = ""
            // Today reads again when this sheet closes.
            session.showSettings = false
        } catch {
            message = error.localizedDescription
        }
    }
}

/// One screen for what reads your HMN from outside: the connected agents and apps, and the keys you made for them.
struct AgentsAndAppsView: View {
    @State private var part = "connected"

    var body: some View {
        Group {
            if part == "keys" { KeysView() } else { ConnectedView() }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack(spacing: 6) {
                Button("Connected") { part = "connected" }.buttonStyle(ChipButtonStyle(selected: part == "connected"))
                    .accessibilityAddTraits(part == "connected" ? [.isSelected] : [])
                Button("Keys") { part = "keys" }.buttonStyle(ChipButtonStyle(selected: part == "keys"))
                    .accessibilityAddTraits(part == "keys" ? [.isSelected] : [])
                Spacer()
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 8)
            .background(Theme.ground)
        }
        .navigationTitle("Agents and apps")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A hidden phone cannot show its own data again. Only the Mac that runs HMN can.
struct HiddenNote: View {
    var body: some View {
        Text("Hidden. Show your things again from the menu bar of your HMN.")
            .font(Theme.font(13)).foregroundStyle(Theme.graphite)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct PrivacyView: View {
    @EnvironmentObject private var session: Session
    @State private var hidden = false
    @State private var confirmHide = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                SmallLabel(text: "Who sees what")
                VStack(spacing: 0) {
                    line("Public", "Anyone: the lock screen, a guest agent.")
                    line("Household", "Your home: the fridge, your family.")
                    line("Personal", "This phone and its widget.")
                    line("Private", "This phone, unlocked.")
                    line("Sealed", "The vault. No agent reads it.", last: true)
                }
                .card(padding: 0)
                HStack(spacing: 8) {
                    Image(systemName: session.grant == nil ? "lock" : "lock.open").foregroundStyle(Theme.tealDark)
                    Text(session.grant == nil ? "The vault is closed." : "The vault is open for a few minutes.")
                        .font(Theme.text).foregroundStyle(Theme.graphite)
                }
                .padding(.top, 4)
                if hidden {
                    HiddenNote()
                } else {
                    Button("Hide this phone") { confirmHide = true }.buttonStyle(PillButtonStyle(kind: .secondary))
                }
            }
            .padding(22)
        }
        .navigationTitle("Privacy")
        .background(Theme.ground.ignoresSafeArea())
        .task { await readHidden() }
        .confirmationDialog("Hide this phone?", isPresented: $confirmHide, titleVisibility: .visible) {
            Button("Hide", role: .destructive) { Task { await session.hide(); await readHidden() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Only Public things show. Undo it from the menu bar of your HMN.")
        }
    }

    private func readHidden() async {
        hidden = (try? await session.client().me())?.credential.forcedCeiling != nil
    }

    private func line(_ name: String, _ text: String, last: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(Theme.row)
                Text(text).font(Theme.small).foregroundStyle(Theme.graphite)
            }
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
            .padding(.horizontal, Theme.Space.l)
            if !last { Theme.rule.frame(height: 1).padding(.leading, Theme.Space.l) }
        }
    }
}

struct AuditView: View {
    @EnvironmentObject private var session: Session
    @State private var entries: [AuditEntry] = []
    @State private var loaded = false
    @State private var message: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let message { MessageLine(text: message, isError: true) }
                if !loaded && message == nil { LoadingState() }
                if loaded && entries.isEmpty && message == nil { EmptyState(title: "Nothing yet.") }
                if !groups.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(Array(groups.enumerated()), id: \.element.first.id) { index, group in
                            row(group.first, count: group.count)
                            if index < groups.count - 1 { Theme.rule.frame(height: 1).padding(.leading, Theme.Space.l) }
                        }
                    }
                    .card(padding: 0)
                }
            }
            .padding(22)
        }
        .navigationTitle("Audit log")
        .background(Theme.ground.ignoresSafeArea())
        .task {
            do {
                entries = try await session.client().audit()
            } catch {
                message = error.localizedDescription
            }
            loaded = true
        }
    }

    /// Rows with the same action, tier, and surface in the same minute are one row with a count.
    private var groups: [(first: AuditEntry, count: Int)] {
        var out: [(first: AuditEntry, count: Int)] = []
        for entry in entries.prefix(300) {
            if let last = out.last, last.first.action == entry.action, last.first.tier == entry.tier,
               last.first.surface == entry.surface, last.first.at.prefix(16) == entry.at.prefix(16) {
                out[out.count - 1].count += 1
            } else {
                out.append((entry, 1))
            }
        }
        return out
    }

    private func row(_ entry: AuditEntry, count: Int) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(count > 1 ? "\(AuditView.word(entry.action)) ×\(count)" : AuditView.word(entry.action)).font(Theme.row)
                Text([ReviewText.shortDate(entry.at), entry.surface.map(AuditView.place)].compactMap { $0 }.joined(separator: " · "))
                    .font(Theme.small).foregroundStyle(Theme.stone)
            }
            Spacer()
            if let tier = entry.tier { Text(tier.capitalized).font(Theme.small).foregroundStyle(Theme.graphite) }
        }
        .padding(.horizontal, Theme.Space.l)
        .frame(minHeight: 56)
    }

    /// Where the request came from, in words.
    static func place(_ surface: String) -> String {
        switch surface {
        case "mcp": return "agent"
        case "api": return "API"
        case "lock": return "lock screen"
        case "external": return "outside"
        default: return surface
        }
    }

    /// The server writes short action codes. The list shows words.
    static func word(_ action: String) -> String {
        switch action {
        case "read": return "Read"
        case "write": return "Saved"
        case "approve": return "Approved"
        case "reject": return "Declined"
        case "undo": return "Undone"
        case "expire": return "Expired"
        case "grant": return "Vault opened"
        case "panic": return "Hidden"
        case "panic_clear": return "Shown again"
        case "pair": return "Paired"
        case "revoke": return "Revoked"
        case "rotate": return "New secret"
        case "restore": return "Restored"
        case "restore_prior_tip": return "Restore mark"
        case "auth_failure": return "Failed sign-in"
        case "tier_change": return "Tier changed"
        case "purge": return "Purged"
        case "key_create": return "Key made"
        case "key_change": return "Key changed"
        case "grant_private": return "Private given"
        case "end_private": return "Private ended"
        case "external": return "Outside client"
        case "clear_decline": return "Decline cleared"
        case "owner_recovered": return "New owner key"
        default: return action.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}
