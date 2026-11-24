import Foundation
import WidgetKit

enum SettingsStore {
    private static let urlKey = "hmn.serverURL"
    private static let pinKey = "hmn.fingerprint"

    static var serverURL: String {
        get { UserDefaults.standard.string(forKey: urlKey) ?? "" }
        set {
            if newValue.isEmpty { UserDefaults.standard.removeObject(forKey: urlKey) }
            else { UserDefaults.standard.set(newValue, forKey: urlKey) }
        }
    }

    /// The member this phone belongs to, or nil on the owner's phone. It is not a secret: the key is in the Keychain.
    static var member: MemberInfo? {
        get {
            guard let data = UserDefaults.standard.data(forKey: memberKey) else { return nil }
            return try? JSONDecoder().decode(MemberInfo.self, from: data)
        }
        set {
            if let newValue, let data = try? JSONEncoder().encode(newValue) { UserDefaults.standard.set(data, forKey: memberKey) }
            else { UserDefaults.standard.removeObject(forKey: memberKey) }
        }
    }
    private static let memberKey = "hmn.member"

    static var fingerprint: String {
        get { UserDefaults.standard.string(forKey: pinKey) ?? "" }
        set {
            if newValue.isEmpty { UserDefaults.standard.removeObject(forKey: pinKey) }
            else { UserDefaults.standard.set(newValue, forKey: pinKey) }
        }
    }
}

enum SnapshotStore {
    private static let key = "hmn.widget.today"
    private static let suite = "group.org.hmn"

    static var defaults: UserDefaults {
        UserDefaults(suiteName: suite) ?? .standard
    }

    static func save(_ screen: TodayScreen) {
        guard let data = try? JSONEncoder().encode(screen) else { return }
        defaults.set(data, forKey: key)
        WidgetCenter.shared.reloadAllTimelines()
    }

    static func load() -> TodayScreen? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(TodayScreen.self, from: data)
    }

    /// The last Today this phone received at the phone ceiling. It lives in the
    /// app's own defaults, not the App Group, because it may be Private.
    private static let phoneKey = "hmn.phone.today"

    static func savePhone(_ screen: TodayScreen) {
        guard let data = try? JSONEncoder().encode(screen) else { return }
        UserDefaults.standard.set(data, forKey: phoneKey)
    }

    static func loadPhone() -> TodayScreen? {
        guard let data = UserDefaults.standard.data(forKey: phoneKey) else { return nil }
        return try? JSONDecoder().decode(TodayScreen.self, from: data)
    }

    static func clear() {
        defaults.removeObject(forKey: key)
        defaults.removeObject(forKey: publicKey)
        UserDefaults.standard.removeObject(forKey: phoneKey)
        WidgetCenter.shared.reloadAllTimelines()
    }

    private static let publicKey = "hmn.public.lock"

    static func savePublic(dueCount: Int, title: String, subtitle: String) {
        let card = ["dueCount": dueCount, "title": title, "subtitle": subtitle] as [String: Any]
        defaults.set(try? JSONSerialization.data(withJSONObject: card), forKey: publicKey)
        WidgetCenter.shared.reloadAllTimelines()
    }
}
