import AppKit
import SwiftUI

@main
struct HMNMenuApp: App {
    @StateObject private var model = MenuModel()

    init() {
        FontRegistry.register()
    }

    var body: some Scene {
        MenuBarExtra {
            MenuRootView(model: model)
        } label: {
            Text("HMN")
                .font(.system(size: 12, weight: .medium))
        }
        .menuBarExtraStyle(.window)
        .defaultSize(width: 360, height: 560)
    }
}
