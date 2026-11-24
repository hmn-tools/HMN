import Foundation
import Security

enum KeychainStore {
    static let service = "org.hmn"

    static func save(_ secret: String) throws {
        try saveItem(account: "device", secret: secret)
    }

    static func load() -> String? {
        loadItem(account: "device")
    }

    /// The address and fingerprint, kept next to the device key so they survive
    /// a loss of UserDefaults. The device key itself stays in a separate item.
    static func saveConnection(url: String, fingerprint: String) throws {
        let payload = ["url": url, "fingerprint": fingerprint]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let secret = String(data: data, encoding: .utf8) else { return }
        try saveItem(account: "connection", secret: secret)
    }

    static func loadConnection() -> (url: String, fingerprint: String)? {
        guard let raw = loadItem(account: "connection"),
              let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return nil }
        return (object["url"] ?? "", object["fingerprint"] ?? "")
    }

    private static func saveItem(account: String, secret: String) throws {
        let data = Data(secret.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw HMNError.message("The key could not be saved in the Keychain.")
        }
    }

    private static func loadItem(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func saveAuditTip(_ tip: String) throws {
        try saveItem(account: "audit-tip", secret: tip)
    }

    static func loadAuditTip() -> String? {
        loadItem(account: "audit-tip")
    }

    /// The alarm flag. It stays set until the owner acknowledges it.
    static func setAuditAlarm(_ on: Bool) throws {
        if on {
            try saveItem(account: "audit-alarm", secret: "1")
        } else {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: "audit-alarm",
            ]
            SecItemDelete(query as CFDictionary)
        }
    }

    static func auditAlarmOn() -> Bool {
        loadItem(account: "audit-alarm") != nil
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "device",
        ]
        SecItemDelete(query as CFDictionary)
    }
}
