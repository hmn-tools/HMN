// The admin plane: who can pair a phone, who can end Hide, what a revoke takes with it, and what a flood of bad
// tokens on the outside port can lock. Each test starts its own graph.
import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { handleExternal } from "../src/external/http";
import { ensureExternalTables } from "../src/external/tables";
import { ensureApprovalTables } from "../src/approval";
import { call, testApp } from "./helpers";

const MINI = "127.0.0.1";
const AWAY = "10.7.7.7";

async function pairPhone(app: App, name = "Test phone", key = app.secrets!.owner) {
  const made = await call(app, "/api/v1/pairing", { method: "POST", key, ip: MINI });
  expect(made.status).toBe(200);
  const paired = await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: (made.json as { code: string }).code, device_name: name } });
  expect(paired.status).toBe(201);
  const body = paired.json as { secret: string; credential: { id: string } };
  return { secret: body.secret, id: body.credential.id };
}

async function outside(app: App, path: string, options: { method?: string; token?: string; body?: unknown; session?: string; ip?: string } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.session) headers.set("mcp-session-id", options.session);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await handleExternal(
    app.hmn,
    new Request(`https://hmn.local${path}`, { method: options.method ?? "GET", headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined }),
    options.ip ?? "203.0.113.8",
  );
  return { status: response.status, text: await response.text(), headers: response.headers };
}

function audit(app: App, action: string) {
  return app.store.db.query("SELECT actor, entity_id FROM audit_log WHERE action = ? ORDER BY seq").all(action) as Array<{ actor: string; entity_id: string | null }>;
}

test("a pairing code needs the owner key on the mini, and the phone records who paired it", async () => {
  const app = testApp();
  try {
    // A process on the mini with no key. Before this change it got a code, and so a device that opens the vault.
    expect((await call(app, "/api/v1/pairing", { method: "POST", ip: MINI })).status).toBe(401);
    expect((await call(app, "/api/v1/pairing", { method: "POST", key: app.secrets!.agent, ip: MINI })).status).toBe(403);
    expect((await call(app, "/api/v1/pairing", { method: "POST", key: app.secrets!.display, ip: MINI })).status).toBe(403);
    expect((await call(app, "/api/v1/pairing", { method: "POST", key: app.secrets!.owner, ip: AWAY })).status).toBe(403);
    expect(app.store.db.query("SELECT COUNT(*) AS n FROM pairing_codes").get()).toEqual({ n: 0 });

    const phone = await pairPhone(app);
    const row = app.store.db.query("SELECT created_by FROM credentials WHERE id = ?").get(phone.id) as { created_by: string };
    const owner = (await call(app, "/api/v1/me", { key: app.secrets!.owner })).json as { credential: { id: string } };
    expect(row.created_by).toBe(owner.credential.id);
    // The audit row names the key that made the code, not "localhost".
    expect(audit(app, "pair")[0]!.actor).toBe(owner.credential.id);
  } finally {
    app.close();
  }
});

