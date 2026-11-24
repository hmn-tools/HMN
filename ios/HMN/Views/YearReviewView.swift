import SwiftUI

/// The yearly review: one card for a calendar year, made from the record, and one note that the owner writes.
/// No charts, no streaks, no comparison with another year. docs/STRATEGY.md, role 7, and docs/UX.md.
struct YearReviewView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var year: Int?
    @State private var review: YearReview?
    @State private var noteText = ""
    @State private var savedText = ""
    @State private var saving = false
    @State private var message: String?
    @State private var saved = false
    @FocusState private var writing: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let review {
                        if review.years.count > 1 { yearChips(review) }
                        VStack(alignment: .leading, spacing: 8) {
                            Text(review.greeting).font(Theme.title).tracking(-0.6)
                            Text(review.summary).font(Theme.text).foregroundStyle(Theme.graphite)
                        }
                        .padding(.horizontal, 4)
                        noteCard(review)
                        ForEach(review.sections) { section in sectionCard(section) }
                        Text(review.closing)
                            .font(Theme.small).foregroundStyle(Theme.stone)
                            .padding(.horizontal, 4)
                            .padding(.top, 4)
                    } else if message == nil {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    }
                    if let message { MessageLine(text: message, isError: true) }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("The year")
            .navigationBarTitleDisplayMode(.inline)
            .background(Theme.ground.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task { await load() }
        }
    }

    private func yearChips(_ review: YearReview) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(review.years, id: \.self) { value in
                    Button(String(value)) { Task { year = value; await load() } }
                        .buttonStyle(ChipButtonStyle(selected: review.year == value))
                        .accessibilityAddTraits(review.year == value ? [.isSelected] : [])
                }
            }
            .padding(.horizontal, 4)
        }
    }

    private func noteCard(_ review: YearReview) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SmallLabel(text: "Your note")
            TextField("What was this year for?", text: $noteText, axis: .vertical)
                .font(Theme.text)
                .lineLimit(4...14)
                .focused($writing)
                .onChange(of: noteText) { _, _ in saved = false }
            HStack(spacing: 12) {
                Button(saving ? "Saving" : "Save the note") { Task { await save(review.year) } }
                    .buttonStyle(PillButtonStyle())
                    .disabled(saving || noteText == savedText)
                if saved { Text("Saved.").font(Theme.small).foregroundStyle(Theme.stone) }
            }
            Text("Only you see it. It is Private.").font(Theme.small).foregroundStyle(Theme.stone)
        }
        .card()
    }

    private func sectionCard(_ section: ScreenSection) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                SmallLabel(text: section.label)
                Spacer()
                if let trailing = section.trailing { SmallLabel(text: trailing) }
            }
            .padding(.top, 10)
            .padding(.bottom, 4)
            ForEach(Array(section.items.enumerated()), id: \.element.id) { index, item in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title).font(Theme.row).foregroundStyle(Theme.ink)
                        if !item.subtitle.isEmpty { Text(item.subtitle).font(Theme.small).foregroundStyle(Theme.stone) }
                    }
                    Spacer(minLength: 0)
                    if item.done {
                        Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.tealDark)
                            .accessibilityLabel("Done")
                    }
                }
                .frame(minHeight: 52)
                .overlay(alignment: .top) { if index > 0 { Theme.rule.frame(height: 1) } }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .card(padding: 0)
    }

    private func load() async {
        do {
            let next = try await session.client().yearReview(year)
            review = next
            noteText = next.note?.body ?? ""
            savedText = noteText
            saved = false
            message = nil
        } catch { message = error.localizedDescription }
    }

    private func save(_ year: Int) async {
        saving = true
        defer { saving = false }
        do {
            _ = try await session.client().saveYearNote(year, body: noteText)
            savedText = noteText
            saved = true
            writing = false
            message = nil
        } catch { message = error.localizedDescription }
    }
}
