import SwiftUI

/// Find any record by its words, and open it. Each result says what it is: a task, a person, a note.
struct SearchView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [Entity] = []
    @State private var searched = false
    @State private var message: String?
    @State private var opened: Entity?
    @FocusState private var typing: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    TextField(hint: "Search your HMN", text: $query)
                        .textFieldStyle(FieldStyle())
                        .focused($typing)
                        .submitLabel(.search)
                        .autocorrectionDisabled()
                    if let message { MessageLine(text: message, isError: true) }
                    if searched && results.isEmpty && message == nil {
                        Text("Nothing matches \"\(query.trimmingCharacters(in: .whitespaces))\".")
                            .font(Theme.text).foregroundStyle(Theme.graphite)
                            .padding(.horizontal, 4)
                    }
                    if !results.isEmpty {
                        VStack(spacing: 0) {
                            ForEach(results) { entity in
                                Button { opened = entity } label: { row(entity) }
                                    .buttonStyle(.plain)
                            }
                        }
                        .card(padding: 0)
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.ground.ignoresSafeArea())
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .navigationDestination(item: $opened) { entity in RecordView(type: entity.type, id: entity.id) }
            // The sheet must finish its move before the field can take the keyboard.
            .task {
                try? await Task.sleep(nanoseconds: 450_000_000)
                typing = true
            }
            // A short wait after each key, so a search runs once the owner stops typing.
            .task(id: query) {
                let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
                guard text.count >= 2 else { results = []; searched = false; message = nil; return }
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard !Task.isCancelled else { return }
                do {
                    let found = try await session.client().search(text)
                    guard !Task.isCancelled else { return }
                    results = found
                    message = nil
                } catch is CancellationError {
                    return
                } catch {
                    results = []
                    message = error.localizedDescription
                }
                searched = true
            }
        }
    }

    private func row(_ entity: Entity) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entity.title).font(Theme.text).foregroundStyle(Theme.ink)
                    .multilineTextAlignment(.leading)
                Text(Words.type(entity.type)).font(Theme.small).foregroundStyle(Theme.stone)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 60)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) { Theme.hair.frame(height: 1).padding(.leading, 16) }
    }
}
