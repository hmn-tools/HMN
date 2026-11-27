import SwiftUI
import UIKit

/**
 The design system of the app. Its name is Garden: white cards on a stone ground, one sans face, and ink
 for the main action. The four washed accents (teal, lilac, coral, sand) are used sparingly.
 docs/UX.md has the rules. The pages that the server draws still use server/src/tokens.ts, from the first design.
 */
enum Theme {
    // Each colour has a light and a dark value. The phone chooses, from its own appearance setting.
    // Dark Garden: a warm near-black ground, cards one step lighter, and ink that turns to paper. The accents
    // keep their hue and gain a little light, so that they still read on the dark ground.

    // Ground and surfaces
    static let ground = adaptive(0xEAEAE7, 0x121211)
    static let card = adaptive(0xFFFFFF, 0x252523)
    /// Text on ink. In dark mode ink is light, so this is dark.
    static let paper = adaptive(0xF4F4F2, 0x121211)
    /// A pressed surface, and a fill inside a card.
    static let paper2 = adaptive(0xEAEAE7, 0x30302D)

    // Text
    static let ink = adaptive(0x0D0D0D, 0xEDEDEA)
    static let graphite = adaptive(0x434343, 0xC6C6C1)
    /// Labels and second lines. 5.8 to 1 on the light ground, 6.9 to 1 on the dark ground.
    static let stone = adaptive(0x595956, 0x9E9E98)

    // Lines
    static let hair = adaptive(0xD3D3CF, 0x42423E)
    /// The line between two rows of one card.
    static let rule = adaptive(0xECECE9, 0x383835)

    // The washed accents. Teal is the "alive" colour. The other three are the band.
    static let teal = adaptive(0x6FA8A0, 0x7DB8AF)
    static let tealTint = adaptive(0xE8F1EF, 0x1E2E2B)
    static let tealBorder = adaptive(0xBFD8D4, 0x35524D)
    /// Teal as text. 5.7 to 1 on a light card, 7.1 to 1 on a dark card.
    static let tealDark = adaptive(0x3F6F68, 0x8FC8BF)
    static let lilac = adaptive(0x9A8BB0, 0xA898BF)
    static let coral = adaptive(0xD98A82, 0xE0958D)
    static let sand = adaptive(0xE8CF8A, 0xE3CB88)
    /// Revoke, remove, and an error.
    static let danger = adaptive(0xA33A2E, 0xEC8A7A)
    /// The soft shadow under a card. In dark mode a card is lifted by its lighter colour, so the shadow is darker.
    static let shadow = adaptive(0x2E2A1E, 0x000000)
    static let shadowOpacity: Double = 0.14

