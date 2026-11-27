import SwiftUI

/// The Projects tab: projects, and lists next to them as a filter. docs/ONTOLOGY.md, section 5.2.
struct ProjectsHome: View {
    @AppStorage("projects.mode") private var mode = "projects"

    var body: some View {
        Group {
            if mode == "lists" {
                ListsView()
            } else if mode == "family" {
                FamilyTasksView()
            } else {
                BrowseView(type: "project", title: "Projects", empty: "No projects yet.", hiddenKind: "list", root: true)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack(spacing: 6) {
                Button("Projects") { mode = "projects" }.buttonStyle(ChipButtonStyle(selected: mode != "lists" && mode != "family"))
                Button("Lists") { mode = "lists" }.buttonStyle(ChipButtonStyle(selected: mode == "lists"))
                Button("Family") { mode = "family" }.buttonStyle(ChipButtonStyle(selected: mode == "family"))
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(Theme.ground)
        }
    }
}

/// Every list, with how many items are open, and a way to start a new one.
struct ListsView: View {
    @EnvironmentObject private var session: Session
    @State private var lists: [ListEntry] = []
    @State private var loaded = false
    @State private var message: String?
    @State private var newTitle = ""
    @State private var newTier = "household"
    @State private var note: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                RootTitle("Lists")
                if !loaded { LoadingState() }
                if loaded && lists.isEmpty {
                    Text("No lists yet.").font(Theme.font(14)).foregroundStyle(Theme.graphite).padding(.top, 12)
                }
                if !lists.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(lists) { entry in
                            NavigationLink {
                                ListDetailView(parentId: entry.list.id, title: entry.list.title)
                            } label: {
                                listRow(entry)
                            }
                            .buttonStyle(.plain)
                            if entry.id != lists.last?.id { Theme.hair.frame(height: 1).padding(.leading, Theme.Space.l) }
                        }
                    }
                    .card(padding: 0)
                }
                VStack(alignment: .leading, spacing: 10) {
                    SmallLabel(text: "New list")
                    TextField(hint: "Groceries, packing, gifts", text: $newTitle)
                        .textFieldStyle(FieldStyle())
                        .submitLabel(.done)
                        .onSubmit { Task { await create() } }
                    // A member sees Household and Public. A list made above that would hide itself from its maker.
                    if !session.isMember {
                        HStack(spacing: 6) {
                            ForEach(["household", "personal", "private"], id: \.self) { tier in
                                Button(Words.id(tier)) { newTier = tier }.buttonStyle(ChipButtonStyle(selected: newTier == tier))
                            }
                        }
                    }
                    Button("Start the list") { Task { await create() } }
                        .buttonStyle(PillButtonStyle())
                        .disabled(newTitle.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .card()
                if let note { MessageLine(text: note) }
                if let message { MessageLine(text: message, isError: true) }
            }
            .padding(16)
        }
        .toolbar(.hidden, for: .navigationBar)
        .background(Theme.ground.ignoresSafeArea())
        // A list changes in its own screen. Read again each time this one shows.
        .onAppear { Task { await load() } }
        .refreshable { await load() }
    }

    private func listRow(_ entry: ListEntry) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.list.title).font(Theme.row).foregroundStyle(Theme.ink)
                Text("\(entry.items.isEmpty ? "Empty" : entry.open == 0 ? "All done" : "\(entry.open) open") · \(Words.id(entry.list.tier))")
                    .font(Theme.small).foregroundStyle(Theme.stone)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, Theme.Space.l)
        .frame(minHeight: 60)
        .contentShape(Rectangle())
    }

    private func load() async {
        do {
            lists = try await session.client().lists()
            message = nil
        } catch { message = error.localizedDescription }
        loaded = true
    }

    private func create() async {
        let title = newTitle.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        do {
            let answer = try await session.client().createList(title: title, tier: newTier)
            newTitle = ""
            if answer.pending { note = "Waiting for a yes." }
            await load()
        } catch { message = error.localizedDescription }
    }
}

/// One list: add an item, tick it, bring a done one back.
struct ListDetailView: View {
    @EnvironmentObject private var session: Session
    var parentId: String
    var title: String

