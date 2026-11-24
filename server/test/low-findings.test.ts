// The low findings of the audit of 2026-11-23: the oracles, the guest inbox, the audit check of head rows, the
// TLS key, key rotation, plugin secrets, and model names. Each test starts its own graph. No real Keychain.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { handleExternal } from "../src/external/http";
import { writeJournal } from "../src/journal";
import { pullModel, removeModel } from "../src/models/client";
import { ensureModelSchema } from "../src/models/store";
import { readPluginSecret } from "../src/plugins/secrets";
import { ensureCerts, renewCerts } from "../src/tls";
import { call, testApp } from "./helpers";

const propose = (app: ReturnType<typeof testApp>, key: string, payload: Record<string, unknown>) =>
  call(app, "/api/v1/proposals", { method: "POST", key, surface: "mcp", body: { op: payload.op, payload } });

test("a key gets one answer for a row that is hidden and for a row that does not exist", async () => {
  const app = testApp();
  try {
    const agent = app.secrets!.agent;
    const answers = [];
    // person_sam is Private, note_trip is Sealed, task_clinic is in the Health area, and the last id does not exist.
    for (const id of ["person_sam", "note_trip", "area_health", "note_no_such_row"]) {
      const update = await propose(app, agent, { op: "update", id, patch: { title: "Probe" } });
      const remove = await propose(app, agent, { op: "delete", id });
      const link = await propose(app, agent, { op: "link", link: { from_id: "task_notes", to_id: id, rel: "about" } });
      const create = await propose(app, agent, { op: "create", entity: { type: "task", title: "Probe", area_id: id } });
      answers.push([update, remove, link, create].map((reply) => `${reply.status} ${reply.text}`));
    }
    for (const row of answers) expect(row).toEqual(answers[3]);
    expect(answers[3]![0]).toContain("404");
    // No proposal was left in the queue by the probes.
    expect((app.store.db.query("SELECT COUNT(*) AS n FROM proposals WHERE payload LIKE '%Probe%'").get() as { n: number }).n).toBe(0);
    // A row that the key can read still works.
    expect((await propose(app, agent, { op: "update", id: "task_notes", patch: { title: "Send the weekly notes" } })).status).toBe(201);
    // A key cannot set source_id. external_id stays allowed.
    expect((await propose(app, agent, { op: "create", entity: { type: "event", title: "X", source_id: "source_cal" } })).status).toBe(422);
    expect((await propose(app, agent, { op: "create", entity: { type: "task", title: "From mail", external_id: "mail-1" } })).status).toBe(201);
  } finally {
    app.close();
  }
});

