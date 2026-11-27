import XCTest
@testable import HMNMenu

final class MenuLogicTests: XCTestCase {
    func testCertificatePinHashAndCompare() {
        let hash = CertPin.sha256Hex(Data("hmn-test-cert".utf8))
        XCTAssertEqual(hash, "ebdfef3d741c8efa2430b571a9835479821e0146093ef47760dfe629bf87c397")
        XCTAssertTrue(CertPin.matches(expected: hash.uppercased(), actual: hash))
        XCTAssertFalse(CertPin.matches(expected: hash, actual: "abc"))
        XCTAssertFalse(CertPin.matches(expected: "", actual: hash))
    }

    func testBackupNamesRejectPaths() {
        XCTAssertTrue(BackupName.isValid("backup-2026-11-11T043900000Z.hmn"))
        XCTAssertFalse(BackupName.isValid("../hmn.sqlite.enc"))
        XCTAssertFalse(BackupName.isValid("backup-2026-11-11T043900000Z.hmn/../../etc/passwd"))
        XCTAssertFalse(BackupName.isValid("/tmp/backup-2026-11-11T043900000Z.hmn"))
        XCTAssertFalse(BackupName.isValid("notes.txt"))
    }

    func testOwnerKeyRule() {
        XCTAssertTrue(OwnerKeyRule.accepts("hmn_shortkey"))
        XCTAssertFalse(OwnerKeyRule.accepts("not-a-key"))
        XCTAssertFalse(OwnerKeyRule.accepts("hmn_short"))
        XCTAssertFalse(OwnerKeyRule.accepts("hmn_has space"))
    }

    func testServiceCommands() {
        let gui = ServiceSpec(
            label: "org.hmn.server",
            domain: "gui",
            uid: "501",
            plistPath: "/Users/example/Library/LaunchAgents/org.hmn.server.plist"
        )
        XCTAssertEqual(
            ServiceControl.command(action: .start, spec: gui),
            ["launchctl", "bootstrap", "gui/501", gui.plistPath]
        )
        XCTAssertEqual(
            ServiceControl.command(action: .stop, spec: gui),
            ["launchctl", "bootout", "gui/501/org.hmn.server"]
        )
        XCTAssertEqual(
            ServiceControl.command(action: .restart, spec: gui),
            ["launchctl", "kickstart", "-k", "gui/501/org.hmn.server"]
        )
        let system = ServiceSpec(
            label: "org.hmn.server",
            domain: "system",
            uid: "0",
            plistPath: "/Library/LaunchDaemons/org.hmn.server.plist"
        )
        XCTAssertEqual(
            ServiceControl.command(action: .start, spec: system),
            ["launchctl", "bootstrap", "system", system.plistPath]
        )
        XCTAssertEqual(
            ServiceControl.command(action: .status, spec: system),
            ["launchctl", "print", "system/org.hmn.server"]
        )
    }

    func testMenuConfigDecodesWithoutSecrets() throws {
        let json = """
        {"base_url":"https://127.0.0.1:8787","fingerprint":"abc123","label":"org.hmn.server","domain":"gui","plist":"/tmp/hmn.plist","uid":"501"}
        """
        let config = try MenuConfig.load(from: Data(json.utf8))
        XCTAssertEqual(config.baseURL, "https://127.0.0.1:8787")
        XCTAssertEqual(config.service.uid, "501")
        XCTAssertFalse(json.contains("hmn_"))
    }

