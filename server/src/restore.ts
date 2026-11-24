/**
 * The restore tool. Stop the server first.
 *
 *   bun src/restore.ts --backup <file> [--data-dir <dir>] [--replace]
 *
 * It asks for the recovery passphrase from the paper, and it does not show what you type. It puts the graph of the
 * backup in the data directory with keys from the KEK of this Mac, keeps the passphrase, and makes a new owner key.
 * On a Mac the new owner key goes into the Keychain as `hmn.owner`. Pair each phone again after a restore.
 */
import { existsSync } from "node:fs";
import { restoreFromBackup } from "./recovery";
import { loadKek, runSecurity } from "./store";

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1]! : null;
}

async function readPassphrase(): Promise<string> {
  const tty = process.stdin.isTTY;
  if (tty) Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  process.stderr.write("Recovery passphrase: ");
  try {
    for await (const line of console) return line;
    return "";
  } finally {
    if (tty) Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
    process.stderr.write("\n");
  }
}

const backupPath = option("backup");
const dataDir = option("data-dir") ?? process.env.HMN_DATA_DIR ?? "./data";
if (!backupPath || !existsSync(backupPath)) {
  console.error("Give the backup file: bun src/restore.ts --backup <file> [--data-dir <dir>] [--replace]");
  process.exit(1);
}
try {
  const passphrase = await readPassphrase();
  const kek = loadKek({ dataDir });
  const { ownerKey } = restoreFromBackup({ backupPath, passphrase, dataDir, kek, replace: process.argv.includes("--replace") });
  let stored = false;
  if (process.platform === "darwin" && process.env.HMN_INSECURE_DEV_KEK !== "1") {
    stored = runSecurity(["add-generic-password", "-s", "hmn.owner", "-a", "hmn", "-w", ownerKey, "-U"]).exitCode === 0;
    runSecurity(["add-generic-password", "-s", "hmn.backup", "-a", "hmn", "-w", passphrase.trim(), "-U"]);
  }
  console.error("The backup is restored. Each old owner key is revoked.");
  if (stored) console.error("The new owner key is in the Keychain as hmn.owner. The menu bar app reads it there.");
  else console.log(`New owner key, shown once: ${ownerKey}`);
  console.error("Start the server, then pair each phone again.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "The restore failed.");
  process.exit(1);
}
