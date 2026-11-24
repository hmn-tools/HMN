// Inputs and outside parties: the cloud path of the workers, the model reply check, calendar feeds, the e-ink setup,
// and the OAuth setup code. Each test starts its own graph. No test opens a socket to another host.
import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { handleExternal } from "../src/external/http";
import { s256 } from "../src/external/clients";
import { fetchIcs } from "../src/plugins/calendar";
import { assertCloudEndpoint, getWorker } from "../src/workers/config";
import { proseIsGrounded } from "../src/workers/guard";
import { clientFor, CLOUD_MAX_CHARS } from "../src/workers/llm";
import { call, testApp } from "./helpers";

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });

test("a worker's cloud call is recorded and capped, and a Private row or a large prompt does not go out", async () => {
  const app = testApp();
  process.env.HMN_LLM_CLOUD_KEY = "test-cloud-key-not-real";
  try {
    const sent: string[] = [];
    const fake = async (url: string) => {
      sent.push(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } });
    };
    const worker = {
      ...getWorker(app.store.db, "morning", new Date().toISOString()),
      llm_mode: "cloud" as const,
      cloud_enabled: true,
      cloud_warning_ack: true,
      cloud_endpoint: "https://api.example.com/v1/chat/completions",
      cloud_tier: "personal" as const,
    };
    const { client } = clientFor(worker, fake as never, app.store.db);
    expect(client.id).toBe("cloud");
    expect(await client.complete("Say one line.", { items: [{ id: "task_1", tier: "personal", title: "Example" }] })).toBe("ok");
    await expect(client.complete("Say one line.", { items: [{ id: "note_p", tier: "private", title: "Example" }] })).rejects.toThrow();
    await expect(client.complete("x".repeat(CLOUD_MAX_CHARS), {})).rejects.toThrow();
    expect(sent.length).toBe(1);
    const rows = app.store.db.query("SELECT blocked, capped, destination FROM model_egress ORDER BY at").all() as Array<{ blocked: number; capped: number; destination: string }>;
    expect(rows).toEqual([
      { blocked: 0, capped: 0, destination: "api.example.com" },
      { blocked: 1, capped: 0, destination: "api.example.com" },
    ]);
    // With no ledger, nothing goes out.
    const bare = clientFor(worker, fake as never).client;
    await expect(bare.complete("Say one line.", {})).rejects.toThrow();
    expect(sent.length).toBe(1);
  } finally {
    delete process.env.HMN_LLM_CLOUD_KEY;
    app.close();
  }
});

test("the cloud host of a worker changes only on the mini, and it is never a host on this network", async () => {
  const app = testApp();
  try {
    const change = (ip: string) =>
      call(app, "/api/v1/workers/morning", { method: "POST", ...owner(app), ip, body: { cloud_endpoint: "https://api.example.com/v1/chat/completions" } });
    expect((await change("10.4.4.4")).status).toBe(403);
    expect((await change("127.0.0.1")).status).toBe(200);
    // A change that does not touch the cloud still works from the phone.
    expect((await call(app, "/api/v1/workers/morning", { method: "POST", ...owner(app), ip: "10.4.4.4", body: { enabled: true } })).status).toBe(200);
    for (const bad of ["https://[::ffff:7f00:1]/v1", "https://[::ffff:192.168.1.2]/v1", "https://[fd00::1]/v1", "https://[fe80::1]/v1", "https://router/v1", "https://nas.lan/v1", "https://box.ts.net/v1", "https://2130706433/v1"]) {
      expect(() => assertCloudEndpoint(bad)).toThrow();
    }
    expect(() => assertCloudEndpoint("https://api.example.com/v1")).not.toThrow();
  } finally {
    app.close();
  }
});

test("a model reply with a link, or with a word in another script that the notes do not have, is not used", () => {
  const corpus = "Book the dentist for Luca. See https://example.com/form. Встреча в пятницу.";
  expect(proseIsGrounded("Book the dentist for Luca.", corpus)).toBe(true);
  expect(proseIsGrounded("Встреча в пятницу.", corpus)).toBe(true);
  expect(proseIsGrounded("See https://example.com/form", corpus)).toBe(false);
  expect(proseIsGrounded("Book the dentist at www.example.com", corpus)).toBe(false);
  expect(proseIsGrounded("Book the dentist. Пароль сегодня.", corpus)).toBe(false);
});

test("a calendar is read only from an https address on the internet, with a size limit, and a key cannot set the address", async () => {
  const app = testApp();
  try {
    for (const url of ["http://cal.example.com/a.ics", "https://127.0.0.1/a.ics", "https://192.168.1.5/a.ics", "webcal://router/a.ics", "file:///etc/hosts"]) {
      expect((await call(app, "/api/v1/calendars", { method: "POST", ...owner(app), body: { title: "Feed", url } })).status).toBe(422);
    }
    expect((await call(app, "/api/v1/calendars", { method: "POST", ...owner(app), body: { title: "Feed", url: "webcal://cal.example.com/a.ics" } })).status).toBe(201);
    const planted = await call(app, "/api/v1/proposals", {
      method: "POST",
      key: app.secrets!.agent,
      surface: "mcp",
      body: { op: "create", payload: { op: "create", entity: { type: "source", kind: "calendar", title: "Friendly calendar", properties: { url: "https://cal.example.com/x.ics" } } } },
    });
    expect(planted.status).toBe(422);
    const big = async () => new Response("B".repeat(2_100_000));
    await expect(fetchIcs("https://cal.example.com/a.ics", null, null, big as never)).rejects.toThrow("too large");
    await expect(fetchIcs("https://10.0.0.8/a.ics", null, null, big as never)).rejects.toThrow("internet");
    // The owner's own CalDAV server on this network is allowed.
    const small = async () => new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
    expect(await fetchIcs("https://10.0.0.8/a.ics", null, null, small as never, { allowLocal: true })).toContain("VCALENDAR");
    // The sync route no longer fails with 500.
    expect((await call(app, "/api/v1/calendars/sync", { method: "POST", key: app.secrets!.agent, surface: "mcp" })).status).toBe(403);
  } finally {
    app.close();
  }
});

