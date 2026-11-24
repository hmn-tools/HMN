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
                                            Text(summaries[row.id] ?? [row.kind?.capitalized, row.status?.capitalized, row.tier.capitalized].compactMap { $0 }.joined(separator: " · "))
                                                .font(Theme.small).foregroundStyle(Theme.stone)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.stone)
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
            }
            .padding(22)
        }
        .navigationTitle(title)
        .background(Theme.ground.ignoresSafeArea())
        .task { await load() }
    }

    private func load() async {
        do { rows = try await session.client().entities(type).filter { hiddenKind == nil || $0.kind != hiddenKind } }
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

struct EntityDetailView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    var type: String
    var id: String
    @State private var entity: Entity?
    @State private var links: [GraphLink] = []
    @State private var title = ""
    @State private var bodyText = ""
    @State private var hasDue = false
    @State private var dueDate = Date()
    /// A date with a time keeps its time. A date with no time stays a day.
    @State private var dueHasTime = false
    @State private var status = ""
    @State private var message: String?
    @State private var confirmDelete = false
    @State private var unlinking: GraphLink?
    private let tiers = ["public", "household", "personal", "private", "sealed"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 12) {
                    TextField("Title", text: $title).font(Theme.heading)
                    TextField("Notes", text: $bodyText, axis: .vertical)
                        .textFieldStyle(FieldStyle())
                        .lineLimit(3...10)
                    HStack {
                        Toggle(isOn: $hasDue) { Text("Date").font(Theme.body) }
                            .tint(Theme.tealDark)
                            .fixedSize()
                        Spacer()
                        if hasDue {
                            DatePicker("Date", selection: $dueDate, displayedComponents: dueHasTime ? [.date, .hourAndMinute] : [.date])
                                .labelsHidden()
                        }
                    }
                    if !statuses.isEmpty {
                        labeled("Status") {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(statuses, id: \.self) { value in
                                        Button(value.capitalized) { status = value }
                                            .buttonStyle(ChipButtonStyle(selected: status == value))
                                    }
                                }
                            }
                        }
                    }
                    if let line = entity?.doneLine {
                        Text(line).font(Theme.small).foregroundStyle(Theme.stone)
                    }
                    Button("Save") { Task { await save(tier: nil) } }.buttonStyle(PillButtonStyle())
                }
                .card()
                if type == "task", let entity, entity.kind != "item" {
                    ForPeopleCard(taskId: id, links: links) { await load() }
                    ItemsEditor(parentId: id, placeholder: "Add a step", empty: "No steps.", label: "Steps")
                }
                if let entity {
                    VStack(alignment: .leading, spacing: 8) {
                        SmallLabel(text: "Who sees it")
                        // Five tiers do not fit one line on a small phone. The row scrolls.
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(tiers, id: \.self) { tier in
                                    Button(tier.capitalized) { Task { await save(tier: tier) } }
                                        .buttonStyle(ChipButtonStyle(selected: entity.tier == tier))
                                        .accessibilityValue(entity.tier == tier ? "selected" : "")
                                }
                            }
                        }
                        Text(entity.tierSource == "override" ? "Set on this item." : "From its area.")
                            .font(Theme.small).foregroundStyle(Theme.stone)
                    }
                    .card()
                }
                let others = links.filter { !(type == "task" && $0.rel == "for" && $0.peer.type == "person") && $0.peer.kind != "item" }
                if !others.isEmpty {
                    SmallLabel(text: "Linked")
                    VStack(spacing: 0) {
                        ForEach(others) { link in
                            HStack {
                                NavigationLink {
                                    ItemPage(type: link.peer.type, id: link.peer.id, title: link.peer.title)
                                } label: {
                                    Text(link.peer.title).font(Theme.row).foregroundStyle(Theme.ink)
                                }
                                Spacer()
                                Button("Remove") { unlinking = link }.buttonStyle(TextButtonStyle(danger: true))
                            }
                            .padding(.horizontal, Theme.Space.l)
                            .frame(minHeight: 52)
                            if link.id != others.last?.id { Theme.rule.frame(height: 1).padding(.leading, Theme.Space.l) }
                        }
                    }
                    .card(padding: 0)
                }
                if let message { MessageLine(text: message) }
                Button("Delete") { confirmDelete = true }.buttonStyle(TextButtonStyle(danger: true))
            }
            .padding(22)
        }
        .navigationTitle(type.capitalized)
        .navigationBarTitleDisplayMode(.inline)
        .background(Theme.ground.ignoresSafeArea())
        .confirmationDialog("Remove the link to \(unlinking?.peer.title ?? "it")?", isPresented: Binding(get: { unlinking != nil }, set: { if !$0 { unlinking = nil } }), titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                if let link = unlinking { Task { await unlink(link.id) } }
                unlinking = nil
            }
            Button("Cancel", role: .cancel) { unlinking = nil }
        } message: {
            Text("Both items stay. Only the link goes.")
        }
        .confirmationDialog("Delete \(title.isEmpty ? "this" : title)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await remove() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It leaves your lists. Its history stays.")
        }
        .task { await load() }
    }

    private func labeled<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SmallLabel(text: label)
            content()
        }
    }

    /// The statuses of each type, from SCHEMA.md. A status that is not in the list is kept and shown.
    private var statuses: [String] {
        let known: [String: [String]] = [
            "task": ["inbox", "open", "done"],
            "project": ["active", "paused", "done", "someday"],
            "goal": ["active", "paused", "done"],
            "event": ["upcoming", "done", "cancelled"],
            "habit": ["active", "paused"],
        ]
        guard var list = known[type] else { return [] }
        if !status.isEmpty && !list.contains(status) { list.append(status) }
        return list
    }

    private func readDue(_ value: String?) {
        guard let value, !value.isEmpty else { hasDue = false; return }
        hasDue = true
        if value.contains("T") {
            let parser = ISO8601DateFormatter()
            parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            dueDate = parser.date(from: value) ?? ISO8601DateFormatter().date(from: value) ?? Date()
            dueHasTime = true
        } else {
            dueDate = Self.dayFormat.date(from: String(value.prefix(10))) ?? Date()
            dueHasTime = false
        }
    }

    private var dueString: String {
        guard hasDue else { return "" }
        return dueHasTime ? ISO8601DateFormatter().string(from: dueDate) : Self.dayFormat.string(from: dueDate)
    }

    private static let dayFormat: DateFormatter = {
        let format = DateFormatter()
        format.calendar = Calendar(identifier: .gregorian)
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "yyyy-MM-dd"
        return format
    }()

    private func load() async {
        do {
            let rows = try await session.client().entities(type)
            entity = rows.first { $0.id == id }
            title = entity?.title ?? ""
            bodyText = entity?.body ?? ""
            readDue(entity?.dueAt)
            status = entity?.status ?? ""
            links = try await session.client().links(type: type, id: id)
        } catch {
            message = error.localizedDescription
        }
    }

    private func save(tier: String?) async {
        var fields = ["title": title, "body": bodyText, "due_at": dueString, "status": status]
        if let tier { fields["tier"] = tier }
        do {
            entity = try await session.client().updateEntity(type: type, id: id, fields: fields)
            message = tier == "public" ? "Saved. It shows on shared displays now." : "Saved."
            await load()
        } catch { message = error.localizedDescription }
    }

    private func unlink(_ linkId: String) async {
        do {
            try await session.client().deleteLink(linkId)
            await load()
        } catch { message = error.localizedDescription }
    }

    private func remove() async {
        do {
            try await session.client().deleteEntity(type: type, id: id)
            dismiss()
        } catch { message = error.localizedDescription }
    }
}
