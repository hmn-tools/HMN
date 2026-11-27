import Combine
import Foundation

@MainActor
final class MenuModel: ObservableObject {
    @Published var config: MenuConfig
    @Published var launchd = "Not checked"
    @Published var health = "Not checked"
    @Published var version = ""
    @Published var hiddenCount = 0
    @Published var pairedCount = 0
    @Published var devices: [PairedDevice] = []
    @Published var backups: [BackupFile] = []
    @Published var audit: [AuditEntry] = []
    @Published var chain = "Not checked"
    @Published var chainOK: Bool?
    @Published var pairingCode = ""
    @Published var pairingPayload = ""
    @Published var notice = ""
    @Published var noticeArea: NoticeArea = .general
    @Published var starting = false
    @Published var fault = false
    @Published var busy = false
    @Published var ownerKeyPresent = false
    @Published var modelRoutes: [String] = []
    @Published var modelRam = "no extra RAM"
    @Published var voice = VoiceNote.line
    @Published var localModels: [ManagedModel] = []
    @Published var spendLine = "This month: nothing is sent to the cloud."
    @Published var spendNotice = false
    @Published var externalOn = false
    @Published var externalPort = "8788"

    private var client: AdminClient?
    private var cachedOwnerKey: String?
    private let transportFactory: (String) -> ((URLRequest) async throws -> HTTPResult)?
    private let keyLoader: () async -> String?
    private let configLoader: () -> MenuConfig
    private let statusChecker: (ServiceSpec) async -> Bool

    init(
        config: MenuConfig? = nil,
        transportFactory: ((String) -> ((URLRequest) async throws -> HTTPResult)?)? = nil,
        keyLoader: (() async -> String?)? = nil,
        statusChecker: ((ServiceSpec) async -> Bool)? = nil
    ) {
        self.config = config ?? MenuConfig.loadFromDisk()
        self.configLoader = config.map { fixed in { fixed } } ?? { MenuConfig.loadFromDisk() }
        self.transportFactory = transportFactory ?? { fingerprint in
            let transport = PinnedTransport(fingerprint: fingerprint)
            return { request in try await transport.send(request) }
        }
        self.keyLoader = keyLoader ?? { await KeychainStore.loadAsync(service: "hmn.owner") }
        self.statusChecker = statusChecker ?? { spec in await ServiceControl.run(.status, spec: spec) }
    }

    var serverState: ServerState {
        if starting { return .starting }
        if launchd != "loaded" { return .stopped }
        if health != "answering" { return .unreachable }
        return fault ? .fault : .running
    }

    /// The data cards show only when the server answers and the owner key is there.
    var panelsReady: Bool { serverState == .running && ownerKeyPresent }

    private func clearLists() {
        devices = []
        backups = []
        audit = []
        hiddenCount = 0
        pairedCount = 0
        chainOK = nil
        chain = "Not checked"
        pairingCode = ""
        pairingPayload = ""
    }

    func refresh() async {
        notice = ""
        noticeArea = .server
        fault = false
        config = configLoader()
        launchd = await statusChecker(config.service) ? "loaded" : "not loaded"
        guard !config.fingerprint.isEmpty else {
            health = "No certificate pin yet."
            clearLists()
            return
        }
        let key: String?
        if let cached = cachedOwnerKey, !cached.isEmpty {
            key = cached
        } else {
            let loaded = await keyLoader()
            if let loaded, !loaded.isEmpty {
                cachedOwnerKey = loaded
            }
            key = loaded
        }
        ownerKeyPresent = !(key ?? "").isEmpty
        guard let send = transportFactory(config.fingerprint) else {
            health = "The server did not answer."
            clearLists()
            return
        }
        let next = AdminClient(baseURL: config.baseURL, key: key, fingerprint: config.fingerprint, send: send)
        client = next
        do {
            let live = try await next.health()
            health = live.ok ? "answering" : "not answering"
            version = live.version
        } catch {
            health = "The server did not answer."
            clearLists()
            return
        }
        guard ownerKeyPresent else {
            noticeArea = .owner
            notice = "The owner key is not in the Keychain."
            return
        }
        do {
            let status = try await next.status()
            hiddenCount = status.devices.hidden
            pairedCount = status.devices.paired
            version = status.version
            devices = try await next.devices().devices
            backups = try await next.backups().backups
            audit = try await next.audit().entries
            let verified = try await next.verify()
            chainOK = verified.ok
            chain = verified.ok ? "The activity record checks out." : "The activity record does not check out. Something changed it."
            if let board = try? await next.modelBoard() {
                voice = board.voice
                modelRam = board.ramLabel
                modelRoutes = board.routes.keys.sorted().map { key in
                    let id = board.routes[key] ?? ""
                    let name = board.models.first { $0.id == id }?.name ?? String(id.split(separator: ":", maxSplits: 1).last ?? "")
                    return "\(MenuWords.route(key)): \(name)"
                }
                localModels = board.models.filter { $0.runtime == "ollama" }
                if let spend = board.spend {
                    spendNotice = spend.notice != nil
                    spendLine = spend.notice ?? spend.line
                }
            }
            if let gate = try? await next.externalGate() {
                externalOn = gate.enabled
                externalPort = gate.port
            }
        } catch let error as AdminFailure {
            clearLists()
            fault = true
            noticeArea = .server
            notice = Self.notice(for: error)
        } catch {
            clearLists()
            fault = true
            noticeArea = .server
            notice = "The server refused."
        }
    }

