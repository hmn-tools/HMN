import CoreText
import SwiftUI

enum FontRegistry {
    static func register() {
        let names = ["IBMPlexMono-Regular", "IBMPlexMono-Medium", "IBMPlexMono-SemiBold"]
        for name in names {
            let url = Bundle.main.url(forResource: name, withExtension: "ttf", subdirectory: "Fonts")
                ?? Bundle.main.url(forResource: name, withExtension: "ttf")
            guard let url else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }
}

enum Theme {
    static let paper = Color(red: 244 / 255, green: 244 / 255, blue: 242 / 255)
    static let paper2 = Color(red: 234 / 255, green: 234 / 255, blue: 231 / 255)
    static let card = Color.white
    static let ink = Color(red: 13 / 255, green: 13 / 255, blue: 13 / 255)
    static let graphite = Color(red: 67 / 255, green: 67 / 255, blue: 67 / 255)
    static let stone = Color(red: 138 / 255, green: 138 / 255, blue: 138 / 255)
    static let hair = Color(red: 220 / 255, green: 220 / 255, blue: 218 / 255)
    static let rule = Color(red: 228 / 255, green: 228 / 255, blue: 225 / 255)
    static let teal = Color(red: 111 / 255, green: 168 / 255, blue: 160 / 255)
    static let lilac = Color(red: 154 / 255, green: 139 / 255, blue: 176 / 255)
    static let coral = Color(red: 217 / 255, green: 138 / 255, blue: 130 / 255)
    static let sand = Color(red: 232 / 255, green: 207 / 255, blue: 138 / 255)

    static func font(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let name: String
        switch weight {
        case .semibold, .bold, .heavy, .black:
            name = "IBMPlexMono-SemiBold"
        case .medium:
            name = "IBMPlexMono-Medium"
        default:
            name = "IBMPlexMono-Regular"
        }
        return .custom(name, size: size)
    }
}

struct Stripe: View {
    var body: some View {
        HStack(spacing: 0) {
            Theme.lilac
            Theme.coral
            Theme.sand
        }
        .frame(height: 6)
    }
}

struct RuledPaper: View {
    var body: some View {
        Theme.paper
            .overlay(
                Canvas { context, size in
                    var y: CGFloat = 0
                    while y < size.height {
                        var path = Path()
                        path.move(to: CGPoint(x: 0, y: y))
                        path.addLine(to: CGPoint(x: size.width, y: y))
                        context.stroke(path, with: .color(Theme.rule), lineWidth: 1)
                        y += 28
                    }
                }
            )
    }
}
