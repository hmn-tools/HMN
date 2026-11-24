import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  aesDecrypt,
  aesEncrypt,
  decryptFile,
  encryptFile,
  parseKeyMaterial,
  recoveryPassphrase,
} from "./crypto";

export function wrap(kek: Buffer, key: Buffer): Buffer {
  return aesEncrypt(kek, key);
}
export function unwrap(kek: Buffer, blob: Buffer): Buffer {
  return aesDecrypt(kek, blob);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT,
  body TEXT,
  status TEXT,
  kind TEXT,
  due_at TEXT,
  area_id TEXT,
  properties TEXT NOT NULL DEFAULT '{}',
  tier TEXT,
  content_sealed INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL,
  origin_ref TEXT,
  source_id TEXT,
  external_id TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  rel TEXT NOT NULL,
  origin TEXT NOT NULL,
  origin_ref TEXT,
  tier TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  max_tier TEXT NOT NULL,
  vault INTEGER NOT NULL DEFAULT 0,
  allow_types TEXT,
  allow_areas TEXT,
  deny_areas TEXT,
  forced_ceiling TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  rotated_from TEXT,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS vault_grants (
  id TEXT PRIMARY KEY,
  grant_hash TEXT NOT NULL UNIQUE,
  credential_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_lock (
  subject TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  locked_until TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  tier TEXT,
  entity_type TEXT,
  entity_id TEXT,
  surface TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  subject_hash TEXT
);
CREATE TABLE IF NOT EXISTS entity_versions (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  supersedes_id TEXT,
  valid_from TEXT NOT NULL,
  tombstone INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  title TEXT,
  body TEXT,
  status TEXT,
  kind TEXT,
  due_at TEXT,
  area_id TEXT,
  properties TEXT NOT NULL DEFAULT '{}',
  tier TEXT,
  content_sealed INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL,
  origin_ref TEXT,
  source_id TEXT,
  external_id TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_entity ON entity_versions(entity_id);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  key_id TEXT,
  op TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  payload TEXT,
  reason TEXT,
  read_set TEXT,
  tier TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY,
  body TEXT,
  url TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  tier TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  content_sealed INTEGER NOT NULL DEFAULT 0,
  attachments TEXT NOT NULL DEFAULT '[]',
  suggestion TEXT,
  result_type TEXT,
  result_id TEXT,
  origin TEXT NOT NULL,
  origin_ref TEXT,
  captured_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  credential_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_items(status, deleted_at);
CREATE TABLE IF NOT EXISTS display_state (
  id TEXT PRIMARY KEY CHECK (id = 'device'),
  screen_index INTEGER NOT NULL,
  shown_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external
  ON entities(source_id, external_id)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;
`;

export type Store = {
  db: Database;
  dbKey: Buffer;
  sealedKey: Buffer;
  backupPassphrase: string;
  dataDir: string;
  /** The plaintext graph, from memory. It is never written to disk in this form. */
  plainBytes: () => Buffer;
  encPath: string;
  /** Save the graph when it changed since the last save. `force` saves also with no change. */
  persist: (force?: boolean) => void;
  /** True when the graph has a change that is not in the saved file. */
  dirty: () => boolean;
  close: () => void;
  replaceDatabase: (plain: Buffer, nextSealed: Buffer) => void;
  /** A new database key. Crash-safe: see the function. */
  rotateKeys: () => { rotated: string };
};

function migrate(db: Database) {
  const audit = db.query("PRAGMA table_info(audit_log)").all() as Array<{ name: string }>;
  if (!audit.some((column) => column.name === "subject_hash")) {
    db.exec("ALTER TABLE audit_log ADD COLUMN subject_hash TEXT");
  }
}

function readWrap(path: string, kek: Buffer): Buffer | null {
  if (!existsSync(path)) return null;
  return unwrap(kek, readFileSync(path));
}

function writeWrap(path: string, kek: Buffer, key: Buffer) {
  writeFileSync(path, wrap(kek, key), { mode: 0o600 });
}

/** The folder of the working copy of the database. Memory on Linux, the user's temporary folder on a Mac. */
export function runtimeBase(): string {
  return existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
}

/** False only when the system says that no such process exists. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists, or this shell may not check it. Both keep the copy.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A server that was killed cannot remove its working copy, and that copy is not
 * encrypted. Each start removes the copies of processes that are gone. The
 * name has the process id, so the copy of a server that still runs stays.
 */
export function removeStaleRuntimeFiles(base: string): number {
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = /^hmn-(\d+)-[0-9a-f]{8}\.sqlite(-journal|-wal|-shm)?$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || processIsAlive(pid)) continue;
    try {
      unlinkSync(join(base, name));
      removed += 1;
    } catch {
      // Another user's file, or a file that is already gone.
    }
  }
  return removed;
}

export function openStore(dataDir: string, kek: Buffer): Store {
  if (kek.length !== 32) throw new Error("KEK must be 32 bytes");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const keyDir = join(dataDir, "keys");
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });

  const encPathEarly = join(dataDir, "hmn.sqlite.enc");
  // A rotation that stopped half way leaves a `.prev` wrap. The key that opens the saved file is the right one.
  let dbKey = pickDbKey(keyDir, kek, encPathEarly);
  let sealedKey = readWrap(join(keyDir, "sealed.wrap"), kek);
  let backupPassphrase: string | null = null;
  const phrasePath = join(keyDir, "recovery.wrap");
  if (existsSync(phrasePath)) {
    backupPassphrase = unwrap(kek, readFileSync(phrasePath)).toString("utf8");
  }
  const encPath = join(dataDir, "hmn.sqlite.enc");
  if (!dbKey && existsSync(encPath)) {
    // A graph without its key cannot open. A new key would hide that and make an empty graph next to it.
    throw new Error("The data directory has a graph and no keys/db.wrap. HMN does not start. Restore the keys folder or run the restore tool.");
  }
  if (!dbKey) {
    dbKey = randomBytes(32);
    writeWrap(join(keyDir, "db.wrap"), kek, dbKey);
  }
  if (!sealedKey) {
    sealedKey = randomBytes(32);
    writeWrap(join(keyDir, "sealed.wrap"), kek, sealedKey);
  }
  if (!backupPassphrase) {
    backupPassphrase = recoveryPassphrase();
    writeWrap(phrasePath, kek, Buffer.from(backupPassphrase, "utf8"));
  }

  // A version before 2026-11-23 kept a plaintext working copy in the temporary folder. Remove what a killed server left.
  removeStaleRuntimeFiles(runtimeBase());
  // The working copy is in the memory of this process only. A kill or a power cut leaves no plaintext file.
  const initial = existsSync(encPath) ? decryptFile(dbKey, readFileSync(encPath)) : null;
  // A change to the schema is not a row change, so a new store and a restore start as unsaved.
  let unsaved = true;
  let savedChanges = -1;
  const store: Store = {
    db: memoryDatabase(initial),
    dbKey,
    sealedKey,
    backupPassphrase,
    dataDir,
    encPath,
    plainBytes() {
      return Buffer.from(this.db.serialize());
    },
    dirty() {
      return unsaved || changeCount(this.db) !== savedChanges;
    },
    persist(force = false) {
      // A read changes nothing, so a read does not encrypt and write the whole graph again.
      if (!force && !this.dirty()) return;
      // Free pages hold old text. When they are a large part of the file, make the file small again.
      compactIfLoose(this.db);
      const plain = this.plainBytes();
      // Write a complete new file, then put it in place in one step. A kill or
      // a power cut during the save leaves the old graph, not a part of a file.
      const tmp = `${encPath}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, encryptFile(dbKey, plain));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, encPath);
      savedChanges = changeCount(this.db);
      unsaved = false;
    },
    close() {
      try {
        this.persist();
      } finally {
        this.db.close();
      }
    },
    rotateKeys() {
      // The database key encrypts the saved file as one blob. A new one changes no value in the graph, so the audit
      // chain, which hashes the stored history, stays whole. 1. Keep the old wrap as `.prev`. 2. Put the new wrap in
      // place. 3. Save the graph under the new key. 4. Remove `.prev`. A stop between 2 and 3 leaves a file that only
      // the old key opens, and the next start takes the `.prev` wrap (pickDbKey).
      const nextDb = randomBytes(32);
      copyFileSync(join(keyDir, "db.wrap"), join(keyDir, "db.wrap.prev"));
      writeWrapAtomic(join(keyDir, "db.wrap"), kek, nextDb);
      dbKey = nextDb;
      this.dbKey = nextDb;
      this.persist(true);
      if (existsSync(join(keyDir, "db.wrap.prev"))) unlinkSync(join(keyDir, "db.wrap.prev"));
      return { rotated: "database" };
    },
    replaceDatabase(plain: Buffer, nextSealed: Buffer) {
      const previous = this.plainBytes();
      const previousSealed = Buffer.from(this.sealedKey);
      this.db.close();
      try {
        this.db = memoryDatabase(plain);
        prepareDatabase(this.db);
        unsaved = true;
        if (!nextSealed.equals(previousSealed)) {
          writeWrap(join(keyDir, "sealed.wrap"), kek, nextSealed);
          this.sealedKey = nextSealed;
        }
        this.persist();
      } catch (error) {
        if (!this.sealedKey.equals(previousSealed)) {
          writeWrap(join(keyDir, "sealed.wrap"), kek, previousSealed);
          this.sealedKey = previousSealed;
        }
        this.db = memoryDatabase(previous);
        prepareDatabase(this.db);
        unsaved = true;
        throw error;
      }
    },
  };
  prepareDatabase(store.db);
  migrate(store.db);
  return store;
}

