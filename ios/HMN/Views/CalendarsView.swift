import SwiftUI

/** The calendars that HMN mirrors. A calendar is read from its ICS address, and HMN does not write back. */
struct CalendarsView: View {
    @EnvironmentObject private var session: Session
    @State private var calendars: [CalendarInfo] = []
    @State private var interval = 15
    @State private var areas: [Entity] = []
    @State private var message: String?
    @State private var title = ""
    @State private var address = ""
    @State private var areaId = ""
    @State private var tier = ""
    @State private var working = false
    @State private var loaded = false

    private let tiers = ["", "public", "household", "personal", "private"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Read every \(interval) minutes. HMN never writes to them.")
                    .font(Theme.small).foregroundStyle(Theme.stone)
                if let message { MessageLine(text: message) }
                if loaded && calendars.isEmpty { EmptyState(title: "No calendars yet.") }
                ForEach(calendars) { calendar in card(calendar) }
                if !calendars.isEmpty {
                    Button("Read now") { Task { await sync() } }
                        .buttonStyle(PillButtonStyle(kind: .secondary))
                        .disabled(working)
                }
                SmallLabel(text: "Add a calendar").padding(.top, 10)
                VStack(alignment: .leading, spacing: 12) {
                    TextField("Name", text: $title).textFieldStyle(FieldStyle()).autocorrectionDisabled()
                    SecureField("https:// or webcal://", text: $address)
                        .textFieldStyle(FieldStyle())
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("Google calls it the secret address in iCal format. HMN keeps it hidden.")
                        .font(Theme.small).foregroundStyle(Theme.stone)
                    picker("Area", selection: $areaId, options: [("", "None")] + areas.map { ($0.id, $0.title) })
                    picker("Tier", selection: $tier, options: tiers.map { ($0, $0.isEmpty ? "From the area" : $0.capitalized) })
                    Button("Add") { Task { await add() } }
                        .buttonStyle(PillButtonStyle())
                        .disabled(address.isEmpty || working)
                }
                .card()
            }
            .padding(22)
        }
        .navigationTitle("Calendars")
        .background(Theme.ground.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func card(_ calendar: CalendarInfo) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(calendar.title).font(Theme.row)
                    Text(facts(calendar)).font(Theme.small).foregroundStyle(Theme.stone)
                }
                Spacer()
                Menu {
                    Button(calendar.approval == "review" ? "Accept without review" : "Review each change") { Task { await setApproval(calendar) } }
                    Button(calendar.freeBusy == true ? "Stop busy times" : "Give busy times") { Task { await setFreeBusy(calendar) } }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.ink)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Settings for \(calendar.title)")
            }
            Text(status(calendar)).font(Theme.small).foregroundStyle(statusColor(calendar))
        }
        .card()
    }

    /// The count of events, the tier, review, and busy times, in one line.
    private func facts(_ calendar: CalendarInfo) -> String {
        var parts = ["\(calendar.events) events", calendar.eventTier.map { $0.capitalized } ?? "Area tier", calendar.approval == "review" ? "Review" : "Auto"]
        if calendar.freeBusy == true { parts.append("busy times") }
        return parts.joined(separator: " · ")
    }

    private func statusColor(_ calendar: CalendarInfo) -> Color {
        guard let last = calendar.lastSync else { return Theme.graphite }
        return last.ok ? Theme.graphite : Theme.danger
    }

    private func status(_ calendar: CalendarInfo) -> String {
        if !calendar.hasUrl { return "No address." }
        guard let last = calendar.lastSync else { return "Not read yet." }
        let when = ReviewText.shortDate(last.at)
        if last.ok { return "Read \(when) · \(last.changes) changes" }
        return "Missed \(when). \(last.error ?? "The calendar did not answer.")"
    }

    private func field(_ label: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased()).font(Theme.font(10)).foregroundStyle(Theme.stone)
            TextField(label, text: text).font(Theme.font(14)).autocorrectionDisabled()
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
            let list = try await session.client().calendars()
            calendars = list.calendars
            interval = list.intervalMinutes
            areas = (try? await session.client().entities("area")) ?? []
        } catch {
            message = error.localizedDescription
        }
        loaded = true
    }

    private func add() async {
        working = true
        defer { working = false }
        var fields: [String: Any] = ["title": title.isEmpty ? "Calendar" : title, "url": address.trimmingCharacters(in: .whitespacesAndNewlines)]
        if !areaId.isEmpty { fields["area_id"] = areaId }
        if !tier.isEmpty { fields["event_tier"] = tier }
        do {
            _ = try await session.client().saveCalendar(id: nil, fields: fields)
            title = ""
            address = ""
            message = "Added."
            _ = try? await session.client().syncCalendars()
            await load()
            await session.refreshToday()
        } catch {
            message = error.localizedDescription
        }
    }

    private func setApproval(_ calendar: CalendarInfo) async {
        do {
            _ = try await session.client().saveCalendar(id: calendar.id, fields: ["approval": calendar.approval == "review" ? "auto" : "review"])
            await load()
        } catch {
            message = error.localizedDescription
        }
    }

    private func setFreeBusy(_ calendar: CalendarInfo) async {
        do {
            _ = try await session.client().saveCalendar(id: calendar.id, fields: ["free_busy": !(calendar.freeBusy ?? false)])
            await load()
        } catch {
            message = error.localizedDescription
        }
    }

    private func sync() async {
        working = true
        defer { working = false }
        do {
            let result = try await session.client().syncCalendars()
            let failed = result.results.filter { !$0.ok }.count
            message = failed == 0 ? "All read." : "\(failed) of \(result.results.count) did not answer."
            await load()
            await session.refreshToday()
        } catch {
            message = error.localizedDescription
        }
    }
}
