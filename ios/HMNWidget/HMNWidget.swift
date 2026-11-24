import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

struct WidgetScreen: Decodable {
    var dueCount: Int
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
        let entry = Entry(date: .now, screen: WidgetSnapshot.load())
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(3600))))
    }
}

struct HMNWidgetView: View {
    var entry: Entry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let screen = entry.screen {
            if family == .systemSmall { small(screen) } else { medium(screen) }
        } else {
            Text("Open HMN to pair this phone.")
                .font(.custom("IBMPlexMono-Regular", size: 12))
                .foregroundStyle(WidgetColor.graphite)
                .padding()
                .containerBackground(WidgetColor.card, for: .widget)
        }
    }

    private func small(_ screen: WidgetScreen) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("TODAY")
                Spacer()
                Button(intent: OpenCaptureIntent()) {
                    Image(systemName: "plus")
                }
                .buttonStyle(.plain)
                Text("\(screen.dueCount) DUE")
            }
            .font(.custom("IBMPlexMono-Medium", size: 10))
            Text("\(screen.dueCount)").font(.custom("IBMPlexMono-SemiBold", size: 40))
            if let next = screen.next {
                Text("Next: \(next.title)").font(.custom("IBMPlexMono-Medium", size: 12))
                Text(next.subtitle).font(.custom("IBMPlexMono-Regular", size: 11)).foregroundStyle(.secondary)
            } else {
                Text("Nothing coming.").font(.custom("IBMPlexMono-Regular", size: 12))
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .containerBackground(WidgetColor.card, for: .widget)
    }

    private func medium(_ screen: WidgetScreen) -> some View {
        let due = screen.sections.first { $0.id == "due" }?.items.prefix(3) ?? []
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("HMN · TODAY")
                Spacer()
                Button(intent: OpenCaptureIntent()) {
                    Image(systemName: "plus")
                }
                .buttonStyle(.plain)
                Text("UPDATED \(screen.updatedLabel)")
            }
            .font(.custom("IBMPlexMono-Medium", size: 10))
            ForEach(Array(due.enumerated()), id: \.offset) { _, item in
                HStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: 2).stroke(WidgetColor.ink, lineWidth: 1.2).frame(width: 14, height: 14)
                    Text(item.title).font(.custom("IBMPlexMono-Medium", size: 13)).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .containerBackground(WidgetColor.card, for: .widget)
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
        let title = entry.card?.title ?? "HMN"
        let subtitle = entry.card?.subtitle ?? "Open HMN"
        Group {
            if family == .accessoryInline {
                Text(title)
            } else if family == .accessoryCircular {
                Text(title.prefix(1)).font(.headline)
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.custom("IBMPlexMono-Medium", size: 12)).lineLimit(1)
                    Text(subtitle).font(.custom("IBMPlexMono-Regular", size: 10)).lineLimit(2)
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
            Text("TO WATCH").font(.custom("IBMPlexMono-Medium", size: 10))
            Text(entry.card?.title.isEmpty == false ? entry.card!.title : "Nothing coming.")
                .font(.custom("IBMPlexMono-SemiBold", size: 22))
            Text(entry.card?.subtitle ?? "").font(.custom("IBMPlexMono-Regular", size: 12))
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
                Text(context.state.title).font(.custom("IBMPlexMono-SemiBold", size: 16))
                Text(context.state.subtitle).font(.custom("IBMPlexMono-Regular", size: 12))
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

    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255, blue: CGFloat(value & 0xFF) / 255, alpha: 1)
        })
    }
}
