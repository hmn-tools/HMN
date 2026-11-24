import Foundation
import Security

enum KeychainStore {
    static let account = "hmn"

    static func load(service: String, account: String = KeychainStore.account) -> String? {
        // The installer creates hmn.owner via /usr/bin/security, whose Keychain ACL
        // trusts Apple's security tool rather than an ad-hoc signed app bundle.
        // Reading through /usr/bin/security avoids repeated Keychain prompts on
        // every click, and passes no secret on the command line.
        if let value = loadViaSecurityCLI(service: service, account: account) {
            return value
        }
        return loadViaSecItem(service: service, account: account)
    }

    static func loadAsync(service: String, account: String = KeychainStore.account) async -> String? {
        await Task.detached {
            load(service: service, account: account)
        }.value
    }

    static func save(service: String, secret: String, account: String = KeychainStore.account) -> Bool {
        let value = secret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard service != "hmn.owner" || OwnerKeyRule.accepts(value) else { return false }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    private static func loadViaSecurityCLI(service: String, account: String) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["find-generic-password", "-s", service, "-a", account, "-w"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        try? pipe.fileHandleForWriting.close()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              let raw = String(data: data, encoding: .utf8) else {
            return nil
        }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private static func loadViaSecItem(service: String, account: String) -> String? {
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
}
