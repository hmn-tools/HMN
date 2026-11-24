import { deflateSync } from "node:zlib";

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

export const WIDTH = 800;
export const HEIGHT = 480;
export const OG = { width: 800, height: 480 };
export const TRMNL_X = { width: 1872, height: 1404 };

export function panelFor(model: string | null, width?: number | null, height?: number | null): { id: "og" | "x"; width: number; height: number } {
  const name = (model ?? "").toLowerCase();
  if (name === "x" || (width === TRMNL_X.width && height === TRMNL_X.height)) return { id: "x", ...TRMNL_X };
  return { id: "og", ...OG };
}

/** 1-bit BMP3, bottom-up, palette 0 black and 1 white. 800×480 is 48062 bytes. */
export function encodeBmp1(white: (x: number, y: number) => boolean): Buffer {
  const rowBytes = WIDTH / 8;
  const pixels = Buffer.alloc(rowBytes * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    const fileRow = HEIGHT - 1 - y;
    for (let x = 0; x < WIDTH; x++) {
      if (!white(x, y)) continue;
      const index = fileRow * rowBytes + (x >> 3);
      pixels[index] = (pixels[index] ?? 0) | (0x80 >> (x & 7));
    }
  }
  const header = Buffer.alloc(14 + 40 + 8);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(header.length + pixels.length, 2);
  header.writeUInt32LE(header.length, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(WIDTH, 18);
  header.writeInt32LE(HEIGHT, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(1, 28);
  header.writeUInt32LE(0, 30);
  header.writeUInt32LE(pixels.length, 34);
  header.writeUInt32LE(2, 46);
  header.writeUInt8(255, 14 + 40 + 4);
  header.writeUInt8(255, 14 + 40 + 5);
  header.writeUInt8(255, 14 + 40 + 6);
  return Buffer.concat([header, pixels]);
}

/** Greyscale PNG. bitDepth 1 is black and white, 2 is four greys, 4 is sixteen greys. */
export function encodePngGrey(
  bitDepth: 1 | 2 | 4,
  sample: (x: number, y: number) => number,
  width = WIDTH,
  height = HEIGHT,
): Buffer {
  const pixelsPerByte = 8 / bitDepth;
  const rowBytes = Math.ceil(width / pixelsPerByte);
  const raw = Buffer.alloc((rowBytes + 1) * height);
  const max = (1 << bitDepth) - 1;
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const value = Math.max(0, Math.min(max, sample(x, y)));
      const byteIndex = row + 1 + Math.floor(x / pixelsPerByte);
      const shift = (pixelsPerByte - 1 - (x % pixelsPerByte)) * bitDepth;
      raw[byteIndex] = (raw[byteIndex] ?? 0) | (value << shift);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * An indexed PNG (colour type 3), as TRMNL serves a colour image: bitDepth 2 holds four colours. The firmware of
 * the TRMNL BWRY maps each palette colour to an ink by its RGB value, so the palette holds the exact inks.
 */
export function encodePngIndexed(
  bitDepth: 1 | 2 | 4,
  palette: ReadonlyArray<readonly [number, number, number]>,
  index: (x: number, y: number) => number,
  width = WIDTH,
  height = HEIGHT,
): Buffer {
  if (palette.length > 1 << bitDepth) throw new Error("palette too large for the bit depth");
  const pixelsPerByte = 8 / bitDepth;
  const rowBytes = Math.ceil(width / pixelsPerByte);
  const raw = Buffer.alloc((rowBytes + 1) * height);
  const max = palette.length - 1;
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const value = Math.max(0, Math.min(max, index(x, y)));
      const byteIndex = row + 1 + Math.floor(x / pixelsPerByte);
      const shift = (pixelsPerByte - 1 - (x % pixelsPerByte)) * bitDepth;
      raw[byteIndex] = (raw[byteIndex] ?? 0) | (value << shift);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = 3;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("PLTE", Buffer.from(palette.flat())),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The four inks of the TRMNL BWRY, in palette order. */
export const BWRY_INKS = [
  [0, 0, 0],
  [255, 255, 255],
  [255, 0, 0],
  [255, 255, 0],
] as const;

/** The model names that a four-colour TRMNL sends in its `Model` header. */
export function isBwryModel(model: string | null): boolean {
  const name = (model ?? "").toLowerCase();
  return name === "og_4clr" || name === "og_gen2_4clr" || name === "og_bwry";
}
