import SwiftUI

/**
 The job of an agent key, as the owner sets it: a short purpose, the areas it can read, whether it reads items
 with no area, and the types it can read. The server enforces the lists. The purpose is a label for the owner,
 and the agent never receives it. docs/SCHEMA.md, "The ceiling of an agent key".
 */
struct JobDraft: Equatable {
    var purpose = ""
    var areas: Set<String> = []
    var noArea = false
    var types: Set<String> = []
    /// True when the owner lets the agent keep its own copy and ask for the feed of changes.
    var memory = false
    /// True when the key has no area list: it reads every area up to its ceiling.
    var areasOpen = true

    static let purposeMax = 200
    /// The types the owner can choose, in the order that the chips show. The server word for a Thing is `asset`, and for a Date it is `event`.
    static let typeChoices = ["task", "note", "person", "place", "asset", "goal", "project", "event", "habit"]

    static func typeLabel(_ type: String) -> String { type == "event" ? "Date" : Words.type(type) }

    init() {}

    /// The job of a key that exists.
    init(key: AgentKey) {
        purpose = key.purpose ?? ""
        if let list = key.allowAreas {
            areasOpen = false
            areas = Set(list.filter { $0 != "none" })
            noArea = list.contains("none")
        }
        types = Set(key.allowTypes ?? [])
        memory = key.memory == true
    }

    /// The job of a new key: it reads no area until the owner chooses one.
    static var fresh: JobDraft {
        var draft = JobDraft()
        draft.areasOpen = false
        return draft
    }

    /// `strict` is the new key: no area chosen is no area read. For a key that exists, no area chosen is every area.
    mutating func toggleArea(_ id: String, strict: Bool) {
        if areas.contains(id) { areas.remove(id) } else { areas.insert(id) }
        settle(strict: strict)
    }

    mutating func setNoArea(_ on: Bool, strict: Bool) {
        noArea = on
        settle(strict: strict)
    }

    private mutating func settle(strict: Bool) {
        areasOpen = strict ? false : (areas.isEmpty && !noArea)
    }

    mutating func toggleType(_ type: String) {
        if types.contains(type) { types.remove(type) } else { types.insert(type) }
    }

    /// The fields for the key route. A list that is not set is `NSNull`, which the server reads as no limit.
    var fields: [String: Any] {
        let list: Any = areasOpen ? NSNull() : (areas.sorted() + (noArea ? ["none"] : []))
        let kinds: Any = types.isEmpty ? NSNull() : DraftOrder.sorted(types)
        return ["purpose": purpose.trimmingCharacters(in: .whitespacesAndNewlines), "allow_areas": list, "allow_types": kinds, "memory": memory]
    }
}

private enum DraftOrder {
    static func sorted(_ types: Set<String>) -> [String] { JobDraft.typeChoices.filter { types.contains($0) } }
}

/// One area that the owner can choose.
struct AreaChoice: Identifiable, Hashable {
    var id: String
    var title: String
}

