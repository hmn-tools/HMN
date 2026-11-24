// Storage and recovery: the key of the graph, purge, restore, the daily backup, the owner key, and the mirror.
// Each test starts its own graph. No test reads or writes a real Keychain.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app";
import { restoreFromBackup } from "../src/recovery";
import { keychainKek, openStore } from "../src/store";
import { call } from "./helpers";

function clockedApp(dataDir = mkdtempSync(join(tmpdir(), "hmn-storage-")), kek = randomBytes(32)) {
  const clock = { now: new Date("2026-11-11T04:39:00.000Z") };
  const app = createApp({ dataDir, kek, now: () => clock.now, timeZone: "Australia/Perth" });
  return { app, clock, dataDir, kek };
}

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });
const MINI = "127.0.0.1";

test("a failed Keychain read stops the start, and a new KEK is made only for a new data directory", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hmn-kek-"));
  const calls: string[][] = [];
  const stub = (exit: number) => (args: string[]) => {
    calls.push(args);
    return { exitCode: args[0] === "find-generic-password" ? exit : 0, stdout: Buffer.alloc(0) };
  };
  // A locked keychain, or a refused read.
  expect(() => keychainKek(dataDir, stub(36))).toThrow("makes no new key");
  expect(calls.some((args) => args[0] === "add-generic-password")).toBe(false);
  // The item is missing, and the data directory has a graph.
  const store = openStore(dataDir, randomBytes(32));
  store.close();
  calls.length = 0;
  expect(() => keychainKek(dataDir, stub(44))).toThrow("makes no new key");
  expect(calls.some((args) => args[0] === "add-generic-password")).toBe(false);
  // A new data directory: one add, and it does not replace an item.
  calls.length = 0;
  const fresh = mkdtempSync(join(tmpdir(), "hmn-kek-"));
  expect(keychainKek(fresh, stub(44)).length).toBe(32);
  const add = calls.find((args) => args[0] === "add-generic-password")!;
  expect(add).toBeDefined();
  expect(add.includes("-U")).toBe(false);
});

test("a graph without its wrapped key does not open, and nothing new is made beside it", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hmn-nokey-"));
  const kek = randomBytes(32);
  openStore(dataDir, kek).close();
  rmSync(join(dataDir, "keys", "db.wrap"));
  expect(() => openStore(dataDir, kek)).toThrow("no keys/db.wrap");
  expect(existsSync(join(dataDir, "keys", "db.wrap"))).toBe(false);
});

test("a purge also removes the text from the proposal and the journal that named the row", async () => {
  const { app } = clockedApp();
  try {
    const made = await call(app, "/api/v1/proposals", {
      method: "POST",
      key: app.secrets!.agent,
      surface: "mcp",
      body: { op: "create", payload: { op: "create", entity: { type: "note", title: "PURGEMARK title", body: "PURGEMARK body" } }, reason: "PURGEMARK reason" },
    });
    const id = (made.json as { id: string }).id;
    const approved = await call(app, `/api/v1/proposals/${id}/approve`, { method: "POST", ...owner(app) });
    expect(approved.status).toBe(200);
    const note = app.store.db.query("SELECT id FROM entities WHERE title LIKE 'PURGEMARK%'").get() as { id: string };
    expect(app.store.plainBytes().toString("latin1")).toContain("PURGEMARK");
    const purged = await call(app, `/api/v1/note/${note.id}/purge`, { method: "POST", ...owner(app) });
    expect(purged.status).toBe(200);
    app.store.persist();
    expect(app.store.plainBytes().toString("latin1")).not.toContain("PURGEMARK");
  } finally {
    app.close();
  }
});

test("a restore of an older backup keeps the revokes and Hide of the live graph", async () => {
  const { app } = clockedApp();
  try {
    const key = await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body: { name: "research" } });
    const research = key.json as { id: string; token: string };
    const backup = await call(app, "/api/v1/backup", { method: "POST", key: app.secrets!.owner, ip: MINI });
    expect(backup.status).toBe(200);
    const name = (backup.json as { name: string }).name;
    expect(name).toMatch(/^backup-.*\.hmn$/);
    expect(backup.text).not.toContain(app.store.dataDir);

    await call(app, `/api/v1/devices/${research.id}/revoke`, { method: "POST", ...owner(app) });
    expect((await call(app, "/api/v1/me", { key: research.token })).status).toBe(401);

    const restored = await call(app, "/api/v1/admin/restore", { method: "POST", key: app.secrets!.owner, ip: MINI, body: { name } });
    expect(restored.status).toBe(200);
    // Before this change, the key worked again.
    expect((await call(app, "/api/v1/me", { key: research.token })).status).toBe(401);
    const rows = app.store.db.query("SELECT action FROM audit_log ORDER BY seq DESC LIMIT 4").all() as Array<{ action: string }>;
    expect(rows.map((row) => row.action)).toContain("restore_prior_tip");

    // The backup route needs the owner key, also on the mini.
    expect((await call(app, "/api/v1/backup", { method: "POST", key: app.secrets!.agent, ip: MINI })).status).toBe(403);
  } finally {
    app.close();
  }
});

