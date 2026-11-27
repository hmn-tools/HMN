import SwiftUI

/**
 A project page: what is open, a field for the next step, what it is linked to, and what is done.
 A task is a step of the project through the `part_of` link (ONTOLOGY.md, 2.3). Edit is behind a button.
 */
struct ProjectPageView: View {
    @EnvironmentObject private var session: Session
    var id: String
    var title: String
    @State private var project: Entity?
    @State private var open: [Entity] = []
    @State private var done: [Entity] = []
    @State private var others: [GraphLink] = []
    @State private var newTask = ""
    @State private var working = false
    @State private var loaded = false
    @State private var message: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                header
                addField
                if !loaded { LoadingState() }
                if loaded && open.isEmpty {
                    Text("Nothing open. Add the next step.").font(Theme.text).foregroundStyle(Theme.graphite)
                }
                if !open.isEmpty {
                    SmallLabel(text: "Open · \(open.count)")
                    taskRows(open)
                }
                if !others.isEmpty {
                    SmallLabel(text: "Linked")
                    linkedRows
                }
                if !done.isEmpty {
                    SmallLabel(text: "Done")
                    taskRows(Array(done.prefix(5)))
                }
                if let message { MessageLine(text: message, isError: true) }
            }
            .padding(16)
        }
        .navigationTitle("Project")
        .navigationBarTitleDisplayMode(.inline)
        .background(Theme.ground.ignoresSafeArea())
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                NavigationLink("Edit") { EntityDetailView(type: "project", id: id) }
            }
        }
        .onAppear { Task { await load() } }
        .refreshable { await load() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            SmallLabel(text: project?.status.map(Words.id) ?? "Project")
            Text(project?.title ?? title).font(Theme.heading)
            if let body = project?.body, !body.isEmpty {
                Text(body).font(Theme.text).foregroundStyle(Theme.graphite).fixedSize(horizontal: false, vertical: true)
            }
            if let due = project?.dueAt {
                Text("Due \(ReviewText.day(due))").font(Theme.small).foregroundStyle(Theme.stone)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private var addField: some View {
        HStack(spacing: 8) {
            TextField(hint: "Add a task", text: $newTask)
                .textFieldStyle(FieldStyle())
                .submitLabel(.done)
                .onSubmit { Task { await add() } }
            Button("Add") { Task { await add() } }
                .buttonStyle(ChipButtonStyle(solid: true))
                .disabled(newTask.trimmingCharacters(in: .whitespaces).isEmpty || working)
        }
    }

    private func taskRows(_ rows: [Entity]) -> some View {
        VStack(spacing: 0) {
            ForEach(rows) { task in
                HStack(spacing: 4) {
                    TickButton(done: task.isDone, title: task.title) { Task { await complete(task) } }
                    NavigationLink {
                        EntityDetailView(type: "task", id: task.id)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(task.title).font(Theme.row).foregroundStyle(task.isDone ? Theme.stone : Theme.ink)
                                if let due = task.dueAt, !task.isDone {
                                    Text(ReviewText.day(due)).font(Theme.small).foregroundStyle(Theme.stone)
                                }
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.leading, 6)
                .padding(.trailing, Theme.Space.l)
                .frame(minHeight: 60)
                if task.id != rows.last?.id { Theme.hair.frame(height: 1).padding(.leading, Theme.Space.l) }
            }
        }
        .card(padding: 0)
    }

    private var linkedRows: some View {
        VStack(spacing: 0) {
            ForEach(others) { link in
                NavigationLink {
                    ItemPage(type: link.peer.type, id: link.peer.id, title: link.peer.title)
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(link.peer.title).font(Theme.row).foregroundStyle(Theme.ink)
                            Text(Words.type(link.peer.type)).font(Theme.small).foregroundStyle(Theme.stone)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
                    }
                    .padding(.horizontal, Theme.Space.l)
                    .frame(minHeight: 60)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if link.id != others.last?.id { Theme.hair.frame(height: 1).padding(.leading, Theme.Space.l) }
            }
        }
        .card(padding: 0)
    }

    private func load() async {
        do {
            let client = session.client()
            async let projects = client.entities("project")
            async let links = client.links(type: "project", id: id)
            async let tasks = client.entities("task")
            let (allProjects, allLinks, allTasks) = try await (projects, links, tasks)
            project = allProjects.first { $0.id == id }
            let steps = Set(allLinks.filter { $0.peer.type == "task" && $0.rel == "part_of" }.map(\.peer.id))
            let mine = allTasks.filter { steps.contains($0.id) }
            open = mine.filter { !$0.isDone }.sorted { ($0.dueAt ?? "9999") < ($1.dueAt ?? "9999") }
            done = mine.filter(\.isDone)
            others = allLinks.filter { !($0.peer.type == "task" && $0.rel == "part_of") }
            message = nil
        } catch {
            message = error.localizedDescription
        }
        loaded = true
    }

    private func add() async {
        let text = newTask.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, !working else { return }
        working = true
        defer { working = false }
        do {
            // The task takes the project's area, and its tier when the project has one of its own.
            let tier = project?.tierSource == "override" ? project?.tier : nil
            let task = try await session.client().createTask(title: text, due: nil, status: "open", areaId: project?.areaId, tier: tier)
            try await session.client().link(fromType: "task", fromId: task.id, rel: "part_of", toType: "project", toId: id)
            newTask = ""
            await load()
        } catch {
            message = error.localizedDescription
        }
    }

    private func complete(_ task: Entity) async {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        do {
            _ = try await session.client().setDone(task.id, !task.isDone)
            await load()
        } catch {
            message = error.localizedDescription
        }
    }
}

/// The page for one item: a person and a project have their own page, and each other type opens its detail.
struct ItemPage: View {
    var type: String
    var id: String
    var title: String

    var body: some View {
        switch type {
        case "person": PersonPageView(id: id, title: title)
        case "project": ProjectPageView(id: id, title: title)
        default: EntityDetailView(type: type, id: id)
        }
    }
}
