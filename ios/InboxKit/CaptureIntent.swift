import AppIntents
import Foundation

struct OpenCaptureIntent: AppIntent {
    static var title: LocalizedStringResource = "Add to HMN"
    static var description = IntentDescription("Put something in the inbox. It is not filed until you process it.")
    static var openAppWhenRun = true

    @Parameter(title: "Text", default: "")
    var text: String

    @Parameter(title: "Private", default: false)
    var privateNote: Bool

    init() {
        text = ""
        privateNote = false
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            InboxQueue.requestOpen()
            return .result(dialog: "Opening the inbox.")
        }
        InboxQueue.enqueue(text: trimmed, source: "siri", privateNote: privateNote, tier: privateNote ? "private" : "personal", attachments: [])
        return .result(dialog: "In the inbox.")
    }
}

struct SendToHMNIntent: AppIntent {
    static var title: LocalizedStringResource = "Send to HMN"
    static var description = IntentDescription("Put text, a link, or JSON in the inbox. Personal is the default. The tier can only go up.")
    static var openAppWhenRun = true

    @Parameter(title: "Text", default: "")
    var text: String

    @Parameter(title: "URL", default: "")
    var url: String

    @Parameter(title: "JSON", default: "")
    var json: String

    @Parameter(title: "Tag", default: "")
    var tag: String

    @Parameter(title: "Tier", default: "personal")
    var tier: String

    init() {
        text = ""
        url = ""
        json = ""
        tag = ""
        tier = "personal"
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        var body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let link = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let payload = json.trimmingCharacters(in: .whitespacesAndNewlines)
        if !payload.isEmpty { body = body.isEmpty ? payload : "\(body)\n\(payload)" }
        let cleanTag = tag.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "#", with: "")
        if !cleanTag.isEmpty { body = body.isEmpty ? "#\(cleanTag)" : "\(body) #\(cleanTag)" }
        if body.isEmpty && link.isEmpty {
            InboxQueue.requestOpen()
            return .result(dialog: "Nothing to send.")
        }
        let hint = tier.lowercased()
        let raised = hint == "private" || hint == "sealed" ? hint : "personal"
        InboxQueue.enqueue(text: body.isEmpty ? link : body, source: "shortcut", privateNote: raised == "private", tier: raised, url: link, attachments: [])
        return .result(dialog: "In the inbox.")
    }
}
