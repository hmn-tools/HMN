import Foundation

struct ExternalGate: Decodable, Equatable {
    var enabled: Bool
    var port: String
}

struct HealthStatus: Decodable, Equatable {
    var ok: Bool
    var service: String
    var version: String
}

struct AdminStatus: Decodable, Equatable {
    var ok: Bool
    var service: String
    var version: String
    var time: String
    var fingerprint: String
    var devices: DeviceCounts
    var backups: Int

    struct DeviceCounts: Decodable, Equatable {
        var paired: Int
        var hidden: Int
    }
}

struct PairedDevice: Decodable, Identifiable, Equatable {
    var id: String
    var name: String
    var scope: String
    var maxTier: String
    var forcedCeiling: String?
    var expiresAt: String?
    var createdAt: String
    var revokedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name, scope
        case maxTier = "max_tier"
        case forcedCeiling = "forced_ceiling"
        case expiresAt = "expires_at"
        case createdAt = "created_at"
        case revokedAt = "revoked_at"
    }

    var isRevoked: Bool { revokedAt != nil }
    var isHidden: Bool { forcedCeiling == "public" && !isRevoked }
}

struct DeviceList: Decodable, Equatable {
    var devices: [PairedDevice]
}

struct BackupFile: Decodable, Identifiable, Equatable {
    var name: String
    var bytes: Int
    var modifiedAt: String
    var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name, bytes
        case modifiedAt = "modified_at"
    }
}

struct BackupList: Decodable, Equatable {
    var backups: [BackupFile]
}

struct PairingCode: Decodable, Equatable {
    var code: String
    var expiresAt: String
    var payload: String

    enum CodingKeys: String, CodingKey {
        case code, payload
        case expiresAt = "expires_at"
    }
}

struct AuditEntry: Decodable, Identifiable, Equatable {
    var seq: Int
    var at: String
    var action: String
    var tier: String?
    var surface: String?
    var id: Int { seq }
}

struct AuditList: Decodable, Equatable {
    var entries: [AuditEntry]
}

struct AuditVerify: Decodable, Equatable {
    var ok: Bool
    var tip: String?
    var rows: Int?
}

struct PanicResult: Decodable, Equatable {
    var hidden: Int
}

enum BackupName {
    static let pattern = #"^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]+Z\.hmn$"#

    static func isValid(_ name: String) -> Bool {
        name.range(of: pattern, options: .regularExpression) != nil
    }
}

enum OwnerKeyRule {
    static func accepts(_ secret: String) -> Bool {
        let trimmed = secret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("hmn_"), trimmed.count >= 12 else { return false }
        return !trimmed.contains(" ") && !trimmed.contains("\n") && !trimmed.contains("\t")
    }
}

enum APIMessage {
    static func safe(from data: Data) -> String {
        struct Envelope: Decodable {
            struct Inner: Decodable { var message: String }
            var error: Inner
        }
        let decoded = (try? JSONDecoder().decode(Envelope.self, from: data))?.error.message
        let message = decoded ?? "The server refused."
        if message.contains("hmn_") { return "The server refused." }
        return message
    }
}

struct ManagedModel: Decodable, Identifiable, Equatable {
    var id: String
    var runtime: String
    var name: String
    var privacy: String
    var installed: Bool
    var ramBytes: Int

    enum CodingKeys: String, CodingKey {
        case id, runtime, name, privacy, installed
        case ramBytes = "ram_bytes"
    }
}

struct ModelSpend: Decodable, Equatable {
    var month: String
    var chars: Int
    var tokens: Int
    var usd: Double
    var capUsd: Double
    var notice: String?

    enum CodingKeys: String, CodingKey {
        case month, chars, tokens, usd, notice
        case capUsd = "cap_usd"
    }

    var line: String {
        String(format: "This month · %d tokens · $%.2f of $%.2f.", tokens, usd, capUsd)
    }
}

struct ModelBoard: Decodable, Equatable {
    var models: [ManagedModel]
    var routes: [String: String]
    var ramBytes: Int
    var voice: String
    var spend: ModelSpend?

    enum CodingKeys: String, CodingKey {
        case models, routes, voice, spend
        case ramBytes = "ram_bytes"
    }

    var ramLabel: String {
        ramBytes <= 0 ? "no extra RAM" : "\(ramBytes / 1_000_000_000) GB"
    }
}

enum VoiceNote {
    static let line = "Voice stays on this Mac. It is not sent away."
}
