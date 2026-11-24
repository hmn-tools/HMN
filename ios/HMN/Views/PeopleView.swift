import SwiftUI

/// The People tab: each person with one line, the relation and the next date. Organisations come after the
/// people. docs/ONTOLOGY.md, sections 2.2 and 5.2.
struct PeopleView: View {
    @EnvironmentObject private var session: Session
    @State private var people: [PersonEntry] = []
    @State private var loaded = false
    @State private var message: String?

    var body: some View {
        let persons = people.filter { !$0.organisation }
        let organisations = people.filter(\.organisation)
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if !loaded && message == nil { LoadingState() }
                if loaded && people.isEmpty {
                    Text(message ?? "No one here yet.").font(Theme.font(14)).foregroundStyle(Theme.graphite).padding(.top, 12)
                }
                if !persons.isEmpty { rows(persons) }
                if !organisations.isEmpty {
                    SmallLabel(text: "Organisations")
                    rows(organisations)
                }
                if let message, !people.isEmpty { MessageLine(text: message, isError: true) }
            }
            .padding(22)
        }
        .navigationTitle("People")
        .background(Theme.ground.ignoresSafeArea())
        // A person changes on its own page. Read again each time this one shows.
        .onAppear { Task { await load() } }
        .refreshable { await load() }
    }

    private func rows(_ list: [PersonEntry]) -> some View {
        VStack(spacing: 0) {
            ForEach(list) { entry in
                NavigationLink {
                    PersonPageView(id: entry.id, title: entry.person.title)
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.person.title).font(Theme.row).foregroundStyle(Theme.ink)
                            if !entry.line.isEmpty {
                                Text(entry.line).font(Theme.small).foregroundStyle(Theme.stone).lineLimit(1)
                            }
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.stone)
                    }
                    .padding(.horizontal, Theme.Space.l)
                    .frame(minHeight: 60)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if entry.id != list.last?.id { Theme.rule.frame(height: 1).padding(.leading, Theme.Space.l) }
            }
        }
        .card(padding: 0)
    }

    private func load() async {
        do {
            people = try await session.client().people()
            message = nil
        } catch { message = error.localizedDescription }
        loaded = true
    }
}

