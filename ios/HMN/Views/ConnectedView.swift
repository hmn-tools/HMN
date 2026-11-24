import SwiftUI

struct ConnectedView: View {
    @EnvironmentObject private var session: Session
    @State private var connections: [Connection] = []
    @State private var loaded = false
    @State private var message: String?
    @State private var also: String?
    @State private var revoking: Connection?
    /// The credential of this phone. It is not offered for revoke here: Settings pairs the phone again.
    @State private var myId: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let message { MessageLine(text: message, isError: true) }
                if let also { MessageLine(text: also) }
                if loaded && live.isEmpty { EmptyState(title: "Nothing connected.") }
                ForEach(live) { item in card(item) }
            }
            .padding(22)
        }
        .navigationTitle("Connected")
        .background(Theme.ground.ignoresSafeArea())
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog("Revoke \(revoking.map { Self.shownName($0) } ?? "this")?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
            Button("Revoke", role: .destructive) {
                if let item = revoking { Task { await revoke(item.id) } }
                revoking = nil
            }
            Button("Cancel", role: .cancel) { revoking = nil }
        } message: {
            Text("It stops at once.")
        }
    }

    /// A revoked connection is history, and it is not listed.
    private var live: [Connection] { connections.filter { !$0.revoked } }

    private func card(_ item: Connection) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(Self.shownName(item)).font(Theme.row)
                        if item.id == myId {
                            Text("This phone").font(Theme.small).foregroundStyle(Theme.tealDark)
                        }
                    }
                    Text(line(item)).font(Theme.small).foregroundStyle(Theme.stone)
                }
                Spacer()
                if canRevoke(item) {
                    Button("Revoke") { revoking = item }.buttonStyle(TextButtonStyle(danger: true))
                }
            }
            ForEach(item.reads.prefix(3)) { read in
                Text("Read \(read.title ?? read.type) · \(ReviewText.shortDate(read.at))")
                    .font(Theme.small).foregroundStyle(Theme.graphite)
                    .lineLimit(1)
            }
        }
        .card()
    }

    /// The owner key runs the menu bar, and this phone is the one in your hand. Neither is revoked from here.
    private func canRevoke(_ item: Connection) -> Bool {
        item.revocable && item.id != myId && Self.kind(item) != "Owner key"
    }

    private func line(_ item: Connection) -> String {
        let used = item.lastAccess.map { "used \(ReviewText.shortDate($0))" } ?? "not used yet"
        return [Self.kind(item), item.tierCap.capitalized, used].joined(separator: " · ")
    }

    /// The server names a key "mcp" whether it is the owner key, an agent key, or an outside client.
    static func kind(_ item: Connection) -> String {
        switch item.kind {
        case "guest": return "Guest"
        case "device": return "Phone"
        case "view": return "View"
        case "trmnl": return "Display"
        case "plugin": return "Plugin"
        default:
            if item.scopes.contains("write") { return "Owner key" }
            if item.name.hasPrefix("external:") { return "Outside" }
            return "Agent"
        }
    }

    static func shownName(_ item: Connection) -> String {
        item.name.hasPrefix("external:") ? String(item.name.dropFirst("external:".count)) : item.name
    }

    private func load() async {
        do {
            connections = try await session.client().connections()
            myId = try? await session.client().me().credential.id
            message = nil
        } catch {
            message = error.localizedDescription
        }
        loaded = true
    }

    private func revoke(_ id: String) async {
        do {
            let result = try await session.client().revokeConnection(id)
            await load()
            let names = (result.alsoRevoked ?? []).map(\.name)
            also = names.isEmpty ? nil : "Also revoked: \(names.joined(separator: ", "))."

        } catch {
            message = error.localizedDescription
        }
    }
}

struct JournalView: View {
    @EnvironmentObject private var session: Session
    let id: String
    @State private var entry: JournalEntry?
    @State private var message = "Not available."

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let entry {
                    Text(entry.name).font(Theme.font(18, weight: .semibold))
                    Text("\(entry.at) · \(entry.model)").font(Theme.font(12)).foregroundStyle(Theme.stone)
                    Text(entry.why).font(Theme.font(13)).foregroundStyle(Theme.graphite)
                    Text("READ").font(Theme.font(10)).foregroundStyle(Theme.stone)
                    if entry.read.isEmpty { Text("Nothing to show.").font(Theme.font(12)).foregroundStyle(Theme.stone) }
                    ForEach(entry.read) { item in
                        Text(item.title).font(Theme.font(14))
                    }
                    Text("PROPOSED").font(Theme.font(10)).foregroundStyle(Theme.stone).padding(.top, 6)
                    if entry.proposed.isEmpty { Text("No proposal to show.").font(Theme.font(12)).foregroundStyle(Theme.stone) }
                    ForEach(entry.proposed) { item in
                        Text(item.title).font(Theme.font(14))
                        if let reason = item.reason {
                            Text(reason).font(Theme.font(12)).foregroundStyle(Theme.graphite)
                        }
                    }
                    if entry.hidden {
                        Text("Partly hidden.").font(Theme.font(12)).foregroundStyle(Theme.stone)
                    }
                } else {
                    Text(message).font(Theme.font(13)).foregroundStyle(Theme.graphite)
                }
            }
            .padding(22)
        }
        .navigationTitle("Journal")
        .background(Theme.ground.ignoresSafeArea())
        .task { await load() }
    }

    private func load() async {
        do { entry = try await session.client().journal(id) }
        catch { message = error.localizedDescription }
    }
}
