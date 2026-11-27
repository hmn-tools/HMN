import SwiftUI

struct BrowseView: View {
    @EnvironmentObject private var session: Session
    var type: String
    var title: String
    var empty: String
    /// A kind that has its own screen, such as `list`, is left out here.
    var hiddenKind: String? = nil
    @State private var rows: [Entity] = []
    @State private var message: String?
    @State private var loaded = false
    /// For a project: how many steps are open, and the next date. It replaces "Active · Personal".
    @State private var summaries: [String: String] = [:]
    @State private var schema: AppSchema?
    @State private var making = false
    @State private var opened: Entity?
    @State private var showArchived = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if !loaded { LoadingState() }
                if loaded && rows.isEmpty {
                    Text(message ?? empty).font(Theme.font(14)).foregroundStyle(Theme.graphite).padding(.top, 12)
                }
                if !rows.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(rows) { row in
                            NavigationLink {
                                ItemPage(type: row.type, id: row.id, title: row.title)
                            } label: {
                                VStack(spacing: 0) {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(row.title).font(Theme.row).foregroundStyle(Theme.ink)
                                            Text(summaries[row.id] ?? line(row))
                                                .font(Theme.small).foregroundStyle(Theme.stone)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
                                            .accessibilityHidden(true)
                                    }
                                    .padding(.horizontal, Theme.Space.l)
                                    .frame(minHeight: 60)
                                    if row.id != rows.last?.id { Theme.rule.frame(height: 1).padding(.leading, Theme.Space.l) }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .card(padding: 0)
                }
                if loaded && archivable {
                    Button(showArchived ? "Hide archived" : "Show archived") {
                        showArchived.toggle()
                        Task { await load() }
                    }
                    .buttonStyle(TextButtonStyle())
                    .padding(.top, 8)
                }
            }
            .padding(16)
        }
        .navigationTitle(title)
        .background(Theme.ground.ignoresSafeArea())
        .toolbar {
            if canMake {
                ToolbarItem(placement: .primaryAction) {
                    Button { making = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New \(Words.type(type).lowercased())")
                }
            }
        }
        .sheet(isPresented: $making) {
            NewRecordSheet(type: type) { made in opened = made }.themed()
        }
        .navigationDestination(item: $opened) { made in
            ItemPage(type: made.type, id: made.id, title: made.title)
        }
        // A record changes in its own screen. Read again each time this one shows.
        .onAppear { Task { await load() } }
        .refreshable { await load() }
    }

    private var canMake: Bool { NewRecordSheet.choices.contains { $0.0 == type } }
    private var archivable: Bool { schema?.statuses[type]?.contains("archived") == true }

    /// The second line in words: the kind, the date or the status, and the tier only when it is not Personal.
    private func line(_ row: Entity) -> String {
        var parts: [String] = []
        if let kind = schema?.kindTitle(row.type, row.kind) { parts.append(kind) }
        if let due = row.dueAt, !due.isEmpty, let date = DateText.parse(due) {
            parts.append(date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)))
        } else if let status = row.status, !status.isEmpty, status != "open", status != "active" {
            parts.append(Words.id(status))
        }
        if row.tier != "personal" { parts.append(Words.id(row.tier)) }
        return parts.isEmpty ? Words.type(row.type) : parts.joined(separator: " · ")
    }

    private func load() async {
        schema = await SchemaCache.load(session)
        do { rows = try await session.client().entities(type, archived: showArchived).filter { hiddenKind == nil || $0.kind != hiddenKind } }
        catch { message = error.localizedDescription }
        loaded = true
        if type == "project" { await summarise() }
    }

    /// One read of the tasks, and one read of the links of each project. A personal graph has few projects.
    private func summarise() async {
        let client = session.client()
        guard let tasks = try? await client.entities("task") else { return }
        let byId = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
        var out: [String: String] = [:]
        await withTaskGroup(of: (String, String).self) { group in
            for project in rows where project.status != "done" {
                group.addTask {
                    let links = (try? await client.links(type: "project", id: project.id)) ?? []
                    let open = links.filter { $0.peer.type == "task" && $0.rel == "part_of" }
                        .compactMap { byId[$0.peer.id] }
                        .filter { !$0.isDone }
                    if open.isEmpty { return (project.id, project.status == "active" ? "Nothing open" : (project.status ?? "").capitalized) }
                    var line = open.count == 1 ? "1 open" : "\(open.count) open"
                    if let next = open.compactMap(\.dueAt).min() { line += " · next \(ReviewText.day(next))" }
                    return (project.id, line)
                }
            }
            for await (id, line) in group { out[id] = line }
        }
        summaries = out
    }
}