    var body: some View {
        ScrollView {
            ItemsEditor(parentId: parentId, placeholder: "Add an item", empty: "Nothing on it yet.")
                .padding(16)
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .background(Theme.ground.ignoresSafeArea())
        .toolbar {
            // The owner renames, re-tiers, completes, archives, or deletes the list in its editor.
            if !session.isMember {
                ToolbarItem(placement: .primaryAction) {
                    NavigationLink("Edit") { RecordView(type: "project", id: parentId) }
                }
            }
        }
    }
}

/// The items of a list, or the steps of a task. Open items first, then the done ones with "Again".
struct ItemsEditor: View {
    @EnvironmentObject private var session: Session
    var parentId: String
    var placeholder: String
    var empty: String
    var label: String? = nil
    @State private var items: [Entity] = []
    @State private var loaded = false
    @State private var newItem = ""
    @State private var message: String?
    /// A member's write that waits for the owner. It is news, not an error.
    @State private var note: String?
    @FocusState private var adding: Bool
    @State private var renaming: Entity?
    @State private var renameText = ""
    @State private var deleting: Entity?

    var body: some View {
        let open = items.filter { !$0.isDone }
        let done = items.filter { $0.isDone }
        VStack(alignment: .leading, spacing: 12) {
            if let label { SmallLabel(text: label) }
            HStack(spacing: 8) {
                TextField(hint: placeholder, text: $newItem)
                    .textFieldStyle(FieldStyle())
                    .focused($adding)
                    .submitLabel(.done)
                    .onSubmit { Task { await add() } }
                Button { Task { await add() } } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.paper)
                        .frame(width: 44, height: 44)
                        .background(Circle().fill(Theme.ink))
                }
                .buttonStyle(.plain)
                .opacity(newItem.trimmingCharacters(in: .whitespaces).isEmpty ? 0.3 : 1)
                .disabled(newItem.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityLabel("Add")
            }
            if loaded && items.isEmpty {
                Text(empty).font(Theme.font(14)).foregroundStyle(Theme.graphite)
            }
            if !open.isEmpty { rows(open) }
            if !done.isEmpty {
                SmallLabel(text: open.isEmpty ? "All done" : "Done")
                rows(done)
            }
            if let note { MessageLine(text: note) }
            if let message { MessageLine(text: message, isError: true) }
        }
        .task { await load() }
    }

    private func rows(_ list: [Entity]) -> some View {
        VStack(spacing: 0) {
            ForEach(list) { item in
                HStack(spacing: 4) {
                    TickButton(done: item.isDone, title: item.title) { Task { await toggle(item) } }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(Theme.row)
                            .strikethrough(item.isDone, color: Theme.stone)
                            .foregroundStyle(item.isDone ? Theme.stone : Theme.ink)
                        if let line = item.doneLine {
                            Text(line).font(Theme.small).foregroundStyle(Theme.stone)
                        }
                    }
                    Spacer()
                    if item.isDone {
                        Button("Again") { Task { await toggle(item) } }.buttonStyle(TextButtonStyle())
                    }
                }
                .padding(.leading, 6)
                .padding(.trailing, Theme.Space.l)
                .frame(minHeight: 52)
                .contentShape(Rectangle())
                .contextMenu {
                    if !session.isMember {
                        Button("Rename") { renameText = item.title; renaming = item }
                        Button("Delete", role: .destructive) { deleting = item }
                    }
                }
                if item.id != list.last?.id { Theme.hair.frame(height: 1).padding(.leading, Theme.Space.l) }
            }
        }
        .card(padding: 0)
        .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField(hint: "Name", text: $renameText)
            Button("Save") {
                if let item = renaming { Task { await rename(item) } }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .confirmationDialog("Delete \(deleting?.title ?? "it")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let item = deleting { Task { await delete(item) } }
                deleting = nil
            }
            Button("Cancel", role: .cancel) { deleting = nil }
        }
    }

    private func load() async {
        do {
            items = try await session.client().items(parent: parentId).items
            message = nil
        } catch { message = error.localizedDescription }
        loaded = true
    }

    private func add() async {
        let title = newItem.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        newItem = ""
        do {
            let answer = try await session.client().addItem(parent: parentId, title: title)
            if let item = answer.entity {
                withAnimation { items.insert(item, at: items.firstIndex { $0.isDone } ?? items.count) }
                note = nil
            } else if answer.pending {
                note = "\(title): waiting for a yes."
            }
            // The keyboard stays up, so a list of ten things is ten lines, not ten taps on the field.
            adding = true
        } catch {
            newItem = title
            message = error.localizedDescription
        }
    }

    private func rename(_ item: Entity) async {
        let text = renameText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, text != item.title else { return }
        do {
            _ = try await session.client().updateRecord(type: "task", id: item.id, body: ["title": text])
            items = try await session.client().items(parent: parentId).items
            message = nil
        } catch { message = error.localizedDescription }
    }

    private func delete(_ item: Entity) async {
        do {
            try await session.client().deleteEntity(type: "task", id: item.id)
            withAnimation { items.removeAll { $0.id == item.id } }
            message = nil
        } catch { message = error.localizedDescription }
    }

    private func toggle(_ item: Entity) async {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        do {
            let answer = try await session.client().setDone(item.id, !item.isDone)
            // The server orders the list: open items as added, then the last done ones.
            let fresh = try await session.client().items(parent: parentId).items
            withAnimation { items = fresh }
            message = nil
            note = answer.pending ? "\(item.title): waiting for a yes." : nil
        } catch { message = error.localizedDescription }
    }
}

