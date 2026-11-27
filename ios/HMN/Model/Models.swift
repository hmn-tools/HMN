import Foundation

struct TodayScreen: Codable, Equatable {
    var id: String?
    var greeting: String
    var summary: String
    var closing: String?
    var dateLabel: String
    var clockLabel: String
    var updatedLabel: String
    var nextLabel: String
    var dueCount: Int
    var index: Int
    var count: Int
    var label: String
    var ceiling: String
    var next: NextEvent?
    var sections: [ScreenSection]
}

struct NextEvent: Codable, Equatable {
    var title: String
    var subtitle: String
}

struct ScreenSection: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var trailing: String?
    var accent: String?
    var items: [ScreenItem]
}

struct ScreenItem: Codable, Equatable, Identifiable {
    var id: String
    var title: String
    var subtitle: String
    var glyph: String
    var done: Bool
    var badge: String?
    var dateMark: String?
    var accent: String?
    /// The type of the row's entity. A row with a type opens its item.
    var type: String?
}

struct Entity: Codable, Identifiable, Hashable {
    var id: String
    var type: String
    var title: String
    var body: String?
    var status: String?
    var kind: String?
    var dueAt: String?
    var areaId: String?
    var tier: String
    var tierSource: String
    var origin: String
    var originRef: String?
    /// Only the keys the app reads. The server writes who completed a task, and when.
    var properties: Completion?

    struct Completion: Codable, Hashable {
        var doneBy: String?
        var doneAt: String?
        /// A routine: its days in words ("Mon, Wed"), and today's check-in.
        var cadence: String?
        var checkedBy: String?
        var checkedAt: String?
    }

    var isDone: Bool { status == "done" }

    /// "Done by you · Today 18:02", or nil when the task is open.
    var doneLine: String? {
        guard isDone else { return nil }
        let who = properties?.doneBy.map { $0 == "owner" ? "you" : $0 } ?? "you"
        guard let at = properties?.doneAt, DateText.parse(at) != nil else { return "Done by \(who)" }
        return "Done by \(who) · \(When.dayAndTime(at))"
    }
}

