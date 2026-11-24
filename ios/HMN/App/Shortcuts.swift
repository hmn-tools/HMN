import AppIntents
import Foundation

struct TodayBriefIntent: AppIntent {
    static var title: LocalizedStringResource = "What's today"
    static var description = IntentDescription("Reads the personal snapshot already on this phone. Private and sealed notes are not in it.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let defaults = UserDefaults(suiteName: InboxQueue.suite) ?? .standard
        guard let data = defaults.data(forKey: "hmn.widget.today"),
              let screen = try? JSONDecoder().decode(PersonalBrief.self, from: data) else {
            return .result(dialog: "Nothing saved on this phone yet.")
        }
        let line = screen.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        return .result(dialog: IntentDialog(stringLiteral: line.isEmpty ? "The day is clear." : line))
    }
}

private struct PersonalBrief: Decodable {
    var summary: String
}

struct HMNShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenCaptureIntent(),
            phrases: ["Add to \(.applicationName)", "Capture in \(.applicationName)"],
            shortTitle: "Add to HMN",
            systemImageName: "plus.square"
        )
        AppShortcut(
            intent: SendToHMNIntent(),
            phrases: ["Send to \(.applicationName)", "Send this to \(.applicationName)"],
            shortTitle: "Send to HMN",
            systemImageName: "tray.and.arrow.down"
        )
        AppShortcut(
            intent: TodayBriefIntent(),
            phrases: ["What's today in \(.applicationName)", "What is today in \(.applicationName)"],
            shortTitle: "What's today",
            systemImageName: "sun.max"
        )
    }
}
