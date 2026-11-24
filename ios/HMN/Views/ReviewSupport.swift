import SwiftUI

/** Shared pieces of the review screens: the source name, a short date, and the small label style. */
enum ReviewText {
    /**
     * `worker:people` reads as "People", `plugin:calendar` as "Calendar", `import:notion` as "Import from notion".
     * A key reads as the name that the owner gave it: "Agent key: research", or "Guest: Mara". The id of a key is not shown.
     */
    static func sourceName(_ source: String, key name: String? = nil, guest: Bool = false) -> String {
        let parts = source.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return source }
        switch parts[0] {
        case "worker", "plugin": return parts[1].prefix(1).uppercased() + parts[1].dropFirst()
        case "import": return "Import from \(parts[1])"
        case "key":
            guard let name, !name.isEmpty else { return "Outside agent" }
            return guest ? "Guest: \(name)" : "Agent key: \(name)"
        default: return source
        }
    }

    /** Workers first, then plugins, then imports, then outside agents. */
    static func rank(_ source: String) -> Int {
        switch source.split(separator: ":").first.map(String.init) {
        case "worker": return 0
        case "plugin": return 1
        case "import": return 2
        default: return 3
        }
    }

    static func sourceKind(_ source: String) -> String {
        switch source.split(separator: ":").first.map(String.init) {
        case "worker": return "worker"
        case "plugin": return "plugin"
        case "import": return "import"
        default: return "outside agent"
        }
    }

    /** `2026-11-11T04:39:00.000Z` reads as `11/11 12:39` in the phone's zone. */
    static func shortDate(_ iso: String?) -> String {
        guard let iso else { return "" }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
        let out = DateFormatter()
        out.dateFormat = "d/M HH:mm"
        return out.string(from: date)
    }

    /** `2026-12-11T04:39:00.000Z` reads as `11/12/2026`. An end date needs its year. */
    static func day(_ iso: String?) -> String {
        guard let iso else { return "" }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
        let out = DateFormatter()
        out.dateFormat = "d/M/yyyy"
        return out.string(from: date)
    }

    /** "1 person", "3 people", "2 tasks". */
    static func counted(_ count: Int, _ type: String) -> String {
        if count == 1 { return "1 \(type)" }
        return "\(count) \(type == "person" ? "people" : type + "s")"
    }

    /** "A", "A and B", or "A, B, and C". */
    static func list(_ items: [String]) -> String {
        if items.count <= 2 { return items.joined(separator: " and ") }
        return items.dropLast().joined(separator: ", ") + ", and " + (items.last ?? "")
    }

    static func operation(_ op: String) -> String {
        switch op {
        case "create": return "add"
        case "update": return "change"
        case "delete": return "remove"
        case "link": return "link"
        case "unlink": return "unlink"
        default: return op
        }
    }
}

/** The label of a section or a field: mono, upper case, in the muted colour. */
struct SmallLabel: View {
    var text: String
    var color: Color = Theme.stone
    var body: some View {
        Text(text.uppercased())
            .font(Theme.label)
            .tracking(1.3)
            .foregroundStyle(color)
    }
}

/** The card of the app, with its content in one column. The name is from the first design. */
struct InkCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 6) { content }
            .card()
    }
}