extension ISO8601DateFormatter {
    static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

/// A list and its items. An item is a task of the kind `item`.
struct ListEntry: Codable, Identifiable {
    var list: Entity
    var open: Int
    var items: [Entity]
    var id: String { list.id }
}

struct ListsPayload: Codable {
    var lists: [ListEntry]
}

/// The items of a list, or the steps of a task.
struct ItemsPayload: Codable {
    var parent: Entity
    var items: [Entity]
}

struct EntityList: Codable {
    var entities: [Entity]
}

struct LinkList: Codable {
    var links: [GraphLink]
}

struct GraphLink: Codable, Identifiable {
    var id: String
    var rel: String
    var direction: String
    var peer: Peer
    struct Peer: Codable {
        var type: String
        var id: String
        var title: String
        var kind: String?
        var tier: String
    }
}

struct Proposal: Codable, Identifiable {
    var id: String
    var agentName: String
    var op: String
    var tier: String
    var status: String
    var createdAt: String
    var redacted: Bool
    var reason: String?
    var payload: ProposalPayload?
    var readSet: ReadSet?
    /** Named by the server: `worker:<id>`, `plugin:<id>`, `import:<name>`, or `key:<id>`. */
    var source: String?
    var decidedBy: String?
    var expiresOn: String?
    /** What an approval writes. The server makes it from the graph, not from the words of the source. */
    var summary: ProposalSummary?
}

struct ProposalSummary: Codable {
    var title: String
    var lines: [Line]
    var warning: String?
    struct Line: Codable {
        var label: String
        /** The value after the approval. */
        var text: String
        /** The value now, for a change that waits. */
        var was: String?
    }
}

struct ProposalList: Codable {
    var proposals: [Proposal]
}

/** One decided proposal in the Activity list. */
struct ActivityItem: Codable, Identifiable {
    var id: String
    var agentName: String
    var source: String
    /** For a source that is a key: the name that the owner gave the key. */
    var sourceName: String?
    var sourceGuest: Bool?
    var op: String
    var entityType: String?
    var tier: String
    var status: String
    var decidedBy: String?
    var decidedAt: String?
    var undoneAt: String?
    var title: String?
    var reason: String?
    var canUndo: Bool
    var canClear: Bool
}

struct ActivityList: Codable {
    var activity: [ActivityItem]
}

struct BatchResult: Codable {
    var decision: String
    var source: String
    var decided: Int
    var failed: Int
    var remaining: Int
    var results: [BatchRow]?
}

struct BatchRow: Codable {
    var id: String
    var status: String
    var error: String?
}

struct PolicyRule: Codable, Identifiable {
    var id: String
    var source: String
    var op: String
    var entityType: String
    var tier: String
    var mode: String
}

struct PolicySource: Codable, Identifiable {
    var source: String
    var canAuto: Bool
    var sourceName: String?
    var sourceGuest: Bool?
    var id: String { source }
}

struct PolicyList: Codable {
    var defaultMode: String
    var rules: [PolicyRule]
    var defaults: [PolicyRule]
    var sources: [PolicySource]
    var neverAuto: [String]
}

struct CalendarSync: Codable {
    var at: String
    var ok: Bool
    var changes: Int
    var error: String?
}

struct CalendarInfo: Codable, Identifiable {
    var id: String
    var title: String
    var areaId: String?
    var eventTier: String?
    var approval: String
    var hasUrl: Bool
    var events: Int
    var lastSync: CalendarSync?
    /// True when the busy times of this calendar go to a key that the owner allows.
    var freeBusy: Bool?
}

struct CalendarList: Codable {
    var calendars: [CalendarInfo]
    var intervalMinutes: Int
}

struct CalendarSyncResult: Codable {
    var results: [Outcome]
    struct Outcome: Codable {
        var id: String
        var ok: Bool
    }
}

struct Removed: Codable {
    var id: String
}

/** A kind is a row that the owner adds. A role is the fixed word that the rules read. */
struct KindInfo: Codable, Identifiable {
    var type: String
    var kind: String
    var title: String
    var role: String?
    var core: Bool
    var inUse: Int
    var id: String { "\(type):\(kind)" }
}

/// What an agent asked for and did not have. It is text from the agent: a screen shows it as data.
struct AgentRequest: Codable, Identifiable, Hashable {
    var id: String
    var agentName: String
    var need: String
    var why: String
    var example: String?
    var status: String
    var asks: Int
    var createdAt: String
    var updatedAt: String
}

struct AgentRequestList: Codable {
    var requests: [AgentRequest]
}

struct KindList: Codable {
    var kinds: [KindInfo]
    var roles: [String: [String]]
    var types: [String]
}

/** An area, with the tier of its items. */
struct AreaRow: Codable, Identifiable {
    var id: String
    var title: String
    var kind: String?
    var properties: Properties?
    struct Properties: Codable {
        var childTier: String?
    }
}

struct AreaRowList: Codable {
    var entities: [AreaRow]
}

/// The phone of a household member. A partner reads Household and the Family area. A child reads Household.
struct Member: Codable, Identifiable {
    var id: String
    var name: String
    var role: String
    var personId: String
    var hidden: Bool
    var lastUsedAt: String?
}

struct MemberList: Codable {
    var members: [Member]
}

/// A pairing code for one member. It ends ten minutes after it is made.
struct MemberCode: Codable {
    var code: String
    var expiresAt: String
    var role: String
    var onFridge: Bool?
    var person: Person
    struct Person: Codable {
        var id: String
        var title: String
    }
}

/// The member code on the fridge now, for the owner. The server never sends the code itself here.
struct FridgeStatus: Codable {
    var fridge: FridgePairing?
    /// True when a display is claimed at Household.
    var ready: Bool
    struct FridgePairing: Codable {
        var personName: String?
        var expiresAt: String
    }
}

/// A pairing link from a QR code: `hmn://pair?url=…&code=…&fp=…`. The phone camera opens it in the app.
struct PairLink: Identifiable, Equatable {
    var id: String { code }
    /// The address of the HMN. A code from the menu bar has none, so the phone keeps the one it has.
    var url: String?
    var code: String
    var fingerprint: String

