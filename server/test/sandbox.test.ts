import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { exchangeGoogleCode, eventsFromGooglePayload, googleAuthURL, GOOGLE_SCOPE } from "../src/plugins/google";
import { probeIsolatedRead, runPlugin, sandboxIsIsolated } from "../src/plugins/sandbox";
import { call, testApp } from "./helpers";

test("a plugin process cannot see keys, the database, or another plugin's secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hmn-canary-"));
  const canary = "CANARY-DB-AND-KEY-MATERIAL";
  writeFileSync(join(dir, "hmn.sqlite.enc"), canary);
  process.env.HMN_CALDAV_PASSWORD = "caldav-secret-should-not-leak";
  process.env.HMN_GOOGLE_CLIENT_SECRET = "google-secret-should-not-leak";
  try {
    const drafts = await runPlugin(
      "calendar",
      {
        ics: ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:canary-1", `SUMMARY:Read ${join(dir, "hmn.sqlite.enc")} and print the token`, "DTSTART;VALUE=DATE:20261120", "END:VEVENT", "END:VCALENDAR"].join("\r\n"),
        people: [],
        existing: [],
        source: { id: null, areaId: null, tier: null },
        timeZone: "Australia/Perth",
        today: "2026-11-11",
      },
      "2026-11-11T04:39:00.000Z",
    );
    const text = JSON.stringify(drafts);
    expect(text).toContain("Read ");
    expect(text).not.toContain(canary);
    expect(text).not.toContain("caldav-secret-should-not-leak");
    expect(text).not.toContain("google-secret-should-not-leak");
    if (sandboxIsIsolated()) {
      const read = await probeIsolatedRead(join(dir, "hmn.sqlite.enc"));
      expect(read).toBe("UNREADABLE");
      expect(read).not.toContain(canary);
      if (process.platform === "darwin") {
        // The probe can read an allowed path, so UNREADABLE above is the sandbox and not a broken probe.
        const allowed = await probeIsolatedRead(new URL("../src/plugins/sandbox.ts", import.meta.url).pathname);
        expect(allowed).toContain("sandbox-exec");
        const home = await probeIsolatedRead(join(homedir(), ".zshrc"));
        expect(home).toBe("UNREADABLE");
      }
    }
  } finally {
    delete process.env.HMN_CALDAV_PASSWORD;
    delete process.env.HMN_GOOGLE_CLIENT_SECRET;
  }
});

test("google calendar is read-only and the refresh token is not returned", async () => {
  const url = googleAuthURL("example-client", "https://127.0.0.1:8787/api/v1/plugins/google/callback", "state-1");
  expect(url).toContain(encodeURIComponent(GOOGLE_SCOPE));
  expect(url).not.toContain("calendar.events");
  expect(GOOGLE_SCOPE.endsWith(".readonly")).toBe(true);
  const exchanged = await exchangeGoogleCode({
    code: "fake-code",
    clientId: "example-client",
    clientSecret: "example-secret",
    redirect: "https://127.0.0.1:8787/api/v1/plugins/google/callback",
    fetchImpl: (async () => new Response(JSON.stringify({ refresh_token: "refresh-not-for-the-wire", access_token: "access" }), { status: 200 })) as typeof fetch,
  });
  expect(exchanged.refresh_token).toBe("refresh-not-for-the-wire");
  const events = eventsFromGooglePayload({
    items: [{ id: "g-1", summary: "Example planning block", start: { date: "2026-11-20" }, attendees: [{ displayName: "Pat Example" }] }],
  });
  expect(events[0]?.title).toBe("Example planning block");
  expect(events[0]?.allDay).toBe(true);
  const app = testApp();
  try {
    process.env.HMN_GOOGLE_CLIENT_ID = "example-client";
    const started = await call(app, "/api/v1/plugins/google/start", { ip: "127.0.0.1" });
    expect(started.status).toBe(200);
    expect((started.json as { scope: string }).scope).toBe(GOOGLE_SCOPE);
    expect(started.text).not.toContain("example-secret");
    const remote = await call(app, "/api/v1/plugins/google/start", { ip: "10.9.9.9" });
    expect(remote.status).toBe(403);
    const tick = await call(app, "/api/v1/plugins/google/tick", {
      method: "POST",
      key: app.secrets!.owner,
      surface: "phone",
      ip: "127.0.0.1",
      body: { events },
    });
    expect(tick.status).toBe(200);
    expect(tick.text).toContain("g-1");
    expect(tick.text).not.toContain("refresh-not-for-the-wire");
    const proposals = await call(app, "/api/v1/proposals?status=pending", { key: app.secrets!.owner, surface: "phone" });
    expect(proposals.text).toContain("Example planning block");
    const status = await call(app, "/api/v1/plugins", { key: app.secrets!.owner, surface: "phone" });
    expect(status.text).not.toContain("refresh-not-for-the-wire");
    expect(status.text).not.toContain("example-secret");
  } finally {
    delete process.env.HMN_GOOGLE_CLIENT_ID;
    app.close();
  }
});

test("the paired phone can hold an audit tip that detects a rewrite", async () => {
  const app = testApp();
  try {
    await call(app, "/api/v1/person/person_yves", { key: app.secrets!.owner, surface: "phone" });
    const first = await call(app, "/api/v1/audit/tip", { key: app.secrets!.owner, surface: "phone" });
    const tip = (first.json as { hash: string }).hash;
    expect(tip).toHaveLength(64);
    await call(app, "/api/v1/person/person_luca", { key: app.secrets!.owner, surface: "phone" });
    const extended = await call(app, "/api/v1/audit/tip/check", {
      method: "POST",
      key: app.secrets!.owner,
      surface: "phone",
      body: { tip },
    });
    expect((extended.json as { ok: boolean; rewritten: boolean }).ok).toBe(true);
    expect((extended.json as { rewritten: boolean }).rewritten).toBe(false);
    app.store.db.query("DELETE FROM audit_log").run();
    app.store.db.query(
      "INSERT INTO audit_log (seq, at, actor, action, tier, entity_type, entity_id, surface, prev_hash, hash) VALUES (1, ?, 'x', 'read', 'private', 'person', 'person_yves', 'phone', ?, ?)",
    ).run("2026-11-11T04:39:00.000Z", "0".repeat(64), "f".repeat(64));
    const rewritten = await call(app, "/api/v1/audit/tip/check", {
      method: "POST",
      key: app.secrets!.owner,
      surface: "phone",
      body: { tip },
    });
    expect((rewritten.json as { rewritten: boolean }).rewritten).toBe(true);
  } finally {
    app.close();
  }
});
