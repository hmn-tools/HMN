#!/usr/bin/swift
import AppKit
import CoreText
import Foundation

/// Rasterize IBM Plex and the HMN mark B to 1-bit glyphs for the fridge panel.
/// No antialiased greys: each pixel is ink or paper.

let root = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath)
let fontsDir = root.appendingPathComponent("server/assets/fonts")
let markURL = root.appendingPathComponent("server/assets/logo/hmn-mark-B.svg")
let outURL = root.appendingPathComponent("server/src/devices/eink-glyphs.ts")

struct FaceSpec {
    let key: String
    let file: String
    let size: CGFloat
}

let faces: [FaceSpec] = [
    FaceSpec(key: "sansRegular16", file: "IBMPlexSans-Regular.ttf", size: 16),
    FaceSpec(key: "sansMedium20", file: "IBMPlexSans-Medium.ttf", size: 20),
    FaceSpec(key: "sansSemibold24", file: "IBMPlexSans-SemiBold.ttf", size: 24),
    FaceSpec(key: "sansSemibold32", file: "IBMPlexSans-SemiBold.ttf", size: 32),
    FaceSpec(key: "sansSemibold48", file: "IBMPlexSans-SemiBold.ttf", size: 48),
    FaceSpec(key: "monoMedium14", file: "IBMPlexMono-Medium.ttf", size: 14),
    FaceSpec(key: "monoMedium18", file: "IBMPlexMono-Medium.ttf", size: 18),
]

var charset = ""
for u in 32...126 { charset.append(Character(UnicodeScalar(u)!)) }
charset += "·–—…’‘"
// Avoid generating a glyph twice.
var seen = Set<Character>()
let characters = charset.filter { seen.insert($0).inserted }

func registerFont(at url: URL) -> CTFontDescriptor {
    var err: Unmanaged<CFError>?
    CTFontManagerRegisterFontsForURL(url as CFURL, .process, &err)
    guard let descs = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor], let desc = descs.first else {
        fputs("cannot load font \(url.path)\n", stderr)
        exit(1)
    }
    return desc
}

func packRows(_ bits: [[UInt8]], width: Int) -> String {
    let rowBytes = (width + 7) / 8
    var hex = ""
    hex.reserveCapacity(bits.count * rowBytes * 2)
    let digits: [Character] = Array("0123456789abcdef")
    for row in bits {
        var byte: UInt8 = 0
        var filled = 0
        for x in 0..<width {
            byte <<= 1
            if x < row.count && row[x] == 1 { byte |= 1 }
            filled += 1
            if filled == 8 {
                hex.append(digits[Int(byte >> 4)])
                hex.append(digits[Int(byte & 0x0F)])
                byte = 0
                filled = 0
            }
        }
        if filled > 0 {
            byte <<= (8 - filled)
            hex.append(digits[Int(byte >> 4)])
            hex.append(digits[Int(byte & 0x0F)])
        }
        _ = rowBytes
    }
    return hex
}

func rasterGlyph(font: CTFont, scalar: UnicodeScalar, ascent: Int, height: Int) -> (advance: Int, width: Int, left: Int, rows: String)? {
    var unichar = UniChar(scalar.value)
    var glyph: CGGlyph = 0
    CTFontGetGlyphsForCharacters(font, &unichar, &glyph, 1)
    if glyph == 0 && scalar.value != 32 { return nil }
    var advance = CGSize.zero
    CTFontGetAdvancesForGlyphs(font, .default, &glyph, &advance, 1)
    let adv = max(1, Int(ceil(advance.width)))
    if scalar.value == 32 {
        return (adv, 0, 0, "")
    }
    guard let path = CTFontCreatePathForGlyph(font, glyph, nil) else {
        return (adv, 0, 0, "")
    }
    let box = path.boundingBoxOfPath
    // One pixel of padding around the ink so thresholding does not clip stems.
    let left = Int(floor(box.minX)) - 1
    let top = Int(floor(box.minY)) - 1
    let width = max(1, Int(ceil(box.maxX)) + 1 - left)
    let pathHeight = max(1, Int(ceil(box.maxY)) + 1 - top)
    // Render the path into a local bitmap (origin at bottom-left of the path box).
    let bytesPerRow = width
    var pixels = [UInt8](repeating: 0, count: width * pathHeight)
    let space = CGColorSpaceCreateDeviceGray()
    guard let ctx = CGContext(
        data: &pixels,
        width: width,
        height: pathHeight,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: space,
        bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else { return nil }
    ctx.setShouldAntialias(true)
    ctx.setShouldSmoothFonts(false)
    ctx.setFillColor(gray: 0, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: pathHeight))
    ctx.setFillColor(gray: 1, alpha: 1)
    ctx.translateBy(x: CGFloat(-left), y: CGFloat(-top))
    ctx.addPath(path)
    ctx.fillPath()
    // Threshold to 1-bit: ink where the coverage is strong enough to read at a distance.
    var inkRows: [[UInt8]] = Array(repeating: Array(repeating: 0, count: width), count: height)
    for py in 0..<pathHeight {
        for px in 0..<width {
            if pixels[py * width + px] < 140 { continue }
            // CoreGraphics bitmap is bottom-up. Path y is in font space (up). Baseline is `ascent` from the top.
            // Empirically, row 0 of this CG bitmap is the top of the path (font maxY).
            let fontY = top + pathHeight - 1 - py
            let row = ascent - fontY
            if row < 0 || row >= height { continue }
            inkRows[row][px] = 1
        }
    }
    return (adv, width, left, packRows(inkRows, width: width))
}