    init?(_ link: URL) {
        guard link.scheme?.lowercased() == "hmn", link.host?.lowercased() == "pair",
              let items = URLComponents(url: link, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let code = value("code"), !code.isEmpty, code.count <= 32,
              let pin = value("fp"), !pin.isEmpty, pin.count <= 128 else { return nil }
        let address = value("url")
        if let address, !(address.lowercased().hasPrefix("https://")) { return nil }
        self.url = address
        self.code = code
        self.fingerprint = pin
    }
}

/** The key of one agent or one outside client. The key itself is never sent to the phone. */
struct AgentKey: Codable, Identifiable {
    var id: String
    var name: String
    /// `agent` reads and proposes. `read` is the key of a view: it reads, and it cannot propose.
    var scope: String?
    var outside: Bool
    var ceiling: String
    var privateUntil: String?
    var expiresAt: String?
    var denyAreas: [String]
    var lastUsedAt: String?
    var state: String
    var keychainItem: String?
    /// True when this key can read the owner's busy times.
    var freeBusy: Bool?
    /// True for the agent of another person.
    var guest: Bool?
    /// The phone or the owner key that made this key. A revoke of the maker also revokes this key.
    var madeBy: Maker?
    struct Maker: Codable {
        var id: String
        var name: String
    }
}

/// The answer to a revoke. `alsoRevoked` has the keys that the revoked credential made.
struct RevokeResult: Codable {
    var alsoRevoked: [Item]?
    struct Item: Codable {
        var id: String
        var name: String
    }
}

struct AgentKeyList: Codable {
    var keys: [AgentKey]
    var privateDaysMax: Int
}

/** What a Private grant adds for one key, from the real graph, before the owner gives it. */
struct KeyPreview: Codable {
    var name: String
    var outside: Bool
    var readsNow: Int
    var adds: Int
    var byType: [String: Int]
    var examples: [Example]
    var stillClosed: [String]
    var warnings: [String]
    struct Example: Codable {
        var type: String
        var title: String
    }
}

struct ProposalPayload: Codable {
    var entity: ProposedEntity?
    var links: [ProposedLink]?
}

struct ProposedEntity: Codable {
    var title: String?
    var dueAt: String?
    var type: String?
}

struct ProposedLink: Codable {
    var rel: String?
    var toType: String?
    var toId: String?
}

struct ReadSet: Codable {
    var summary: String?
    var denied: [String]?
    var journalId: String?
}

struct Me: Codable {
    var credential: CredentialInfo
    var surface: String
    var ceiling: String
    var ownerName: String?
    var member: MemberInfo?
}

struct CredentialInfo: Codable {
    var id: String
    var name: String
    var scope: String
    var maxTier: String
    var vault: Bool
    /// `public` while this phone is hidden.
    var forcedCeiling: String?
}

struct AuditList: Codable {
    var entries: [AuditEntry]
}

struct AuditEntry: Codable, Identifiable {
    var seq: Int
    var at: String
    var action: String
    var tier: String?
    var surface: String?
    var id: Int { seq }
}

struct PairingCode: Codable {
    var code: String
    var expiresAt: String
    var payload: String
}

struct PairResult: Codable {
    var secret: String
    var credential: CredentialInfo
    /// Set when the code was for a member of the household.
    var member: MemberInfo?
}

/// A member of the household: the person this phone belongs to, and the role. The app then shows member mode.
struct MemberInfo: Codable, Equatable {
    var role: String
    var personId: String?
    var name: String
}

/// The answer to a write. The owner gets the row. A member gets the row when the write is applied at once, or
/// `pending` when it waits for the owner.
struct WriteAnswer: Decodable {
    var entity: Entity?
    var pending: Bool

    private enum Keys: String, CodingKey { case status, proposalId, entity }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        if container.contains(.proposalId) {
            pending = (try? container.decode(String.self, forKey: .status)) == "pending"
            entity = try? container.decode(Entity.self, forKey: .entity)
        } else {
            pending = false
            entity = try Entity(from: decoder)
        }
    }
}

/// A task for one person or more, with its steps.
struct FamilyTask: Codable, Identifiable {
    var task: Entity
    var people: [PersonRef]
    var steps: StepCount
    var id: String { task.id }

    struct PersonRef: Codable, Equatable { var id: String; var title: String }
    struct StepCount: Codable, Equatable { var open: Int; var done: Int }

    private enum CodingKeys: String, CodingKey { case task, people = "for", steps }
}

struct FamilyTaskList: Codable {
    var tasks: [FamilyTask]
}

/// A routine: a habit for a person, on some days of the week, with a check-in for today. docs/ONTOLOGY.md, section 2.5.
struct Routine: Codable, Identifiable {
    var habit: Entity
    var people: [FamilyTask.PersonRef]
    var days: [String]
    var dueToday: Bool
    var doneToday: Bool
    var id: String { habit.id }

    private enum CodingKeys: String, CodingKey { case habit, people = "for", days, dueToday, doneToday }

