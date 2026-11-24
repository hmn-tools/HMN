import Foundation

struct HTTPResult {
    var status: Int
    var body: Data
}

enum AdminFailure: Error, Equatable {
    case missingKey
    case unpinned
    case unreachable
    case refused(String)
    case undecodable
}

final class AdminClient {
    var baseURL: String
    var key: String?
    var fingerprint: String
    var send: (URLRequest) async throws -> HTTPResult

    init(baseURL: String, key: String?, fingerprint: String, send: @escaping (URLRequest) async throws -> HTTPResult) {
        self.baseURL = baseURL
        self.key = key
        self.fingerprint = fingerprint
        self.send = send
    }

    func externalGate() async throws -> ExternalGate {
        try await decode(ExternalGate.self, method: "GET", path: "/api/v1/external")
    }

    func setExternal(_ enabled: Bool) async throws -> ExternalGate {
        let path = enabled ? "/api/v1/external/enable" : "/api/v1/external/disable"
        return try await decode(ExternalGate.self, method: "POST", path: path)
    }

    func health() async throws -> HealthStatus {
        try await decode(HealthStatus.self, method: "GET", path: "/health", authorize: false)
    }

    func status() async throws -> AdminStatus {
        try await decode(AdminStatus.self, method: "GET", path: "/api/v1/admin/status")
    }

    func devices() async throws -> DeviceList {
        try await decode(DeviceList.self, method: "GET", path: "/api/v1/admin/devices")
    }

    func panic() async throws -> PanicResult {
        try await decode(PanicResult.self, method: "POST", path: "/api/v1/admin/panic")
    }

    func clearPanic() async throws -> PanicResult {
        try await decode(PanicResult.self, method: "POST", path: "/api/v1/admin/panic/clear")
    }

    func backups() async throws -> BackupList {
        try await decode(BackupList.self, method: "GET", path: "/api/v1/admin/backups")
    }

    func restore(name: String) async throws {
        guard BackupName.isValid(name) else { throw AdminFailure.refused("Name a backup from this mini.") }
        let body = try JSONSerialization.data(withJSONObject: ["name": name])
        _ = try await request(method: "POST", path: "/api/v1/admin/restore", body: body, allowed: [200])
    }

    func backup() async throws {
        _ = try await request(method: "POST", path: "/api/v1/backup", body: nil, allowed: [200])
    }

    func pair() async throws -> PairingCode {
        try await decode(PairingCode.self, method: "POST", path: "/api/v1/pairing")
    }

    func revoke(id: String) async throws {
        guard !id.contains("/"), !id.contains("..") else { throw AdminFailure.refused("The server refused.") }
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        _ = try await request(method: "POST", path: "/api/v1/devices/\(encoded)/revoke", body: nil, allowed: [200])
    }

    func audit() async throws -> AuditList {
        try await decode(AuditList.self, method: "GET", path: "/api/v1/audit")
    }

    func verify() async throws -> AuditVerify {
        let (_, data) = try await request(method: "GET", path: "/api/v1/audit/verify", body: nil, allowed: [200, 409])
        return try decode(AuditVerify.self, from: data)
    }

    func modelBoard() async throws -> ModelBoard {
        try await decode(ModelBoard.self, method: "GET", path: "/api/v1/admin/models")
    }

    func pullModel(_ id: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["model_id": id])
        _ = try await request(method: "POST", path: "/api/v1/admin/models/pull", body: body, allowed: [200])
    }

    func removeModel(_ id: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["model_id": id])
        _ = try await request(method: "POST", path: "/api/v1/admin/models/remove", body: body, allowed: [200])
    }

    private func decode<T: Decodable>(_ type: T.Type, method: String, path: String, authorize: Bool = true) async throws -> T {
        let (_, data) = try await request(method: method, path: path, body: nil, authorize: authorize, allowed: [200])
        return try decode(type, from: data)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw AdminFailure.undecodable
        }
    }

    private func request(
        method: String,
        path: String,
        body: Data?,
        authorize: Bool = true,
        allowed: Set<Int>
    ) async throws -> (Int, Data) {
        guard !fingerprint.isEmpty else { throw AdminFailure.unpinned }
        if authorize {
            guard let key, !key.isEmpty else { throw AdminFailure.missingKey }
        }
        let root = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        guard let url = URL(string: root + path), url.scheme == "https" else { throw AdminFailure.unreachable }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("phone", forHTTPHeaderField: "X-HMN-Surface")
        if authorize, let key, !key.isEmpty {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let result: HTTPResult
        do {
            result = try await send(request)
        } catch let failure as AdminFailure {
            throw failure
        } catch {
            throw AdminFailure.unreachable
        }
        guard allowed.contains(result.status) else {
            throw AdminFailure.refused(APIMessage.safe(from: result.body))
        }
        return (result.status, result.body)
    }
}