func rasterFace(_ spec: FaceSpec) -> String {
    let url = fontsDir.appendingPathComponent(spec.file)
    let desc = registerFont(at: url)
    let font = CTFontCreateWithFontDescriptor(desc, spec.size, nil)
    let ascent = Int(ceil(CTFontGetAscent(font)))
    let descent = Int(ceil(CTFontGetDescent(font)))
    let leading = Int(ceil(CTFontGetLeading(font)))
    let height = ascent + descent + max(0, leading)
    var parts: [String] = []
    parts.append("  \(spec.key): {")
    parts.append("    size: \(Int(spec.size)), ascent: \(ascent), height: \(height),")
    parts.append("    glyphs: {")
    for ch in characters {
        guard let scalar = ch.unicodeScalars.first else { continue }
        guard let g = rasterGlyph(font: font, scalar: scalar, ascent: ascent, height: height) else { continue }
        let key: String
        if ch == "\\" { key = "\"\\\\\"" }
        else if ch == "\"" { key = "\"\\\"\"" }
        else if ch == "'" { key = "\"'\"" }
        else { key = "\"\(ch)\"" }
        parts.append("      \(key): { w: \(g.advance), bmpW: \(g.width), left: \(g.left), rows: \"\(g.rows)\" },")
    }
    parts.append("    },")
    parts.append("  },")
    return parts.joined(separator: "\n")
}

func rasterMark(size: Int) -> (size: Int, rows: String) {
    guard let image = NSImage(contentsOf: markURL) else {
        fputs("cannot load mark \(markURL.path)\n", stderr)
        exit(1)
    }
    let width = size
    let height = size
    var pixels = [UInt8](repeating: 0, count: width * height)
    let space = CGColorSpaceCreateDeviceGray()
    guard let ctx = CGContext(
        data: &pixels,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width,
        space: space,
        bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else {
        fputs("mark context failed\n", stderr)
        exit(1)
    }
    ctx.setShouldAntialias(true)
    ctx.setFillColor(gray: 0, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    // NSImage draws in a flipped or unflipped space depending on context; use a rect and let it scale.
    let ns = NSGraphicsContext(cgContext: ctx, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ns
    image.draw(
        in: NSRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)),
        from: .zero,
        operation: .sourceOver,
        fraction: 1.0,
        respectFlipped: true,
        hints: [.interpolation: NSImageInterpolation.high]
    )
    NSGraphicsContext.restoreGraphicsState()
    // The SVG is black on transparent. After drawing on black, ink is dark. Invert sense: we want 1 = ink.
    // If the SVG compositor puts black ink on black, the figure is invisible. Draw white paper first? 
    // Better: fill white, draw the black mark, then ink = dark pixels.
    return (size, "") // placeholder, rewritten below if needed
}

func rasterMarkOnWhite(size: Int) -> (size: Int, rows: String) {
    guard let image = NSImage(contentsOf: markURL) else {
        fputs("cannot load mark \(markURL.path)\n", stderr)
        exit(1)
    }
    let width = size
    let height = size
    var pixels = [UInt8](repeating: 0, count: width * height)
    let space = CGColorSpaceCreateDeviceGray()
    guard let ctx = CGContext(
        data: &pixels,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width,
        space: space,
        bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else {
        fputs("mark context failed\n", stderr)
        exit(1)
    }
    ctx.setShouldAntialias(true)
    ctx.setFillColor(gray: 1, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let ns = NSGraphicsContext(cgContext: ctx, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ns
    image.draw(
        in: NSRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)),
        from: .zero,
        operation: .sourceOver,
        fraction: 1.0,
        respectFlipped: true,
        hints: [.interpolation: NSImageInterpolation.high]
    )
    NSGraphicsContext.restoreGraphicsState()
    var inkRows: [[UInt8]] = []
    inkRows.reserveCapacity(height)
    // CoreGraphics bitmap is bottom-up. Flip to top-down.
    for y in 0..<height {
        let srcY = height - 1 - y
        var row = [UInt8](repeating: 0, count: width)
        for x in 0..<width {
            row[x] = pixels[srcY * width + x] < 140 ? 1 : 0
        }
        inkRows.append(row)
    }
    return (size, packRows(inkRows, width: width))
}

var out = """
// Generated 1-bit IBM Plex and HMN mark B for the fridge e-ink panel.
// Regenerated by server/scripts/raster-eink-type.swift. Do not edit by hand.
export type EinkGlyph = { w: number; bmpW: number; left: number; rows: string };
export type EinkFace = { size: number; ascent: number; height: number; glyphs: Record<string, EinkGlyph> };

export const EINK_FACES = {
"""

for spec in faces {
    fputs("raster \(spec.key)\n", stderr)
    out += "\n" + rasterFace(spec) + "\n"
}
out += "} as const;\n\n"

let mark40 = rasterMarkOnWhite(size: 40)
let mark32 = rasterMarkOnWhite(size: 32)
out += "export const EINK_MARK_40 = { size: \(mark40.size), rows: \"\(mark40.rows)\" };\n"
out += "export const EINK_MARK_32 = { size: \(mark32.size), rows: \"\(mark32.rows)\" };\n"

try out.write(to: outURL, atomically: true, encoding: .utf8)
fputs("wrote \(outURL.path) (\(out.utf8.count) bytes)\n", stderr)