    func testSafeMessageDropsASecret() {
        let body = Data(#"{"error":{"code":"unauthorized","message":"bearer hmn_sample"}}"#.utf8)
        XCTAssertEqual(APIMessage.safe(from: body), "The server refused.")
        let calm = Data(#"{"error":{"code":"localhost","message":"This is only on the mini itself."}}"#.utf8)
        XCTAssertEqual(APIMessage.safe(from: calm), "This is only on the mini itself.")
    }

    func testExternalSwitchUsesTheLocalhostGate() async throws {
        var calls: [(String, String)] = []
        let client = AdminClient(baseURL: "https://127.0.0.1:8787", key: "hmn_shortkey", fingerprint: "abc") { request in
            calls.append((request.httpMethod ?? "", request.url?.path ?? ""))
            let on = request.url?.path.hasSuffix("/enable") == true
            let body = #"{"enabled":\#(on),"port":"8788"}"#
            return HTTPResult(status: 200, body: Data(body.utf8))
        }
        let current = try await client.externalGate()
        XCTAssertFalse(current.enabled)
        XCTAssertEqual(current.port, "8788")
        let closed = try await client.setExternal(false)
        XCTAssertFalse(closed.enabled)
        let opened = try await client.setExternal(true)
        XCTAssertTrue(opened.enabled)
        XCTAssertEqual(calls.map(\.0), ["GET", "POST", "POST"])
        XCTAssertEqual(calls.map(\.1), ["/api/v1/external", "/api/v1/external/disable", "/api/v1/external/enable"])
    }

    func testClientSendsTheKeyAsAHeader() async throws {
        let key = "hmn_shortkey"
        let client = AdminClient(baseURL: "https://127.0.0.1:8787/", key: key, fingerprint: "abc123") { request in
            XCTAssertEqual(request.url?.absoluteString, "https://127.0.0.1:8787/api/v1/admin/status")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(key)")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-HMN-Surface"), "phone")
            XCTAssertFalse(request.url?.absoluteString.contains(key) ?? true)
            let body = #"{"ok":true,"service":"hmn","version":"0.1.0","time":"2026-11-11T04:39:00.000Z","fingerprint":"abc123","devices":{"paired":1,"hidden":0},"backups":0}"#
            return HTTPResult(status: 200, body: Data(body.utf8))
        }
        let status = try await client.status()
        XCTAssertEqual(status.devices.paired, 1)
        XCTAssertEqual(status.fingerprint, "abc123")
    }

    func testClientDecodesDevicesAuditAndBackups() async throws {
        let client = AdminClient(baseURL: "https://127.0.0.1:8787", key: "hmn_shortkey", fingerprint: "abc") { request in
            let path = request.url?.path ?? ""
            let body: String
            if path.hasSuffix("/devices") {
                body = #"{"devices":[{"id":"device_test","name":"Test phone","scope":"write","max_tier":"private","forced_ceiling":null,"expires_at":"2027-02-09T04:39:00.000Z","created_at":"2026-11-11T04:39:00.000Z","revoked_at":null}]}"#
            } else if path.hasSuffix("/audit/verify") {
                body = #"{"ok":false,"tip":"0000","rows":1}"#
                return HTTPResult(status: 409, body: Data(body.utf8))
            } else if path.hasSuffix("/audit") {
                body = #"{"entries":[{"seq":1,"at":"2026-11-11T04:39:00.000Z","actor":"device_test","action":"pair","tier":null,"entity_type":"device","entity_id":"device_test","surface":"api"}]}"#
            } else if path.hasSuffix("/backups") {
                body = #"{"backups":[{"name":"backup-2026-11-11T043900000Z.hmn","bytes":12,"modified_at":"2026-11-11T04:39:00.000Z"}]}"#
            } else {
                body = "{}"
            }
            return HTTPResult(status: 200, body: Data(body.utf8))
        }
        let devices = try await client.devices()
        XCTAssertEqual(devices.devices.first?.name, "Test phone")
        XCTAssertFalse(devices.devices.first?.isHidden ?? true)
        let listed = try await client.audit()
        XCTAssertEqual(listed.entries.first?.action, "pair")
        let verify = try await client.verify()
        XCTAssertFalse(verify.ok)
        let backups = try await client.backups()
        XCTAssertEqual(backups.backups.first?.name, "backup-2026-11-11T043900000Z.hmn")
    }

    func testRestoreRefusesAPathBeforeTheRequest() async {
        let client = AdminClient(baseURL: "https://127.0.0.1:8787", key: "hmn_shortkey", fingerprint: "abc") { _ in
            XCTFail("A bad backup name must not be sent")
            return HTTPResult(status: 500, body: Data())
        }
        do {
            try await client.restore(name: "../hmn.sqlite.enc")
            XCTFail("expected a refusal")
        } catch let error as AdminFailure {
            XCTAssertEqual(error, .refused("Name a backup from this mini."))
        } catch {
            XCTFail("unexpected error")
        }
    }

