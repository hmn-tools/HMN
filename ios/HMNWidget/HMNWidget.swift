import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

struct WidgetScreen: Decodable {
    var dueCount: Int
    var dateLabel: String?
    var updatedLabel: String
    var next: Next?
    var sections: [Section]
    struct Next: Decodable { var title: String; var subtitle: String }
    struct Section: Decodable { var id: String; var items: [Item] }
    struct Item: Decodable { var title: String }
}

private enum WidgetSnapshot {
    static func load() -> WidgetScreen? {
        let defaults = UserDefaults(suiteName: "group.org.hmn") ?? .standard
        guard let data = defaults.data(forKey: "hmn.widget.today") else { return nil }
        return try? JSONDecoder().decode(WidgetScreen.self, from: data)
    }
}

/// When the snapshot was made, read from its own labels ("FRI 27/11/2026" and "12:30"). The snapshot has no instant,
/// and what is written for the widget does not change. A label that cannot be read gives nil, and the widget then
/// shows the snapshot as it is.
extension WidgetScreen {
    var madeAt: Date? {
        guard let dateLabel else { return nil }
        let parts = dateLabel.split(separator: " ").last?.split(separator: "/").compactMap { Int($0) } ?? []
        let clock = updatedLabel.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 3, clock.count == 2 else { return nil }
        return Calendar.current.date(from: DateComponents(year: parts[2], month: parts[1], day: parts[0], hour: clock[0], minute: clock[1]))
    }

    /// True when the snapshot is from an earlier day than the moment the widget shows.
    func isStale(at moment: Date) -> Bool {
        guard let madeAt else { return false }
        return !Calendar.current.isDate(madeAt, inSameDayAs: moment)
    }
}

/// A tiny copy of the app's `When` (ios/HMN/Views/RecordView.swift). The widget is its own target.
enum WidgetWhen {
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

    static func day(_ date: Date, now: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) { return weekday.string(from: date) }
        return withYear.string(from: date)
    }

    /// "Today 12:30", "Yesterday 12:30", "Thu 26 Nov, 12:30".
    static func stamp(_ date: Date, now: Date) -> String {
        let day = day(date, now: now)
        let time = clock.string(from: date)
        return day == "Today" || day == "Yesterday" ? "\(day) \(time)" : "\(day), \(time)"
    }
}

struct Entry: TimelineEntry {
    var date: Date
    var screen: WidgetScreen?
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: .now, screen: nil) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(Entry(date: .now, screen: WidgetSnapshot.load()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let screen = WidgetSnapshot.load()
        // A second entry at midnight, so a snapshot from this evening does not pass for tomorrow's.
        var entries = [Entry(date: .now, screen: screen)]
        if let midnight = Calendar.current.nextDate(after: .now, matching: DateComponents(hour: 0, minute: 0), matchingPolicy: .nextTime) {
            entries.append(Entry(date: midnight, screen: screen))
        }
        completion(Timeline(entries: entries, policy: .after(Date().addingTimeInterval(3600))))
    }
}

struct HMNWidgetView: View {
    var entry: Entry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let screen = entry.screen {
            if screen.isStale(at: entry.date) {
                stale(screen)
            } else if family == .systemSmall {
                small(screen)
            } else {
                medium(screen)
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text("HMN").font(WidgetFont.label).foregroundStyle(WidgetColor.stone)
                Text("Open HMN to pair this phone.")
                    .font(WidgetFont.small)
                    .foregroundStyle(WidgetColor.graphite)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .padding(14)
            .containerBackground(WidgetColor.card, for: .widget)
        }
    }

