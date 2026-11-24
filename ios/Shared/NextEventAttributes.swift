import ActivityKit
import Foundation

struct NextEventAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var title: String
        var subtitle: String
    }

    var name: String
}
