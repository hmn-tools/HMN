import SwiftUI

/// What the agents asked for and did not have. A request grants nothing: more access is a change in
/// Agents and apps, made by the owner. The text is the agent's, so it shows as plain data.
struct AgentRequestsView: View {
    @EnvironmentObject private var session: Session
    @State private var requests: [AgentRequest] = []
    @State private var showClosed = false
    @State private var loaded = false
    @State private var message: String?

    private var shown: [AgentRequest] { requests.filter { showClosed || $0.status == "open" } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("What your agents asked for. A request changes nothing and grants nothing.")
                    .font(Theme.text).foregroundStyle(Theme.graphite)
                    .fixedSize(horizontal: false, vertical: true)
                if !loaded { LoadingState() }
                if loaded && shown.isEmpty {
                    EmptyState(title: "Nothing asked.", text: "When an agent needs a tool or a field, it says so here.")
                }
                ForEach(shown) { request in card(request) }
                if let message { MessageLine(text: message, isError: true) }
                if loaded && requests.contains(where: { $0.status != "open" }) {
                    Toggle("Show closed", isOn: $showClosed).font(Theme.text).tint(Theme.tealDark).padding(.horizontal, 4)
                }
            }
            .padding(16)
        }
        .background(Theme.ground.ignoresSafeArea())
        .navigationTitle("Requests")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func card(_ request: AgentRequest) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                SmallLabel(text: request.asks > 1 ? "\(request.agentName) · asked \(request.asks) times" : request.agentName)
                Spacer()
                SmallLabel(text: When.day(request.updatedAt))
            }
            Text(request.need).font(Theme.heading).fixedSize(horizontal: false, vertical: true)
            Text(request.why).font(Theme.text).foregroundStyle(Theme.graphite).fixedSize(horizontal: false, vertical: true)
            if let example = request.example {
                Text(example).font(Theme.small).foregroundStyle(Theme.stone).fixedSize(horizontal: false, vertical: true)
            }
            if request.status == "open" {
                HStack(spacing: 10) {
                    Button("Dismiss") { Task { await set(request, "dismissed") } }.buttonStyle(PillButtonStyle(kind: .secondary))
                    Button("Done") { Task { await set(request, "done") } }.buttonStyle(PillButtonStyle())
                }
            } else {
                Text(request.status == "done" ? "Done." : "Dismissed.").font(Theme.small).foregroundStyle(Theme.stone)
            }
        }
        .card(padding: 18)
    }

    private func load() async {
        do {
            requests = try await session.client().agentRequests()
            message = nil
        } catch {
            message = error.localizedDescription
        }
        loaded = true
    }

    private func set(_ request: AgentRequest, _ status: String) async {
        do {
            try await session.client().setAgentRequest(request.id, status: status)
            await load()
        } catch {
            message = error.localizedDescription
        }
    }
}