test("an inbox item from a key gets the same answer whatever its text names, and a guest cannot choose a tier", async () => {
  const app = testApp();
  try {
    const send = (key: string, body: Record<string, unknown>) => call(app, "/api/v1/inbox", { method: "POST", key, surface: "mcp", body });
    const plain = await send(app.secrets!.agent, { text: "Buy milk" });
    const named = await send(app.secrets!.agent, { text: "Sam and #health" });
    for (const reply of [plain, named]) {
      expect(reply.status).toBe(201);
      expect(Object.keys(reply.json as object).sort()).toEqual(["id", "received"]);
    }

    await call(app, "/api/v1/external/enable", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
    const guest = (await call(app, "/api/v1/external/clients", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1", body: { name: "Mara", guest: true } })).json as { token: string };
    const rpc = async (id: number, method: string, params: Record<string, unknown> = {}, session?: string) => {
      const headers = new Headers({ authorization: `Bearer ${guest.token}`, "content-type": "application/json" });
      if (session) headers.set("mcp-session-id", session);
      const response = await handleExternal(app.hmn, new Request("https://hmn.local/external/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }), "203.0.113.8");
      return { session: response.headers.get("mcp-session-id"), text: await response.text() };
    };
    const opened = await rpc(1, "initialize");
    await rpc(2, "tools/call", { name: "capture_inbox", arguments: { text: "A note from Mara #sealed", tier: "sealed", url: "https://example.com/x", source: "siri", attachments: [{ kind: "file", name: "a.txt", data_base64: "QUJD" }] } }, opened.session!);
    const row = app.store.db.query("SELECT tier, source, url, attachments, body FROM inbox_items WHERE origin = 'agent' ORDER BY captured_at DESC, rowid DESC LIMIT 1").get() as Record<string, string>;
    expect(row.tier).toBe("personal");
    expect(row.source).toBe("mcp");
    expect(row.url).toBeNull();
    expect(row.attachments).toBe("[]");
  } finally {
    app.close();
  }
});

test("the audit routes are for the owner, a journal hides its reason from a reader who cannot see its items, and rotate tells nothing", async () => {
  const app = testApp();
  try {
    for (const path of ["/api/v1/audit/tip", "/api/v1/audit/verify"]) {
      expect((await call(app, path, { key: app.secrets!.display })).status).toBe(403);
      expect((await call(app, path, { key: app.secrets!.agent, surface: "mcp" })).status).toBe(403);
      expect((await call(app, path, { key: app.secrets!.owner, surface: "phone" })).status).toBe(200);
    }
    const id = writeJournal(app.hmn, {
      actorId: "worker:week",
      name: "Week",
      model: "hmn.fallback",
      why: "Example private reason with Sam",
      read: [{ type: "person", id: "person_sam", title: "Sam", tier: "private" }],
      proposed: [],
    });
    const forDisplay = await call(app, `/api/v1/journals/${id}`, { key: app.secrets!.display });
    expect(forDisplay.text).not.toContain("Example private reason");
    const forOwner = await call(app, `/api/v1/journals/${id}`, { key: app.secrets!.owner, surface: "phone" });
    expect(forOwner.text).toContain("Example private reason");
    // A key asks to rotate a credential that exists, and one that does not. The answers are the same.
    const real = await call(app, "/api/v1/credentials/key_owner/rotate", { method: "POST", key: app.secrets!.agent, surface: "mcp" });
    const none = await call(app, "/api/v1/credentials/key_no_such/rotate", { method: "POST", key: app.secrets!.agent, surface: "mcp" });
    expect(`${real.status} ${real.text}`).toBe(`${none.status} ${none.text}`);
  } finally {
    app.close();
  }
});

test("the audit check finds a head row that was edited with no new version", async () => {
  const app = testApp();
  try {
    const verify = () => call(app, "/api/v1/audit/verify", { key: app.secrets!.owner, surface: "phone" });
    expect((await verify()).status).toBe(200);
    // Edits through the API keep the chain whole.
    expect((await call(app, "/api/v1/task/task_notes", { method: "PATCH", key: app.secrets!.owner, surface: "phone", body: { title: "Send the notes" } })).status).toBe(200);
    expect((await verify()).status).toBe(200);
    app.store.db.query("UPDATE entities SET title = 'Changed behind the log' WHERE id = 'task_notes'").run();
    const broken = await verify();
    expect(broken.status).toBe(409);
    expect((broken.json as { entity: string }).entity).toBe("task_notes");
  } finally {
    app.close();
  }
});

test("the TLS key is wrapped under the KEK, the CA key is removed, and a plain key from an old version is wrapped", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hmn-tls-"));
  const kek = randomBytes(32);
  const first = ensureCerts(dataDir, kek);
  const files = readdirSync(join(dataDir, "tls")).sort();
  expect(files).toEqual(["ca.crt", "server.crt", "server.key.wrap"]);
  for (const name of files) expect(readFileSync(join(dataDir, "tls", name), "latin1")).not.toContain("PRIVATE KEY");
  expect(first.key).toContain("PRIVATE KEY");
  // The key opens again with the same KEK, and not with another.
  expect(ensureCerts(dataDir, kek).fingerprint).toBe(first.fingerprint);
  expect(() => ensureCerts(dataDir, randomBytes(32))).toThrow("renew-cert");
  // An install from before this change has a plain key.
  writeFileSync(join(dataDir, "tls", "server.key"), first.key, { mode: 0o600 });
  writeFileSync(join(dataDir, "tls", "ca.key"), "old CA key", { mode: 0o600 });
  expect(ensureCerts(dataDir, kek).fingerprint).toBe(first.fingerprint);
  expect(existsSync(join(dataDir, "tls", "server.key"))).toBe(false);
  expect(existsSync(join(dataDir, "tls", "ca.key"))).toBe(false);
  // A renewal makes a new certificate and a new fingerprint.
  expect(renewCerts(dataDir, kek).fingerprint).not.toBe(first.fingerprint);
});

test("a new database key keeps the graph and the audit chain, also after a stop half way", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hmn-rotate-"));
  const kek = randomBytes(32);
  const now = () => new Date("2026-11-11T04:39:00.000Z");
  let app = createApp({ dataDir, kek, now });
  const owner = app.secrets!.owner;
  try {
    const before = readFileSync(join(dataDir, "keys", "db.wrap"));
    expect((await call(app, "/api/v1/admin/rotate-keys", { method: "POST", key: owner, ip: "10.1.1.1" })).status).toBe(403);
    expect((await call(app, "/api/v1/admin/rotate-keys", { method: "POST", key: app.secrets!.agent, ip: "127.0.0.1" })).status).toBe(403);
    const rotated = await call(app, "/api/v1/admin/rotate-keys", { method: "POST", key: owner, ip: "127.0.0.1" });
    expect(rotated.status).toBe(200);
    expect(readFileSync(join(dataDir, "keys", "db.wrap")).equals(before)).toBe(false);
    expect(existsSync(join(dataDir, "keys", "db.wrap.prev"))).toBe(false);
    expect((await call(app, "/api/v1/audit/verify", { key: owner, surface: "phone" })).status).toBe(200);
    app.close();
    app = createApp({ dataDir, kek, now });
    expect((await call(app, "/api/v1/screens/today", { key: owner, surface: "phone" })).text).toContain("Luca");
    app.close();
    // A stop after the new wrap and before the save: the saved file still needs the old key.
    const { copyFileSync } = await import("node:fs");
    const { wrap } = await import("../src/store");
    copyFileSync(join(dataDir, "keys", "db.wrap"), join(dataDir, "keys", "db.wrap.prev"));
    writeFileSync(join(dataDir, "keys", "db.wrap"), wrap(kek, randomBytes(32)));
    app = createApp({ dataDir, kek, now });
    expect((await call(app, "/api/v1/me", { key: owner })).status).toBe(200);
    expect(existsSync(join(dataDir, "keys", "db.wrap.prev"))).toBe(false);
  } finally {
    app.close();
  }
});

test("a test server reads no plugin secret from the Keychain, and a model name with a host or a path is refused", async () => {
  // helpers.ts names a keychain file that does not exist, so the Keychain is not allowed.
  process.env.HMN_TEST_PLUGIN_SECRET = "from-the-environment";
  expect(readPluginSecret("hmn.test.plugin", "HMN_TEST_PLUGIN_SECRET")).toBe("from-the-environment");
  delete process.env.HMN_TEST_PLUGIN_SECRET;
  expect(readPluginSecret("hmn.test.plugin", "HMN_TEST_PLUGIN_SECRET")).toBeNull();

  const app = testApp();
  try {
    ensureModelSchema(app.store.db);
    const sent: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      sent.push(`${url} ${String(init?.body ?? "")}`);
      return new Response("{}");
    }) as never;
    for (const id of ["ollama:hf.co/attacker/backdoor:latest", "ollama:evil.example:443/ns/m", "ollama:../../etc/x", "ollama:not-in-the-catalog:1b"]) {
      const result = await pullModel(app.store.db, id, fake);
      expect(result.ok).toBe(false);
    }
    expect((await removeModel(app.store.db, "ollama:../../etc/x", fake)).ok).toBe(true);
    expect(sent).toEqual([]);
  } finally {
    app.close();
  }
});
