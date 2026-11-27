import SwiftUI

/// Member mode: the app on the phone of a household member. Home, Lists, and Family, and none of the owner's tabs.
/// The member key sets this mode. docs/ONTOLOGY.md, section 5.4.
enum MemberTab { case home, lists, family }

struct MemberRootView: View {
    @State private var tab: MemberTab = .home
    @Environment(\.dynamicTypeSize) private var dynamicType

    var body: some View {
        ZStack(alignment: .bottom) {
            Group {
                switch tab {
                case .home: TodayView()
                case .lists: NavigationStack { ListsView() }
                case .family: NavigationStack { FamilyTasksView() }
                }
            }
            .padding(.bottom, 76)
            tabBar
        }
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            tabButton(.home, "Home", symbol: "house")
            tabButton(.lists, "Lists", symbol: "checklist")
            tabButton(.family, "Family", symbol: "person.2")
        }
        .padding(.horizontal, 8)
        .frame(height: 64)
        .background(Theme.card)
        .clipShape(Capsule())
        .shadow(color: Theme.shadow.opacity(0.2), radius: 14, x: 0, y: 10)
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
    }

    /// At the largest text sizes the bar shows icons only, as the owner's bar does, so that a label never wraps.
    private var iconsOnly: Bool { dynamicType >= .accessibility1 }

    private func tabButton(_ value: MemberTab, _ title: String, symbol: String) -> some View {
        Button { tab = value } label: {
            VStack(spacing: 2) {
                Image(systemName: symbol)
                    .font(.system(size: 18, weight: .regular))
                    .frame(height: 22)
                if !iconsOnly {
                    Text(title)
                        .font(Theme.sans(11, weight: .medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                }
            }
            .foregroundStyle(tab == value ? Theme.ink : Theme.stone)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(tab == value ? Theme.ground : Color.clear)
            .clipShape(Capsule())
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityAddTraits(tab == value ? [.isSelected] : [])
    }
}

/// The tasks for people: open first, then the ones done lately. A tick completes a task for everyone on it.
struct FamilyTasksView: View {
    @EnvironmentObject private var session: Session
    @State private var tasks: [FamilyTask] = []
    @State private var routines: [Routine] = []
    @State private var loaded = false
    @State private var removing: Routine?
    @State private var editing: Routine?
    @State private var message: String?
    @State private var note: String?

    var body: some View {
        let open = tasks.filter { !$0.task.isDone }
        let done = tasks.filter { $0.task.isDone }
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                RootTitle("Family")
                if !loaded && message == nil { LoadingState() }
                if loaded && tasks.isEmpty && routines.isEmpty {
                    Text("No family tasks yet.").font(Theme.font(14)).foregroundStyle(Theme.graphite).padding(.top, 12)
                }
                if !open.isEmpty { rows(open) }
                if !routines.isEmpty {
                    SmallLabel(text: "Routines")
                    routineRows
                }
                if !session.isMember { NewRoutineCard { await load() } }
                if !done.isEmpty {
                    SmallLabel(text: "Done lately")
                    rows(done)
                }
                if let note { MessageLine(text: note) }
                if let message { MessageLine(text: message, isError: true) }
            }
            .padding(16)
        }
        .toolbar(.hidden, for: .navigationBar)
        .background(Theme.ground.ignoresSafeArea())
        .sheet(item: $editing, onDismiss: { Task { await load() } }) { routine in
            RoutineEditSheet(routine: routine).themed()
        }
        .confirmationDialog("Remove \(removing?.habit.title ?? "this routine")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                if let routine = removing { Task { await remove(routine) } }
                removing = nil
            }
            Button("Cancel", role: .cancel) { removing = nil }
        } message: {
            Text("It leaves the phones and the fridge. Pause keeps it for later.")
        }
        .onAppear { Task { await load() } }
        .refreshable { await load() }
    }

    private func rows(_ list: [FamilyTask]) -> some View {
        VStack(spacing: 0) {
            ForEach(list) { entry in
                HStack(spacing: 4) {
                    TickButton(done: entry.task.isDone, title: entry.task.title) { Task { await toggle(entry) } }
                    NavigationLink {
                        FamilyTaskDetailView(entry: entry)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.task.title)
                                    .font(Theme.row)
                                    .strikethrough(entry.task.isDone, color: Theme.stone)
                                    .foregroundStyle(entry.task.isDone ? Theme.stone : Theme.ink)
                                Text(FamilyTaskDetailView.subtitle(entry)).font(Theme.small).foregroundStyle(Theme.stone)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
                                .accessibilityHidden(true)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.leading, 6)
                .padding(.trailing, Theme.Space.l)
                .frame(minHeight: 60)
                if entry.id != list.last?.id { Theme.hair.frame(height: 1).padding(.leading, Theme.Space.l) }
            }
        }
        .card(padding: 0)
    }

    /// Today's tick for a routine that is due today. A routine for another day shows its days, with no tick.
    private var routineRows: some View {
        VStack(spacing: 0) {
            ForEach(routines) { routine in
                HStack(spacing: 4) {
                    if routine.dueToday {
                        TickButton(done: routine.doneToday, title: routine.habit.title, routine: true) { Task { await tick(routine) } }
                    } else {
                        Image(systemName: "minus").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.stone).frame(width: 44, height: 44)
                            .accessibilityLabel("Not today")
                    }
                    if session.isMember {
                        routineLabel(routine)
                    } else {
                        Button { editing = routine } label: { routineLabel(routine) }
                            .buttonStyle(.plain)
                            .accessibilityHint("Opens the routine")
                    }
                }
                .padding(.leading, 6)
                .padding(.trailing, Theme.Space.l)
                .frame(minHeight: 60)
                .contentShape(Rectangle())
                .contextMenu {
                    if !session.isMember {
                        Button(routine.habit.status == "paused" ? "Start again" : "Pause") { Task { await pause(routine) } }
                        Button("Remove", role: .destructive) { removing = routine }
                    }
                }
                if routine.id != routines.last?.id { Theme.hair.frame(height: 1).padding(.leading, Theme.Space.l) }
            }
        }
        .card(padding: 0)
    }

    /// The words of a routine row, with a chevron only when the row opens (the owner's phone).
    private func routineLabel(_ routine: Routine) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(routine.habit.title)
                    .font(Theme.row)
                    .strikethrough(routine.doneToday, color: Theme.stone)
                    .foregroundStyle(routine.doneToday || !routine.dueToday ? Theme.stone : Theme.ink)
                Text(routine.subtitle).font(Theme.small).foregroundStyle(Theme.stone)
            }
            Spacer()
            if !session.isMember {
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
    }

    private func load() async {
        do {
            async let family = session.client().familyTasks()
            async let daily = session.client().routines()
            tasks = try await family
            routines = try await daily
            message = nil
        } catch { message = error.localizedDescription }
        loaded = true
    }

    private func tick(_ routine: Routine) async {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        do {
            if routine.doneToday { _ = try await session.client().uncheck(routine.id) } else { _ = try await session.client().checkIn(routine.id) }
            await load()
        } catch { message = error.localizedDescription }
    }

    private func pause(_ routine: Routine) async {
        do {
            _ = try await session.client().updateEntity(type: "habit", id: routine.id, fields: ["status": routine.habit.status == "paused" ? "active" : "paused"])
            await load()
        } catch { message = error.localizedDescription }
    }

    private func remove(_ routine: Routine) async {
        do {
            try await session.client().deleteEntity(type: "habit", id: routine.id)
            note = "\(routine.habit.title) is gone."
            await load()
        } catch { message = error.localizedDescription }
    }

    private func toggle(_ entry: FamilyTask) async {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        do {
            let answer = try await session.client().setDone(entry.task.id, !entry.task.isDone)
            note = answer.pending ? "\(entry.task.title): waiting for a yes." : nil
            await load()
        } catch { message = error.localizedDescription }
    }
}