test("a hidden phone cannot end Hide, by any route", async () => {
  const app = testApp();
  try {
    const phone = await pairPhone(app);
    const today = (ip: string, secret = phone.secret) => call(app, "/api/v1/screens/today", { key: secret, surface: "phone", ip });
    expect((await today(AWAY)).text).toContain("Luca");
    expect((await call(app, "/api/v1/panic", { method: "POST", key: phone.secret, surface: "phone", ip: AWAY })).status).toBe(200);
    expect((await today(AWAY)).text).not.toContain("Luca");

    // The phone asks to see its data again: from the network, and from the mini itself.
    const away = await call(app, "/api/v1/panic/clear", { method: "POST", key: phone.secret, surface: "phone", ip: AWAY });
    expect(away.status).toBe(403);
    const local = await call(app, "/api/v1/panic/clear", { method: "POST", key: phone.secret, surface: "phone", ip: MINI });
    expect(local.status).toBe(403);
    expect((local.json as { error: { code: string } }).error.code).toBe("hidden");
    expect((await call(app, "/api/v1/admin/panic/clear", { method: "POST", key: phone.secret, ip: MINI })).status).toBe(403);

    // The ways around Hide: a new phone, a new key, a Private grant, an outside client.
    expect((await call(app, "/api/v1/pairing", { method: "POST", key: phone.secret, ip: MINI })).status).toBe(403);
    expect((await call(app, "/api/v1/keys", { method: "POST", key: phone.secret, surface: "phone", ip: MINI, body: { name: "escape" } })).status).toBe(403);
    expect((await call(app, "/api/v1/keys/key_agent/private", { method: "POST", key: phone.secret, surface: "phone", ip: MINI, body: { days: 1, understood: true } })).status).toBe(403);
    expect((await call(app, "/api/v1/external/clients", { method: "POST", key: phone.secret, ip: MINI, body: { name: "escape" } })).status).toBe(403);
    expect((await today(AWAY)).text).not.toContain("Luca");
    // A hidden phone still has the write scope. It cannot make a Private row or a Private area Public, because it cannot read them.
    const lowerRow = await call(app, "/api/v1/task/task_dentist", { method: "PATCH", key: phone.secret, surface: "phone", ip: AWAY, body: { tier: "public" } });
    const lowerArea = await call(app, "/api/v1/area/area_family", { method: "PATCH", key: phone.secret, surface: "phone", ip: AWAY, body: { properties: { child_tier: "public" } } });
    expect([lowerRow.status, lowerArea.status]).toEqual([404, 404]);
    expect((await today(AWAY)).text).not.toContain("Luca");

    // A new secret for the phone keeps Hide.
    const rotated = await call(app, `/api/v1/credentials/${phone.id}/rotate`, { method: "POST", key: phone.secret, surface: "phone", ip: AWAY });
    expect(rotated.status).toBe(200);
    const next = rotated.json as { id: string; secret: string };
    expect((await today(AWAY, phone.secret)).status).toBe(401);
    expect((await today(AWAY, next.secret)).text).not.toContain("Luca");
    expect(audit(app, "panic_clear")).toEqual([]);

    // The owner key on the mini ends Hide, and the audit log has a row for it.
    const owner = (await call(app, "/api/v1/me", { key: app.secrets!.owner })).json as { credential: { id: string } };
    expect((await call(app, "/api/v1/panic/clear", { method: "POST", key: app.secrets!.owner, ip: AWAY, body: { id: next.id } })).status).toBe(403);
    const shown = await call(app, "/api/v1/panic/clear", { method: "POST", key: app.secrets!.owner, ip: MINI, body: { id: next.id } });
    expect(shown.status).toBe(200);
    expect((await today(AWAY, next.secret)).text).toContain("Luca");
    expect(audit(app, "panic_clear")).toEqual([{ actor: owner.credential.id, entity_id: next.id }]);
  } finally {
    app.close();
  }
});

test("the keys that a phone made are revoked with the phone, and the phone cannot take their secrets", async () => {
  const app = testApp();
  try {
    const phone = await pairPhone(app, "Old phone");
    const other = await pairPhone(app, "Other phone");
    // The phone makes two keys. On the mini the answer has the key itself, so that this test can use it.
    const make = async (secret: string, name: string, scope?: string) => {
      const reply = await call(app, "/api/v1/keys", { method: "POST", key: secret, surface: "phone", ip: MINI, body: scope ? { name, scope } : { name } });
      expect(reply.status).toBe(201);
      return reply.json as { id: string; token: string; made_by: { id: string; name: string } | null };
    };
    const research = await make(phone.secret, "research");
    const kitchen = await make(phone.secret, "kitchen", "read");
    const errands = await make(other.secret, "errands");
    const ownerKey = await make(app.secrets!.owner, "mine");
    expect(research.made_by).toEqual({ id: phone.id, name: "Old phone" });
    const listed = (await call(app, "/api/v1/keys", { key: app.secrets!.owner, surface: "phone" })).json as { keys: Array<{ id: string; made_by: { name: string } | null }> };
    expect(listed.keys.find((key) => key.id === kitchen.id)?.made_by?.name).toBe("Old phone");

    // A phone on the network asks for a new secret for the key. Before this change the answer had the secret.
    const taken = await call(app, `/api/v1/credentials/${research.id}/rotate`, { method: "POST", key: phone.secret, surface: "phone", ip: AWAY });
    expect(taken.status).toBe(403);
    expect(taken.text).not.toContain("hmn_");
    const me = (token: string) => call(app, "/api/v1/me", { key: token, ip: MINI });
    expect((await me(research.token)).status).toBe(200);

    // The phone gets a new secret for itself. Its keys now belong to the new credential.
    const rotated = (await call(app, `/api/v1/credentials/${phone.id}/rotate`, { method: "POST", key: phone.secret, surface: "phone", ip: AWAY })).json as { id: string; secret: string };

    const revoked = await call(app, `/api/v1/devices/${rotated.id}/revoke`, { method: "POST", key: app.secrets!.owner, surface: "phone" });
    expect(revoked.status).toBe(200);
    const also = (revoked.json as { also_revoked: Array<{ id: string; name: string }> }).also_revoked;
    expect(also.map((item) => item.name).sort()).toEqual(["kitchen", "research"]);
    expect((await me(rotated.secret)).status).toBe(401);
    expect((await me(research.token)).status).toBe(401);
    expect((await me(kitchen.token)).status).toBe(401);
    // The keys of another phone and of the owner key stay, and so does the other phone.
    expect((await me(errands.token)).status).toBe(200);
    expect((await me(ownerKey.token)).status).toBe(200);
    expect((await me(other.secret)).status).toBe(200);
    expect(audit(app, "revoke").map((row) => row.entity_id).sort()).toEqual([kitchen.id, research.id, rotated.id].sort());
  } finally {
    app.close();
  }
});