    /// One colour with a value for light mode and a value for dark mode, as 0xRRGGBB.
    static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((value >> 16) & 0xFF) / 255,
                green: CGFloat((value >> 8) & 0xFF) / 255,
                blue: CGFloat(value & 0xFF) / 255,
                alpha: 1
            )
        })
    }

    enum Space {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 24
    }

    enum Radius {
        static let chip: CGFloat = 10
        static let field: CGFloat = 14
        static let card: CGFloat = 18
    }

    // The type scale. Six roles in sans, and two in mono for labels and data.
    static let title = sans(30, weight: .semibold)
    static let heading = sans(22, weight: .semibold)
    static let row = sans(16, weight: .medium)
    static let body = sans(16)
    static let text = sans(14)
    static let small = sans(13)
    static let label = mono(11, weight: .medium)
    static let data = mono(13)

    /// IBM Plex Sans is in the app. The system sans is the fallback, if a file does not load.
    /// The names are the PostScript names in the files, which are shorter than the file names.
    private static let hasPlexSans = UIFont(name: "IBMPlexSans", size: 12) != nil

    static func sans(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let style = textStyle(size)
        if hasPlexSans {
            let name: String
            switch weight {
            case .semibold, .bold, .heavy, .black: name = "IBMPlexSans-SmBld"
            case .medium: name = "IBMPlexSans-Medm"
            default: name = "IBMPlexSans"
            }
            return .custom(name, size: size, relativeTo: style.swiftUI)
        }
        // The size follows the text size that the owner set on the phone.
        return .system(size: UIFontMetrics(forTextStyle: style.uiKit).scaledValue(for: size), weight: weight)
    }

    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let name: String
        switch weight {
        case .semibold, .bold, .heavy, .black: name = "IBMPlexMono-SemiBold"
        case .medium: name = "IBMPlexMono-Medium"
        default: name = "IBMPlexMono-Regular"
        }
        return .custom(name, size: size, relativeTo: textStyle(size).swiftUI)
    }

    /**
     The older call, with a size from the first design. It gives the nearest role of the scale, so that a
     screen that is not rewritten yet has the same type as a screen that is.
     A size of 10 or less was a label, and it stays mono. Each other size is sans.
     */
    static func font(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        if size < 10.5 { return mono(11, weight: .medium) }
        if size < 11.5 { return weight == .regular ? sans(13) : mono(12, weight: weight) }
        if size < 12.5 { return sans(13, weight: weight) }
        if size < 13.5 { return sans(14, weight: weight) }
        if size < 17 { return sans(16, weight: weight) }
        if size < 24 { return sans(22, weight: .semibold) }
        return sans(30, weight: .semibold)
    }

    private static func textStyle(_ size: CGFloat) -> (swiftUI: Font.TextStyle, uiKit: UIFont.TextStyle) {
        if size >= 28 { return (.largeTitle, .largeTitle) }
        if size >= 20 { return (.title2, .title2) }
        if size >= 15 { return (.body, .body) }
        if size >= 13 { return (.subheadline, .subheadline) }
        return (.caption, .caption1)
    }
}

/** The band of the brand: lilac, coral, sand. It is on a screen one time at most. */
struct Stripe: View {
    var body: some View {
        HStack(spacing: 0) {
            Theme.lilac
            Theme.coral
            Theme.sand
        }
        .frame(width: 84, height: 5)
        .clipShape(Capsule())
        .accessibilityHidden(true)
    }
}

/** A screen that waits for its first answer. One quiet spinner, in place of an empty card. */
struct LoadingState: View {
    var body: some View {
        ProgressView()
            .tint(Theme.stone)
            .frame(maxWidth: .infinity, minHeight: 120)
            .accessibilityLabel("Loading")
    }
}

extension View {
    /// The root of a screen or a sheet: the ground, ink for each text, and ink for each control.
    func themed() -> some View {
        self
            .foregroundStyle(Theme.ink)
            .tint(Theme.ink)
            .background(Theme.ground.ignoresSafeArea())
    }

    /// A white card with round corners and a soft shadow. It is the one container of the app.
    func card(padding: CGFloat = Theme.Space.l) -> some View {
        self
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
            .shadow(color: Theme.shadow.opacity(Theme.shadowOpacity), radius: 12, x: 0, y: 8)
    }
}

/**
 The buttons of the app. A screen has one primary button. A secondary button is white.
 A danger button has the danger colour as text, and its action asks before it runs.
 */
struct PillButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, danger }
    var kind: Kind = .primary

    func makeBody(configuration: Configuration) -> some View {
        PillLabel(kind: kind, pressed: configuration.isPressed, label: configuration.label)
    }

    private struct PillLabel<Label: View>: View {
        @Environment(\.isEnabled) private var enabled
        let kind: Kind
        let pressed: Bool
        let label: Label

        var body: some View {
            label
                .font(Theme.sans(16, weight: .semibold))
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(background)
                .foregroundStyle(foreground)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(Theme.hair, lineWidth: kind == .primary || !enabled ? 0 : 1))
                .opacity(pressed ? 0.8 : 1)
        }

        private var background: Color {
            if !enabled { return Theme.hair }
            return kind == .primary ? Theme.ink : Theme.card
        }

        private var foreground: Color {
            if !enabled { return Theme.graphite }
            switch kind {
            case .primary: return Theme.paper
            case .secondary: return Theme.ink
            case .danger: return Theme.danger
            }
        }
    }
}