test("a family date from a subscribed feed waits for the owner, also on a calendar set to auto", async () => {
  const app = testApp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:feed-family", "SUMMARY:Example dinner", "DTSTART;VALUE=DATE:20261111", "ATTENDEE;CN=Yves:mailto:yves@example.com", "END:VEVENT", "END:VCALENDAR"].join("\r\n"),
    )) as unknown as typeof fetch;
  try {
    const made = await call(app, "/api/v1/calendars", { method: "POST", ...owner(app), body: { title: "Feed", url: "https://cal.example.com/feed.ics", approval: "auto" } });
    const id = (made.json as { id: string }).id;
    const ticked = await call(app, "/api/v1/plugins/calendar/tick", { method: "POST", ...owner(app), ip: "127.0.0.1", body: { source_id: id } });
    expect(ticked.status).toBe(200);
    const proposals = (ticked.json as { proposals: Array<{ status: string }> }).proposals;
    expect(proposals.map((item) => item.status)).toEqual(["pending"]);
    expect(app.store.db.query("SELECT id FROM entities WHERE external_id = 'feed-family'").get()).toBeNull();
  } finally {
    globalThis.fetch = realFetch;
    app.close();
  }
});

test("a display key goes only to the address that asked first, and a second address blocks the pairing", async () => {
  const app = testApp();
  try {
    const setup = async (mac: string, ip: string, extra: Record<string, string> = {}) => {
      const response = await app.fetch(new Request("https://hmn.local/api/setup", { headers: { ID: mac, ...extra } }), ip);
      return (await response.json()) as { api_key: string | null; friendly_id: string; message: string };
    };
    const claim = (friendly: string) =>
      call(app, `/api/v1/trmnl/devices/${friendly}/claim`, { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1", body: { name: "Kitchen" } });

    // The display asks, the owner claims, and the display gets its key.
    const first = await setup("41:B4:10:39:A1:01", "10.0.0.21", { Model: "m".repeat(300) });
    expect((app.store.db.query("SELECT model FROM trmnl_devices WHERE friendly_id = ?").get(first.friendly_id) as { model: string }).model.length).toBe(40);
    expect((await claim(first.friendly_id)).status).toBe(200);
    expect((await setup("41:B4:10:39:A1:01", "10.0.0.66")).api_key).toBeNull();
    // The other address asked too, so the pairing is blocked, also for the real display.
    const blocked = await setup("41:B4:10:39:A1:01", "10.0.0.21");
    expect(blocked.api_key).toBeNull();
    expect(blocked.message).toContain("Two machines");

    // A clean pairing: one address.
    const second = await setup("41:B4:10:39:A1:02", "10.0.0.22");
    expect((await claim(second.friendly_id)).status).toBe(200);
    expect((await setup("41:B4:10:39:A1:02", "10.0.0.22")).api_key?.startsWith("hmn_")).toBe(true);

    // An attacker who asks first: the owner sees the block when claiming.
    await setup("41:B4:10:39:A1:03", "10.0.0.66");
    const third = await setup("41:B4:10:39:A1:03", "10.0.0.23");
    expect((await claim(third.friendly_id)).status).toBe(409);
  } finally {
    app.close();
  }
});

test("the OAuth setup code is long, wrong codes close the form for a while, and the form names the client", async () => {
  const app = testApp();
  try {
    await call(app, "/api/v1/external/enable", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
    const made = await call(app, "/api/v1/external/setup-codes", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1", body: { ceiling: "personal" } });
    const code = (made.json as { code: string }).code;
    expect(code).toMatch(/^[A-Z2-9]{12}$/);
    const outside = async (path: string, init: RequestInit) => {
      const response = await handleExternal(app.hmn, new Request(`https://hmn.local${path}`, init), "203.0.113.8");
      return { status: response.status, text: await response.text() };
    };
    const registered = await outside("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "<b>OpenBot</b>", redirect_uris: ["http://127.0.0.1:9/callback"] }),
    });
    const clientId = (JSON.parse(registered.text) as { client_id: string }).client_id;
    const page = await outside(`/oauth/authorize?client_id=${clientId}&redirect_uri=http://127.0.0.1:9/callback`, { method: "GET" });
    expect(page.text).toContain("&lt;b&gt;OpenBot&lt;/b&gt;");
    const form = (setup: string) =>
      outside("/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, redirect_uri: "http://127.0.0.1:9/callback", code_challenge: s256("verifier-verifier-verifier-verifier"), code_challenge_method: "S256", setup_code: setup }).toString(),
      });
    for (let i = 0; i < 10; i++) expect((await form(`WRONGCODE${i}AB`)).status).toBe(401);
    // The right code is refused too while the form is closed.
    expect((await form(code)).status).toBe(429);
  } finally {
    app.close();
  }
});
