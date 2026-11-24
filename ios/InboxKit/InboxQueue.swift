import Foundation

struct PendingFile: Codable {
    var kind: String
    var name: String
    var contentType: String
}

struct PendingCapture: Codable {
    var text: String
    var source: String
    var privateNote: Bool
    var tier: String
    var url: String
    var attachments: [PendingFile]
}

/// One queued capture and the id of its file.
struct QueuedCapture {
    var id: String
    var item: PendingCapture
}

/// The queue is a folder in the App Group container. Each capture is its own file,
/// written with file protection `.completeUnlessOpen`. A capture is removed only after
/// the server accepted it. The share extension and the intents add a file and never
/// rewrite the others, so a locked phone cannot lose a capture. Old captures that sit in
/// the App Group preferences are moved into files on the next read.
enum InboxQueue {
    static let suite = "group.org.hmn"
    static let queueKey = "hmn.inbox.queue"
    static let openKey = "hmn.open.capture"

    static var defaults: UserDefaults {
        UserDefaults(suiteName: suite) ?? .standard
    }

    private static var folder: URL {
        let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: suite)
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("hmn-inbox", isDirectory: true)
    }

    private static func ensureFolder() {
        try? FileManager.default.createDirectory(
            at: folder,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUnlessOpen]
        )
    }

    @discardableResult
    private static func write(_ item: PendingCapture, id: String) -> Bool {
        ensureFolder()
        guard let data = try? JSONEncoder().encode(item) else { return false }
        let url = folder.appendingPathComponent("\(id).json")
        return (try? data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])) != nil
    }

    static func enqueue(text: String, source: String, privateNote: Bool, tier: String = "personal", url: String = "", attachments: [PendingFile]) {
        let raised = tier == "household" || tier == "private" || tier == "sealed" ? tier : "personal"
        let item = PendingCapture(text: text, source: source, privateNote: privateNote, tier: raised, url: url, attachments: attachments)
        // The name starts with the time, so that the oldest capture goes first.
        let id = String(format: "%013d-%@", Int(Date().timeIntervalSince1970 * 1000), UUID().uuidString)
        write(item, id: id)
        defaults.set(true, forKey: openKey)
    }

    /// Every queued capture, oldest first. Nothing is removed here.
    static func pending() -> [QueuedCapture] {
        migrateLegacy()
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        return names.filter { $0.hasSuffix(".json") }.sorted().compactMap { name in
            let url = folder.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: url),
                  let item = try? JSONDecoder().decode(PendingCapture.self, from: data) else { return nil }
            return QueuedCapture(id: String(name.dropLast(5)), item: item)
        }
    }

    /// Call this after the server accepted the capture.
    static func remove(_ id: String) {
        try? FileManager.default.removeItem(at: folder.appendingPathComponent("\(id).json"))
    }

    static func consumeOpen() -> Bool {
        let open = defaults.bool(forKey: openKey)
        if open { defaults.set(false, forKey: openKey) }
        return open
    }

    static func requestOpen() {
        defaults.set(true, forKey: openKey)
    }

    private static func migrateLegacy() {
        guard let data = defaults.data(forKey: queueKey) else { return }
        guard let items = try? JSONDecoder().decode([PendingCapture].self, from: data) else {
            defaults.removeObject(forKey: queueKey)
            return
        }
        var ok = true
        for (index, item) in items.enumerated() {
            let id = String(format: "%013d-legacy-%04d-%@", 0, index, UUID().uuidString)
            if !write(item, id: id) { ok = false }
        }
        if ok { defaults.removeObject(forKey: queueKey) }
    }
}