/** A button that is only text, for a second action. It is 44 points tall, so that a finger can find it. */
struct TextButtonStyle: ButtonStyle {
    var danger = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.sans(14, weight: .medium))
            .underline()
            .foregroundStyle(danger ? Theme.danger : Theme.ink)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

/** The result of an action, next to the control that made it. An error has the danger colour. */
struct MessageLine: View {
    var text: String
    var isError = false
    var body: some View {
        Text(text)
            .font(Theme.text)
            .foregroundStyle(isError ? Theme.danger : Theme.ink)
            .padding(.horizontal, Theme.Space.l)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(isError ? Theme.card : Theme.tealTint)
            .clipShape(Capsule())
    }
}

/**
 The title of a tab screen: large, inside the content, with an optional button at the trailing edge.
 A tab screen hides its navigation bar and uses this. A pushed screen uses an inline navigation title.
 */
struct RootTitle<Trailing: View>: View {
    var title: String
    var trailing: () -> Trailing

    init(_ title: String, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.title = title
        self.trailing = trailing
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(Theme.title).tracking(-0.6).accessibilityAddTraits(.isHeader)
            Spacer()
            trailing()
        }
        .padding(.horizontal, 4)
    }
}

extension RootTitle where Trailing == EmptyView {
    init(_ title: String) {
        self.init(title) { EmptyView() }
    }
}

/** The plus button at the trailing edge of a tab title. It is 44 points square. */
struct RootAddButton: View {
    var label: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(.body.weight(.medium))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.ink)
        .accessibilityLabel(label)
    }
}

/** A screen with nothing on it: one line, and one smaller line. */
struct EmptyState: View {
    var title: String
    var text: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(Theme.heading)
            if let text { Text(text).font(Theme.text).foregroundStyle(Theme.graphite) }
        }
        .card(padding: 20)
    }
}

/**
 One value of a small choice, such as a tier or a number of days. The selected value is quiet: a teal tint,
 dark teal text, and a thin dark teal edge. Solid ink is for the main action, so `solid` gives the ink
 look to a small button that acts, such as Add beside a field.
 */
struct ChipButtonStyle: ButtonStyle {
    var selected = false
    var solid = false

    func makeBody(configuration: Configuration) -> some View {
        Chip(selected: selected, solid: solid, pressed: configuration.isPressed, label: configuration.label)
    }

    private struct Chip<Label: View>: View {
        @Environment(\.isEnabled) private var enabled
        let selected: Bool
        let solid: Bool
        let pressed: Bool
        let label: Label

        var body: some View {
            label
                .font(Theme.sans(14, weight: .medium))
                .padding(.horizontal, 14)
                .frame(minHeight: 36)
                .background(background)
                .foregroundStyle(foreground)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(edge, lineWidth: 1))
                .frame(minHeight: 44)
                .contentShape(Rectangle())
                .opacity(pressed ? 0.7 : 1)
        }

        private var background: Color {
            if solid { return enabled ? Theme.ink : Theme.hair }
            return selected ? Theme.tealTint : Theme.card
        }

        private var foreground: Color {
            if !enabled { return Theme.graphite }
            if solid { return Theme.paper }
            return selected ? Theme.tealDark : Theme.ink
        }

        private var edge: Color {
            if solid { return .clear }
            return selected ? Theme.tealDark : Theme.hair
        }
    }
}

/**
 A field with a placeholder in the stone colour. The system placeholder is too faint on the dark card, so each
 field of the app is made with `hint:` and not with the plain label.
 */
extension TextField where Label == Text {
    init(hint: String, text: Binding<String>, axis: Axis = .horizontal) {
        self.init(text: text, prompt: Text(hint).foregroundStyle(Theme.stone), axis: axis) { Text(hint) }
    }
}

extension SecureField where Label == Text {
    init(hint: String, text: Binding<String>) {
        self.init(text: text, prompt: Text(hint).foregroundStyle(Theme.stone)) { Text(hint) }
    }
}

/** A text field on a white ground with round corners. The label goes above it, as a SmallLabel. */
struct FieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .font(Theme.body)
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.field, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.field, style: .continuous).stroke(Theme.hair, lineWidth: 1))
    }
}
