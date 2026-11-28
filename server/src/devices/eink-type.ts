/**
 * 1-bit IBM Plex and the HMN mark B, for the fridge panel. Colour is applied by the caller: the glyphs themselves
 * are only ink or paper, so a title can stay black on white or white on black.
 */
import { EINK_FACES, EINK_MARK_40, EINK_MARK_48, type EinkFace, type EinkGlyph } from "./eink-glyphs";

export const faces = EINK_FACES;
export const MARK_40 = EINK_MARK_40;
export const MARK_48 = EINK_MARK_48;

export function measure(face: EinkFace, text: string): number {
  let width = 0;
  for (const ch of text) width += glyph(face, ch).w;
  return width;
}

export function ellipsis(face: EinkFace, text: string, maxWidth: number): string {
  if (measure(face, text) <= maxWidth) return text;
  const dots = "…";
  const room = maxWidth - measure(face, dots);
  if (room <= 0) return dots;
  let kept = "";
  for (const ch of text) {
    if (measure(face, kept + ch) > room) break;
    kept += ch;
  }
  return kept + dots;
}

export function drawText(
  canvas: Uint8Array,
  width: number,
  height: number,
  face: EinkFace,
  text: string,
  x: number,
  y: number,
  ink: number,
  maxWidth?: number,
): number {
  const value = maxWidth != null ? ellipsis(face, text, maxWidth) : text;
  let cursor = x;
  for (const ch of value) {
    const g = glyph(face, ch);
    blitGlyph(canvas, width, height, g, face.height, cursor, y, ink);
    cursor += g.w;
  }
  return cursor;
}

export function drawMark(
  canvas: Uint8Array,
  width: number,
  height: number,
  mark: { size: number; rows: string },
  x: number,
  y: number,
  ink: number,
) {
  const rowBytes = Math.ceil(mark.size / 8);
  for (let gy = 0; gy < mark.size; gy++) {
    for (let gx = 0; gx < mark.size; gx++) {
      if (!bitAt(mark.rows, rowBytes, gx, gy)) continue;
      const px = x + gx;
      const py = y + gy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      canvas[py * width + px] = ink;
    }
  }
}

export function fillRect(canvas: Uint8Array, width: number, height: number, x: number, y: number, w: number, h: number, ink: number) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.ceil(x + w));
  const y1 = Math.min(height, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) {
    const row = py * width;
    for (let px = x0; px < x1; px++) canvas[row + px] = ink;
  }
}

/** A filled rounded rectangle. Corner follows Garden's card radius, flattened to the pixel grid. */
export function fillRoundRect(
  canvas: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  ink: number,
) {
  const r = Math.max(0, Math.min(radius, Math.floor(Math.min(w, h) / 2)));
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      if (!insideRound(px, py, w, h, r)) continue;
      const dx = x + px;
      const dy = y + py;
      if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
      canvas[dy * width + dx] = ink;
    }
  }
}

/** A 2-pixel hairline around a rounded rectangle, drawn outside the fill if inset is 0. */
export function strokeRoundRect(
  canvas: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  ink: number,
  weight = 2,
) {
  const r = Math.max(0, Math.min(radius, Math.floor(Math.min(w, h) / 2)));
  for (let py = -weight; py < h + weight; py++) {
    for (let px = -weight; px < w + weight; px++) {
      const outer = insideRound(px + weight, py + weight, w + weight * 2, h + weight * 2, r + weight);
      const inner = insideRound(px, py, w, h, r);
      if (!outer || inner) continue;
      const dx = x + px;
      const dy = y + py;
      if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
      canvas[dy * width + dx] = ink;
    }
  }
}

export function fillCircle(canvas: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number, ink: number) {
  const r2 = radius * radius;
  for (let py = -radius; py <= radius; py++) {
    for (let px = -radius; px <= radius; px++) {
      if (px * px + py * py > r2) continue;
      const dx = cx + px;
      const dy = cy + py;
      if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
      canvas[dy * width + dx] = ink;
    }
  }
}

export function strokeCircle(canvas: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number, ink: number, weight = 2) {
  const outer2 = radius * radius;
  const innerR = Math.max(0, radius - weight);
  const inner2 = innerR * innerR;
  for (let py = -radius; py <= radius; py++) {
    for (let px = -radius; px <= radius; px++) {
      const d = px * px + py * py;
      if (d > outer2 || d < inner2) continue;
      const dx = cx + px;
      const dy = cy + py;
      if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
      canvas[dy * width + dx] = ink;
    }
  }
}

function insideRound(px: number, py: number, w: number, h: number, r: number): boolean {
  if (px < 0 || py < 0 || px >= w || py >= h) return false;
  if (r <= 0) return true;
  let dx = 0;
  let dy = 0;
  if (px < r && py < r) {
    dx = r - px;
    dy = r - py;
  } else if (px >= w - r && py < r) {
    dx = px - (w - 1 - r);
    dy = r - py;
  } else if (px < r && py >= h - r) {
    dx = r - px;
    dy = py - (h - 1 - r);
  } else if (px >= w - r && py >= h - r) {
    dx = px - (w - 1 - r);
    dy = py - (h - 1 - r);
  } else return true;
  return dx * dx + dy * dy <= r * r;
}

function glyph(face: EinkFace, ch: string): EinkGlyph {
  return face.glyphs[ch] ?? face.glyphs["?"] ?? { w: face.size / 2, bmpW: 0, left: 0, rows: "" };
}

function blitGlyph(
  canvas: Uint8Array,
  width: number,
  height: number,
  g: EinkGlyph,
  faceHeight: number,
  x: number,
  y: number,
  ink: number,
) {
  if (!g.bmpW || !g.rows) return;
  const rowBytes = Math.ceil(g.bmpW / 8);
  for (let gy = 0; gy < faceHeight; gy++) {
    for (let gx = 0; gx < g.bmpW; gx++) {
      if (!bitAt(g.rows, rowBytes, gx, gy)) continue;
      const px = x + g.left + gx;
      const py = y + gy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      canvas[py * width + px] = ink;
    }
  }
}

function bitAt(rows: string, rowBytes: number, x: number, y: number): boolean {
  const i = y * rowBytes + Math.floor(x / 8);
  const hex = rows.slice(i * 2, i * 2 + 2);
  if (hex.length < 2) return false;
  const byte = parseInt(hex, 16);
  return ((byte >> (7 - (x % 8))) & 1) === 1;
}
