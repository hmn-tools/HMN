import ActivityKit
import Foundation

enum LiveEvent {
    static func sync(title: String, subtitle: String) async {
        let state = NextEventAttributes.ContentState(title: title, subtitle: subtitle)
        let content = ActivityContent(state: state, staleDate: nil)
        if let current = Activity<NextEventAttributes>.activities.first {
            await current.update(content)
            return
        }
        _ = try? Activity.request(attributes: NextEventAttributes(name: "next"), content: content, pushType: nil)
    }
}
