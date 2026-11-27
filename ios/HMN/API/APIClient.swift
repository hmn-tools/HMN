import CryptoKit
import Foundation

private struct Empty: Decodable {}

/// The one check for the address of your HMN. Only https is allowed, because the pin runs only on TLS.
enum ServerAddress {
    static let notHTTPS = "The address must start with https://"

    static func parse(_ text: String) throws -> URL {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty else {
            throw HMNError.message(notHTTPS)
        }
        return url
    }
}

/// One path segment of a URL. A server-supplied id never adds a "/" or a "." step to the path.
enum Path {
    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    private static let accepted = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-")

    static func segment(_ id: String) throws -> String {
        guard !id.isEmpty, id != ".", id != "..",
              id.unicodeScalars.allSatisfy({ accepted.contains($0) }) else {
            throw HMNError.message("That id is not valid.")
        }
        return id.addingPercentEncoding(withAllowedCharacters: unreserved) ?? id
    }
}

final class APIClient: NSObject, URLSessionDelegate {
    var baseURL: URL
    var token: String
    var fingerprint: String
    private var grant: String?

    /// A kept client holds its connection open between requests. A passing client lets it go after its last request.
    private let keepsWarm: Bool

    init(baseURL: URL, token: String, fingerprint: String, keepsWarm: Bool = false) {
        self.baseURL = baseURL
        self.token = token
        self.fingerprint = fingerprint
        self.keepsWarm = keepsWarm
    }

    func setGrant(_ value: String?) { grant = value }

    /// Each request waits at most this long for the server to answer.
    static let timeout: TimeInterval = 8

    // One session for each client, made on the first request. A passing client ends it after its last request, so
    // the session does not keep the client and its grant alive. A kept client ends it only in finish().
    private let lock = NSLock()
    private var cachedSession: URLSession?
    private var inFlight = 0
    /// How many requests the pin refused that have not yet said why. A count, so two refusals at once both say so.
    private var pinRefused = 0

    private func beginRequest() -> URLSession {
        lock.lock(); defer { lock.unlock() }
        inFlight += 1
        if let cachedSession { return cachedSession }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = Self.timeout
        configuration.waitsForConnectivity = false
        let made = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        cachedSession = made
        return made
    }

    private func endRequest() {
        lock.lock()
        inFlight = max(0, inFlight - 1)
        let done = (!keepsWarm && inFlight == 0) ? cachedSession : nil
        if done != nil { cachedSession = nil }
        lock.unlock()
        done?.finishTasksAndInvalidate()
    }