    /// A snapshot from an earlier day. It says when it was made and shows no count, so it does not look like today.
    private func stale(_ screen: WidgetScreen) -> some View {
        let since = screen.madeAt.map { WidgetWhen.stamp($0, now: entry.date) } ?? screen.updatedLabel
        return VStack(alignment: .leading, spacing: 6) {
            Text("HMN · TODAY").font(WidgetFont.label).foregroundStyle(WidgetColor.stone)
            Text("Not updated since \(since).")
                .font(WidgetFont.row)
                .foregroundStyle(WidgetColor.ink)
            Text("Open HMN to see today.").font(WidgetFont.small).foregroundStyle(WidgetColor.graphite)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(14)
        .containerBackground(WidgetColor.card, for: .widget)
    }

    private func small(_ screen: WidgetScreen) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("TODAY")
                Spacer()
                captureButton
            }
            .font(WidgetFont.label)
            .foregroundStyle(WidgetColor.stone)
            Text("\(screen.dueCount)")
                .font(WidgetFont.sans(40, .semibold))
                .foregroundStyle(WidgetColor.ink)
                .accessibilityLabel(screen.dueCount == 1 ? "1 thing due" : "\(screen.dueCount) things due")
            Text("due")
                .font(WidgetFont.small)
                .foregroundStyle(WidgetColor.stone)
            if let next = screen.next {
                Text("Next: \(next.title)").font(WidgetFont.row).foregroundStyle(WidgetColor.ink).lineLimit(2)
                Text(next.subtitle).font(WidgetFont.small).foregroundStyle(WidgetColor.stone).lineLimit(1)
            } else {
                Text("Nothing coming.").font(WidgetFont.small).foregroundStyle(WidgetColor.graphite)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(14)
        .containerBackground(WidgetColor.card, for: .widget)
    }

    private func medium(_ screen: WidgetScreen) -> some View {
        let overdue = screen.sections.first { $0.id == "overdue" }?.items ?? []
        let dueToday = screen.sections.first { $0.id == "due" }?.items ?? []
        let all = overdue + dueToday
        let due = all.prefix(3)
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("HMN · TODAY")
                Spacer()
                captureButton
                Text("UPDATED \(screen.updatedLabel)")
            }
            .font(WidgetFont.label)
            .foregroundStyle(WidgetColor.stone)
            if due.isEmpty {
                Text("Nothing due.").font(WidgetFont.small).foregroundStyle(WidgetColor.graphite)
            }
            ForEach(Array(due.enumerated()), id: \.offset) { _, item in
                HStack(spacing: 8) {
                    Circle().stroke(WidgetColor.graphite, lineWidth: 1.2).frame(width: 14, height: 14)
                    Text(item.title).font(WidgetFont.row).foregroundStyle(WidgetColor.ink).lineLimit(1)
                }
            }
            if all.count > due.count {
                Text("+\(all.count - due.count) more").font(WidgetFont.small).foregroundStyle(WidgetColor.stone)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(14)
        .containerBackground(WidgetColor.card, for: .widget)
    }

    private var captureButton: some View {
        Button(intent: OpenCaptureIntent()) {
            Image(systemName: "plus")
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Capture something")
    }
}

struct PublicCard: Decodable {
    var dueCount: Int
    var title: String
    var subtitle: String
}

private enum PublicSnapshot {
    static func load() -> PublicCard? {
        let defaults = UserDefaults(suiteName: "group.org.hmn") ?? .standard
        guard let data = defaults.data(forKey: "hmn.public.lock") else { return nil }
        return try? JSONDecoder().decode(PublicCard.self, from: data)
    }
}

struct LockEntry: TimelineEntry {
    var date: Date
    var card: PublicCard?
}

struct LockProvider: TimelineProvider {
    func placeholder(in context: Context) -> LockEntry { LockEntry(date: .now, card: nil) }
    func getSnapshot(in context: Context, completion: @escaping (LockEntry) -> Void) {
        completion(LockEntry(date: .now, card: PublicSnapshot.load()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LockEntry>) -> Void) {
        let entry = LockEntry(date: .now, card: PublicSnapshot.load())
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(3600))))
    }
}

struct LockWidgetView: View {
    var entry: LockEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let hasNext = entry.card?.title.isEmpty == false
        let title = hasNext ? entry.card!.title : "HMN"
        let subtitle = hasNext ? (entry.card?.subtitle ?? "") : (entry.card?.subtitle.isEmpty == false ? entry.card!.subtitle : "Nothing for the household.")
        Group {
            if family == .accessoryInline {
                Text(title)
            } else if family == .accessoryCircular {
                Text(entry.card.map { "\($0.dueCount)" } ?? "HMN")
                    .font(.headline)
                    .accessibilityLabel(entry.card.map { "\($0.dueCount) due" } ?? "HMN")
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(WidgetFont.sans(13, .medium)).lineLimit(1)
                    Text(subtitle).font(WidgetFont.sans(11)).lineLimit(2)
                }
            }
        }
        .containerBackground(for: .widget) { Color.clear }
    }
}

