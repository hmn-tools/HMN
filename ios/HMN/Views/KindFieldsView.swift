import SwiftUI

/// The fields that one kind adds: a car's registration, a document's expiry. The owner adds, removes, and saves.
/// A value already kept in a record stays there when its field goes.
struct KindFieldsView: View {
    @EnvironmentObject private var session: Session
    let kind: KindInfo
    @State private var base: [AppSchema.FieldSpec] = []
    @State private var fields: [AppSchema.FieldSpec] = []
    @State private var saved: [AppSchema.FieldSpec] = []
    @State private var newLabel = ""
    @State private var newType = "text"
    @State private var newChoices = ""
    @State private var message: String?
    @State private var failed = false
    @State private var working = false
    @State private var loaded = false

    /// The field types, in the words the owner reads.
    static let types: [(String, String)] = [
        ("text", "Text"), ("long", "Long text"), ("date", "Date"), ("yearly", "Each year"), ("expiry", "Expiry"),
        ("number", "Number"), ("url", "Link"), ("choice", "Choice"), ("person", "Person"), ("thing", "Thing"),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !loaded { LoadingState() }
                if loaded {
                    if !base.isEmpty {
                        SmallLabel(text: "Every \(Words.type(kind.type).lowercased()) has")
                        Text(base.map(\.label).joined(separator: ", ")).font(Theme.text).foregroundStyle(Theme.graphite)
                    }
                    SmallLabel(text: "\(kind.title) adds").padding(.top, 6)
                    if fields.isEmpty {
                        Text("No fields of its own yet.").font(Theme.text).foregroundStyle(Theme.stone)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(fields, id: \.key) { field in row(field) }
                        }
                        .card(padding: 0)
                    }
                    SmallLabel(text: "Add a field").padding(.top, 10)
                    VStack(alignment: .leading, spacing: 10) {
                        TextField(hint: "Name, for example Policy number", text: $newLabel).textFieldStyle(FieldStyle())
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(Self.types, id: \.0) { option in
                                    Button(option.1) { newType = option.0 }
                                        .buttonStyle(ChipButtonStyle(selected: newType == option.0))
                                }
                            }
                        }
                        if newType == "choice" {
                            TextField(hint: "The choices, with commas", text: $newChoices).textFieldStyle(FieldStyle())
                        }
                        Button("Add the field") { add() }
                            .buttonStyle(PillButtonStyle(kind: .secondary))
                            .disabled(newLabel.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    .card()
                    Button(working ? "Saving" : "Save") { Task { await save() } }
                        .buttonStyle(PillButtonStyle())
                        .disabled(working || fields == saved)
                    if let message { MessageLine(text: message, isError: failed) }
                }
            }
            .padding(16)
        }
        .background(Theme.ground.ignoresSafeArea())
        .navigationTitle(kind.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func row(_ field: AppSchema.FieldSpec) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(field.label).font(Theme.text)
                Text(typeWord(field)).font(Theme.small).foregroundStyle(Theme.stone)
            }
            Spacer(minLength: 0)
            Button("Remove") { fields.removeAll { $0.key == field.key } }
                .buttonStyle(TextButtonStyle(danger: true))
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 60)
        .overlay(alignment: .bottom) { Theme.hair.frame(height: 1).padding(.leading, 16) }
    }

    private func typeWord(_ field: AppSchema.FieldSpec) -> String {
        let word = Self.types.first { $0.0 == field.type }?.1 ?? Words.id(field.type)
        guard let choices = field.choices, !choices.isEmpty else { return word }
        return "\(word): \(choices.joined(separator: ", "))"
    }

    private func add() {
        let label = newLabel.trimmingCharacters(in: .whitespaces)
        guard !label.isEmpty else { return }
        let choices = newChoices.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if newType == "choice" && choices.count < 2 {
            message = "A choice needs two or more options, with commas between them."
            failed = true
            return
        }
        let key = Self.key(label)
        guard !fields.contains(where: { $0.key == key }) && !base.contains(where: { $0.key == key }) else {
            message = "A field with that name is already here."
            failed = true
            return
        }
        fields.append(AppSchema.FieldSpec(key: key, label: label, type: newType, choices: newType == "choice" ? choices : nil))
        newLabel = ""
        newChoices = ""
        message = nil
    }

    /// The same key as the server makes: "Insurance ends" is `insurance_ends`.
    static func key(_ label: String) -> String {
        let folded = label.lowercased().folding(options: .diacriticInsensitive, locale: nil)
        var key = folded.replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        key = String(key.prefix(40))
        if key.first.map({ !$0.isLetter }) ?? true { key = String("f_\(key)".prefix(40)) }
        return key
    }

    private func load() async {
        await SchemaCache.reload(session)
        let schema = SchemaCache.value
        base = schema?.fields[kind.type] ?? []
        fields = schema?.kindFields?.first { $0.type == kind.type && $0.kind == kind.kind }?.fields ?? []
        saved = fields
        loaded = true
    }

    private func save() async {
        working = true
        defer { working = false }
        let body: [[String: Any]] = fields.map { field in
            var item: [String: Any] = ["key": field.key, "label": field.label, "type": field.type]
            if let choices = field.choices { item["choices"] = choices }
            return item
        }
        do {
            try await session.client().saveKindFields(type: kind.type, kind: kind.kind, fields: body)
            await SchemaCache.reload(session)
            saved = fields
            message = "Saved. Each \(kind.title.lowercased()) shows these fields."
            failed = false
        } catch {
            message = error.localizedDescription
            failed = true
        }
    }
}