test("the paper passphrase restores a backup on a new Mac, and the old owner key stops", async () => {
  const first = clockedApp();
  const passphrase = first.app.store.backupPassphrase;
  const oldOwner = first.app.secrets!.owner;
  let backupPath = "";
  try {
    const made = await call(first.app, "/api/v1/backup", { method: "POST", key: oldOwner, ip: MINI });
    backupPath = join(first.dataDir, "backups", (made.json as { name: string }).name);
  } finally {
    first.app.close();
  }
  // A new Mac: a new data directory and a new KEK. Only the file and the paper come with the owner.
  const dataDir = mkdtempSync(join(tmpdir(), "hmn-newmac-"));
  const kek = randomBytes(32);
  expect(() => restoreFromBackup({ backupPath, passphrase: "wrong-words", dataDir, kek })).toThrow("did not open");
  const { ownerKey } = restoreFromBackup({ backupPath, passphrase: ` ${passphrase}\n`, dataDir, kek });
  expect(() => restoreFromBackup({ backupPath, passphrase, dataDir, kek })).toThrow("--replace");

  const second = createApp({ dataDir, kek, now: () => new Date("2026-11-11T04:39:00.000Z"), timeZone: "Australia/Perth" });
  try {
    expect(second.secrets).toBeNull();
    expect((await call(second, "/api/v1/me", { key: oldOwner })).status).toBe(401);
    const me = await call(second, "/api/v1/screens/today", { key: ownerKey, surface: "phone" });
    expect(me.status).toBe(200);
    expect(me.text).toContain("Luca");
    // The paper stays valid for the next backups.
    expect(second.store.backupPassphrase).toBe(passphrase);
  } finally {
    second.close();
  }
});

test("a daily backup runs once a day, keeps fourteen files, and copies each one to a second folder", () => {
  const { app, clock } = clockedApp();
  const copies = mkdtempSync(join(tmpdir(), "hmn-copies-"));
  process.env.HMN_BACKUP_COPY_DIR = copies;
  try {
    expect(app.hmn.backupIfDue()).not.toBeNull();
    expect(app.hmn.backupIfDue()).toBeNull();
    for (let day = 1; day <= 16; day++) {
      clock.now = new Date(clock.now.getTime() + 25 * 3_600_000);
      expect(app.hmn.backupIfDue()).not.toBeNull();
    }
    const kept = readdirSync(join(app.store.dataDir, "backups"));
    expect(kept.length).toBe(14);
    expect(readdirSync(copies).sort()).toEqual(kept.sort());
  } finally {
    delete process.env.HMN_BACKUP_COPY_DIR;
    app.close();
  }
});

test("the owner key renews itself on the mini, also in the 30 days after its end", async () => {
  const { app, clock } = clockedApp();
  try {
    const start = clock.now.getTime();
    clock.now = new Date(start + 95 * 86_400_000);
    expect((await call(app, "/api/v1/me", { key: app.secrets!.owner })).status).toBe(401);
    expect((await call(app, "/api/v1/owner/renew", { method: "POST", key: app.secrets!.owner, ip: "10.5.5.5" })).status).toBe(401);
    const renewed = await call(app, "/api/v1/owner/renew", { method: "POST", key: app.secrets!.owner, ip: MINI });
    expect(renewed.status).toBe(200);
    const next = renewed.json as { secret: string; expires_at: string };
    expect(Date.parse(next.expires_at)).toBe(clock.now.getTime() + 90 * 86_400_000);
    expect((await call(app, "/api/v1/me", { key: app.secrets!.owner, ip: MINI })).status).toBe(401);
    const me = await call(app, "/api/v1/me", { key: next.secret });
    expect((me.json as { credential: { expires_at: string } }).credential.expires_at).toBe(next.expires_at);
    // An agent key is not the owner key.
    expect((await call(app, "/api/v1/owner/renew", { method: "POST", key: app.secrets!.agent, ip: MINI })).status).toBe(401);

    // Long after the end, the grace is over.
    clock.now = new Date(clock.now.getTime() + 125 * 86_400_000);
    expect((await call(app, "/api/v1/owner/renew", { method: "POST", key: next.secret, ip: MINI })).status).toBe(401);
  } finally {
    app.close();
  }
});

test("the mirror follows a change of an area's tier, and leaves out a field that the row marks as Private", async () => {
  const { app } = clockedApp();
  try {
    const mirror = (path: string) => readFileSync(join(app.store.dataDir, "mirror", path), "utf8");
    app.store.persist(true);
    expect(mirror("entities/task/task_notes.md")).toContain("Send weekly notes");
    const raised = await call(app, "/api/v1/area/area_work", { method: "PATCH", ...owner(app), body: { properties: { child_tier: "private" } } });
    expect(raised.status).toBe(200);
    app.store.persist();
    expect(mirror("entities/task/task_notes.md")).not.toContain("Send weekly notes");
    expect(mirror("timelines/task_notes.jsonl")).not.toContain("Send weekly notes");

    const made = await call(app, "/api/v1/note", {
      method: "POST",
      ...owner(app),
      body: { title: "Plumber", tier: "personal", properties: { phone: "5550199", trade: "plumbing", _privacy: { phone: "private" } } },
    });
    expect(made.status).toBe(201);
    app.store.persist();
    const id = (made.json as { id: string }).id;
    const line = mirror(`timelines/${id}.jsonl`);
    expect(line).toContain("plumbing");
    expect(line).not.toContain("5550199");
  } finally {
    app.close();
  }
});
