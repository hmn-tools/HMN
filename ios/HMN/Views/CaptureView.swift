import SwiftUI

struct CaptureView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var tier = "personal"
    @State private var items: [InboxItem] = []
    @State private var suggestions: [String] = []
    @State private var message: String?
    @State private var saved: String?
    @State private var deleting: InboxItem?
    @FocusState private var typing: Bool
    @State private var openId: String?
    @State private var retag = ""
    @State private var fileQuery = ""
    @State private var fileHits: [Entity] = []

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    TextField("A thought, a task, a link. Tag with #.", text: $text, axis: .vertical)
                        .lineLimit(3...6)
                        .textFieldStyle(FieldStyle())
                        .focused($typing)
                        .onChange(of: text) { _, value in Task { await complete(value) } }
                    if !suggestions.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(suggestions, id: \.self) { tag in
                                    Button("#\(tag)") { apply(tag) }
                                        .buttonStyle(ChipButtonStyle())
                                }
                            }
                        }
                    }
                    HStack(spacing: 8) {
                        tierButton("Household", "household")
                        tierButton("Personal", "personal")
                        tierButton("Private", "private")
                    }
                    Button("Save") { Task { await save() } }
                        .buttonStyle(PillButtonStyle())
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if let saved { MessageLine(text: saved) }
                    if let message { MessageLine(text: message, isError: true) }
                    SmallLabel(text: items.isEmpty ? "Inbox · empty" : "Inbox · \(items.count)")
                        .padding(.top, 10)
                        .padding(.horizontal, 4)
                    ForEach(items) { item in
                        row(item)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 16)
            }
            .background(Theme.ground)
            .navigationTitle("Add a note")
            .background(Theme.ground.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task {
                typing = true
                await reload()
            }
            .confirmationDialog("Delete this note?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    if let item = deleting { Task { await act(item, "delete") } }
                }
            }
        }
    }

    private func row(_ item: InboxItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(item.body?.isEmpty == false ? item.body! : "Untitled")
                .font(Theme.row)
                .foregroundStyle(Theme.ink)
            Text(subtitle(item))
                .font(Theme.small)
                .foregroundStyle(Theme.stone)
            if openId == item.id {
                SmallLabel(text: "Make it a")
                HStack(spacing: 6) {
                    Button("Task") { Task { await make(item, "task") } }.buttonStyle(ChipButtonStyle())
                    Button("Note") { Task { await make(item, "note") } }.buttonStyle(ChipButtonStyle())
                    Button("Person") { Task { await make(item, "person") } }.buttonStyle(ChipButtonStyle())
                }
                SmallLabel(text: "Or keep it as a note about")
                TextField("Find a person, a project, a thing", text: $fileQuery)
                    .textFieldStyle(FieldStyle())
                    .onChange(of: fileQuery) { _, value in Task { await lookUp(value) } }
                ForEach(fileHits) { hit in
                    Button { Task { await file(item, to: hit.id) } } label: {
                        HStack {
                            Text(hit.title).font(Theme.row).foregroundStyle(Theme.ink)
                            Spacer()
                            Text(Words.type(hit.type)).font(Theme.small).foregroundStyle(Theme.stone)
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                TextField("Change the #tags", text: $retag, axis: .vertical)
                    .textFieldStyle(FieldStyle())
                HStack(spacing: 20) {
                    Button("Save tags") { Task { await retag(item) } }
                    if item.suggestion != nil {
                        Button("Accept") { Task { await act(item, "accept") } }
                    }
                    Button("Archive") { Task { await act(item, "archive") } }
                    Spacer()
                    Button("Delete") { deleting = item }
                        .buttonStyle(TextButtonStyle(danger: true))
                }
                .buttonStyle(TextButtonStyle())
            }
        }
        .card()
        .contentShape(Rectangle())
        .onTapGesture {
            openId = openId == item.id ? nil : item.id
            let tags = (item.tags ?? []).map { "#\($0)" }.joined(separator: " ")
            retag = [item.body ?? "", tags].filter { !$0.isEmpty }.joined(separator: " ")
            fileQuery = ""
            fileHits = []
        }
        .accessibilityAddTraits(.isButton)
    }

    private func subtitle(_ item: InboxItem) -> String {
        if let label = item.suggestion?.label { return label }
        let tags = item.tags ?? []
        if tags.isEmpty { return "Waiting" }
        return tags.map { "#\($0)" }.joined(separator: " ")
    }

    private func tierButton(_ title: String, _ value: String) -> some View {
        Button(title) { tier = value }
            .buttonStyle(ChipButtonStyle(selected: tier == value))
            .accessibilityValue(tier == value ? "selected" : "")
    }

    private func apply(_ tag: String) {
        guard let range = text.range(of: "#[a-z0-9/_-]*$", options: .regularExpression) else {
            text += text.hasSuffix(" ") || text.isEmpty ? "#\(tag) " : " #\(tag) "
            return
        }
        text.replaceSubrange(range, with: "#\(tag) ")
    }

    private func complete(_ value: String) async {
        guard let range = value.range(of: "#([a-z0-9/_-]*)$", options: .regularExpression) else {
            suggestions = []
            return
        }
        let token = String(value[range]).dropFirst()
        suggestions = (try? await session.client().inboxTags(String(token))) ?? []
    }

    private func reload() async {
        items = (try? await session.client().inboxItems()) ?? []
    }

    private func save() async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            _ = try await session.client().captureInbox(text: trimmed, source: "app", tier: tier, attachments: [])
            text = ""
            tier = "personal"
            message = nil
            saved = "Saved to the inbox."
            await reload()
        } catch {
            message = error.localizedDescription
        }
    }

    private func act(_ item: InboxItem, _ action: String) async {
        do {
            _ = try await session.client().processInbox(item.id, action: action)
            openId = nil
            deleting = nil
            await reload()
        } catch {
            message = error.localizedDescription
        }
    }

    private func retag(_ item: InboxItem) async {
        do {
            _ = try await session.client().processInbox(item.id, action: "retag", text: retag)
            openId = nil
            await reload()
        } catch {
            message = error.localizedDescription
        }
    }

    private func lookUp(_ query: String) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else { fileHits = []; return }
        fileHits = Array(((try? await session.client().search(trimmed)) ?? []).prefix(4))
    }

    /// The capture becomes a task, a note, or a person, with no tag to type first.
    private func make(_ item: InboxItem, _ route: String) async {
        do {
            _ = try await session.client().processInbox(item.id, action: "accept", route: route)
            openId = nil
            message = nil
            saved = route == "person" ? "Added to People." : route == "note" ? "Kept as a note." : "Now a task."
            await reload()
            await session.refreshToday()
        } catch {
            message = error.localizedDescription
        }
    }

    private func file(_ item: InboxItem, to entityId: String) async {
        do {
            _ = try await session.client().processInbox(item.id, action: "file", entityId: entityId)
            openId = nil
            await reload()
        } catch {
            message = error.localizedDescription
        }
    }
}