    func start() async { await service(.start) }
    func stop() async { await service(.stop) }
    func restart() async { await service(.restart) }

    func setExternal(_ on: Bool) async {
        guard let client else { return }
        await run(.outside) { _ = try await client.setExternal(on) }
    }

    func hide() async {
        guard let client else { return }
        await run(.hide) {
            if self.hiddenCount > 0 {
                _ = try await client.clearPanic()
            } else {
                _ = try await client.panic()
            }
        }
    }

    func pair() async {
        guard let client else { return }
        await run(.pair) {
            let code = try await client.pair()
            self.pairingCode = code.code
            self.pairingPayload = code.payload
        }
    }

    func revoke(_ id: String) async {
        guard let client else { return }
        await run(.phones) { try await client.revoke(id: id) }
    }

    func backup() async {
        guard let client else { return }
        await run(.backups) { try await client.backup() }
    }

    func restore(_ name: String) async {
        guard let client else { return }
        await run(.backups) { try await client.restore(name: name) }
    }

    func pullModel(_ id: String) async {
        guard let client else { return }
        await run(.models) { try await client.pullModel(id) }
    }

    func removeModel(_ id: String) async {
        guard let client else { return }
        await run(.models) { try await client.removeModel(id) }
    }

    func saveOwnerKey(_ secret: String) -> Bool {
        let trimmed = secret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard OwnerKeyRule.accepts(trimmed) else { return false }
        let saved = KeychainStore.save(service: "hmn.owner", secret: trimmed)
        if saved {
            cachedOwnerKey = trimmed
            ownerKeyPresent = true
        }
        return saved
    }

    private func service(_ action: ServiceAction) async {
        busy = true
        starting = action == .start || action == .restart
        defer {
            busy = false
            starting = false
        }
        if action == .start {
            let loaded = await ServiceControl.run(.status, spec: config.service)
            _ = await ServiceControl.run(loaded ? .restart : .start, spec: config.service)
        } else {
            _ = await ServiceControl.run(action, spec: config.service)
        }
        try? await Task.sleep(nanoseconds: 400_000_000)
        await refresh()
        // A server takes a few seconds to answer after a start. Look again before the panel says it is not answering.
        if action != .stop {
            var tries = 0
            while health != "answering" && launchd == "loaded" && tries < 6 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await refresh()
                tries += 1
            }
        }
    }

    private func run(_ area: NoticeArea, _ work: () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do {
            try await work()
            await refresh()
        } catch let error as AdminFailure {
            noticeArea = area
            notice = Self.notice(for: error)
        } catch {
            noticeArea = area
            notice = "The server refused."
        }
    }

    private static func notice(for error: AdminFailure) -> String {
        switch error {
        case .refused(let message):
            return message
        case .missingKey:
            return "The owner key is not in the Keychain."
        case .unpinned:
            return "No certificate pin yet."
        case .unreachable:
            return "The server did not answer."
        case .undecodable:
            return "The server refused."
        }
    }
}