/// The owner adds a routine for a child: what, for whom, and on which days.
struct NewRoutineCard: View {
    @EnvironmentObject private var session: Session
    var changed: () async -> Void
    @State private var title = ""
    @State private var personId: String?
    @State private var days: Set<String> = Set(NewRoutineCard.week.map(\.id))
    @State private var people: [Entity] = []
    @State private var message: String?

    static let week: [(id: String, letter: String)] = [("mon", "M"), ("tue", "T"), ("wed", "W"), ("thu", "T"), ("fri", "F"), ("sat", "S"), ("sun", "S")]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SmallLabel(text: "New routine")
            TextField(hint: "Feed the cat, pack the school bag", text: $title)
                .textFieldStyle(FieldStyle())
                .submitLabel(.done)
            if people.isEmpty {
                // A routine is at Household. A person above Household would hide it from the person it is for.
                Text("Put a child at Household first. Only they show here.").font(Theme.small).foregroundStyle(Theme.stone)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(people) { person in
                            Button(person.title) { personId = person.id }.buttonStyle(ChipButtonStyle(selected: personId == person.id))
                        }
                    }
                }
            }
            HStack(spacing: 6) {
                ForEach(Self.week, id: \.id) { day in
                    Button(day.letter) {
                        if days.contains(day.id) { days.remove(day.id) } else { days.insert(day.id) }
                    }
                    .buttonStyle(ChipButtonStyle(selected: days.contains(day.id)))
                    .accessibilityLabel(day.id.capitalized)
                    .accessibilityAddTraits(days.contains(day.id) ? [.isSelected] : [])
                }
            }
            Button("Add the routine") { Task { await create() } }
                .buttonStyle(PillButtonStyle())
                .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || personId == nil || days.isEmpty)
            if let message { MessageLine(text: message, isError: true) }
        }
        .card()
        .task {
            let all = (try? await session.client().entities("person")) ?? []
            people = all.filter { $0.tier == "household" || $0.tier == "public" }
            if people.count == 1 { personId = people.first?.id }
        }
    }

    private func create() async {
        guard let personId else { return }
        let picked = Self.week.map(\.id).filter { days.contains($0) }
        do {
            _ = try await session.client().createRoutine(title: title.trimmingCharacters(in: .whitespaces), personId: personId, days: picked.count == 7 ? [] : picked)
            title = ""
            message = nil
            await changed()
        } catch { message = error.localizedDescription }
    }
}

