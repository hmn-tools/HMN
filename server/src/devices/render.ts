import { GLYPH_H, GLYPH_W, GLYPHS } from "../glyphs";
import type { TodayScreen } from "../screens";
import { BWRY_INKS, encodeBmp1, encodePngGrey, encodePngIndexed, OG } from "./image";

/** Grey levels, or `bwry` for the four inks of a TRMNL BWRY (drawn here in black and white only). */
export type Depth = "1" | "4" | "16" | "bwry";
export type Panel = { width: number; height: number };

export function screenLines(screen: TodayScreen, limit = 22): string[] {
  const lines = [`HMN  ${screen.date_label}`, screen.greeting, screen.summary];
  for (const section of screen.sections) {
    lines.push(section.label.toUpperCase());
    for (const item of section.items.slice(0, 8)) {
      lines.push(item.title);
      if (item.subtitle) lines.push(item.subtitle);
    }
  }
  if (screen.closing) lines.push(screen.closing);
  lines.push(`> ${screen.label}  ${screen.updated_label}`);
  return lines.map((line) => clean(line, limit > 22 ? 120 : 78)).slice(0, limit);
}

export function renderScreen(screen: TodayScreen, format: "bmp" | "png", depth: Depth, panel: Panel = OG): Buffer {
  const limit = panel.height > 1000 ? 40 : 22;
  return renderLines(screenLines(screen, limit), format, depth, `> ${screen.label}`, panel);
}

export function renderLines(lines: string[], format: "bmp" | "png", depth: Depth, bar: string, panel: Panel = OG): Buffer {
  const { width, height } = panel;
  const scale = height > 1000 ? 2 : 1;
  const grey = new Uint8Array(width * height);
  grey.fill(255);
  fillRect(grey, width, 0, 0, width, 8 * scale, 0);
  let y = 28 * scale;
  const step = 20 * scale;
  for (const line of lines.slice(0, -1)) {
    blit(grey, width, height, line, 24 * scale, y, 0, scale);
    y += step;
    if (y > height - 40 * scale) break;
  }
  const barTop = height - 32 * scale;
  fillRect(grey, width, 0, barTop, width, height - barTop, 0);
  blit(grey, width, height, clean(bar, 80), 24 * scale, barTop + 4, 255, scale);
  if (depth === "bwry") {
    // A four-colour panel takes a palette PNG. A 1-bit BMP is not safe on it.
    return encodePngIndexed(2, BWRY_INKS, (x, py) => ((grey[py * width + x] ?? 0) >= 128 ? 1 : 0), width, height);
  }
  if (format === "bmp") {
    return encodeBmp1((x, py) => (grey[py * width + x] ?? 0) >= 128);
  }
  if (depth === "16") {
    return encodePngGrey(4, (x, py) => Math.round(((grey[py * width + x] ?? 255) / 255) * 15), width, height);
  }
  if (depth === "4") {
    return encodePngGrey(2, (x, py) => {
      const value = grey[py * width + x] ?? 255;
      if (value < 64) return 0;
      if (value < 128) return 1;
      if (value < 200) return 2;
      return 3;
    }, width, height);
  }
  return encodePngGrey(1, (x, py) => ((grey[py * width + x] ?? 0) >= 128 ? 1 : 0), width, height);
}

function clean(value: string, max = 78): string {
  return [...value].map((ch) => (GLYPHS[ch] ? ch : ch === "·" || ch === "—" || ch === "–" ? "-" : " ")).join("").slice(0, max);
}

function fillRect(grey: Uint8Array, width: number, x: number, y: number, w: number, h: number, color: number) {
  const height = grey.length / width;
  for (let py = y; py < y + h && py < height; py++) {
    for (let px = x; px < x + w && px < width; px++) grey[py * width + px] = color;
  }
}

function blit(grey: Uint8Array, width: number, height: number, text: string, x: number, y: number, color: number, scale: number) {
  let cursor = x;
  for (const ch of text) {
    const glyph = GLYPHS[ch] ?? [];
    for (let gy = 0; gy < GLYPH_H; gy++) {
      const bits = glyph[gy] ?? 0;
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if ((bits & (1 << (GLYPH_W - 1 - gx))) === 0) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = cursor + gx * scale + sx;
            const py = y + gy * scale + sy;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            grey[py * width + px] = color;
          }
        }
      }
    }
    cursor += GLYPH_W * scale;
  }
}
