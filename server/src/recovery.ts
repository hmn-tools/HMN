/**
 * Restore a backup with the paper passphrase only. This is for a new Mac, or a Mac whose Keychain is gone: the
 * data directory gets new keys from the KEK of this Mac, the graph of the backup, and a new owner key.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureApprovalTables } from "./approval";
import { decryptBackup } from "./crypto";
import { ensureDeviceTables } from "./devices/tables";
import { ensureExternalTables } from "./external/tables";
import { Hmn, parseBackupBody } from "./hmn";
import { ensureKindTables } from "./kinds";
import { openStore, setRecoveryPassphrase } from "./store";
import { ensureWorkers } from "./workers/config";

export function restoreFromBackup(options: {
  backupPath: string;
  passphrase: string;
  dataDir: string;
  kek: Buffer;
  replace?: boolean;
  now?: () => Date;
}): { ownerKey: string } {
  if (existsSync(join(options.dataDir, "hmn.sqlite.enc")) && !options.replace) {
    throw new Error("The data directory has a graph. Stop the server, then run this again with --replace to put the backup in its place.");
  }
  let plain: Buffer;
  try {
    plain = decryptBackup(options.passphrase.trim(), readFileSync(options.backupPath));
  } catch {
    throw new Error("The backup did not open. Check the file and the passphrase: 13 words with hyphens between them.");
  }
  const parsed = parseBackupBody(plain);
  const store = openStore(options.dataDir, options.kek);
  try {
    store.replaceDatabase(parsed.sqlite, parsed.sealedKey);
    setRecoveryPassphrase(store, options.kek, options.passphrase.trim());
    const now = options.now ?? (() => new Date());
    const hmn = new Hmn(store, now, "UTC");
    // A backup can be from before a table or a column existed.
    ensureKindTables(store.db);
    ensureDeviceTables(store.db);
    ensureExternalTables(store.db);
    ensureApprovalTables(store.db);
    ensureWorkers(store.db, now().toISOString());
    const ownerKey = hmn.recoverOwner();
    return { ownerKey };
  } finally {
    store.close();
  }
}
