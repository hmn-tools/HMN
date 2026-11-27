import SwiftUI

/// The schema of the graph, read once from your HMN and kept for the life of the app.
@MainActor
enum SchemaCache {
    private(set) static var value: AppSchema?
    static func load(_ session: Session) async -> AppSchema? {
        if let value { return value }
        value = try? await session.client().schema()
        return value
    }
}

/// The record editor keeps its old name, so every page that opens a record still does.
struct EntityDetailView: View {
    var type: String
    var id: String
    var body: some View { RecordView(type: type, id: id) }
}

/**
 One editor for every type, built from the schema: the name and the text, the kind, the status, a date where the type
 has one, the typed fields of the type, the area, the links in words, who sees it, and Archive or Delete.
 A mirrored event and a source are read: only who sees it changes. docs/UX-PASS.md, batch 2.
 */
struct RecordView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    let type: String
    let id: String

    @State private var schema: AppSchema?
    @State private var entity: Entity?
    @State private var links: [GraphLink] = []
    @State private var near: Neighbours?
    @State private var areas: [AreaRow] = []
    @State private var draft = Draft()
    @State private var saved = Draft()
    @State private var mirrored = false
    @State private var loaded = false
    @State private var working = false
    @State private var message: String?
    @State private var failed = false
    @State private var confirmDelete = false
    @State private var unlinking: GraphLink?
    @State private var addingLink = false
    @State private var askTier: String?
    /// True while the owner decides whether to drop the edits.
    @State private var askLeave = false

    /// Edits that are not saved. While there are some, Back becomes Cancel, and Cancel asks first.
    private var dirty: Bool { loaded && !readOnly && draft != saved }

    /// The editable part of a record. Save sends only what changed.
    struct Draft: Equatable {
        var title = ""
        var body = ""
        var status = ""
        var kind = ""
        var areaId = ""
        var hasDue = false
        var due = Date()
        var dueHasTime = false
        var fields: [String: String] = [:]
        var childTier = ""
    }

    private let tiers = ["public", "household", "personal", "private", "sealed"]
    private var readOnly: Bool { mirrored || type == "source" }
    private var usesDate: Bool { ["task", "event", "project"].contains(type) }
    private var statuses: [String] { (schema?.statuses[type] ?? []).filter { $0 != "archived" } }
    private var canArchive: Bool { schema?.statuses[type]?.contains("archived") == true }
    private var isArchived: Bool { entity?.status == "archived" }
    private var fieldSpecs: [AppSchema.FieldSpec] { schema?.fields[type] ?? [] }
    private var kinds: [KindInfo] {
        // A list and a step have their own screens. Their kind is not a choice here.
        if type == "task" && entity?.kind == "item" { return [] }
        if type == "project" && entity?.kind == "list" { return [] }
        return (schema?.kinds(of: type) ?? []).filter { !(type == "task" && $0.kind == "item") && !(type == "project" && $0.kind == "list") }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !loaded && message == nil { LoadingState() }
                if loaded {
                    if mirrored { MessageLine(text: "From your calendar. Change it there. Who sees it can change here.") }
                    if type == "source" { MessageLine(text: "Where facts came from. It is kept as it is.") }
                    if isArchived { MessageLine(text: "Archived. It is out of your lists and search.") }
                    mainCard
                    if !readOnly { detailsCard }
                    if !readOnly && !fieldSpecs.isEmpty { fieldsCard }
                    if !readOnly {
                        Button(working ? "Saving" : "Save") { Task { await save() } }
                            .buttonStyle(PillButtonStyle())
                            .disabled(working || draft == saved || draft.title.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    if let message { MessageLine(text: message, isError: failed) }
                    if type == "task", let entity, entity.kind != "item" {
                        ForPeopleCard(taskId: id, links: links) { await load() }
                        ItemsEditor(parentId: id, placeholder: "Add a step", empty: "No steps.", label: "Steps")
                    }
                    linkedCard
                    nearby
                    tierCard
                    footer
                }
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(Words.type(type))
        .navigationBarTitleDisplayMode(.inline)
        .background(Theme.ground.ignoresSafeArea())
        .navigationBarBackButtonHidden(dirty)
        .interactiveDismissDisabled(dirty)
        .preference(key: UnsavedEditsKey.self, value: dirty)
        .toolbar {
            if dirty {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { askLeave = true } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(working || draft.title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .confirmationDialog("Drop your changes?", isPresented: $askLeave, titleVisibility: .visible) {
            Button("Drop the changes", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .task { await load() }
        .sheet(isPresented: $addingLink) {
            AddLinkSheet(fromType: type, fromId: id) { await load() }.themed()
        }
        .confirmationDialog("Remove the link to \(unlinking?.peer.title ?? "it")?", isPresented: Binding(get: { unlinking != nil }, set: { if !$0 { unlinking = nil } }), titleVisibility: .visible) {
            Button("Remove the link", role: .destructive) {
                if let link = unlinking { Task { await unlink(link.id) } }
                unlinking = nil
            }
            Button("Cancel", role: .cancel) { unlinking = nil }
        }
        .confirmationDialog(tierQuestion, isPresented: Binding(get: { askTier != nil }, set: { if !$0 { askTier = nil } }), titleVisibility: .visible) {
            Button("Yes, change it") {
                if let tier = askTier { Task { await setTier(tier) } }
                askTier = nil
            }
            Button("Cancel", role: .cancel) { askTier = nil }
        }
        .confirmationDialog("Delete \(draft.title.isEmpty ? "this" : draft.title)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            if canArchive && !isArchived {
                Button("Archive it") { Task { await archive(true) } }
            }
            Button("Delete", role: .destructive) { Task { await remove() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(canArchive && !isArchived ? "Archive keeps it out of the way and keeps it." : "Its history stays.")
        }
    }

    // MARK: cards

    private var mainCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            if readOnly {
                Text(draft.title).font(Theme.heading)
                if !draft.body.isEmpty { Text(draft.body).font(Theme.text).foregroundStyle(Theme.graphite) }
            } else {
                labeled("Name") {
                    TextField(hint: "Name", text: $draft.title).textFieldStyle(FieldStyle())
                }
                labeled(type == "note" ? "Text" : "About") {
                    TextField(hint: type == "note" ? "Write it here" : "Anything to remember", text: $draft.body, axis: .vertical)
                        .textFieldStyle(FieldStyle())
                        .lineLimit(type == "note" ? 6...20 : 2...10)
                }
            }
            if let line = entity?.doneLine {
                Text(line).font(Theme.small).foregroundStyle(Theme.stone)
            }
        }
        .card()
    }

    private var detailsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !kinds.isEmpty {
                labeled("Kind") {
                    chips(kinds.map { ($0.kind, $0.title) }, selection: $draft.kind)
                }
            }
            if statuses.count > 1 {
                labeled("Status") {
                    chips(statuses.map { ($0, Words.id($0)) }, selection: $draft.status)
                }
            }
            if usesDate {
                labeled(type == "event" ? "When" : "Due") {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Toggle(isOn: $draft.hasDue) { Text(draft.hasDue ? "On a date" : "No date").font(Theme.text) }
                                .tint(Theme.tealDark)
                            if draft.hasDue {
                                Toggle(isOn: $draft.dueHasTime) { Text("Time").font(Theme.text) }
                                    .tint(Theme.tealDark)
                                    .fixedSize()
                            }
                        }
                        if draft.hasDue {
                            DatePicker("Date", selection: $draft.due, displayedComponents: draft.dueHasTime ? [.date, .hourAndMinute] : [.date])
                                .labelsHidden()
                        }
                    }
                }
            }
            if type == "area" {
                labeled("Items filed here are") {
                    chips(tiers.map { ($0, Words.id($0)) }, selection: $draft.childTier)
                }
            } else if type != "source" && !areas.isEmpty {
                labeled("Area") {
                    chips([("", "None")] + areas.map { ($0.id, $0.title) }, selection: $draft.areaId)
                }
            }
        }
        .card()
    }

    private var fieldsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(fieldSpecs, id: \.key) { spec in
                labeled(spec.label) { field(spec) }
            }
        }
        .card()
    }

    @ViewBuilder
    private func field(_ spec: AppSchema.FieldSpec) -> some View {
        let binding = Binding(get: { draft.fields[spec.key] ?? "" }, set: { draft.fields[spec.key] = $0 })
        switch spec.type {
        case "long":
            TextField(hint: spec.label, text: binding, axis: .vertical).textFieldStyle(FieldStyle()).lineLimit(2...8)
        case "number":
            TextField(hint: spec.label, text: binding).textFieldStyle(FieldStyle()).keyboardType(.numberPad)
        case "url":
            TextField(hint: "https://", text: binding).textFieldStyle(FieldStyle())
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
        case "choice":
            chips([("", "None")] + (spec.choices ?? []).map { ($0, Words.id($0)) }, selection: binding)
        case "date":
            DateField(value: binding)
        default:
            TextField(hint: spec.label, text: binding).textFieldStyle(FieldStyle())
        }
    }

    @ViewBuilder
    private var linkedCard: some View {
        let shown = links.filter { !(type == "task" && $0.rel == "for" && $0.peer.type == "person") && $0.peer.kind != "item" }
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SmallLabel(text: "Linked")
                Spacer()
                if !readOnly || mirrored {
                    Button("Add a link") { addingLink = true }.buttonStyle(TextButtonStyle())
                }
            }
            if shown.isEmpty {
                Text("Nothing linked yet.").font(Theme.small).foregroundStyle(Theme.stone)
            } else {
                VStack(spacing: 0) {
                    ForEach(shown) { link in
                        HStack(spacing: 8) {
                            NavigationLink {
                                ItemPage(type: link.peer.type, id: link.peer.id, title: link.peer.title)
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(link.peer.title).font(Theme.row).foregroundStyle(Theme.ink)
                                        Text(relationLine(link)).font(Theme.small).foregroundStyle(Theme.stone)
                                    }
                                    Spacer(minLength: 0)
                                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
                                        .accessibilityHidden(true)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            Button { unlinking = link } label: {
                                Image(systemName: "xmark").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
                                    .frame(width: 44, height: 44).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove the link to \(link.peer.title)")
                        }
                        .padding(.leading, 16)
                        .frame(minHeight: 60)
                        if link.id != shown.last?.id { Theme.hair.frame(height: 1).padding(.leading, 16) }
                    }
                }
                .card(padding: 0)
            }
        }
    }

    /// "For · Person", "Part of · Project", or "Has · Task" for a link that comes in.
    private func relationLine(_ link: GraphLink) -> String {
        let relation = schema?.relation(link.rel)
        let word = link.direction == "out" ? (relation?.out ?? Words.id(link.rel)) : (relation?.inWord ?? Words.id(link.rel))
        return "\(word) · \(Words.type(link.peer.type))"
    }

    @ViewBuilder
    private var tierCard: some View {
        if let entity {
            VStack(alignment: .leading, spacing: 8) {
                SmallLabel(text: "Who sees it")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(tiers, id: \.self) { tier in
                            Button(Words.id(tier)) { chooseTier(tier) }
                                .buttonStyle(ChipButtonStyle(selected: entity.tier == tier))
                                .accessibilityAddTraits(entity.tier == tier ? [.isSelected] : [])
                        }
                    }
                }
                Text(tierSourceLine(entity)).font(Theme.small).foregroundStyle(Theme.stone)
            }
            .card()
        }
    }

    private func tierSourceLine(_ entity: Entity) -> String {
        switch entity.tierSource {
        case "override": return "Set on this item."
        case "area":
            if let area = areas.first(where: { $0.id == entity.areaId }) { return "From \(area.title)." }
            return "From its area."
        default: return "Personal unless you choose."
        }
    }

    private var footer: some View {
        HStack(spacing: 24) {
            if canArchive && !readOnly {
                Button(isArchived ? "Bring it back" : "Archive") { Task { await archive(!isArchived) } }
                    .buttonStyle(TextButtonStyle())
            }
            Spacer()
            if !readOnly {
                Button("Delete") { confirmDelete = true }.buttonStyle(TextButtonStyle(danger: true))
            }
        }
        .padding(.horizontal, 4)
    }

    /// The rows two links away, each with the linked row it is reached through. At most eight.
    @ViewBuilder private var nearby: some View {
        if let near {
            let byId = Dictionary(near.nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            let far = Array(near.nodes.filter { $0.distance == 2 && $0.kind != "item" }.prefix(8))
            if !far.isEmpty {
                SmallLabel(text: "Nearby")
                VStack(spacing: 0) {
                    ForEach(far) { node in
                        NavigationLink {
                            ItemPage(type: node.type, id: node.id, title: node.title)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(node.title).font(Theme.row).foregroundStyle(Theme.ink)
                                    Text(through(node, near, byId)).font(Theme.small).foregroundStyle(Theme.stone)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
                                    .accessibilityHidden(true)
                            }
                            .padding(.horizontal, 16)
                            .frame(minHeight: 60)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if node.id != far.last?.id { Theme.hair.frame(height: 1).padding(.leading, 16) }
                    }
                }
                .card(padding: 0)
            }
        }
    }

    private func through(_ node: Neighbours.Node, _ near: Neighbours, _ byId: [String: Neighbours.Node]) -> String {
        let step = near.edges.compactMap { edge -> Neighbours.Node? in
            let other = edge.from == node.id ? edge.to : edge.to == node.id ? edge.from : nil
            guard let other, let found = byId[other], found.distance == 1 else { return nil }
            return found
        }.first
        return [Words.type(node.type), step.map { "through \($0.title)" }].compactMap { $0 }.joined(separator: " · ")
    }

    // MARK: parts

    private func labeled<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SmallLabel(text: label)
            content()
        }
    }

    /// A row of chips that scrolls to the chosen one, so a choice at the end of the row is never out of sight.
    private func chips(_ options: [(String, String)], selection: Binding<String>) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(options, id: \.0) { option in
                        Button(option.1) { selection.wrappedValue = option.0 }
                            .buttonStyle(ChipButtonStyle(selected: selection.wrappedValue == option.0))
                            .accessibilityAddTraits(selection.wrappedValue == option.0 ? [.isSelected] : [])
                            .id(option.0)
                    }
                }
            }
            .onAppear { proxy.scrollTo(selection.wrappedValue, anchor: .center) }
        }
    }

    private var tierQuestion: String {
        switch askTier {
        case "public": return "Show it to anyone? It can be on a shared display and the lock screen."
        case "household": return "Share it with your household? It shows on the fridge and their phones."
        default: return "Make it less private?"
        }
    }

    /// A move toward Public asks first. A move toward Sealed does not.
    private func chooseTier(_ tier: String) {
        guard let entity, tier != entity.tier else { return }
        let order = ["public", "household", "personal", "private", "sealed"]
        let from = order.firstIndex(of: entity.tier) ?? 2
        let to = order.firstIndex(of: tier) ?? 2
        if to < from { askTier = tier } else { Task { await setTier(tier) } }
    }

    // MARK: work

    private func load() async {
        schema = await SchemaCache.load(session)
        do {
            let (record, properties) = try await session.client().record(type: type, id: id)
            entity = record
            mirrored = (properties["mirror"] as? Bool) == true
            var next = Draft()
            next.title = record.title
            next.body = record.body ?? ""
            next.status = record.status ?? ""
            next.kind = record.kind ?? ""
            next.areaId = record.areaId ?? ""
            next.childTier = (properties["child_tier"] as? String) ?? ""
            if let due = record.dueAt, !due.isEmpty {
                next.hasDue = true
                next.dueHasTime = due.contains("T")
                next.due = DateText.parse(due) ?? Date()
            }
            for spec in schema?.fields[type] ?? [] {
                if let value = properties[spec.key] {
                    if let number = value as? Double {
                        next.fields[spec.key] = number.rounded() == number ? String(Int(number)) : String(number)
                    } else if let text = value as? String {
                        next.fields[spec.key] = text
                    }
                }
            }
            draft = next
            saved = next
            links = (try? await session.client().links(type: type, id: id)) ?? []
            near = try? await session.client().neighbours(type: type, id: id)
            if type != "area" && type != "source" && areas.isEmpty { areas = (try? await session.client().areas()) ?? [] }
            loaded = true
        } catch {
            message = error.localizedDescription
            failed = true
            loaded = true
        }
    }

    private func save() async {
        working = true
        defer { working = false }
        var body: [String: Any] = [:]
        if draft.title != saved.title { body["title"] = draft.title.trimmingCharacters(in: .whitespaces) }
        if draft.body != saved.body { body["body"] = draft.body }
        if draft.status != saved.status { body["status"] = draft.status.isEmpty ? NSNull() : draft.status }
        if draft.kind != saved.kind { body["kind"] = draft.kind.isEmpty ? NSNull() : draft.kind }
        if draft.areaId != saved.areaId { body["area_id"] = draft.areaId.isEmpty ? NSNull() : draft.areaId }
        let due = draft.hasDue ? DateText.stored(draft.due, withTime: draft.dueHasTime) : ""
        let savedDue = saved.hasDue ? DateText.stored(saved.due, withTime: saved.dueHasTime) : ""
        if due != savedDue { body["due_at"] = due.isEmpty ? NSNull() : due }
        var patch: [String: Any] = [:]
        for spec in fieldSpecs where (draft.fields[spec.key] ?? "") != (saved.fields[spec.key] ?? "") {
            let value = (draft.fields[spec.key] ?? "").trimmingCharacters(in: .whitespaces)
            if value.isEmpty { patch[spec.key] = NSNull() }
            else if spec.type == "number", let number = Double(value) { patch[spec.key] = number }
            else { patch[spec.key] = value }
        }
        if draft.childTier != saved.childTier { patch["child_tier"] = draft.childTier.isEmpty ? NSNull() : draft.childTier }
        if !patch.isEmpty { body["properties_patch"] = patch }
        guard !body.isEmpty else { return }
        do {
            _ = try await session.client().updateRecord(type: type, id: id, body: body)
            message = "Saved."
            failed = false
            await load()
            await session.refreshToday()
        } catch {
            message = error.localizedDescription
            failed = true
        }
    }

    private func setTier(_ tier: String) async {
        do {
            _ = try await session.client().updateRecord(type: type, id: id, body: ["tier": tier])
            message = "Now \(Words.id(tier))."
            failed = false
            await load()
        } catch {
            message = error.localizedDescription
            failed = true
        }
    }

    private func archive(_ on: Bool) async {
        let back = schema?.statuses[type]?.first ?? "open"
        do {
            _ = try await session.client().updateRecord(type: type, id: id, body: ["status": on ? "archived" : back])
            message = on ? "Archived." : "Back in your lists."
            failed = false
            await load()
        } catch {
            message = error.localizedDescription
            failed = true
        }
    }

    private func unlink(_ linkId: String) async {
        do {
            try await session.client().deleteLink(linkId)
            await load()
        } catch {
            message = error.localizedDescription
            failed = true
        }
    }

    private func remove() async {
        do {
            try await session.client().deleteEntity(type: type, id: id)
            dismiss()
        } catch {
            message = error.localizedDescription
            failed = true
        }
    }
}

