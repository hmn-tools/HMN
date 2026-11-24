import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, testApp } from "./helpers";
import { keychainAllowed, keychainArgs, loadKek } from "../src/store";

test("menu-bar admin stays on the mini and does not return secrets", async () => {
  const app = testApp();
  try {
    const remote = await call(app, "/api/v1/admin/status", { key: app.secrets!.owner, ip: "10.1.1.1" });
    expect(remote.status).toBe(403);
    const agent = await call(app, "/api/v1/admin/status", { key: app.secrets!.agent, ip: "127.0.0.1" });
    expect(agent.status).toBe(403);
    const display = await call(app, "/api/v1/admin/devices", { key: app.secrets!.display, ip: "127.0.0.1" });
    expect(display.status).toBe(403);

    const status = await call(app, "/api/v1/admin/status", { key: app.secrets!.owner, ip: "127.0.0.1" });
    expect(status.status).toBe(200);
    const body = status.json as { fingerprint: string; devices: { paired: number; hidden: number }; backups: number };
    expect(body.fingerprint).toBe("test");
    expect(body.devices.paired).toBe(0);
    expect(body.devices.hidden).toBe(0);
    expect(body.backups).toBe(0);
    expect(status.text).not.toContain(app.secrets!.owner);
    expect(status.text).not.toContain("key_hash");
    expect(status.text).not.toContain("Yves");

    const paired = await call(app, "/api/v1/pairing", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
    const code = (paired.json as { code: string; payload: string }).code;
    expect((paired.json as { payload: string }).payload).toContain(`code=${code}`);
    const phone = await call(app, "/api/v1/pair", {
      method: "POST",
      ip: "10.4.4.4",
      body: { code, device_name: "Test phone" },
    });
    expect(phone.status).toBe(201);
    const device = phone.json as { secret: string; credential: { id: string } };
    const before = await call(app, "/api/v1/screens/today", { key: device.secret, surface: "phone", ip: "10.4.4.4" });
    expect(before.text).toContain("Luca");

    const hidden = await call(app, "/api/v1/admin/panic", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
    expect(hidden.status).toBe(200);
    expect((hidden.json as { hidden: number }).hidden).toBe(1);
    const after = await call(app, "/api/v1/screens/today", { key: device.secret, surface: "phone", ip: "10.4.4.4" });
    expect(after.text).not.toContain("Luca");
    expect(after.text).toContain("Lakeside Grand Prix");
    const ownerStill = await call(app, "/api/v1/screens/today", { key: app.secrets!.owner, surface: "phone" });
    expect(ownerStill.text).toContain("Luca");

    const listed = await call(app, "/api/v1/admin/devices", { key: app.secrets!.owner, ip: "127.0.0.1" });
    expect(listed.status).toBe(200);
    expect(listed.text).toContain("Test phone");
    expect(listed.text).toContain(device.credential.id);
    expect(listed.text).not.toContain(device.secret);
    expect(listed.text).not.toContain("key_hash");
    const row = (listed.json as { devices: Array<{ id: string; forced_ceiling: string | null }> }).devices[0];
    expect(row?.forced_ceiling).toBe("public");

    const remotePanic = await call(app, "/api/v1/admin/panic/clear", {
      method: "POST",
      key: app.secrets!.owner,
      ip: "10.9.9.9",
    });
    expect(remotePanic.status).toBe(403);
    const cleared = await call(app, "/api/v1/admin/panic/clear", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
    expect(cleared.status).toBe(200);
    const shown = await call(app, "/api/v1/screens/today", { key: device.secret, surface: "phone", ip: "10.4.4.4" });
    expect(shown.text).toContain("Luca");

    const revoked = await call(app, `/api/v1/devices/${device.credential.id}/revoke`, {
      method: "POST",
      key: app.secrets!.owner,
      surface: "phone",
    });
    expect(revoked.status).toBe(200);
    const dead = await call(app, "/api/v1/me", { key: device.secret, surface: "phone", ip: "10.4.4.4" });
    expect(dead.status).toBe(401);
  } finally {
    app.close();
  }
});

test("a localhost restore replaces the graph and rejects other names", async () => {
  const app = testApp();
  try {
    const marker = await call(app, "/api/v1/task", {
      method: "POST",
      key: app.secrets!.owner,
      surface: "phone",
      body: { title: "Restore marker", status: "open", kind: "task", area_id: "area_work" },
    });
    expect(marker.status).toBe(201);
    const made = await call(app, "/api/v1/backup", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
    expect(made.status).toBe(200);
    const later = await call(app, "/api/v1/task", {
      method: "POST",
      key: app.secrets!.owner,
      surface: "phone",
      body: { title: "After the copy", status: "open", kind: "task", area_id: "area_work" },
    });
    expect(later.status).toBe(201);

    const listed = await call(app, "/api/v1/admin/backups", { key: app.secrets!.owner, ip: "127.0.0.1" });
    expect(listed.status).toBe(200);
    const name = (listed.json as { backups: Array<{ name: string }> }).backups[0]?.name;
    expect(name).toMatch(/^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]+Z\.hmn$/);
    expect(listed.text).not.toContain(app.secrets!.owner);
    expect(listed.text).not.toContain("/data");

    const remote = await call(app, "/api/v1/admin/restore", {
      method: "POST",
      key: app.secrets!.owner,
      ip: "10.2.2.2",
      body: { name },
    });
    expect(remote.status).toBe(403);
    const traversal = await call(app, "/api/v1/admin/restore", {
      method: "POST",
      key: app.secrets!.owner,
      ip: "127.0.0.1",
      body: { name: "../hmn.sqlite.enc" },
    });
    expect(traversal.status).toBe(422);
    const missing = await call(app, "/api/v1/admin/restore", {
      method: "POST",
      key: app.secrets!.owner,
      ip: "127.0.0.1",
      body: { name: "backup-2026-11-11T000000000Z.hmn" },
    });
    expect(missing.status).toBe(404);

    const restored = await call(app, "/api/v1/admin/restore", {
      method: "POST",
      key: app.secrets!.owner,
      ip: "127.0.0.1",
      body: { name },
    });
    expect(restored.status).toBe(200);
    const gone = await call(app, "/api/v1/search?q=After%20the%20copy", { key: app.secrets!.owner, surface: "phone" });
    expect(gone.text).not.toContain("After the copy");
    const back = await call(app, "/api/v1/search?q=Restore%20marker", { key: app.secrets!.owner, surface: "phone" });
    expect(back.text).toContain("Restore marker");
    const enc = readFileSync(`${app.store.dataDir}/hmn.sqlite.enc`);
    expect(enc.subarray(0, 15).toString("utf8")).not.toBe("SQLite format 3");
    expect(enc.toString("utf8")).not.toContain("After the copy");
    const verify = await call(app, "/api/v1/audit/verify", { key: app.secrets!.owner, surface: "phone" });
    expect(verify.status).toBe(200);
  } finally {
    app.close();
  }
});

test("a missing keychain file and the dev key flag stop every Keychain call", () => {
  const before = { keychain: process.env.HMN_KEYCHAIN, dev: process.env.HMN_INSECURE_DEV_KEK };
  const dir = mkdtempSync(join(tmpdir(), "hmn-kek-"));
  try {
    // `security` writes to the login keychain when the named file is missing. The server must not call it.
    process.env.HMN_KEYCHAIN = join(dir, "missing.keychain-db");
    delete process.env.HMN_INSECURE_DEV_KEK;
    expect(keychainAllowed()).toBe(false);
    writeFileSync(join(dir, "present.keychain-db"), "");
    process.env.HMN_KEYCHAIN = join(dir, "present.keychain-db");
    expect(keychainAllowed()).toBe(true);
    delete process.env.HMN_KEYCHAIN;
    expect(keychainAllowed()).toBe(true);

    // The dev key flag works on each platform, and it keeps the key out of the Keychain.
    process.env.HMN_INSECURE_DEV_KEK = "1";
    expect(keychainAllowed()).toBe(false);
    const kek = loadKek({ dataDir: join(dir, "data") });
    expect(kek.length).toBe(32);
    expect(existsSync(join(dir, "data", "keys", "kek.dev"))).toBe(true);
    expect(loadKek({ dataDir: join(dir, "data") }).equals(kek)).toBe(true);
  } finally {
    if (before.keychain === undefined) delete process.env.HMN_KEYCHAIN;
    else process.env.HMN_KEYCHAIN = before.keychain;
    if (before.dev === undefined) delete process.env.HMN_INSECURE_DEV_KEK;
    else process.env.HMN_INSECURE_DEV_KEK = before.dev;
  }
});

test("keychain commands can target a keychain file", () => {
  const previous = process.env.HMN_KEYCHAIN;
  process.env.HMN_KEYCHAIN = "/Library/Keychains/System.keychain";
  try {
    expect(keychainArgs(["find-generic-password", "-s", "hmn.kek", "-w"])).toEqual([
      "find-generic-password",
      "-s",
      "hmn.kek",
      "-w",
      "/Library/Keychains/System.keychain",
    ]);
  } finally {
    if (previous === undefined) delete process.env.HMN_KEYCHAIN;
    else process.env.HMN_KEYCHAIN = previous;
  }
});