    func testPairingQRUsesThePayloadOnly() throws {
        let image = QRCode.image(for: "hmn://pair?code=TESTCODE&fp=abc123")
        XCTAssertNotNil(image)
        XCTAssertNil(QRCode.image(for: ""))
        XCTAssertEqual(VoiceNote.line, "Voice stays on this Mac. It is not sent away.")
        let json = """
        {"models":[{"id":"ollama:qwen2.5:7b","runtime":"ollama","name":"qwen2.5:7b","version":"7b","pinned_version":null,"privacy":"local","capabilities":["chat"],"context":32768,"disk_bytes":1,"ram_bytes":6000000000,"speed":"steady","installed":true,"endpoint_host":"localhost"}],"routes":{"morning_brief":"ollama:qwen2.5:7b"},"stats":[],"ram_bytes":6000000000,"voice":"Voice stays on this Mac. It is not sent away.","cloud":{"opt_in":false,"ceiling":null}}
        """
        let board = try JSONDecoder().decode(ModelBoard.self, from: Data(json.utf8))
        XCTAssertEqual(board.ramLabel, "6 GB")
        XCTAssertEqual(board.models.first?.privacy, "local")
        XCTAssertFalse(json.contains("api.openai.com"))
    }

    @MainActor
    func testMenuModelCachesOwnerKeyAcrossRefreshes() async {
        var keyReads = 0
        let config = MenuConfig(
            baseURL: "https://127.0.0.1:8787",
            fingerprint: "abc123",
            label: "org.hmn.server",
            domain: "gui",
            plist: "/tmp/hmn.plist",
            uid: "501"
        )
        let model = MenuModel(
            config: config,
            transportFactory: { _ in
                return { request in
                    let path = request.url?.path ?? ""
                    let body: String
                    if path.hasSuffix("/health") {
                        body = #"{"ok":true,"service":"hmn","version":"0.1.0","time":"2026-11-11T04:39:00.000Z"}"#
                    } else if path.hasSuffix("/admin/status") {
                        body = #"{"ok":true,"service":"hmn","version":"0.1.0","time":"2026-11-11T04:39:00.000Z","fingerprint":"abc123","devices":{"paired":0,"hidden":0},"backups":0}"#
                    } else if path.hasSuffix("/devices") {
                        body = #"{"devices":[]}"#
                    } else if path.hasSuffix("/backups") {
                        body = #"{"backups":[]}"#
                    } else if path.hasSuffix("/audit/verify") {
                        body = #"{"ok":true,"tip":"0000","rows":0}"#
                    } else if path.hasSuffix("/audit") {
                        body = #"{"entries":[]}"#
                    } else if path.hasSuffix("/external") {
                        body = #"{"enabled":false,"port":"8788"}"#
                    } else {
                        body = "{}"
                    }
                    return HTTPResult(status: 200, body: Data(body.utf8))
                }
            },
            keyLoader: {
                keyReads += 1
                return "hmn_shortkey"
            },
            statusChecker: { _ in true }
        )
        await model.refresh()
        await model.refresh()
        XCTAssertEqual(keyReads, 1)
        XCTAssertTrue(model.ownerKeyPresent)
        XCTAssertEqual(model.health, "answering")
    }

    func testWordsHideStoredValues() {
        XCTAssertEqual(MenuWords.tier("personal"), "Personal")
        XCTAssertEqual(MenuWords.tier(nil), "")
        XCTAssertEqual(MenuWords.action("panic_clear"), "Shown again")
        XCTAssertEqual(MenuWords.action("kind_fields"), "Kind fields")
        XCTAssertEqual(MenuWords.surface("lock"), "Lock screen")
        XCTAssertEqual(MenuWords.surface(nil), "")
        XCTAssertEqual(MenuWords.route("morning_brief"), "Morning brief")
        XCTAssertEqual(MenuWords.when("not a date"), "")
        let when = MenuWords.when("2020-01-02T03:04:00.000Z")
        XCTAssertFalse(when.contains("T"))
        XCTAssertFalse(when.contains("2020-"))
    }

    @MainActor
    func testServerStateNamesEachCase() async {
        let config = MenuConfig(baseURL: "https://127.0.0.1:8787", fingerprint: "abc", label: "l", domain: "gui", plist: "/tmp/p", uid: "501")
        let stopped = MenuModel(config: config, transportFactory: { _ in nil }, keyLoader: { "hmn_shortkey" }, statusChecker: { _ in false })
        await stopped.refresh()
        XCTAssertEqual(stopped.serverState, .stopped)
        let silent = MenuModel(config: config, transportFactory: { _ in { _ in throw AdminFailure.unreachable } }, keyLoader: { "hmn_shortkey" }, statusChecker: { _ in true })
        await silent.refresh()
        XCTAssertEqual(silent.serverState, .unreachable)
        XCTAssertFalse(silent.panelsReady)
    }
}