test("the key of an outside client works on the outside port only, also after a new secret", async () => {
  const app = testApp();
  try {
    await call(app, "/api/v1/external/enable", { method: "POST", key: app.secrets!.owner, ip: MINI });
    const minted = (await call(app, "/api/v1/external/clients", { method: "POST", key: app.secrets!.owner, ip: MINI, body: { name: "Mara", guest: true, free_busy: true } })).json as { id: string; token: string };
    const init = { jsonrpc: "2.0", id: 1, method: "initialize" };
    expect((await outside(app, "/external/mcp", { method: "POST", token: minted.token, body: init })).status).toBe(200);

    // The main port has no fence and no rate limit. Before this change the token worked there, also after "disable".
    expect((await call(app, "/api/v1/me", { key: minted.token, ip: AWAY })).status).toBe(401);
    expect((await call(app, "/mcp", { method: "POST", key: minted.token, ip: AWAY, body: init })).status).toBe(401);
    expect((await call(app, "/api/v1/task", { key: minted.token, ip: AWAY })).status).toBe(401);
    // A token on the wrong port is not a guess. Twelve of them do not lock that address.
    for (let i = 0; i < 12; i++) await call(app, "/api/v1/me", { key: minted.token, ip: MINI });
    expect((await call(app, "/api/v1/me", { key: app.secrets!.owner, ip: MINI })).status).toBe(200);

    // The owner gives the client a new secret. It is still an outside client, and still a guest.
    const rotated = await call(app, `/api/v1/credentials/${minted.id}/rotate`, { method: "POST", key: app.secrets!.owner, ip: MINI });
    expect(rotated.status).toBe(200);
    const next = rotated.json as { id: string; secret: string };
    const row = app.store.db.query("SELECT external, guest, free_busy, created_by FROM credentials WHERE id = ?").get(next.id) as Record<string, unknown>;
    const owner = (await call(app, "/api/v1/me", { key: app.secrets!.owner })).json as { credential: { id: string } };
    expect(row).toEqual({ external: 1, guest: 1, free_busy: 1, created_by: owner.credential.id });
    expect((await call(app, "/api/v1/me", { key: next.secret, ip: AWAY })).status).toBe(401);
    expect((await outside(app, "/external/mcp", { method: "POST", token: next.secret, body: init })).status).toBe(200);

    await call(app, "/api/v1/external/disable", { method: "POST", key: app.secrets!.owner, ip: MINI });
    expect((await outside(app, "/external/mcp", { method: "POST", token: next.secret, body: init })).status).toBe(404);
    expect((await call(app, "/mcp", { method: "POST", key: next.secret, ip: AWAY, body: init })).status).toBe(401);
  } finally {
    app.close();
  }
});

