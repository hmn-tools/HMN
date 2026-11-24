import SwiftUI

/** The owner's areas and kinds. The words belong to the owner. A role is the fixed word that the rules read. */
struct AreasView: View {
    @EnvironmentObject private var session: Session
    @State private var areas: [AreaRow] = []
    @State private var kinds: [KindInfo] = []
    @State private var roles: [String: [String]] = [:]
    @State private var types: [String] = []
    @State private var message: String?
    @State private var working = false
    @State private var loaded = false

    @State private var areaTitle = ""
    @State private var areaKind = "other"
    @State private var areaTier = ""

    @State private var kindType = "area"
    @State private var kindTitle = ""
    @State private var kindRole = ""

    private let tiers = ["", "public", "household", "personal", "private", "sealed"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let message { MessageLine(text: message) }
                if loaded && areas.isEmpty { EmptyState(title: "No areas yet.") }
                if !areas.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(areas) { area in
                            areaCard(area)
                            if area.id != areas.last?.id { Theme.rule.frame(height: 1).padding(.leading, Theme.Space.l) }
                        }
                    }
                    .card(padding: 0)
                }

                SmallLabel(text: "Add an area").padding(.top, 10)
                VStack(alignment: .leading, spacing: 12) {
                    TextField("Name, for example Work", text: $areaTitle).textFieldStyle(FieldStyle()).autocorrectionDisabled()
                    picker("Kind", selection: $areaKind, options: kindsOf("area").map { ($0.kind, $0.title) })
                    picker("Tier", selection: $areaTier, options: tiers.map { ($0, $0.isEmpty ? "From the kind" : $0.capitalized) })
                    Text(tierNote).font(Theme.small).foregroundStyle(Theme.stone)
                    Button("Add the area") { Task { await addArea() } }
                        .buttonStyle(PillButtonStyle())
                        .disabled(areaTitle.isEmpty || working)
                }
                .card()

                SmallLabel(text: "Kinds").padding(.top, 14)
                ForEach(types, id: \.self) { type in
                    let list = kindsOf(type)
                    if !list.isEmpty {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(type.capitalized).font(Theme.label).foregroundStyle(Theme.stone)
                                .padding(.horizontal, Theme.Space.l).padding(.top, Theme.Space.m).padding(.bottom, 4)
                            ForEach(list) { kind in
                                kindRow(kind)
                                    .padding(.horizontal, Theme.Space.l)
                                    .frame(minHeight: 52)
                                if kind.id != list.last?.id { Theme.rule.frame(height: 1).padding(.leading, Theme.Space.l) }
                            }
                        }
                        .card(padding: 0)
                    }
                }

                SmallLabel(text: "Add a kind").padding(.top, 10)
                VStack(alignment: .leading, spacing: 12) {
                    picker("For", selection: $kindType, options: types.map { ($0, $0.capitalized) })
                    TextField("Name, for example Studio", text: $kindTitle).textFieldStyle(FieldStyle()).autocorrectionDisabled()
                    picker("Role", selection: $kindRole, options: [("", "No role")] + (roles[kindType] ?? []).map { ($0, $0.capitalized) })
                    Text(AreasView.roleNote(type: kindType, role: kindRole.isEmpty ? nil : kindRole))
                        .font(Theme.small).foregroundStyle(Theme.stone)
                    Button("Add the kind") { Task { await addKind() } }
                        .buttonStyle(PillButtonStyle())
                        .disabled(AreasView.slug(kindTitle).isEmpty || working)
                }
                .card()
            }
            .padding(22)
        }
        .navigationTitle("Areas and kinds")
        .background(Theme.ground.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: kindType) { _, _ in kindRole = "" }
        .task { await load() }
    }

    private func areaCard(_ area: AreaRow) -> some View {
        let kind = kinds.first { $0.type == "area" && $0.kind == area.kind }
        let tier = area.properties?.childTier ?? "personal"
        let kindName = kind?.title ?? (area.kind ?? "No kind")
        // The kind is named only when it differs from the area, so "Work" is not "Work · Work".
        let line = kindName.lowercased() == area.title.lowercased() ? tier.capitalized : "\(kindName) · \(tier.capitalized)"
        return VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(area.title).font(Theme.row)
                Spacer()
                Text(line).font(Theme.small).foregroundStyle(Theme.stone)
            }
            if let role = kind?.role {
                Text(AreasView.roleNote(type: "area", role: role)).font(Theme.small).foregroundStyle(Theme.graphite)
            }
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, Theme.Space.m)
        .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
    }

    private func kindRow(_ kind: KindInfo) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(kind.title).font(Theme.body)
                Text(kindLine(kind)).font(Theme.small).foregroundStyle(Theme.stone)
            }
            Spacer()
            if !kind.core && kind.inUse == 0 {
                Button("Remove") { Task { await remove(kind) } }
                    .font(Theme.font(13, weight: .medium)).foregroundStyle(Theme.graphite)
            }
        }
    }

    private func kindLine(_ kind: KindInfo) -> String {
        var parts: [String] = []
        if let role = kind.role { parts.append(role.capitalized) }
        if kind.core { parts.append("built in") }
        parts.append(kind.inUse == 0 ? "not used" : "\(kind.inUse) in use")
        return parts.joined(separator: " · ")
    }

    private func kindsOf(_ type: String) -> [KindInfo] { kinds.filter { $0.type == type } }

    /// What the server does when the owner gives no tier.
    private var tierNote: String {
        guard areaTier.isEmpty else { return "Items here are \(areaTier.capitalized)." }
        switch kinds.first(where: { $0.type == "area" && $0.kind == areaKind })?.role {
        case "health", "money": return "Items are Sealed."
        case "family": return "Items are Private."
        default: return "Items are Personal."
        }
    }

    /// One sentence for each role. A role with no sentence here has no rule.
    static func roleNote(type: String, role: String?) -> String {
        switch (type, role) {
        case ("area", "family"): return "Family dates go to this area."
        case ("area", "work"): return "Shown on the work screen."
        case ("area", "health"): return "Health goes here. No agent reads it."
        case ("area", "money"): return "No agent reads this area."
        case ("area", "sport"): return "Fixtures go to this area."
        case ("person", "self"): return "This kind is you."
        case ("person", "family"): return "Their dates are family dates."
        case ("person", "organisation"): return "A school, a garage, a doctor. Listed after the people."
        case ("event", "family"): return "A family date. It is Private."
        case ("event", "fixture"): return "A start time with no result."
        default: return "A name only."
        }
    }

    /// "Side project" becomes `side_project`. The server accepts lower-case letters, digits, and underscores.
    static func slug(_ title: String) -> String {
        let lowered = title.lowercased().unicodeScalars.map { scalar -> Character in
            let isLetter = scalar.value >= 97 && scalar.value <= 122
            let isDigit = scalar.value >= 48 && scalar.value <= 57
            return isLetter || isDigit ? Character(scalar) : "_"
        }
        let joined = String(lowered).split(separator: "_").joined(separator: "_")
        let trimmed = String(joined.drop { !$0.isLetter })
        return String(trimmed.prefix(40))
    }

    private func field(_ label: String, placeholder: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased()).font(Theme.font(10)).foregroundStyle(Theme.stone)
            TextField(placeholder, text: text).font(Theme.font(14)).autocorrectionDisabled()
        }
    }

    private func picker(_ label: String, selection: Binding<String>, options: [(String, String)]) -> some View {
        HStack {
            Text(label.uppercased()).font(Theme.font(10)).foregroundStyle(Theme.stone)
            Spacer()
            Picker(label, selection: selection) {
                ForEach(options, id: \.0) { option in Text(option.1).tag(option.0) }
            }
            .tint(Theme.ink)
        }
    }

    private func load() async {
        do {
            let list = try await session.client().kinds()
            kinds = list.kinds
            roles = list.roles
            types = list.types
            areas = try await session.client().areas()
            if !kindsOf("area").contains(where: { $0.kind == areaKind }) { areaKind = kindsOf("area").first?.kind ?? "other" }
            loaded = true
        } catch {
            message = error.localizedDescription
        }
    }

    private func addArea() async {
        working = true
        defer { working = false }
        do {
            let made = try await session.client().createArea(title: areaTitle.trimmingCharacters(in: .whitespaces), kind: areaKind, childTier: areaTier.isEmpty ? nil : areaTier)
            message = "Added \(made.title). Its items are \((made.properties?.childTier ?? "personal").capitalized)."
            areaTitle = ""
            areaTier = ""
            await load()
        } catch {
            message = error.localizedDescription
        }
    }

    private func addKind() async {
        working = true
        defer { working = false }
        let name = kindTitle.trimmingCharacters(in: .whitespaces)
        do {
            let made = try await session.client().saveKind(type: kindType, kind: AreasView.slug(name), title: name, role: kindRole.isEmpty ? nil : kindRole)
            message = "Added the kind \(made.title)."
            kindTitle = ""
            kindRole = ""
            await load()
            if made.type == "area" { areaKind = made.kind }
        } catch {
            message = error.localizedDescription
        }
    }

    private func remove(_ kind: KindInfo) async {
        do {
            try await session.client().removeKind(type: kind.type, kind: kind.kind)
            message = "Removed the kind \(kind.title)."
            await load()
        } catch {
            message = error.localizedDescription
        }
    }
}