/// The choices of a job. The new-key sheet and the Job card both use it.
struct JobChoices: View {
    @Binding var draft: JobDraft
    let areas: [AreaChoice]
    /// A new key reads nothing until the owner chooses an area.
    var strict = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                SmallLabel(text: "What it is for")
                TextField(hint: "Keep the car service on track", text: $draft.purpose, axis: .vertical)
                    .textFieldStyle(FieldStyle())
                    .lineLimit(1...3)
                    .onChange(of: draft.purpose) { _, value in
                        if value.count > JobDraft.purposeMax { draft.purpose = String(value.prefix(JobDraft.purposeMax)) }
                    }
                Text("A note for you. The agent never sees it.").font(Theme.small).foregroundStyle(Theme.stone)
            }
            VStack(alignment: .leading, spacing: 6) {
                SmallLabel(text: "Areas it can read")
                if areas.isEmpty {
                    Text("You have no areas yet.").font(Theme.text).foregroundStyle(Theme.graphite)
                } else {
                    FlowLayout(spacing: 6) {
                        ForEach(areas) { area in
                            Button(area.title) { draft.toggleArea(area.id, strict: strict) }
                                .buttonStyle(ChipButtonStyle(selected: draft.areas.contains(area.id)))
                                .accessibilityAddTraits(draft.areas.contains(area.id) ? [.isSelected] : [])
                        }
                    }
                }
                Toggle(isOn: Binding(get: { draft.noArea }, set: { draft.setNoArea($0, strict: strict) })) {
                    Text("Items with no area").font(Theme.text)
                }
                .tint(Theme.tealDark)
                Text(areaSentence).font(Theme.small).foregroundStyle(Theme.stone)
            }
            VStack(alignment: .leading, spacing: 6) {
                SmallLabel(text: "Types it can read")
                FlowLayout(spacing: 6) {
                    ForEach(JobDraft.typeChoices, id: \.self) { type in
                        Button(JobDraft.typeLabel(type)) { draft.toggleType(type) }
                            .buttonStyle(ChipButtonStyle(selected: draft.types.contains(type)))
                            .accessibilityAddTraits(draft.types.contains(type) ? [.isSelected] : [])
                    }
                }
                Text(typeSentence).font(Theme.small).foregroundStyle(Theme.stone)
            }
        }
    }

    private var areaSentence: String {
        if draft.areasOpen { return "None chosen: it reads every area, up to its ceiling." }
        let titles = areas.filter { draft.areas.contains($0.id) }.map(\.title)
        var parts = titles
        if draft.noArea { parts.append("items with no area") }
        if parts.isEmpty { return "Choose the areas this agent needs. It reads nothing else." }
        return "It reads only \(ReviewText.list(parts)), and nothing else."
    }

    private var typeSentence: String {
        if draft.types.isEmpty { return "None chosen: it reads every type." }
        let names = JobDraft.typeChoices.filter { draft.types.contains($0) }.map { JobDraft.typeLabel($0).lowercased() }
        return "It reads only \(ReviewText.list(names))."
    }
}

/// The Job card of the agent page. It saves with the owner route for a key, and the page reloads its counts.
struct JobCard: View {
    let key: AgentKey
    let areas: [AreaChoice]
    /// Called with the changed key, after the server saved it.
    var onSaved: (AgentKey) async -> Void
    @EnvironmentObject private var session: Session
    @State private var draft: JobDraft
    @State private var saved: JobDraft
    @State private var message: String?
    @State private var failed = false
    @State private var working = false

    init(key: AgentKey, areas: [AreaChoice], onSaved: @escaping (AgentKey) async -> Void) {
        self.key = key
        self.areas = areas
        self.onSaved = onSaved
        let start = JobDraft(key: key)
        _draft = State(initialValue: start)
        _saved = State(initialValue: start)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SmallLabel(text: "Job")
            JobChoices(draft: $draft, areas: areas)
            VStack(alignment: .leading, spacing: 6) {
                Toggle(isOn: $draft.memory) {
                    Text("Keeps its own memory").font(Theme.text)
                }
                .tint(Theme.tealDark)
                Text("It can ask for each change it is allowed to see, up to 2,000 rows a day. Turn this on only for an agent you trust to hold a copy.")
                    .font(Theme.small).foregroundStyle(Theme.stone)
            }
            if let message { MessageLine(text: message, isError: failed) }
            Button("Save the job") { Task { await save() } }
                .buttonStyle(PillButtonStyle())
                .disabled(draft == saved || working)
        }
        .card()
    }

    private func save() async {
        working = true
        defer { working = false }
        do {
            let changed = try await session.client().changeKey(key.id, fields: draft.fields)
            let next = JobDraft(key: changed)
            draft = next
            saved = next
            failed = false
            message = "Saved."
            await onSaved(changed)
        } catch {
            failed = true
            message = error.localizedDescription
        }
    }
}

/// Chips that wrap onto the next line.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                y += rowHeight + spacing
                x = 0
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += rowHeight + spacing
                x = bounds.minX
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
