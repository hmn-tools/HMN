import SwiftUI

@main
struct HMNApp: App {
    @StateObject private var session = Session()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .tint(Theme.ink)
                // A text with no colour of its own takes ink. Ink is dark in light mode and light in dark mode.
                .foregroundStyle(Theme.ink)
        }
    }
}

@MainActor
final class Session: ObservableObject {
    @Published var serverURL: String { didSet { persistConnection() } }
    @Published var fingerprint: String { didSet { persistConnection() } }
    @Published var token: String
    @Published var grant: String?
    @Published var today: TodayScreen?
    @Published var banner: String?
    @Published var showCapture = false
    @Published var showSettings = false
    /// True when the audit log of your HMN did not match the tip this phone kept.
    /// It stays on until the owner taps the button. The Keychain keeps the flag.
    @Published var auditAlarm = KeychainStore.auditAlarmOn()
    private var flushing = false

    /// A pairing link that the camera opened. The app asks before it uses it.
    @Published var pairLink: PairLink?

    /// The member this phone belongs to. Nil on the owner's phone.
    @Published var member: MemberInfo? = SettingsStore.member

    /// True when this phone has a key for your HMN.
    var isPaired: Bool { !token.isEmpty }
    /// True on a member's phone: the app shows Home, Lists, and Family.
    var isMember: Bool { isPaired && member != nil }

    func setMember(_ value: MemberInfo?) {
        member = value
        SettingsStore.member = value
    }

    /// The server says whose phone this is. A phone that was paired before member mode learns it here.
    func refreshMember() async {
        guard isPaired, let me = try? await client().me() else { return }
        if me.member != member { setMember(me.member) }
    }

    /// Forget the key on this phone. The server keeps the credential until the owner revokes it.
    func forget() {
        KeychainStore.clear()
        token = ""
        setMember(nil)
        today = nil
        SnapshotStore.clear()
    }

    init() {
        let saved = KeychainStore.loadConnection()
        var url = SettingsStore.serverURL
        var pin = SettingsStore.fingerprint
        if url.isEmpty, let saved = saved, !saved.url.isEmpty { url = saved.url }
        if pin.isEmpty, let saved = saved, !saved.fingerprint.isEmpty { pin = saved.fingerprint }
        if !url.isEmpty { SettingsStore.serverURL = url }
        if !pin.isEmpty { SettingsStore.fingerprint = pin }
        self.serverURL = url
        self.fingerprint = pin
        self.token = KeychainStore.load() ?? ""
        self.auditAlarm = KeychainStore.auditAlarmOn()
    }

    /// Writes the address and fingerprint now. The device key is stored separately.
    func persistConnection() {
        SettingsStore.serverURL = serverURL
        SettingsStore.fingerprint = fingerprint
        try? KeychainStore.saveConnection(url: serverURL, fingerprint: fingerprint)
    }

    func client() -> APIClient {
        // A bad address gets a client that refuses every call with a plain message.
        let url = (try? ServerAddress.parse(serverURL)) ?? URL(string: "about:blank")!
        let api = APIClient(baseURL: url, token: token, fingerprint: fingerprint.trimmingCharacters(in: .whitespacesAndNewlines))
        api.setGrant(grant)
        return api
    }

    func refreshToday() async {
        do {
            let phone = try await client().today(surface: "phone")
            today = phone
            SnapshotStore.savePhone(phone)
            let widget = try await client().today(surface: "widget")
            SnapshotStore.save(widget)
            banner = nil
        } catch {
            banner = today == nil ? nil : "Offline. This is the last saved day."
        }
    }

    func hide() async {
        try? await client().panic()
        SnapshotStore.clear()
        grant = nil
        await refreshToday()
    }

    /// The owner closes the vault when the app leaves the screen.
    func closeVault() { grant = nil }

    func raiseAuditAlarm() {
        auditAlarm = true
        try? KeychainStore.setAuditAlarm(true)
    }

    /// The owner has seen the alarm. Only now the phone adopts the tip that the server holds.
    func acknowledgeAuditAlarm() async {
        do {
            let tip = try await client().auditTip()
            try KeychainStore.saveAuditTip(tip.hash)
            try KeychainStore.setAuditAlarm(false)
            auditAlarm = false
        } catch {
            banner = error.localizedDescription
        }
    }

    func flushInbox() async {
        guard !flushing else { return }
        flushing = true
        defer { flushing = false }
        for queued in InboxQueue.pending() {
            let item = queued.item
            var text = item.text
            let attachments = item.attachments.map { ["kind": $0.kind, "name": $0.name, "content_type": $0.contentType] }
            if item.privateNote && !text.contains("#private") {
                text = text.isEmpty ? "#private" : "\(text) #private"
            }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty && attachments.isEmpty {
                InboxQueue.remove(queued.id)
                continue
            }
            let tier = ["household", "private", "sealed"].contains(item.tier) ? item.tier : "personal"
            do {
                _ = try await client().captureInbox(text: trimmed.isEmpty ? "Attachment" : trimmed, source: item.source, tier: tier, attachments: attachments, url: item.url)
                // The server accepted it. Only now the item leaves the queue.
                InboxQueue.remove(queued.id)
            } catch {
                // It stays in the queue. The next flush tries again.
                continue
            }
        }
        if InboxQueue.consumeOpen() { showCapture = true }
    }

    /// Pair with the address, fingerprint, and code of a QR code. A failure puts the old address back.
    func pair(with link: PairLink) async throws {
        let oldURL = serverURL
        let oldPin = fingerprint
        if let url = link.url { serverURL = url }
        fingerprint = link.fingerprint
        do {
            let result = try await client().pair(code: link.code, name: "iPhone")
            try savePairing(secret: result.secret)
            setMember(result.member)
            today = nil
            SnapshotStore.clear()
        } catch {
            serverURL = oldURL
            fingerprint = oldPin
            throw error
        }
    }

    func savePairing(secret: String) throws {
        _ = try ServerAddress.parse(serverURL)
        serverURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        fingerprint = fingerprint.trimmingCharacters(in: .whitespacesAndNewlines)
        try KeychainStore.save(secret)
        token = secret
        persistConnection()
    }
}