struct StandByWidgetView: View {
    var entry: LockEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title = entry.card?.title, !title.isEmpty {
                Text("TO WATCH").font(WidgetFont.label).foregroundStyle(WidgetColor.stone)
                Text(title)
                    .font(WidgetFont.sans(22, .semibold))
                    .foregroundStyle(WidgetColor.ink)
                Text(entry.card?.subtitle ?? "").font(WidgetFont.small).foregroundStyle(WidgetColor.stone)
            } else {
                Text("HOUSEHOLD").font(WidgetFont.label).foregroundStyle(WidgetColor.stone)
                Text(entry.card?.subtitle.isEmpty == false ? entry.card!.subtitle : "Nothing for the household.")
                    .font(WidgetFont.sans(22, .semibold))
                    .foregroundStyle(WidgetColor.ink)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(16)
        .containerBackground(WidgetColor.card, for: .widget)
    }
}

struct NextEventLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: NextEventAttributes.self) { context in
            VStack(alignment: .leading, spacing: 4) {
                Text(context.state.title).font(WidgetFont.sans(16, .semibold))
                Text(context.state.subtitle).font(WidgetFont.sans(13))
            }
            .padding()
            // The card is always dark on the lock screen, so its text is always light.
            .foregroundStyle(Color.white)
            .activityBackgroundTint(Color.black)
            .activitySystemActionForegroundColor(Color.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.state.title)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.state.subtitle)
                }
            } compactLeading: {
                Text("HMN")
            } compactTrailing: {
                Text(context.state.title).lineLimit(1)
            } minimal: {
                Text("HMN")
            }
        }
    }
}

@main
struct HMNWidgets: WidgetBundle {
    var body: some Widget {
        HMNWidget()
        HMNLockWidget()
        HMNStandByWidget()
        NextEventLiveActivity()
    }
}

struct HMNLockWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HMNLock", provider: LockProvider()) { entry in
            LockWidgetView(entry: entry)
        }
        .configurationDisplayName("HMN Lock")
        .description("Public only. The next fixture, never a private name.")
        .supportedFamilies([.accessoryInline, .accessoryCircular, .accessoryRectangular])
    }
}

struct HMNStandByWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HMNStandBy", provider: LockProvider()) { entry in
            StandByWidgetView(entry: entry)
        }
        .configurationDisplayName("HMN StandBy")
        .description("Public only, for the bedside.")
        .supportedFamilies([.systemSmall])
    }
}

struct HMNWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HMNToday", provider: Provider()) { entry in
            HMNWidgetView(entry: entry)
        }
        .configurationDisplayName("HMN")
        .description("Today, without private rows.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}


/// The colours of the widget, in light and dark. The widget is its own target, so it does not read the app theme.
enum WidgetColor {
    static let card = adaptive(0xFFFFFF, 0x1E1E1C)
    static let ink = adaptive(0x0D0D0D, 0xEDEDEA)
    static let graphite = adaptive(0x434343, 0xC6C6C1)
    static let stone = adaptive(0x595956, 0x9E9E98)

    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255, blue: CGFloat(value & 0xFF) / 255, alpha: 1)
        })
    }
}

/// The type of the widget: Garden. Plex Sans for titles and sentences, Plex Mono for labels only.
/// The extension bundles its own copy of the font files. The system face is the fallback.
enum WidgetFont {
    static let label = Font.custom("IBMPlexMono-Medium", size: 10)
    static let row = sans(13, .medium)
    static let small = sans(12)

    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        let name: String
        switch weight {
        case .semibold, .bold, .heavy, .black: name = "IBMPlexSans-SmBld"
        case .medium: name = "IBMPlexSans-Medm"
        default: name = "IBMPlexSans"
        }
        return .custom(name, size: size)
    }
}