    private func takePinRefused() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard pinRefused > 0 else { return false }
        pinRefused -= 1
        return true
    }

    /// Ends the session of this client after its running requests finish. A later request makes a new session.
    func finish() {
        lock.lock()
        let old = cachedSession
        cachedSession = nil
        lock.unlock()
        old?.finishTasksAndInvalidate()
    }

    /// Sends one request and turns each failure into a state the owner can read.
    private func perform(_ request: URLRequest) async throws -> Data {
        let session = beginRequest()
        defer { endRequest() }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            if takePinRefused() { throw HMNError.pin }
            switch error.code {
            case .cancelled: throw CancellationError()
            case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot:
                throw HMNError.pin
            default: throw HMNError.asleep
            }
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let failure = try? JSONDecoder().decode(APIFailure.self, from: data)
            // A 401 with a key means the key is gone. A 401 without one is a pairing code that did not work.
            if status == 401, request.value(forHTTPHeaderField: "Authorization") != nil { throw HMNError.unpaired }
            if status >= 500 { throw HMNError.fault }
            if let failure { throw HMNError.message(failure.error.message) }
            throw HMNError.message("Your HMN gave an answer that this phone cannot read.")
        }
        return data
    }

    func me() async throws -> Me { try await send("/api/v1/me", surface: "phone") }
    func today(surface: String) async throws -> TodayScreen {
        try await send("/api/v1/screens/today", surface: surface)
    }
    func screen(_ id: String) async throws -> TodayScreen {
        try await send("/api/v1/screens/\(try Path.segment(id))", surface: "phone")
    }
    func plugins() async throws -> [PluginInfo] {
        let list: PluginList = try await send("/api/v1/plugins", surface: "phone")
        return list.plugins
    }
    func auditTip() async throws -> AuditTip {
        try await send("/api/v1/audit/tip", surface: "phone")
    }
    func modelSpend() async throws -> ModelSpend {
        try await send("/api/v1/models/spend", surface: "phone")
    }
    func checkAuditTip(_ tip: String) async throws -> AuditCheck {
        try await sendJSON("/api/v1/audit/tip/check", method: "POST", surface: "phone", body: ["tip": tip])
    }
    func lock() async throws -> LockPayload {
        try await send("/api/v1/screens/lock", surface: "lock")
    }
    func createLink(fromType: String, fromId: String, toId: String) async throws {
        let _: Empty = try await sendJSON("/api/v1/links", method: "POST", surface: "phone", body: [
            "from_type": fromType, "from_id": fromId, "rel": "about", "to_type": "note", "to_id": toId,
        ])
    }
    func deleteLink(_ id: String) async throws {
        let _: Empty = try await send("/api/v1/links/\(try Path.segment(id))", method: "DELETE", surface: "phone")
    }
    func checkIn(_ id: String) async throws -> Entity {
        try await send("/api/v1/habits/\(try Path.segment(id))/check-in", method: "POST", surface: "phone")
    }
    /// Take back today's check-in.
    func uncheck(_ id: String) async throws -> Entity {
        try await send("/api/v1/habits/\(try Path.segment(id))/check-in", method: "DELETE", surface: "phone")
    }
    func yearReview(_ year: Int?) async throws -> YearReview {
        try await send("/api/v1/review/year" + (year.map { "?year=\($0)" } ?? ""), surface: "phone")
    }
    func saveYearNote(_ year: Int, body: String) async throws -> Entity {
        try await send("/api/v1/review/year/\(year)/note", method: "PUT", surface: "phone", body: ["body": body])
    }
    func people() async throws -> [PersonEntry] {
        let list: PeopleList = try await send("/api/v1/people", surface: "phone")
        return list.people
    }
    func personPage(_ id: String) async throws -> PersonPage {
        try await send("/api/v1/person/\(try Path.segment(id))/page", surface: "phone")
    }
    func routines() async throws -> [Routine] {
        let list: RoutineList = try await send("/api/v1/routines", surface: "phone")
        return list.routines
    }
    func createRoutine(title: String, personId: String, days: [String]) async throws -> Routine {
        try await sendJSON("/api/v1/routines", method: "POST", surface: "phone", body: ["title": title, "person_id": personId, "days": days])
    }
    func editProposal(_ id: String, title: String, due: String, reason: String, links: [[String: String]]) async throws -> Proposal {
        let body: [String: Any] = ["title": title, "due_at": due, "reason": reason, "links": links]
        return try await sendJSON("/api/v1/proposals/\(try Path.segment(id))", method: "PATCH", surface: "phone", body: body)
    }
    func members() async throws -> [Member] {
        let list: MemberList = try await send("/api/v1/members", surface: "phone")
        return list.members
    }
    func memberCode(personId: String, role: String, fridge: Bool = false) async throws -> MemberCode {
        try await sendJSON("/api/v1/members/pairing", method: "POST", surface: "phone", body: ["person_id": personId, "role": role, "fridge": fridge])
    }
    func fridgePairing() async throws -> FridgeStatus {
        try await send("/api/v1/members/pairing/fridge", surface: "phone")
    }
    func endFridgePairing() async throws {
        let _: Empty = try await send("/api/v1/members/pairing/fridge", method: "DELETE", surface: "phone")
    }
    func revokeMember(_ id: String) async throws {
        let _: Empty = try await send("/api/v1/members/\(try Path.segment(id))", method: "DELETE", surface: "phone")
    }
    func lists() async throws -> [ListEntry] {
        let payload: ListsPayload = try await send("/api/v1/lists", surface: "phone")
        return payload.lists
    }
    func items(parent: String) async throws -> ItemsPayload {
        try await send("/api/v1/items?parent_id=\(Self.query(parent))", surface: "phone")
    }
    func familyTasks() async throws -> [FamilyTask] {
        let list: FamilyTaskList = try await send("/api/v1/family-tasks", surface: "phone")
        return list.tasks
    }
    func addItem(parent: String, title: String) async throws -> WriteAnswer {
        try await send("/api/v1/items", method: "POST", surface: "phone", body: ["parent_id": parent, "title": title])
    }
    func setDone(_ id: String, _ done: Bool) async throws -> WriteAnswer {
        try await send("/api/v1/task/\(try Path.segment(id))", method: "PATCH", surface: "phone", body: ["status": done ? "done" : "open"])
    }
    func createList(title: String, tier: String) async throws -> WriteAnswer {
        try await send("/api/v1/project", method: "POST", surface: "phone", body: ["title": title, "kind": "list", "status": "active", "tier": tier])
    }
    /// A link from a task to a person it is for.
    func link(fromType: String, fromId: String, rel: String, toType: String, toId: String) async throws {
        let _: Empty = try await sendJSON("/api/v1/links", method: "POST", surface: "phone", body: [
            "from_type": fromType, "from_id": fromId, "rel": rel, "to_type": toType, "to_id": toId,
        ])
    }
    func entities(_ type: String, archived: Bool) async throws -> [Entity] {
        let list: EntityList = try await send("/api/v1/\(try Path.segment(type))\(archived ? "?archived=1" : "")", surface: "phone")
        return list.entities
    }
    func entities(_ type: String) async throws -> [Entity] {
        let list: EntityList = try await send("/api/v1/\(try Path.segment(type))", surface: "phone")
        return list.entities
    }
    func accessReads(_ id: String, limit: Int = 200) async throws -> [ClientRead] {
        let list: ClientReadList = try await send("/api/v1/access/\(try Path.segment(id))/reads?limit=\(limit)", surface: "phone")
        return list.reads
    }
    func agentScope(_ id: String) async throws -> AgentScope {
        try await send("/api/v1/access/\(try Path.segment(id))/scope", surface: "phone")
    }
    /// The Today screen as that agent key would get it. Read only.
    func agentToday(_ id: String) async throws -> TodayScreen {
        try await send("/api/v1/access/\(try Path.segment(id))/today", surface: "phone")
    }
    func agentTimeline(_ id: String, limit: Int = 100) async throws -> AgentTimeline {
        try await send("/api/v1/access/\(try Path.segment(id))/timeline?limit=\(limit)", surface: "phone")
    }
    func neighbours(type: String, id: String, depth: Int = 2) async throws -> Neighbours {
        try await send("/api/v1/\(try Path.segment(type))/\(try Path.segment(id))/neighbours?depth=\(depth)", surface: "phone")
    }
    func links(type: String, id: String) async throws -> [GraphLink] {
        let list: LinkList = try await send("/api/v1/\(try Path.segment(type))/\(try Path.segment(id))/links", surface: "phone")
        return list.links
    }
    func proposals() async throws -> [Proposal] {
        let list: ProposalList = try await send("/api/v1/proposals", surface: "phone")
        return list.proposals
    }
    func inboxItems() async throws -> [InboxItem] {
        let list: InboxList = try await send("/api/v1/inbox", surface: "phone")
        return list.items
    }
    func inboxTags(_ query: String) async throws -> [String] {
        let escaped = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let list: TagList = try await send("/api/v1/inbox/tags?q=\(escaped)", surface: "phone")
        return list.tags
    }
    func search(_ query: String) async throws -> [Entity] {
        let escaped = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let list: SearchList = try await send("/api/v1/search?q=\(escaped)", surface: "phone")
        return list.results
    }
    func captureInbox(text: String, source: String, tier: String, attachments: [[String: String]], url: String? = nil) async throws -> InboxItem {
        var body: [String: Any] = ["text": text, "source": source, "tier": tier]
        if let url, !url.isEmpty { body["url"] = url }
        if !attachments.isEmpty { body["attachments"] = attachments }
        return try await sendJSON("/api/v1/inbox", method: "POST", surface: "phone", body: body)
    }
    func processInbox(_ id: String, action: String, text: String? = nil, entityId: String? = nil, route: String? = nil) async throws -> InboxItem {
        var body: [String: Any] = ["action": action]
        if let text { body["text"] = text }
        if let entityId { body["entity_id"] = entityId }
        if let route { body["route"] = route }
        return try await sendJSON("/api/v1/inbox/\(try Path.segment(id))/process", method: "POST", surface: "phone", body: body)
    }
    /// A task with no date goes to the inbox, unless the caller names a status, such as "open" for a step of a project.
    /// A task made on a person or a project page takes that page's area and tier, so it is seen where the page is.
    func createTask(title: String, due: String?, status: String? = nil, areaId: String? = nil, tier: String? = nil) async throws -> Entity {
        var body: [String: String] = ["title": title, "status": status ?? (due == nil ? "inbox" : "open"), "kind": "task"]
        if let due { body["due_at"] = due }
        if let areaId { body["area_id"] = areaId }
        if let tier { body["tier"] = tier }
        return try await send("/api/v1/task", method: "POST", surface: "phone", body: body)
    }
    /// What the editors need: statuses, kinds, relations, and typed fields. docs/SCHEMA.md.
    func schema() async throws -> AppSchema {
        try await send("/api/v1/schema", surface: "phone")
    }
    /// One record by its id, and its properties as plain values for the typed fields.
    func record(type: String, id: String) async throws -> (Entity, [String: Any]) {
        let path = "/api/v1/\(try Path.segment(type))/\(try Path.segment(id))"
        let entity: Entity = try await send(path, surface: "phone")
        let raw: RawRecord = try await send(path, surface: "phone")
        return (entity, raw.properties)
    }
    func createRecord(type: String, body: [String: Any]) async throws -> Entity {
        try await sendJSON("/api/v1/\(try Path.segment(type))", method: "POST", surface: "phone", body: body)
    }
    /// A change with any values: NSNull clears a field, and `properties_patch` changes some properties only.
    func updateRecord(type: String, id: String, body: [String: Any]) async throws -> Entity {
        try await sendJSON("/api/v1/\(try Path.segment(type))/\(try Path.segment(id))", method: "PATCH", surface: "phone", body: body)
    }
    func updateEntity(type: String, id: String, fields: [String: String]) async throws -> Entity {
        try await send("/api/v1/\(try Path.segment(type))/\(try Path.segment(id))", method: "PATCH", surface: "phone", body: fields)
    }
    func deleteEntity(type: String, id: String) async throws {
        let _: Empty = try await send("/api/v1/\(try Path.segment(type))/\(try Path.segment(id))", method: "DELETE", surface: "phone")
    }
    func approve(_ id: String) async throws -> Proposal {
        try await send("/api/v1/proposals/\(try Path.segment(id))/approve", method: "POST", surface: "phone")
    }
    func reject(_ id: String) async throws -> Proposal {
        try await send("/api/v1/proposals/\(try Path.segment(id))/reject", method: "POST", surface: "phone")
    }
    func pending(source: String) async throws -> [Proposal] {
        let list: ProposalList = try await send("/api/v1/proposals?status=pending&source=\(Self.query(source))", surface: "phone")
        return list.proposals
    }
    /** One decision for the named proposals of one source. The caller sends each id that it showed. */
    func decideBatch(approve: Bool, source: String, ids: [String]) async throws -> BatchResult {
        try await sendJSON("/api/v1/proposals/batch", method: "POST", surface: "phone", body: [
            "decision": approve ? "approve" : "reject", "source": source, "ids": ids,
        ])
    }
    func activity() async throws -> [ActivityItem] {
        let list: ActivityList = try await send("/api/v1/activity", surface: "phone")
        return list.activity
    }
    func undo(_ id: String) async throws {
        let _: Proposal = try await send("/api/v1/proposals/\(try Path.segment(id))/undo", method: "POST", surface: "phone")
    }
    func clearDecline(_ id: String) async throws {
        let _: Removed = try await send("/api/v1/proposals/\(try Path.segment(id))/clear", method: "POST", surface: "phone")
    }
    func policy() async throws -> PolicyList {
        try await send("/api/v1/policy", surface: "phone")
    }
    func setPolicy(source: String, mode: String) async throws {
        let _: PolicyRule = try await sendJSON("/api/v1/policy", method: "PUT", surface: "phone", body: ["source": source, "mode": mode])
    }
    func removePolicy(_ id: String) async throws {
        let _: Removed = try await send("/api/v1/policy/\(try Path.segment(id))", method: "DELETE", surface: "phone")
    }
    func agentKeys() async throws -> AgentKeyList {
        try await send("/api/v1/keys", surface: "phone")
    }
    /// A view key has the scope `read`. It starts at Public, and it cannot propose.
    func createAgentKey(name: String, view: Bool = false) async throws -> AgentKey {
        let body: [String: Any] = view ? ["name": name, "scope": "read"] : ["name": name]
        return try await sendJSON("/api/v1/keys", method: "POST", surface: "phone", body: body)
    }
    func changeKey(_ id: String, fields: [String: Any]) async throws -> AgentKey {
        try await sendJSON("/api/v1/keys/\(try Path.segment(id))", method: "POST", surface: "phone", body: fields)
    }
    func keyPreview(_ id: String) async throws -> KeyPreview {
        try await send("/api/v1/keys/\(try Path.segment(id))/preview", surface: "phone")
    }
    /** The owner confirmed the three warnings on the screen before this call. */
    func grantPrivate(_ id: String, days: Int) async throws -> AgentKey {
        try await sendJSON("/api/v1/keys/\(try Path.segment(id))/private", method: "POST", surface: "phone", body: ["days": days, "understood": true])
    }
    func endPrivate(_ id: String) async throws -> AgentKey {
        try await send("/api/v1/keys/\(try Path.segment(id))/private", method: "DELETE", surface: "phone")
    }
    func kinds() async throws -> KindList {
        try await send("/api/v1/kinds", surface: "phone")
    }
    /** A kind with no role is a name only. */
    /// The fields that one kind adds. The list replaces the one before.
    func saveKindFields(type: String, kind: String, fields: [[String: Any]]) async throws {
        let _: Empty = try await sendJSON("/api/v1/kinds/\(try Path.segment(type))/\(try Path.segment(kind))/fields", method: "PUT", surface: "phone", body: ["fields": fields])
    }
    func agentRequests(status: String? = nil) async throws -> [AgentRequest] {
        let list: AgentRequestList = try await send(status.map { "/api/v1/agent-requests?status=\($0)" } ?? "/api/v1/agent-requests", surface: "phone")
        return list.requests
    }
    func unreadableDates() async throws -> [UnreadableDate] {
        let list: UnreadableDateList = try await send("/api/v1/dates/unreadable", surface: "phone")
        return list.dates
    }
    func setAgentRequest(_ id: String, status: String) async throws {
        let _: Empty = try await send("/api/v1/agent-requests/\(try Path.segment(id))", method: "PATCH", surface: "phone", body: ["status": status])
    }
    func saveKind(type: String, kind: String, title: String, role: String?) async throws -> KindInfo {
        var body: [String: Any] = ["type": type, "kind": kind, "title": title]
        if let role { body["role"] = role }
        return try await sendJSON("/api/v1/kinds", method: "PUT", surface: "phone", body: body)
    }
    func removeKind(type: String, kind: String) async throws {
        let _: Empty = try await send("/api/v1/kinds/\(try Path.segment(type))/\(try Path.segment(kind))", method: "DELETE", surface: "phone")
    }
    func areas() async throws -> [AreaRow] {
        let list: AreaRowList = try await send("/api/v1/area", surface: "phone")
        return list.entities
    }
    /** With no tier, the server sets the tier of the items from the role of the kind. */
    func createArea(title: String, kind: String, childTier: String?) async throws -> AreaRow {
        var body: [String: Any] = ["title": title, "kind": kind]
        if let childTier { body["properties"] = ["child_tier": childTier] }
        return try await sendJSON("/api/v1/area", method: "POST", surface: "phone", body: body)
    }
    func calendars() async throws -> CalendarList {
        try await send("/api/v1/calendars", surface: "phone")
    }
    func saveCalendar(id: String?, fields: [String: Any]) async throws -> CalendarInfo {
        try await sendJSON(try id.map { "/api/v1/calendars/\(try Path.segment($0))" } ?? "/api/v1/calendars", method: "POST", surface: "phone", body: fields)
    }
    func syncCalendars() async throws -> CalendarSyncResult {
        try await send("/api/v1/calendars/sync", method: "POST", surface: "phone")
    }
    private static func query(_ value: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+?")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
    func submitHealth(_ summaries: [[String: Any]], includeSamples: Bool) async throws {
        var body: [String: Any] = ["summaries": summaries]
        if includeSamples { body["include_samples"] = true }
        let _: Empty = try await sendJSON("/api/v1/plugins/health/submit", method: "POST", surface: "phone", body: body)
    }
    func pair(code: String, name: String) async throws -> PairResult {
        try await send("/api/v1/pair", method: "POST", surface: "phone", body: ["code": code, "device_name": name], authenticated: false)
    }
    func mintGrant() async throws -> GrantResult {
        try await send("/api/v1/vault/grants", method: "POST", surface: "phone")
    }
    func panic() async throws { let _: Empty = try await send("/api/v1/panic", method: "POST", surface: "phone") }
    func audit() async throws -> [AuditEntry] {
        let list: AuditList = try await send("/api/v1/audit", surface: "phone")
        return list.entries
    }
    func connections() async throws -> [Connection] {
        let list: ConnectionList = try await send("/api/v1/access", surface: "phone")
        return list.connections
    }
    @discardableResult
    func revokeConnection(_ id: String) async throws -> RevokeResult {
        try await send("/api/v1/access/\(try Path.segment(id))/revoke", method: "POST", surface: "phone")
    }
    func journal(_ id: String) async throws -> JournalEntry {
        try await send("/api/v1/journals/\(try Path.segment(id))", surface: "phone")
    }

    private func send<T: Decodable>(
        _ path: String,
        method: String = "GET",
        surface: String,
        body: [String: String]? = nil,
        authenticated: Bool = true
    ) async throws -> T {
        guard baseURL.scheme?.lowercased() == "https" else { throw HMNError.message(ServerAddress.notHTTPS) }
        guard let url = URL(string: path, relativeTo: baseURL), url.scheme?.lowercased() == "https" else { throw HMNError.message(ServerAddress.notHTTPS) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(surface, forHTTPHeaderField: "X-HMN-Surface")
        if authenticated {
            guard !token.isEmpty else { throw HMNError.message("Pair this phone in Settings.") }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let grant { request.setValue(grant, forHTTPHeaderField: "X-HMN-Grant") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data = try await perform(request)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: data)
    }

    private func sendJSON<T: Decodable>(_ path: String, method: String, surface: String, body: [String: Any]) async throws -> T {
        guard baseURL.scheme?.lowercased() == "https" else { throw HMNError.message(ServerAddress.notHTTPS) }
        guard let url = URL(string: path, relativeTo: baseURL), url.scheme?.lowercased() == "https" else { throw HMNError.message(ServerAddress.notHTTPS) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(surface, forHTTPHeaderField: "X-HMN-Surface")
        guard !token.isEmpty else { throw HMNError.message("Pair this phone in Settings.") }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let grant { request.setValue(grant, forHTTPHeaderField: "X-HMN-Grant") }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let data = try await perform(request)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: data)
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else {
            return (.cancelAuthenticationChallenge, nil)
        }
        let der = SecCertificateCopyData(leaf) as Data
        let digest = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
        guard !fingerprint.isEmpty, digest == fingerprint.lowercased() else {
            lock.lock(); pinRefused += 1; lock.unlock()
            return (.cancelAuthenticationChallenge, nil)
        }
        return (.useCredential, URLCredential(trust: trust))
    }
}
