import SwiftUI

/// The dates that HMN cannot read. A screen skips such a date, so this list is where the owner sees them.
/// Each row opens the record, where the date can be set again.
struct UnreadableDatesView: View {
    @EnvironmentObject private var session: Session
    @State private var dates: [UnreadableDate] = []
    @State private var loaded = false
    @State private var message: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("HMN cannot read these dates, so a screen skips them. Open a record to set the date again.")
                    .font(Theme.text).foregroundStyle(Theme.graphite)
                    .fixedSize(horizontal: false, vertical: true)
                if !loaded && message == nil { LoadingState() }
                if loaded && dates.isEmpty {
                    EmptyState(title: "Every date can be read.", text: nil)
                }
                if !dates.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(dates) { item in
                            NavigationLink(destination: RecordView(type: item.type, id: item.id)) {
                                VStack(spacing: 0) {
                                    HStack(alignment: .firstTextBaseline) {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(item.title ?? "Untitled").font(Theme.row).foregroundStyle(Theme.ink)
                                            Text("\(item.field): \(item.value)").font(Theme.small).foregroundStyle(Theme.stone)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
                                    }
                                    .padding(.horizontal, Theme.Space.l)
                                    .padding(.vertical, 10)
                                    .frame(minHeight: 52)
                                    if item.id != dates.last?.id || item.field != dates.last?.field {
                                        Theme.hair.frame(height: 1).padding(.leading, Theme.Space.l)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .card(padding: 0)
                }
                if let message { MessageLine(text: message, isError: true) }
            }
            .padding(16)
        }
        .background(Theme.ground.ignoresSafeArea())
        .navigationTitle("Dates to fix")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            dates = try await session.client().unreadableDates()
            message = nil
        } catch is URLError {
            message = "Your HMN did not answer."
        } catch {
            message = error.localizedDescription
        }
        loaded = true
    }
}