/// One family task: who it is for, who completed it, and its steps.
struct FamilyTaskDetailView: View {
    @EnvironmentObject private var session: Session
    @State var entry: FamilyTask
    @State private var note: String?
    @State private var message: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(entry.task.title).font(Theme.heading)
                    // The steps show below, so the header leaves out their count.
                    Text(Self.subtitle(entry, steps: false)).font(Theme.small).foregroundStyle(Theme.stone)
                    Button(entry.task.isDone ? "Open again" : "Mark done") { Task { await toggle() } }
                        .buttonStyle(PillButtonStyle(kind: entry.task.isDone ? .secondary : .primary))
                }
                .card()
                ItemsEditor(parentId: entry.task.id, placeholder: "Add a step", empty: "No steps.", label: "Steps")
                if let note { MessageLine(text: note) }
                if let message { MessageLine(text: message, isError: true) }
            }
            .padding(16)
        }
        .navigationTitle("Family task")
        .navigationBarTitleDisplayMode(.inline)
        .background(Theme.ground.ignoresSafeArea())
    }

    /// "Sam, Alex · 1 of 2 steps · due Tomorrow", or "Done by Sam · Today 18:02".
    static func subtitle(_ entry: FamilyTask, steps showSteps: Bool = true) -> String {
        if let line = entry.task.doneLine { return line }
        var parts = [entry.people.map(\.title).joined(separator: ", ")]
        let steps = entry.steps.open + entry.steps.done
        if showSteps && steps > 0 { parts.append("\(entry.steps.done) of \(steps) steps") }
        if let due = entry.task.dueAt, !due.isEmpty { parts.append("due \(When.day(due))") }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func toggle() async {
        do {
            let answer = try await session.client().setDone(entry.task.id, !entry.task.isDone)
            if let task = answer.entity { entry.task = task }
            note = answer.pending ? "Waiting for a yes." : nil
            message = nil
        } catch { message = error.localizedDescription }
    }
}

/// Settings on a member's phone: whose phone it is, Hide, and Forget.
struct MemberSettingsView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var hidden = false
    @State private var confirmForget = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        SmallLabel(text: "This phone")
                        Text(session.member?.name ?? "Member").font(Theme.heading)
                        Text(reach).font(Theme.small).foregroundStyle(Theme.stone)
                    }
                    .card()
                    if hidden {
                        Text("Hidden. The owner shows it again from the HMN menu bar.")
                            .font(Theme.font(13)).foregroundStyle(Theme.graphite)
                    } else {
                        Button("Hide this phone") { Task { await hide() } }.buttonStyle(PillButtonStyle(kind: .secondary))
                    }
                    Button("Forget this phone") { confirmForget = true }.buttonStyle(TextButtonStyle(danger: true))
                }
                .padding(16)
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .background(Theme.ground.ignoresSafeArea())
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .confirmationDialog("Forget this phone?", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("Forget", role: .destructive) {
                    session.forget()
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("It needs a new pairing code after this.")
            }
            .task { hidden = (try? await session.client().me())?.credential.forcedCeiling != nil }
        }
    }

    private var reach: String {
        session.member?.role == "partner" ? "Partner · the household, and the family's private records" : "Child · the household"
    }

    private func hide() async {
        do {
            try await session.client().panic()
            hidden = true
            SnapshotStore.clear()
        } catch {}
    }
}