/// A date field that can be empty. The value is stored as YYYY-MM-DD.
struct DateField: View {
    @Binding var value: String
    var body: some View {
        HStack {
            Toggle(isOn: Binding(get: { !value.isEmpty }, set: { value = $0 ? DateText.stored(Date(), withTime: false) : "" })) {
                Text(value.isEmpty ? "No date" : "On a date").font(Theme.text)
            }
            .tint(Theme.tealDark)
            if !value.isEmpty {
                DatePicker("Date", selection: Binding(get: { DateText.parse(value) ?? Date() }, set: { value = DateText.stored($0, withTime: false) }), displayedComponents: [.date])
                    .labelsHidden()
            }
        }
    }
}

/// The two stored forms of a date: a day (YYYY-MM-DD) and an instant.
enum DateText {
    private static let day: DateFormatter = {
        let format = DateFormatter()
        format.calendar = Calendar(identifier: .gregorian)
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "yyyy-MM-dd"
        return format
    }()

    static func parse(_ value: String) -> Date? {
        if value.count == 10 { return day.date(from: value) }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    static func stored(_ date: Date, withTime: Bool) -> String {
        withTime ? ISO8601DateFormatter().string(from: date) : day.string(from: date)
    }
}

/// The one way the app writes a date for the owner: "Today", "Tomorrow", "Yesterday", "Fri 13 Nov", or
/// "13 Nov 2027" in another year. A time follows the phone's own 12 or 24 hour setting.
/// It reads both stored forms (a day and an instant). A string that it cannot read is shown as it came.
enum When {
    private static let weekday: DateFormatter = {
        let format = DateFormatter()
        format.dateFormat = "EEE d MMM"
        return format
    }()
    private static let withYear: DateFormatter = {
        let format = DateFormatter()
        format.dateFormat = "d MMM yyyy"
        return format
    }()
    private static let clock: DateFormatter = {
        let format = DateFormatter()
        format.dateStyle = .none
        format.timeStyle = .short
        return format
    }()

