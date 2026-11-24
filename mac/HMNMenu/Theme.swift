import AppKit
import CoreText
import SwiftUI

enum FontRegistry {
    static func register() {
        let names = [
            "IBMPlexSans-Regular", "IBMPlexSans-Medium", "IBMPlexSans-SemiBold",
            "IBMPlexMono-Regular", "IBMPlexMono-Medium", "IBMPlexMono-SemiBold",
        ]
        for name in names {
            let url = Bundle.main.url(forResource: name, withExtension: "ttf", subdirectory: "Fonts")
                ?? Bundle.main.url(forResource: name, withExtension: "ttf")
            guard let url else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }
}

/// Garden, the design system of docs/UX.md: white cards on a calm stone ground, one sans face, ink for the main
/// action. Each colour has a light and a dark value, and the Mac chooses from its own appearance.
enum Theme {
    static let ground = adaptive(0xEAEAE7, 0x121211)
    static let card = adaptive(0xFFFFFF, 0x1E1E1C)
    static let ink = adaptive(0x0D0D0D, 0xEDEDEA)
    static let paper = adaptive(0xF4F4F2, 0x121211)
    static let graphite = adaptive(0x434343, 0xC6C6C1)
    static let stone = adaptive(0x595956, 0x9E9E98)
    static let hair = adaptive(0xD3D3CF, 0x3A3A36)
    static let rule = adaptive(0xECECE9, 0x2C2C29)
    static let teal = adaptive(0x6FA8A0, 0x7DB8AF)
    static let tealDark = adaptive(0x3F6F68, 0x8FC8BF)
    static let tealTint = adaptive(0xE8F1EF, 0x1E2E2B)
    static let danger = adaptive(0xA33A2E, 0xEC8A7A)
    static let lilac = adaptive(0x9A8BB0, 0xA898BF)
    static let coral = adaptive(0xD98A82, 0xE0958D)
    static let sand = adaptive(0xE8CF8A, 0xE3CB88)
    static let shadow = adaptive(0x000000, 0x000000)

    /// IBM Plex Sans, for titles, rows, sentences, and buttons. The system sans is the fallback.
    static func font(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let name: String
        switch weight {
        case .semibold, .bold, .heavy, .black: name = "IBMPlexSans-SemiBold"
        case .medium: name = "IBMPlexSans-Medium"
        default: name = "IBMPlexSans-Regular"
        }
        return .custom(name, size: size)
    }

    /// IBM Plex Mono, for labels and data only: a section label, a date, an id, a count.
    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let name: String
        switch weight {
        case .semibold, .bold, .heavy, .black: name = "IBMPlexMono-SemiBold"
        case .medium: name = "IBMPlexMono-Medium"
        default: name = "IBMPlexMono-Regular"
        }
        return .custom(name, size: size)
    }

    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let value = isDark ? dark : light
            return NSColor(
                srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
                green: CGFloat((value >> 8) & 0xFF) / 255,
                blue: CGFloat(value & 0xFF) / 255,
                alpha: 1
            )
        })
    }
}

/// The band: lilac, coral, and sand, 84 by 5 points, one time on a screen.
struct Stripe: View {
    var body: some View {
        HStack(spacing: 0) {
            Theme.lilac
            Theme.coral
            Theme.sand
        }
        .frame(width: 84, height: 5)
        .clipShape(Capsule())
    }
}

extension View {
    /// A white card on the ground: corner 18, no border, one soft shadow.
    func gardenCard() -> some View {
        padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .shadow(color: Theme.shadow.opacity(0.06), radius: 10, x: 0, y: 4)
    }
}
