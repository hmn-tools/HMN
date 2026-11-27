import SwiftUI

/**
 The page of one agent key, for the owner: its limits, what it can see now, the Today screen as it gets it,
 and what it did. It reads only. A proposal is decided in the Review tab, and a key is changed or revoked
 from the list of keys.
 */
struct AgentPageView: View {
    @EnvironmentObject private var session: Session
    let key: AgentKey
    @State private var scope: AgentScope?
    @State private var timeline: AgentTimeline?
    @State private var message: String?
    @State private var showToday = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                header
                if let message { MessageLine(text: message, isError: true) }
                if scope == nil && message == nil { LoadingState() }
                if let scope {
                    seeing(scope)
                    seeAs
                }
                if let timeline { did(timeline) }
                logRow
            }
            .padding(16)
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .background(Theme.ground.ignoresSafeArea())
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showToday) { AgentTodaySheet(key: key, name: name) }
    }

    private var name: String {
        key.name.hasPrefix("external:") ? String(key.name.dropFirst("external:".count)) : key.name
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(name).font(Theme.heading)
            Text("Sees up to \(Words.id(key.ceiling))").font(Theme.row)
            ForEach(limits, id: \.self) { line in
                Text(line).font(Theme.text).foregroundStyle(Theme.graphite)
            }
            Text(ends).font(Theme.small).foregroundStyle(Theme.stone)
        }
        .card()
    }

    /// The limits of the key, in words.
    private var limits: [String] {
        var lines: [String] = []
        if let areas = key.allowAreas {
            let titles = areas.compactMap { id in scope?.byArea.first { $0.areaId == id }?.title }
            lines.append(titles.isEmpty ? "Only \(ReviewText.counted(areas.count, "area"))." : "Only these areas: \(ReviewText.list(titles)).")
        }
        let closed = key.denyAreas.map { item -> String in
            if item.hasPrefix("role:") { return Words.id(String(item.dropFirst(5))) }
            return scope?.byArea.first { $0.areaId == item }?.title ?? "a closed area"
        }
        if !closed.isEmpty { lines.append("Closed: \(ReviewText.list(closed)).") }
        if let types = key.allowTypes {
            lines.append("Only these types: \(ReviewText.list(types.map { Words.type($0).lowercased() })).")
        } else {
            lines.append("Every type.")
        }
        if key.scope == "read" { lines.append("It reads and cannot propose.") }
        return lines
    }

    private var ends: String {
        if key.state != "active" { return Words.id(key.state) }
        guard let expires = key.expiresAt else { return "It does not end." }
        return "Ends \(When.day(expires))"
    }

    // MARK: What it can see

    private func seeing(_ scope: AgentScope) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SmallLabel(text: "What it can see")
            Text(scope.total == 1 ? "1 row" : "\(scope.total) rows").font(Theme.heading)
            if !scope.byType.isEmpty {
                SmallLabel(text: "By type").padding(.top, 6)
                ForEach(scope.byType) { item in
                    countLine(Words.type(item.type), item.count)
                }
            }
            if !scope.byArea.isEmpty {
                SmallLabel(text: "By area").padding(.top, 6)
                ForEach(scope.byArea) { item in
                    countLine(item.title ?? (item.areaId == nil ? "No area" : "An area"), item.count)
                }
            }
            if !scope.closed.isEmpty {
                SmallLabel(text: "Stays closed").padding(.top, 6)
                ForEach(scope.closed, id: \.self) { line in
                    Text(line).font(Theme.text).foregroundStyle(Theme.graphite)
                }
            }
        }
        .card()
    }

    private func countLine(_ title: String, _ count: Int) -> some View {
        HStack {
            Text(title).font(Theme.text)
            Spacer()
            Text("\(count)").font(Theme.text).foregroundStyle(Theme.stone)
        }
        .accessibilityElement(children: .combine)
    }

    private var seeAs: some View {
        Button { showToday = true } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("See as this agent").font(Theme.row).foregroundStyle(Theme.ink)
                    Text("Today, as \(name) gets it.").font(Theme.small).foregroundStyle(Theme.stone)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
            }
            .padding(.horizontal, Theme.Space.l)
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .card(padding: 0)
    }

    // MARK: What it did

    private func did(_ timeline: AgentTimeline) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                SmallLabel(text: "What it did")
                countLine("Proposals approved", timeline.summary.approved)
                countLine("Proposals declined", timeline.summary.declined)
                countLine("Proposals waiting", timeline.summary.pending)
                countLine("Open requests", timeline.summary.openRequests)
            }
            .card()
            if timeline.items.isEmpty {
                EmptyState(title: "Nothing yet.", text: "\(name) has not read, proposed, or asked.")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(timeline.items.enumerated()), id: \.element.id) { index, item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.text).font(Theme.row).lineLimit(2)
                            Text(subtitle(item)).font(Theme.small).foregroundStyle(Theme.stone)
                        }
                        .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
                        .padding(.horizontal, Theme.Space.l)
                        .accessibilityElement(children: .combine)
                        if index < timeline.items.count - 1 { Theme.hair.frame(height: 1).padding(.leading, Theme.Space.l) }
                    }
                }
                .card(padding: 0)
            }
        }
    }

    private func subtitle(_ item: AgentTimeline.Item) -> String {
        var parts: [String] = []
        switch item.kind {
        case "proposal": parts.append("Proposal")
        case "request": parts.append("Request")
        default: parts.append("Read")
        }
        if let status = item.status { parts.append(Words.id(status)) }
        parts.append(When.dayAndTime(item.at))
        return parts.joined(separator: " · ")
    }

    private var logRow: some View {
        NavigationLink {
            ReadsView(principalId: key.id, name: name)
        } label: {
            HStack {
                Text("Read log").font(Theme.row).foregroundStyle(Theme.ink)
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
            }
            .padding(.horizontal, Theme.Space.l)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .card(padding: 0)
    }

    private func load() async {
        do {
            async let scopeAnswer = session.client().agentScope(key.id)
            async let timelineAnswer = session.client().agentTimeline(key.id)
            scope = try await scopeAnswer
            timeline = try await timelineAnswer
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }
}

/// The Today screen of one agent key, read only: no tick, and no row opens.
struct AgentTodaySheet: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    let key: AgentKey
    let name: String
    @State private var today: TodayScreen?
    @State private var message: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if today == nil && message == nil { LoadingState() }
                    if let message { MessageLine(text: message, isError: true) }
                    if let today {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(today.greeting).font(Theme.heading)
                            Text(today.summary).font(Theme.text).foregroundStyle(Theme.graphite)
                            Text("Up to \(Words.id(today.ceiling))").font(Theme.small).foregroundStyle(Theme.stone)
                        }
                        .card()
                        ForEach(today.sections) { section in
                            VStack(alignment: .leading, spacing: 8) {
                                SmallLabel(text: section.label)
                                ForEach(section.items) { item in
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(item.title).font(Theme.row)
                                        if !item.subtitle.isEmpty { Text(item.subtitle).font(Theme.small).foregroundStyle(Theme.stone) }
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .accessibilityElement(children: .combine)
                                }
                            }
                            .card()
                        }
                        if today.sections.isEmpty { EmptyState(title: "Nothing to show.") }
                    }
                }
                .padding(16)
            }
            .navigationTitle("As \(name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .background(Theme.ground.ignoresSafeArea())
            .task { await load() }
        }
        .themed()
    }

    private func load() async {
        do { today = try await session.client().agentToday(key.id) }
        catch { message = error.localizedDescription }
    }
}