function writeWrapAtomic(path: string, kek: Buffer, key: Buffer) {
  writeFileSync(`${path}.tmp`, wrap(kek, key), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** The database key that opens the saved graph: `db.wrap`, or `db.wrap.prev` after a rotation that stopped. */
function pickDbKey(keyDir: string, kek: Buffer, encPath: string): Buffer | null {
  const current = readWrap(join(keyDir, "db.wrap"), kek);
  const prevPath = join(keyDir, "db.wrap.prev");
  if (!existsSync(prevPath) || !existsSync(encPath)) return current;
  const blob = readFileSync(encPath);
  const opens = (key: Buffer | null) => {
    if (!key) return false;
    try {
      decryptFile(key, blob);
      return true;
    } catch {
      return false;
    }
  };
  if (opens(current)) {
    unlinkSync(prevPath);
    return current;
  }
  const prev = readWrap(prevPath, kek);
  if (prev && opens(prev)) {
    writeWrapAtomic(join(keyDir, "db.wrap"), kek, prev);
    unlinkSync(prevPath);
    return prev;
  }
  return current;
}

/** The rows that this connection inserted, changed, or deleted since it opened. */
function changeCount(db: Database): number {
  return (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
}

/** VACUUM when free pages are more than a quarter of a file of 1 MB or more. */
function compactIfLoose(db: Database) {
  if (db.inTransaction) return;
  const pages = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
  const free = (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
  const size = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size;
  if (pages * size >= 1_000_000 && free * 4 > pages) db.exec("VACUUM");
}

/** A database in memory, from the bytes of a saved graph, or empty. */
function memoryDatabase(plain: Buffer | Uint8Array | null): Database {
  return plain && plain.length > 0 ? Database.deserialize(plain) : new Database(":memory:");
}

function prepareDatabase(db: Database) {
  db.exec("PRAGMA foreign_keys = ON;");
  // A deleted row is overwritten with zeros, so old text does not stay in free pages.
  db.exec("PRAGMA secure_delete = ON;");
  db.exec("PRAGMA journal_mode = DELETE;");
  db.exec(SCHEMA);
}

/** The restore tool keeps the passphrase that the owner typed, so that the paper stays valid. */
export function setRecoveryPassphrase(store: Store, kek: Buffer, phrase: string) {
  writeWrap(join(store.dataDir, "keys", "recovery.wrap"), kek, Buffer.from(phrase, "utf8"));
  store.backupPassphrase = phrase;
}

export function loadKek(options: { dataDir: string; kek?: Buffer }): Buffer {
  if (options.kek) return options.kek;
  if (process.env.HMN_KEK_FILE) {
    return parseKeyMaterial(readFileSync(process.env.HMN_KEK_FILE));
  }
  // The flag comes first, also on a Mac. A test server with this flag does not read or write the Keychain.
  if (process.env.HMN_INSECURE_DEV_KEK === "1") {
    console.error("HMN_INSECURE_DEV_KEK is set. The KEK is in the data directory. Do not use this for real data.");
    return devKek(options.dataDir);
  }
  if (process.platform === "darwin") {
    return keychainKek(options.dataDir);
  }
  throw new Error(
    "No key source. On a Mac, HMN uses the login Keychain. Docker should mount the Keychain export at HMN_KEK_FILE. Refusing to start.",
  );
}

function devKek(dataDir: string): Buffer {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "keys", "kek.dev");
  mkdirSync(join(dataDir, "keys"), { recursive: true, mode: 0o700 });
  if (existsSync(path)) return parseKeyMaterial(readFileSync(path));
  const key = randomBytes(32);
  writeFileSync(path, key.toString("base64url") + "\n", { mode: 0o600 });
  return key;
}

/** `HMN_KEYCHAIN` selects a keychain file for a launchd user. `security` takes the keychain as the last argument. It has no `-k` option. */
/** The tools by absolute path, so that a folder early in PATH (Bun, Homebrew) cannot put another program in their place. */
export const SECURITY_TOOL = "/usr/bin/security";
export const OPENSSL_TOOL = "/usr/bin/openssl";

export function keychainArgs(args: string[]): string[] {
  const path = process.env.HMN_KEYCHAIN;
  if (!path) return args;
  return [...args, path];
}

/**
 * False when the Keychain must not be used: a test server with the dev key flag, or a named keychain file that
 * does not exist. `security add-generic-password` with a missing keychain file writes to the login keychain
 * and reports success, so the check is made here and not left to the tool.
 */
export function keychainAllowed(): boolean {
  if (process.env.HMN_INSECURE_DEV_KEK === "1") return false;
  const named = process.env.HMN_KEYCHAIN;
  return !named || existsSync(named);
}

export function runSecurity(args: string[]): { exitCode: number | null; stdout: Buffer | Uint8Array } {
  if (!keychainAllowed()) return { exitCode: 1, stdout: Buffer.alloc(0) };
  return Bun.spawnSync([SECURITY_TOOL, ...keychainArgs(args)], { stdout: "pipe", stderr: "pipe" });
}

/** `security` exits with 44 when the item is not in the keychain. Each other failure is a fault, not a missing item. */
const SECURITY_NOT_FOUND = 44;

/**
 * The KEK from the Keychain. A new KEK is made only when the Keychain says that the item is not there, and the
 * data directory has no wrapped key. A locked keychain or a refused read stops the server: a new KEK would never
 * open the old graph again.
 */
export function keychainKek(dataDir: string, run: typeof runSecurity = runSecurity): Buffer {
  const proc = run(["find-generic-password", "-s", "hmn.kek", "-a", "hmn", "-w"]);
  if (proc.exitCode === 0) {
    return parseKeyMaterial(Buffer.from(proc.stdout));
  }
  if (proc.exitCode !== SECURITY_NOT_FOUND) {
    throw new Error(`The Keychain did not give hmn.kek (security exit ${proc.exitCode}). Unlock the login keychain, then start HMN again. HMN makes no new key.`);
  }
  if (existsSync(join(dataDir, "keys", "db.wrap"))) {
    throw new Error("hmn.kek is not in the Keychain, and the data directory has a graph. HMN makes no new key, because a new key cannot open that graph. Put hmn.kek back, or restore with the recovery passphrase.");
  }
  const created = randomBytes(32).toString("base64url");
  // No -U: if an item appeared in the meantime, the add fails and nothing is replaced.
  const add = run(["add-generic-password", "-s", "hmn.kek", "-a", "hmn", "-w", created]);
  if (add.exitCode !== 0) {
    throw new Error(
      process.env.HMN_KEYCHAIN && !existsSync(process.env.HMN_KEYCHAIN)
        ? "The keychain file in HMN_KEYCHAIN does not exist. HMN does not fall back to the login Keychain."
        : "Could not store hmn.kek in the macOS Keychain.",
    );
  }
  return parseKeyMaterial(Buffer.from(created));
}

export function anchorAuditTip(tip: string) {
  if (process.platform !== "darwin") return;
  runSecurity(["add-generic-password", "-s", "hmn.audit.tip", "-a", "hmn", "-w", tip, "-U"]);
}

/**
 * Put the key of one agent in the Keychain as `hmn.agent.<name>`, so that the key is not shown or typed.
 * It returns false when the Keychain is not in use, and the caller then gives the key once.
 */
export function rememberAgentKey(name: string, token: string): boolean {
  if (process.platform !== "darwin") return false;
  return runSecurity(["add-generic-password", "-s", `hmn.agent.${name}`, "-a", "hmn", "-w", token, "-U"]).exitCode === 0;
}

export function forgetAgentKey(name: string) {
  if (process.platform !== "darwin") return;
  runSecurity(["delete-generic-password", "-s", `hmn.agent.${name}`, "-a", "hmn"]);
}

/** The same for the key of one view. The item is `hmn.view.<name>`, so that it is not taken for the key of an agent. */
export function rememberViewKey(name: string, token: string): boolean {
  if (process.platform !== "darwin") return false;
  return runSecurity(["add-generic-password", "-s", `hmn.view.${name}`, "-a", "hmn", "-w", token, "-U"]).exitCode === 0;
}

export function forgetViewKey(name: string) {
  if (process.platform !== "darwin") return;
  runSecurity(["delete-generic-password", "-s", `hmn.view.${name}`, "-a", "hmn"]);
}

/** First boot only. The API secrets and the recovery passphrase are not written to the data directory. */
export function rememberBootSecrets(secrets: { owner: string; agent: string; display: string; backup: string }) {
  if (process.platform !== "darwin") return;
  // A test server makes no Keychain call. It prints its keys, and it does not report a Keychain fault.
  if (process.env.HMN_INSECURE_DEV_KEK === "1") return;
  const items: Array<[string, string]> = [
    ["hmn.owner", secrets.owner],
    ["hmn.agent", secrets.agent],
    ["hmn.display", secrets.display],
    ["hmn.backup", secrets.backup],
  ];
  for (const [service, value] of items) {
    if (!value) continue;
    const add = runSecurity(["add-generic-password", "-s", service, "-a", "hmn", "-w", value, "-U"]);
    if (add.exitCode !== 0) console.error(`Could not store ${service} in the Keychain.`);
  }
}