    /// "Luca · Mon, Wed", "Luca · Done 07:42", or "Luca · Done 07:42 by Sam".
    var subtitle: String {
        var parts = [people.map(\.title).joined(separator: ", ")]
        if doneToday {
            var line = "Done"
            if let at = habit.properties?.checkedAt, let date = DateText.parse(at) {
                line += " " + When.time(date)
            }
            // "by Luca" on Luca's own routine says nothing. A tick by someone else names them.
            if let who = habit.properties?.checkedBy, !people.contains(where: { $0.title == who }) { line += " by " + (who == "owner" ? "you" : who) }
            parts.append(line)
        } else {
            parts.append(habit.properties?.cadence ?? "Every day")
            if habit.status == "paused" { parts.append("Paused") }
        }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

struct RoutineList: Codable {
    var routines: [Routine]
}

/// What the editors need from the server. docs/SCHEMA.md, "Archive, note kinds, fields, and links".
struct AppSchema: Codable {
    var statuses: [String: [String]]
    var kinds: [KindInfo]
    var relations: [Relation]
    var fields: [String: [FieldSpec]]

    struct Relation: Codable, Hashable {
        var rel: String
        var out: String
        var inWord: String
        private enum CodingKeys: String, CodingKey { case rel, out, inWord = "in" }
    }
    struct FieldSpec: Codable, Hashable {
        var key: String
        var label: String
        var type: String
        var choices: [String]?
    }

    /// The fields that each kind adds. An older server sends none.
    var kindFields: [KindFields]?

    struct KindFields: Codable, Hashable {
        var type: String
        var kind: String
        var fields: [FieldSpec]
    }

    /// The form of one row: the type's own fields, then the fields of its kind.
    func fields(_ type: String, kind: String?) -> [FieldSpec] {
        let base = fields[type] ?? []
        guard let kind, !kind.isEmpty else { return base }
        return base + (kindFields?.first { $0.type == type && $0.kind == kind }?.fields ?? [])
    }

    /// Every field that a row of this type can have, whatever its kind, so a change of kind keeps the values.
    func allFields(_ type: String) -> [FieldSpec] {
        (fields[type] ?? []) + (kindFields ?? []).filter { $0.type == type }.flatMap(\.fields)
    }

    func kinds(of type: String) -> [KindInfo] { kinds.filter { $0.type == type } }
    func kindTitle(_ type: String, _ kind: String?) -> String? {
        guard let kind else { return nil }
        return kinds.first { $0.type == type && $0.kind == kind }?.title ?? Words.id(kind)
    }
    func relation(_ rel: String) -> Relation? { relations.first { $0.rel == rel } }
}

/// A record's properties as plain values. Only the typed fields read them.
struct RawRecord: Decodable {
    var properties: [String: Any]
    private enum CodingKeys: String, CodingKey { case properties }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let value = try? container.decode(JSONAny.self, forKey: .properties)
        properties = (value?.value as? [String: Any]) ?? [:]
    }
}

/// Any JSON value, for the few places that read free properties.
struct JSONAny: Decodable {
    let value: Any
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { value = NSNull() }
        else if let bool = try? container.decode(Bool.self) { value = bool }
        else if let number = try? container.decode(Double.self) { value = number }
        else if let text = try? container.decode(String.self) { value = text }
        else if let list = try? container.decode([JSONAny].self) { value = list.map(\.value) }
        else if let map = try? container.decode([String: JSONAny].self) { value = map.mapValues(\.value) }
        else { value = NSNull() }
    }
}

/// Stored ids in words: "side_project" is "Side project", "upcoming" is "Upcoming".
enum Words {
    static func id(_ value: String) -> String {
        let text = value.replacingOccurrences(of: "_", with: " ")
        return text.prefix(1).uppercased() + text.dropFirst()
    }
    static func type(_ value: String) -> String {
        switch value {
        case "asset": return "Thing"
        case "habit": return "Habit"
        default: return id(value)
        }
    }
}

/// The yearly review of one calendar year, and the owner's note for it. docs/STRATEGY.md, role 7.
struct YearReview: Codable {
    var year: Int
    var greeting: String
    var summary: String
    var closing: String
    var sections: [ScreenSection]
    var note: Entity?
    var years: [Int]
}

/// A person in the People list, with one line: the relation, and the next date with them.
struct PersonEntry: Codable, Identifiable {
    var person: Entity
    var line: String
    var organisation: Bool
    var id: String { person.id }
}

struct PeopleList: Codable {
    var people: [PersonEntry]
}

/// The person page: the hub of a relationship. docs/ONTOLOGY.md, section 5.2.
struct PersonPage: Codable {
    var person: Entity
    var kindTitle: String?
    var organisation: Bool
    var line: String
    var next: [Linked]
    var tasks: [Linked]
    var done: [Linked]
    var notes: [Linked]
    var things: [Linked]
    var people: [Linked]
    var other: [Linked]
    var routines: [Routine]

