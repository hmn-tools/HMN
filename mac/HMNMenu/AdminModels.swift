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
        String(format: "This month: %d tokens, $%.2f of $%.2f.", tokens, usd, capUsd)
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

/// Stored words turned into words for a person: no raw tier, action, surface, or ISO time on the panel.
enum MenuWords {
    static func tier(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "" }
        return raw.prefix(1).uppercased() + raw.dropFirst()
    }

    static func action(_ raw: String) -> String {
        let known: [String: String] = [
            "read": "Read", "write": "Changed", "approve": "Approved", "auto_approve": "Approved on its own",
            "reject": "Declined", "undo": "Undone", "grant": "Access given", "grant_private": "Private access given",
            "end_private": "Private access ended", "pair": "Phone paired", "revoke": "Phone revoked",
            "panic": "Hidden", "panic_clear": "Shown again", "restore": "Backup restored",
            "auth_failure": "Sign-in refused", "external": "Outside gate changed", "expire": "Expired",
            "rotate": "Key changed", "rotate_keys": "Keys changed", "key_create": "Key made", "key_change": "Key changed",
        ]
        if let word = known[raw] { return word }
        let spaced = raw.replacingOccurrences(of: "_", with: " ")
        return spaced.prefix(1).uppercased() + spaced.dropFirst()
    }

    static func surface(_ raw: String?) -> String {
        switch raw {
        case "phone": return "Phone"
        case "widget": return "Widget"
        case "display": return "Fridge display"
        case "lock": return "Lock screen"
        case "mcp": return "Agent"
        case "api": return "Direct"
        case "external": return "Outside agent"
        case .some(let other) where !other.isEmpty: return tier(other)
        default: return ""
        }
    }

    /// "Today 14:05", "Yesterday 09:30", "Fri 13 Nov, 14:05", or "13 Nov 2025, 14:05", in the Mac's own zone and clock.
    static func when(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        guard let date = withFraction.date(from: iso) ?? plain.date(from: iso) else { return "" }
        let clock = DateFormatter()
        clock.locale = Locale.current
        clock.timeStyle = .short
        clock.dateStyle = .none
        let time = clock.string(from: date)
        if calendar.isDate(date, inSameDayAs: now) { return "Today \(time)" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday \(time)"
        }
        let day = DateFormatter()
        day.locale = Locale.current
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        day.setLocalizedDateFormatFromTemplate(sameYear ? "EEE d MMM" : "d MMM yyyy")
        return "\(day.string(from: date)), \(time)"
    }

    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// "morning_brief" becomes "Morning brief".
    static func route(_ key: String) -> String {
        let spaced = key.replacingOccurrences(of: "_", with: " ")
        return spaced.prefix(1).uppercased() + spaced.dropFirst()
    }
}

/// What the server panel says it is. Each state has its own words and its own buttons.
enum ServerState: Equatable {
    case stopped, starting, running, unreachable, fault

    var title: String {
        switch self {
        case .stopped: return "Stopped"
        case .starting: return "Starting"
        case .running: return "Running"
        case .unreachable: return "Not answering"
        case .fault: return "Had a fault"
        }
    }
}

/// The card that an error belongs to, so the sentence sits next to its control.
enum NoticeArea: Equatable {
    case general, server, owner, outside, hide, pair, phones, backups, models
}