    /// A day in words, from a date.
    static func day(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInTomorrow(date) { return "Tomorrow" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if calendar.isDate(date, equalTo: Date(), toGranularity: .year) { return weekday.string(from: date) }
        return withYear.string(from: date)
    }

    /// A day in words, from a stored day or instant. An empty or unreadable value gives its own text.
    static func day(_ stored: String?) -> String {
        guard let stored, !stored.isEmpty else { return "" }
        guard let date = DateText.parse(stored) else { return stored }
        return day(date)
    }

    /// The time of day, in the phone's own clock setting.
    static func time(_ date: Date) -> String { clock.string(from: date) }

    /// The time with seconds, in the phone's own clock setting. Each knock shows a new time.
    static func timeWithSeconds(_ date: Date) -> String { seconds.string(from: date) }
    private static let seconds: DateFormatter = {
        let format = DateFormatter()
        format.dateStyle = .none
        format.timeStyle = .medium
        return format
    }()

    /// A day and a time, such as "Today 14:05". A stored day with no time shows the day only.
    static func dayAndTime(_ stored: String?) -> String {
        guard let stored, !stored.isEmpty else { return "" }
        guard let date = DateText.parse(stored) else { return stored }
        if stored.count == 10 { return day(date) }
        return "\(day(date)) \(time(date))"
    }
}

/// Link this record to another: find it, choose how they relate, and add it.
struct AddLinkSheet: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    let fromType: String
    let fromId: String
    var added: () async -> Void
    @State private var query = ""
    @State private var results: [Entity] = []
    @State private var target: Entity?
    @State private var rel = "about"
    @State private var schema: AppSchema?
    @State private var message: String?
    @State private var working = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let target {
                        VStack(alignment: .leading, spacing: 10) {
                            SmallLabel(text: "Link to")
                            Text(target.title).font(Theme.heading)
                            Text(Words.type(target.type)).font(Theme.small).foregroundStyle(Theme.stone)
                            Button("Choose another") { self.target = nil }.buttonStyle(TextButtonStyle())
                        }
                        .card()
                        VStack(alignment: .leading, spacing: 8) {
                            SmallLabel(text: "How")
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(schema?.relations ?? [], id: \.rel) { relation in
                                        Button(relation.out) { rel = relation.rel }
                                            .buttonStyle(ChipButtonStyle(selected: rel == relation.rel))
                                            .accessibilityAddTraits(rel == relation.rel ? [.isSelected] : [])
                                    }
                                }
                            }
                        }
                        .card()
                        Button(working ? "Adding" : "Add the link") { Task { await add(target) } }
                            .buttonStyle(PillButtonStyle())
                            .disabled(working)
                    } else {
                        TextField(hint: "Find a person, a place, a thing", text: $query)
                            .textFieldStyle(FieldStyle())
                            .autocorrectionDisabled()
                            .onChange(of: query) { _, text in Task { await find(text) } }
                        if !results.isEmpty {
                            VStack(spacing: 0) {
                                ForEach(results.filter { $0.id != fromId }) { result in
                                    Button {
                                        target = result
                                        rel = Self.suggest(from: fromType, to: result.type)
                                    } label: {
                                        HStack {
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(result.title).font(Theme.row).foregroundStyle(Theme.ink)
                                                Text(Words.type(result.type)).font(Theme.small).foregroundStyle(Theme.stone)
                                            }
                                            Spacer()
                                        }
                                        .padding(.horizontal, 16)
                                        .frame(minHeight: 60)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    Theme.hair.frame(height: 1).padding(.leading, 16)
                                }
                            }
                            .card(padding: 0)
                        } else if query.count >= 2 {
                            Text("Nothing found.").font(Theme.small).foregroundStyle(Theme.stone)
                        }
                    }
                    if let message { MessageLine(text: message, isError: true) }
                }
                .padding(16)
            }
            .navigationTitle("Add a link")
            .navigationBarTitleDisplayMode(.inline)
            .background(Theme.ground.ignoresSafeArea())
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task { schema = await SchemaCache.load(session) }
        }
    }

    /// The usual relation between two types, so most links are one tap.
    static func suggest(from: String, to: String) -> String {
        switch (from, to) {
        case ("task", "project"), ("project", "goal"): return "part_of"
        case ("task", "person"): return "for"
        case ("event", "person"): return "with"
        case ("event", "place"): return "at"
        case ("person", "asset"): return "cares_for"
        case (_, "area"): return "in"
        default: return "about"
        }
    }

    private func find(_ text: String) async {
        let needle = text.trimmingCharacters(in: .whitespaces)
        guard needle.count >= 2 else { results = []; return }
        results = (try? await session.client().search(needle)) ?? []
    }

    private func add(_ target: Entity) async {
        working = true
        defer { working = false }
        do {
            try await session.client().link(fromType: fromType, fromId: fromId, rel: rel, toType: target.type, toId: target.id)
            await added()
            dismiss()
        } catch { message = error.localizedDescription }
    }
}

