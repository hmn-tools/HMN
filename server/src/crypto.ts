import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";

const FILE_MAGIC = Buffer.from("HMNENC1\n");
const BACKUP_MAGIC = Buffer.from("HMNBAK1\n");

export function sha256hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomId(prefix = ""): string {
  const body = randomBytes(16).toString("hex");
  return prefix ? `${prefix}_${body}` : body;
}

export function randomSecret(): string {
  return `hmn_${randomBytes(24).toString("base64url")}`;
}

/** A code from 32 letters and digits that are easy to read: 5 bits for each character. 256 is a multiple of 32, so the draw has no bias. */
export function randomCode(length = 8): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export function aesEncrypt(key: Buffer, plain: Buffer): Buffer {
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function aesDecrypt(key: Buffer, blob: Buffer): Buffer {
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  if (blob.length < 12 + 16) throw new Error("ciphertext too short");
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function sealString(key: Buffer, plain: string): string {
  const blob = aesEncrypt(key, Buffer.from(plain, "utf8"));
  return `seal1:${blob.toString("base64url")}`;
}

export function openString(key: Buffer, stored: string): string {
  if (!stored.startsWith("seal1:")) return stored;
  const blob = Buffer.from(stored.slice("seal1:".length), "base64url");
  return aesDecrypt(key, blob).toString("utf8");
}

export function isSealed(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("seal1:");
}

export function encryptFile(key: Buffer, plain: Buffer): Buffer {
  return Buffer.concat([FILE_MAGIC, aesEncrypt(key, plain)]);
}

export function decryptFile(key: Buffer, blob: Buffer): Buffer {
  if (!blob.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
    throw new Error("database file is not an HMN encrypted store");
  }
  return aesDecrypt(key, blob.subarray(FILE_MAGIC.length));
}

export function passphraseKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 1 << 14, r: 8, p: 1 });
}

export function encryptBackup(passphrase: string, plain: Buffer): Buffer {
  const salt = randomBytes(16);
  const key = passphraseKey(passphrase, salt);
  return Buffer.concat([BACKUP_MAGIC, salt, aesEncrypt(key, plain)]);
}

export function decryptBackup(passphrase: string, blob: Buffer): Buffer {
  if (!blob.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new Error("not an HMN backup");
  }
  const salt = blob.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + 16);
  const key = passphraseKey(passphrase, salt);
  return aesDecrypt(key, blob.subarray(BACKUP_MAGIC.length + 16));
}

/** 256 words, so one random byte selects one word with no modulo bias. Each word is 8 bits. */
export const RECOVERY_WORDS: readonly string[] = [
  "acorn", "alder", "almond", "amber", "anchor", "anvil", "apple", "apron",
  "arbor", "arrow", "aspen", "atlas", "attic", "autumn", "badge", "baker",
  "bamboo", "barley", "barn", "basil", "basin", "beacon", "beech", "bell",
  "berry", "birch", "bison", "blanket", "bloom", "boat", "bolt", "border",
  "bottle", "branch", "brass", "bread", "brick", "bridge", "bronze", "brook",
  "brush", "bucket", "butter", "cabin", "cable", "candle", "canoe", "canvas",
  "canyon", "carpet", "cart", "castle", "cedar", "cellar", "chalk", "cherry",
  "chimney", "cider", "cinder", "clay", "cliff", "clock", "cloud", "clover",
  "coast", "cobalt", "comet", "copper", "coral", "cork", "cotton", "cradle",
  "crane", "creek", "crow", "crystal", "curtain", "dawn", "delta", "desert",
  "dome", "dove", "drum", "dune", "eagle", "earth", "echo", "elbow",
  "elm", "ember", "engine", "falcon", "feather", "fennel", "fern", "ferry",
  "fiddle", "field", "finch", "flame", "flint", "flute", "forest", "fossil",
  "fountain", "fox", "frost", "garden", "garlic", "garnet", "gate", "ginger",
  "glacier", "glass", "glove", "granite", "grape", "gravel", "grove", "gull",
  "hammer", "harbor", "harvest", "hawk", "hazel", "hearth", "hedge", "heron",
  "hill", "hinge", "honey", "hornet", "horse", "ice", "indigo", "iris",
  "iron", "island", "ivory", "ivy", "jacket", "jade", "jasmine", "jetty",
  "juniper", "kayak", "kelp", "kettle", "kite", "ladder", "lagoon", "lake",
  "lantern", "larch", "laurel", "lava", "lemon", "lentil", "lichen", "lilac",
  "linen", "lizard", "lotus", "lumber", "magnet", "mango", "maple", "marble",
  "marsh", "meadow", "melon", "mint", "mirror", "moss", "moth", "mountain",
  "mustard", "needle", "nest", "nettle", "north", "nutmeg", "oak", "oasis",
  "oat", "ocean", "olive", "onion", "opal", "orbit", "orchard", "otter",
  "oyster", "paddle", "paper", "parsley", "pebble", "pepper", "pillow", "pine",
  "planet", "plum", "pocket", "pond", "poppy", "prairie", "puddle", "quail",
  "quartz", "quill", "rabbit", "radish", "rain", "raven", "reed", "ribbon",
  "ridge", "river", "robin", "rope", "rust", "saddle", "saffron", "sage",
  "salmon", "sand", "satin", "scarf", "shadow", "shell", "shovel", "silver",
  "slate", "snow", "sorrel", "sparrow", "spruce", "stone", "storm", "summit",
  "sunset", "swan", "thistle", "thunder", "timber", "tulip", "tunnel", "turtle",
  "umbra", "valley", "velvet", "violet", "walnut", "willow", "winter", "yarrow",
];

export const RECOVERY_WORD_COUNT = 13;

/** 13 words from 256 is 104 bits. The words are lower-case letters only, joined by hyphens, to write on paper. */
export function recoveryPassphrase(): string {
  if (RECOVERY_WORDS.length !== 256) throw new Error("the recovery word list must hold 256 words");
  const bytes = randomBytes(RECOVERY_WORD_COUNT);
  const picked: string[] = [];
  for (const byte of bytes) picked.push(RECOVERY_WORDS[byte]!);
  return picked.join("-");
}

export function parseKeyMaterial(raw: Buffer): Buffer {
  const text = raw.toString("utf8").trim();
  if (/^[A-Za-z0-9+/=_-]{43,44}$/.test(text) || /^[A-Fa-f0-9]{64}$/.test(text)) {
    const buf = /^[A-Fa-f0-9]{64}$/.test(text)
      ? Buffer.from(text, "hex")
      : Buffer.from(text, "base64url");
    if (buf.length === 32) return buf;
  }
  if (raw.length === 32) return raw;
  throw new Error("KEK must be 32 bytes");
}