test("bad tokens on the outside port do not lock the owner out of the main port", async () => {
  const app = testApp();
  try {
    await call(app, "/api/v1/external/enable", { method: "POST", key: app.secrets!.owner, ip: MINI });
    const minted = (await call(app, "/api/v1/external/clients", { method: "POST", key: app.secrets!.owner, ip: MINI, body: { name: "Grok" } })).json as { token: string };
    const init = { jsonrpc: "2.0", id: 1, method: "initialize" };
    // Behind a tunnel, each outside client has the address of the mini.
    for (let i = 0; i < 8; i++) {
      expect((await outside(app, "/external/mcp", { method: "POST", token: `hmn_bad_${i}`, body: init, ip: MINI })).status).toBe(401);
    }
    // The outside port is locked for that address. This is the cost of a tunnel, and it stays on that port.
    expect((await outside(app, "/external/mcp", { method: "POST", token: minted.token, body: init, ip: MINI })).status).toBe(429);
    // The owner key, the menu bar routes, and the switch for outside clients still answer.
    expect((await call(app, "/api/v1/me", { key: app.secrets!.owner, ip: MINI })).status).toBe(200);
    expect((await call(app, "/api/v1/admin/status", { key: app.secrets!.owner, ip: MINI })).status).toBe(200);
    expect((await call(app, "/api/v1/external/disable", { method: "POST", key: app.secrets!.owner, ip: MINI })).status).toBe(200);

    // The main port still counts its own failures.
    for (let i = 0; i < 8; i++) await call(app, "/api/v1/me", { key: `hmn_bad_${i}`, ip: AWAY });
    expect((await call(app, "/api/v1/me", { key: app.secrets!.owner, ip: AWAY })).status).toBe(429);
    expect((await call(app, "/api/v1/me", { key: app.secrets!.owner, ip: MINI })).status).toBe(200);
  } finally {
    app.close();
  }
});

test("a graph from before this change gets the new columns, and its keys have no maker", async () => {
  const app = testApp();
  try {
    const tables = ["credentials", "pairing_codes", "external_setup_codes", "external_auth_codes"];
    const columns = (table: string) => (app.store.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
    // Make the tables as they were, then run the same steps as a start of the server.
    for (const table of tables) app.store.db.exec(`ALTER TABLE ${table} DROP COLUMN created_by`);
    for (const table of tables) expect(columns(table)).not.toContain("created_by");
    ensureExternalTables(app.store.db);
    ensureApprovalTables(app.store.db);
    for (const table of tables) expect(columns(table)).toContain("created_by");
    const phone = await pairPhone(app);
    expect((await call(app, "/api/v1/me", { key: phone.secret, ip: AWAY })).status).toBe(200);
    const listed = (await call(app, "/api/v1/keys", { key: app.secrets!.owner, surface: "phone" })).json as { keys: Array<{ id: string; made_by: unknown }> };
    // The agent key of the first boot has no maker. A revoke of the owner key does not take it.
    expect(listed.keys.find((key) => key.id === "key_agent")?.made_by ?? null).toBeNull();
  } finally {
    app.close();
  }
});

test("a writer changes only a row that it can read, and cannot open an area above its ceiling", async () => {
  const app = testApp();
  try {
    const owner = { key: app.secrets!.owner, surface: "phone" };
    // The owner key reads up to Private. Health gives its items the Sealed tier.
    const area = await call(app, "/api/v1/area/area_health", { method: "PATCH", ...owner, body: { properties: { child_tier: "public" } } });
    expect(area.status).toBe(404);
    const row = app.store.db.query("SELECT properties FROM entities WHERE id = 'area_health'").get() as { properties: string };
    expect(JSON.parse(row.properties).child_tier).toBe("sealed");
    // A row that the owner key reads can still change, also to a lower tier.
    const lowered = await call(app, "/api/v1/task/task_dentist", { method: "PATCH", ...owner, body: { tier: "personal" } });
    expect(lowered.status).toBe(200);
  } finally {
    app.close();
  }
});

test("a pairing code typed in small letters, with a space or a hyphen, works once", async () => {
  const app = testApp();
  try {
    const made = await call(app, "/api/v1/pairing", { method: "POST", key: app.secrets!.owner, ip: MINI });
    const code = (made.json as { code: string }).code;
    const typed = `${code.slice(0, 4).toLowerCase()} -${code.slice(4).toLowerCase()} `;
    const paired = await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: typed, device_name: "Typed phone" } });
    expect(paired.status).toBe(201);
    // The same code a second time is refused, with a message that says what to do.
    const again = await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code, device_name: "Second phone" } });
    expect(again.status).toBe(401);
    expect((again.json as { error: { message: string } }).error.message).toContain("Make a new one");
  } finally {
    app.close();
  }
});