/// The person page: the next dates with a person, the open tasks for them, their routines, the notes about them,
/// and the things and people linked to them. Edit opens the record itself.
struct PersonPageView: View {
    @EnvironmentObject private var session: Session
    var id: String
    var title: String
    @State private var page: PersonPage?
    @State private var message: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    if let kind = page?.kindTitle { SmallLabel(text: kind) }
                    Text(page?.person.title ?? title).font(Theme.heading)
                    if let body = page?.person.body, !body.isEmpty {
                        Text(body).font(Theme.font(14)).foregroundStyle(Theme.graphite).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .card()
                if let page {
                    if page.isEmpty {
                        Text("Nothing linked yet. Link a task, a date, or a note to them, and it shows here.")
                            .font(Theme.font(14)).foregroundStyle(Theme.graphite)
                    }
                    section("Next", page.next)
                    if !page.tasks.isEmpty {
                        SmallLabel(text: "Open")
                        taskRows(page.tasks)
                    }
                    if !page.routines.isEmpty {
                        SmallLabel(text: "Routines")
                        routineRows(page.routines)
                    }
                    section("Notes", page.notes)
                    section(page.organisation ? "People" : "People and organisations", page.people)
                    section("Things and places", page.things)
                    section("Also linked", page.other)
                    section("Done lately", page.done)
                }
                if let message { MessageLine(text: message, isError: true) }
            }
            .padding(22)
        }
        .navigationTitle(page?.organisation == true ? "Organisation" : "Person")
        .navigationBarTitleDisplayMode(.inline)
        .background(Theme.ground.ignoresSafeArea())
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                NavigationLink("Edit") { EntityDetailView(type: "person", id: id) }
            }
        }
        .onAppear { Task { await load() } }
        .refreshable { await load() }
    }

    @ViewBuilder
    private func section(_ label: String, _ rows: [PersonPage.Linked]) -> some View {
        if !rows.isEmpty {
            SmallLabel(text: label)
            VStack(spacing: 0) {
                ForEach(rows) { row in
                    NavigationLink {
                        if row.entity.type == "person" {
                            PersonPageView(id: row.entity.id, title: row.entity.title)
                        } else {
                            EntityDetailView(type: row.entity.type, id: row.entity.id)
                        }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.entity.title).font(Theme.row).foregroundStyle(row.entity.isDone ? Theme.stone : Theme.ink)
                                if let line = subtitle(row) {
                                    Text(line).font(Theme.small).foregroundStyle(Theme.stone)
                                }
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.stone)
                        }
                        .padding(.horizontal, Theme.Space.l)
                        .frame(minHeight: 56)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if row.id != rows.last?.id { Theme.rule.frame(height: 1).padding(.leading, Theme.Space.l) }
                }
            }
            .card(padding: 0)
        }
    }

    /// The open tasks, each with a tick. A task done here leaves for "Done lately".
    private func taskRows(_ rows: [PersonPage.Linked]) -> some View {
        VStack(spacing: 0) {
            ForEach(rows) { row in
                HStack(spacing: 4) {
                    TickButton(done: row.entity.isDone) { Task { await complete(row.entity) } }
                    NavigationLink {
                        EntityDetailView(type: "task", id: row.entity.id)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.entity.title).font(Theme.row).foregroundStyle(Theme.ink)
                                if let line = subtitle(row) { Text(line).font(Theme.small).foregroundStyle(Theme.stone) }
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.stone)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.leading, 6)
                .padding(.trailing, Theme.Space.l)
                .frame(minHeight: 56)
                if row.id != rows.last?.id { Theme.rule.frame(height: 1).padding(.leading, 54) }
            }
        }
        .card(padding: 0)
    }

    private func routineRows(_ routines: [Routine]) -> some View {
        VStack(spacing: 0) {
            ForEach(routines) { routine in
                HStack(spacing: 4) {
                    if routine.dueToday {
                        TickButton(done: routine.doneToday) { Task { await tick(routine) } }
                    } else {
                        Image(systemName: "minus").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.hair).frame(width: 44, height: 44)
                            .accessibilityLabel("Not today")
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(routine.habit.title).font(Theme.row).foregroundStyle(routine.dueToday && !routine.doneToday ? Theme.ink : Theme.stone)
                        Text(routine.doneToday ? routine.subtitle.components(separatedBy: " · ").dropFirst().joined(separator: " · ") : routine.habit.properties?.cadence ?? "Every day")
                            .font(Theme.small).foregroundStyle(Theme.stone)
                    }
                    Spacer()
                }
                .padding(.leading, 6)
                .padding(.trailing, Theme.Space.l)
                .frame(minHeight: 56)
                if routine.id != routines.last?.id { Theme.rule.frame(height: 1).padding(.leading, 54) }
            }
        }
        .card(padding: 0)
    }

    /// The date for a dated row, who completed a done task, or the kind of a thing.
    private func subtitle(_ row: PersonPage.Linked) -> String? {
        if let line = row.entity.doneLine { return line }
        if let when = row.when { return when }
        return row.entity.kind.map { $0.replacingOccurrences(of: "_", with: " ").capitalized }
    }

    private func load() async {
        do {
            page = try await session.client().personPage(id)
            message = nil
        } catch { message = error.localizedDescription }
    }

    private func complete(_ task: Entity) async {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        do {
            _ = try await session.client().setDone(task.id, !task.isDone)
            await load()
        } catch { message = error.localizedDescription }
    }

    private func tick(_ routine: Routine) async {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        do {
            if routine.doneToday { _ = try await session.client().uncheck(routine.id) } else { _ = try await session.client().checkIn(routine.id) }
            await load()
        } catch { message = error.localizedDescription }
    }
}