/// Change a routine: its name, who it is for, its days, and a pause. docs/ONTOLOGY.md, section 2.5.
struct RoutineEditSheet: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    let routine: Routine
    @State private var title = ""
    @State private var personId = ""
    @State private var days: Set<String> = []
    @State private var paused = false
    @State private var people: [Entity] = []
    @State private var working = false
    @State private var message: String?
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 6) {
                        SmallLabel(text: "Name")
                        TextField(hint: "Name", text: $title).textFieldStyle(FieldStyle())
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        SmallLabel(text: "For")
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(people) { person in
                                    Button(person.title) { personId = person.id }
                                        .buttonStyle(ChipButtonStyle(selected: personId == person.id))
                                        .accessibilityAddTraits(personId == person.id ? [.isSelected] : [])
                                }
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        SmallLabel(text: "Days")
                        HStack(spacing: 6) {
                            ForEach(NewRoutineCard.week, id: \.id) { day in
                                Button(day.letter) {
                                    if days.contains(day.id) { days.remove(day.id) } else { days.insert(day.id) }
                                }
                                .buttonStyle(ChipButtonStyle(selected: days.contains(day.id)))
                                .accessibilityLabel(day.id.capitalized)
                                .accessibilityAddTraits(days.contains(day.id) ? [.isSelected] : [])
                            }
                        }
                    }
                    Toggle(isOn: $paused) { Text("Paused").font(Theme.text) }.tint(Theme.tealDark)
                    Button(working ? "Saving" : "Save") { Task { await save() } }
                        .buttonStyle(PillButtonStyle())
                        .disabled(working || title.trimmingCharacters(in: .whitespaces).isEmpty || days.isEmpty || personId.isEmpty)
                    if let message { MessageLine(text: message, isError: true) }
                    Button("Delete the routine") { confirmDelete = true }.buttonStyle(TextButtonStyle(danger: true))
                }
                .padding(16)
            }
            .navigationTitle("Routine")
            .navigationBarTitleDisplayMode(.inline)
            .background(Theme.ground.ignoresSafeArea())
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .confirmationDialog("Delete \(routine.habit.title)?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) { Task { await remove() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("It leaves the phones and the fridge. Paused keeps it for later.")
            }
            .task {
                title = routine.habit.title
                personId = routine.people.first?.id ?? ""
                days = routine.days.isEmpty ? Set(NewRoutineCard.week.map(\.id)) : Set(routine.days)
                paused = routine.habit.status == "paused"
                let all = (try? await session.client().entities("person")) ?? []
                people = all.filter { $0.tier == "household" || $0.tier == "public" }
            }
        }
    }

    /// "Every day", "Weekdays", "Weekends", or "Mon, Wed", as the server writes it.
    private func cadence(_ picked: [String]) -> String {
        if picked.count == 7 { return "Every day" }
        if picked == ["mon", "tue", "wed", "thu", "fri"] { return "Weekdays" }
        if picked == ["sat", "sun"] { return "Weekends" }
        return picked.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: ", ")
    }

    private func save() async {
        working = true
        defer { working = false }
        let picked = NewRoutineCard.week.map(\.id).filter { days.contains($0) }
        let stored = picked.count == 7 ? [String]() : picked
        do {
            _ = try await session.client().updateRecord(type: "habit", id: routine.id, body: [
                "title": title.trimmingCharacters(in: .whitespaces),
                "status": paused ? "paused" : "active",
                "properties_patch": ["days": stored, "cadence": cadence(picked)],
            ])
            // A new person: the old `for` link goes, and a new one comes.
            if personId != routine.people.first?.id {
                let links = (try? await session.client().links(type: "habit", id: routine.id)) ?? []
                for link in links where link.rel == "for" && link.direction == "out" { try await session.client().deleteLink(link.id) }
                try await session.client().link(fromType: "habit", fromId: routine.id, rel: "for", toType: "person", toId: personId)
            }
            dismiss()
        } catch { message = error.localizedDescription }
    }

    private func remove() async {
        do {
            try await session.client().deleteEntity(type: "habit", id: routine.id)
            dismiss()
        } catch { message = error.localizedDescription }
    }
}