/// Make a new record: what it is and its name. The editor opens next, for the rest.
struct NewRecordSheet: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State var type: String
    var created: (Entity) -> Void
    @State private var title = ""
    @State private var working = false
    @State private var message: String?

    static let choices: [(String, String)] = [("task", "Task"), ("note", "Note"), ("project", "Project"), ("person", "Person"), ("place", "Place"), ("asset", "Thing"), ("goal", "Goal"), ("event", "Date")]

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Self.choices, id: \.0) { choice in
                            Button(choice.1) { type = choice.0 }
                                .buttonStyle(ChipButtonStyle(selected: type == choice.0))
                                .accessibilityAddTraits(type == choice.0 ? [.isSelected] : [])
                        }
                    }
                }
                TextField(hint: "Name", text: $title)
                    .textFieldStyle(FieldStyle())
                    .submitLabel(.done)
                    .onSubmit { Task { await create() } }
                Button(working ? "Making it" : "Make it") { Task { await create() } }
                    .buttonStyle(PillButtonStyle())
                    .disabled(working || title.trimmingCharacters(in: .whitespaces).isEmpty)
                if let message { MessageLine(text: message, isError: true) }
                Spacer()
            }
            .padding(16)
            .navigationTitle("New")
            .navigationBarTitleDisplayMode(.inline)
            .background(Theme.ground.ignoresSafeArea())
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium])
    }

    /// The first status and the plain kind of each type.
    private var defaults: [String: Any] {
        switch type {
        case "task": return ["status": "open", "kind": "task"]
        case "note": return ["status": "open", "kind": "note"]
        case "project", "goal": return ["status": "active"]
        case "event": return ["status": "upcoming", "kind": "appointment"]
        case "person", "place", "asset": return ["kind": "other"]
        default: return [:]
        }
    }

    private func create() async {
        let name = title.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        working = true
        defer { working = false }
        var body = defaults
        body["title"] = name
        do {
            let made = try await session.client().createRecord(type: type, body: body)
            dismiss()
            created(made)
        } catch { message = error.localizedDescription }
    }
}

/// True when a record editor below has edits that are not saved. A sheet hides its Close then, so the editor's
/// Cancel, which asks first, is the one way out.
struct UnsavedEditsKey: PreferenceKey {
    static var defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}
