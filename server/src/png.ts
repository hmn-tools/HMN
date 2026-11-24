import { deflateSync } from "node:zlib";
import { GLYPH_H, GLYPH_W, GLYPHS } from "./glyphs";
import type { TodayScreen } from "./screens";

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): Buffer {
  let c = 0xffffffff;
  for (const byte of buf) c = TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  const out = Buffer.alloc(4);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return out;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  return Buffer.concat([len, body, crc32(body)]);
}

function png(width: number, height: number, rgb: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgb(x, y);
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const INK: [number, number, number] = [13, 13, 13];
const PAPER: [number, number, number] = [244, 244, 242];
const WHITE: [number, number, number] = [255, 255, 255];
const STONE: [number, number, number] = [138, 138, 138];
const TEAL: [number, number, number] = [111, 168, 160];

function blit(canvas: Uint8Array, width: number, text: string, x: number, y: number, color: [number, number, number]) {
  let cursor = x;
  for (const ch of text) {
    const glyph = GLYPHS[ch] ?? GLYPHS[" "] ?? [];
    for (let gy = 0; gy < GLYPH_H; gy++) {
      const bits = glyph[gy] ?? 0;
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if ((bits & (1 << (GLYPH_W - 1 - gx))) === 0) continue;
        const px = cursor + gx;
        const py = y + gy;
        if (px < 0 || py < 0 || px >= width || py >= 480) continue;
        const i = (py * width + px) * 3;
        canvas[i] = color[0];
        canvas[i + 1] = color[1];
        canvas[i + 2] = color[2];
      }
    }
    cursor += GLYPH_W;
  }
}

export function todayPng(screen: TodayScreen): Buffer {
  const width = 800;
  const height = 480;
  const canvas = new Uint8Array(width * height * 3);
  canvas.fill(244);
  for (let i = 0; i < canvas.length; i += 3) {
    canvas[i] = PAPER[0];
    canvas[i + 1] = PAPER[1];
    canvas[i + 2] = PAPER[2];
  }
  const stripe = [0x9a8bb0, 0xd98a82, 0xe8cf8a];
  for (let x = 0; x < width; x++) {
    const band = stripe[Math.min(2, Math.floor((x / width) * 3))]!;
    for (let y = 0; y < 8; y++) {
      const i = (y * width + x) * 3;
      canvas[i] = (band >> 16) & 255;
      canvas[i + 1] = (band >> 8) & 255;
      canvas[i + 2] = band & 255;
    }
  }
  const lines: Array<[string, number, [number, number, number]]> = [
    [`HMN   ${screen.date_label}`, 24, INK],
    [screen.greeting, 52, INK],
    [screen.summary, 78, STONE],
  ];
  let y = 110;
  for (const section of screen.sections) {
    lines.push([`${section.label.toUpperCase()}${section.trailing ? "  " + section.trailing : ""}`, y, section.accent === "teal" ? TEAL : STONE]);
    y += 22;
    for (const item of section.items) {
      lines.push([item.title, y, INK]);
      y += 18;
      if (item.subtitle) {
        lines.push([item.subtitle, y, STONE]);
        y += 18;
      }
      y += 6;
    }
    y += 8;
  }
  lines.push([`> ${screen.label}  screen ${screen.index} of ${screen.count}    ${screen.updated_label} -> next ${screen.next_label}`, 450, WHITE]);
  for (let x = 0; x < width; x++) {
    for (let yy = 448; yy < height; yy++) {
      const i = (yy * width + x) * 3;
      canvas[i] = INK[0];
      canvas[i + 1] = INK[1];
      canvas[i + 2] = INK[2];
    }
  }
  for (const [text, yy, color] of lines) blit(canvas, width, text, 28, yy, color);
  return png(width, height, (x, y) => {
    const i = (y * width + x) * 3;
    return [canvas[i]!, canvas[i + 1]!, canvas[i + 2]!];
  });
}