    struct Linked: Codable, Identifiable {
        var entity: Entity
        var rel: String
        var when: String?
        var id: String { entity.id }
    }

    var isEmpty: Bool { next.isEmpty && tasks.isEmpty && done.isEmpty && notes.isEmpty && things.isEmpty && people.isEmpty && other.isEmpty && routines.isEmpty }
}

struct GrantResult: Codable {
    var grant: String
    var expiresAt: String
}

struct AuditTip: Codable {
    var seq: Int
    var hash: String
    var at: String?
}

struct AuditCheck: Codable {
    var ok: Bool
    var rewritten: Bool
    var tip: String
}

struct ConnectionList: Codable { var connections: [Connection] }
struct Connection: Codable, Identifiable {
    var id: String
    var kind: String
    var name: String
    var tierCap: String
    var scopes: [String]
    var lastAccess: String?
    var revoked: Bool
    var revocable: Bool
    var reads: [ConnectionRead]
}
/// One row of the read log of an agent: a read of a row, or a search that it made.
struct ClientRead: Codable, Identifiable {
    var at: String
    var action: String
    var type: String?
    var tier: String?
    var title: String?
    var id: String { at + action + (type ?? "") + (title ?? "") }
}

struct ClientReadList: Codable {
    var reads: [ClientRead]
}

/// The rows near an item: each at a number of links from it.
struct Neighbours: Codable {
    var nodes: [Node]
    var edges: [Edge]

    struct Node: Codable, Identifiable {
        var id: String
        var type: String
        var title: String
        var kind: String?
        var distance: Int
    }
    struct Edge: Codable {
        var from: String
        var to: String
        var rel: String
    }
}

struct ConnectionRead: Codable, Identifiable {
    var at: String
    var action: String
    var type: String
    var title: String?
    var id: String { at + type + (title ?? "") }
}
struct JournalEntry: Codable, Identifiable {
    var id: String
    var name: String
    var at: String
    var model: String
    var why: String
    var read: [JournalItem]
    var proposed: [JournalItem]
    var hidden: Bool
}
struct JournalItem: Codable, Identifiable {
    var id: String
    var type: String
    var title: String
    var reason: String?
}
struct ModelSpend: Codable {
    var tokens: Int
    var usd: Double
    var capUsd: Double
    var notice: String?
}

struct LockPayload: Codable {
    var ceiling: String
    var dueCount: Int
    var subtitle: String
    var next: NextEvent?
}

struct PluginInfo: Codable, Identifiable {
    var id: String
    var installed: Bool
    var tokenConfigured: Bool
}

struct PluginList: Codable {
    var plugins: [PluginInfo]
}

struct APIFailure: Codable {
    var error: Detail
    struct Detail: Codable {
        var code: String
        var message: String
    }
}

struct InboxList: Codable {
    var items: [InboxItem]
}

struct TagList: Codable {
    var tags: [String]
}

struct SearchList: Codable {
    var results: [Entity]
}

struct InboxSuggestion: Codable {
    var route: String
    var label: String
    var entityId: String?
}

struct InboxItem: Codable, Identifiable {
    var id: String
    var body: String?
    var tags: [String]?
    var tier: String?
    var source: String?
    var status: String?
    var suggestion: InboxSuggestion?
    var deleted: Bool?
}

/// What went wrong, in the words the owner reads. Each state of the connection has its own case, so a screen can
/// show the right card: a phone that is not paired any more is not the same as a server that is asleep.
enum HMNError: Error, LocalizedError, Equatable {
    case message(String)
    /// The server does not know this phone's key any more.
    case unpaired
    /// No answer in time: the server is off, or the network is down.
    case asleep
    /// The server showed a certificate that this phone did not pair with.
    case pin
    /// The server answered with a fault of its own.
    case fault
    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        case .unpaired: return "This phone is not paired any more. Pair it again in Settings."
        case .asleep: return "Your HMN did not answer. Try again in a moment."
        case .pin: return "Your HMN showed a certificate that this phone does not know."
        case .fault: return "Your HMN could not finish that. Try again."
        }
    }
}
