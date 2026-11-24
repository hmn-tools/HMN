/**
 * A QR code encoder for the fridge. Byte mode, error correction level M, versions 1 to 10 (up to 213 bytes).
 * The server has no dependencies, so this follows ISO/IEC 18004 directly. A pairing link is about 130 bytes.
 */

/** Per version, level M: error correction codewords per block, and the blocks as [count, data codewords]. */
const LEVEL_M: Array<{ ec: number; blocks: Array<[number, number]> }> = [
  { ec: 10, blocks: [[1, 16]] },
  { ec: 16, blocks: [[1, 28]] },
  { ec: 26, blocks: [[1, 44]] },
  { ec: 18, blocks: [[2, 32]] },
  { ec: 24, blocks: [[2, 43]] },
  { ec: 16, blocks: [[4, 27]] },
  { ec: 18, blocks: [[4, 31]] },
  { ec: 22, blocks: [[2, 38], [2, 39]] },
  { ec: 22, blocks: [[3, 36], [2, 37]] },
  { ec: 26, blocks: [[4, 43], [1, 44]] },
];

const ALIGNMENT: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

export type QrCode = { version: number; size: number; mask: number; dark: boolean[][] };

export function encodeQr(text: string): QrCode {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 0;
  for (let v = 1; v <= LEVEL_M.length; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(v) * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error("The text is too long for a QR code here.");
  const data = codewords(bytes, version);
  const size = 17 + version * 4;
  let best: QrCode | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const dark = draw(version, size, data, mask);
    const score = penalty(dark);
    if (score < bestScore) {
      bestScore = score;
      best = { version, size, mask, dark };
    }
  }
  return best!;
}

function dataCodewords(version: number): number {
  return LEVEL_M[version - 1]!.blocks.reduce((sum, [count, per]) => sum + count * per, 0);
}

/** The data codewords with their error correction, interleaved by block. */
function codewords(bytes: number[], version: number): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  const capacity = dataCodewords(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  for (let pad = 0xec; data.length < capacity / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  const { ec, blocks } = LEVEL_M[version - 1]!;
  const divisor = rsDivisor(ec);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at = 0;
  for (const [count, per] of blocks) {
    for (let b = 0; b < count; b++) {
      const block = data.slice(at, at + per);
      at += per;
      dataBlocks.push(block);
      ecBlocks.push(rsRemainder(block, divisor));
    }
  }
  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < longest; i++) for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  for (let i = 0; i < ec; i++) for (const block of ecBlocks) out.push(block[i]!);
  return out;
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i]! ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

function draw(version: number, size: number, data: number[], mask: number): boolean[][] {
  const dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, value: boolean) => {
    dark[y]![x] = value;
    fixed[y]![x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, ring !== 2 && ring !== 4);
      }
    }
  }
  const centres = ALIGNMENT[version - 1]!;
  const last = centres.length - 1;
  centres.forEach((cy, i) => {
    centres.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    });
  });
  // Reserve the format and version areas before the data goes in. They are drawn last.
  drawFormat(set, size, mask);
  if (version >= 7) drawVersion(set, size, version);

  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fixed[y]![x]) continue;
        const bit = i < data.length * 8 ? ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1 : false;
        i++;
        dark[y]![x] = bit !== masked(mask, x, y);
      }
    }
  }
  return dark;
}

function masked(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

type Setter = (x: number, y: number, value: boolean) => void;

/** The 15 format bits: level M (00) and the mask, with their BCH code, twice. */
export function formatBits(mask: number): number {
  const value = (0b00 << 3) | mask;
  let rem = value;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((value << 10) | rem) ^ 0x5412;
}

function drawFormat(set: Setter, size: number, mask: number) {
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

function drawVersion(set: Setter, size: number, version: number) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const value = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(a, b, value);
    set(b, a, value);
  }
}

/** The four penalty rules of the standard. The mask with the lowest score is used. */
function penalty(dark: boolean[][]): number {
  const size = dark.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let y = 0; y < size; y++) lines.push(dark[y]!);
  for (let x = 0; x < size; x++) lines.push(dark.map((row) => row[x]!));
  const finder = [true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 7 <= line.length; i++) {
      if (!finder.every((value, k) => line[i + k] === value)) continue;
      const before = i >= 4 && line.slice(i - 4, i).every((value) => !value);
      const after = i + 11 <= line.length && line.slice(i + 7, i + 11).every((value) => !value);
      if (before || after) score += 40;
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = dark[y]![x];
      if (dark[y]![x + 1] === c && dark[y + 1]![x] === c && dark[y + 1]![x + 1] === c) score += 3;
    }
  }
  const total = size * size;
  const darkCount = dark.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs(darkCount * 20 - total * 10) / total) * 10;
  return score;
}
