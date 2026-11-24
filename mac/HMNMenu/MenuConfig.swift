import Darwin
import Foundation

struct MenuConfig: Codable, Equatable {
    var baseURL: String
    var fingerprint: String
    var label: String
    var domain: String
    var plist: String
    var uid: String?

    enum CodingKeys: String, CodingKey {
        case baseURL = "base_url"
        case fingerprint, label, domain, plist, uid
    }

    var service: ServiceSpec {
        let resolved = (uid?.isEmpty == false ? uid! : String(getuid()))
        return ServiceSpec(label: label, domain: domain, uid: resolved, plistPath: plist)
    }

    static func load(from data: Data) throws -> MenuConfig {
        try JSONDecoder().decode(MenuConfig.self, from: data)
    }

    static func loadFromDisk() -> MenuConfig {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let paths = [
            home.appendingPathComponent("Library/Application Support/HMN/menu.json"),
            URL(fileURLWithPath: "/Library/Application Support/HMN/menu.json"),
        ]
        for url in paths {
            if let data = try? Data(contentsOf: url), let config = try? load(from: data) {
                return config
            }
        }
        return MenuConfig(
            baseURL: "https://127.0.0.1:8787",
            fingerprint: "",
            label: "org.hmn.server",
            domain: "gui",
            plist: home.appendingPathComponent("Library/LaunchAgents/org.hmn.server.plist").path,
            uid: nil
        )
    }
}