/// The one done mark of the app: a filled check circle in dark teal. An open item has an empty circle.
struct DoneMark: View {
    var done: Bool
    var body: some View {
        if done {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 24))
                .foregroundStyle(Theme.tealDark)
                .frame(width: 24, height: 24)
        } else {
            Circle().stroke(Theme.stone, lineWidth: 1.5).frame(width: 24, height: 24)
        }
    }
}

/// A round tick, 44 points to tap. It names its task for VoiceOver. A routine checks in, and a task is marked done.
struct TickButton: View {
    var done: Bool
    var title: String
    var routine = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            DoneMark(done: done)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var label: String {
        if routine { return done ? "Done: \(title). Tap to take it back." : "Check in: \(title)" }
        return done ? "Done: \(title). Tap to open again." : "Mark as done: \(title)"
    }
}

/// The people a task is for. Any one of them can complete it.
struct ForPeopleCard: View {
    @EnvironmentObject private var session: Session
    var taskId: String
    var links: [GraphLink]
    var changed: () async -> Void
    @State private var people: [Entity] = []
    @State private var message: String?

    var body: some View {
        let chosen = links.filter { $0.rel == "for" && $0.direction == "out" && $0.peer.type == "person" }
        let left = people.filter { person in !chosen.contains { $0.peer.id == person.id } }
        VStack(alignment: .leading, spacing: 8) {
            SmallLabel(text: "For")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(chosen) { link in
                        Button {
                            Task { await remove(link.id) }
                        } label: {
                            HStack(spacing: 4) {
                                Text(link.peer.title)
                                Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                            }
                        }
                        .buttonStyle(ChipButtonStyle(selected: true))
                        .accessibilityLabel("Remove \(link.peer.title)")
                    }
                    if !left.isEmpty {
                        Menu {
                            ForEach(left) { person in
                                Button(person.title) { Task { await add(person.id) } }
                            }
                        } label: {
                            Text(chosen.isEmpty ? "Add a person" : "Add").font(Theme.small).foregroundStyle(Theme.ink)
                                .padding(.horizontal, 12).padding(.vertical, 7)
                                .overlay(Capsule().stroke(Theme.hair, lineWidth: 1))
                        }
                    }
                }
            }
            if let message { MessageLine(text: message, isError: true) }
        }
        .card()
        .task {
            people = (try? await session.client().entities("person")) ?? []
        }
    }

    private func add(_ personId: String) async {
        do {
            try await session.client().link(fromType: "task", fromId: taskId, rel: "for", toType: "person", toId: personId)
            await changed()
        } catch { message = error.localizedDescription }
    }

    private func remove(_ linkId: String) async {
        do {
            try await session.client().deleteLink(linkId)
            await changed()
        } catch { message = error.localizedDescription }
    }
}
