// The Household tier: between Public and Personal. The people of the home, the owner's lock and StandBy widgets,
// and the owner's other surfaces read it. A guest agent and a Public display do not. Each test starts its own graph.
import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { handleExternal } from "../src/external/http";
import { covers, TIERS } from "../src/types";
import { call, testApp } from "./helpers";

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });

async function note(app: App, title: string, body: Record<string, unknown>) {
  const made = await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title, body: "Fictional text.", ...body } });
  expect(made.status).toBe(201);
  return (made.json as { id: string; tier: string }).id;
}

async function makeKey(app: App, body: Record<string, unknown>) {
  const made = await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body });
  expect(made.status).toBe(201);
  return made.json as { id: string; token: string; ceiling: string };
}

test("Household sits between Public and Personal", () => {
  expect(TIERS).toEqual(["public", "household", "personal", "private", "sealed"]);
  expect(covers("personal", "household")).toBe(true);
  expect(covers("household", "public")).toBe(true);
  expect(covers("public", "household")).toBe(false);
  expect(covers("household", "personal")).toBe(false);
});

test("each reader sees a Household row, or does not, by its ceiling", async () => {
  const app = testApp();
  try {
    const home = await note(app, "Example bins night", { tier: "household" });
    const mine = await note(app, "Example personal plan", { tier: "personal" });
    const read = (key: string, surface: string, id: string) => call(app, `/api/v1/note/${id}`, { key, surface });

    // The owner's phone, widget, and lock screen read it. A Public display does not.
    expect((await read(app.secrets!.owner, "phone", home)).status).toBe(200);
    expect((await read(app.secrets!.owner, "widget", home)).status).toBe(200);
    expect((await read(app.secrets!.owner, "lock", home)).status).toBe(200);
    expect((await read(app.secrets!.owner, "lock", mine)).status).toBe(404);
    expect((await read(app.secrets!.owner, "display", home)).status).toBe(404);
    // The display key of the first boot is Public.
    expect((await read(app.secrets!.display, "api", home)).status).toBe(404);
    // An agent key at Personal reads it.
    expect((await read(app.secrets!.agent, "mcp", home)).status).toBe(200);

    // A view key for the home reads Household and not Personal. A Public view key reads neither.
    const fridge = await makeKey(app, { name: "fridge", scope: "read", ceiling: "household" });
    expect(fridge.ceiling).toBe("household");
    expect((await read(fridge.token, "api", home)).status).toBe(200);
    expect((await read(fridge.token, "api", mine)).status).toBe(404);
    const hall = await makeKey(app, { name: "hall", scope: "read" });
    expect(hall.ceiling).toBe("public");
    expect((await read(hall.token, "api", home)).status).toBe(404);

    // An agent key made at Household stays there, and it cannot get the Private grant.
    const helper = await makeKey(app, { name: "helper", ceiling: "household" });
    expect((await read(helper.token, "mcp", home)).status).toBe(200);
    expect((await read(helper.token, "mcp", mine)).status).toBe(404);
    const grant = await call(app, `/api/v1/keys/${helper.id}/private`, { method: "POST", ...owner(app), body: { days: 7, understood: true } });
    expect(grant.status).toBe(409);
  } finally {
    app.close();
  }
});

test("a guest agent does not read Household, and an outside client at Household does", async () => {
  const app = testApp();
  try {
    const home = await note(app, "Example dinner plan", { tier: "household" });
    await call(app, "/api/v1/external/enable", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
    const mint = async (body: Record<string, unknown>) =>
      (await call(app, "/api/v1/external/clients", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1", body })).json as { token: string; ceiling: string };
    const post = (token: string, body: unknown, session?: string) =>
      handleExternal(
        app.hmn,
        new Request("https://hmn.local/external/mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}) },
          body: JSON.stringify(body),
        }),
        "203.0.113.4",
      );
    // An outside client opens a session first, then calls a tool in it.
    const ask = async (token: string) => {
      const opened = await post(token, { jsonrpc: "2.0", id: 1, method: "initialize" });
      const session = opened.headers.get("mcp-session-id") ?? "";
      const answer = await post(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_entity", arguments: { type: "note", id: home } } }, session);
      return answer.text();
    };
    const guest = await mint({ name: "Mara", guest: true });
    expect(guest.ceiling).toBe("public");
    expect(await ask(guest.token)).not.toContain("Example dinner plan");
    const family = await mint({ name: "Family helper", ceiling: "household" });
    expect(family.ceiling).toBe("household");
    expect(await ask(family.token)).toContain("Example dinner plan");
  } finally {
    app.close();
  }
});

test("a capture tagged #household, and an item in a Household area, are Household", async () => {
  const app = testApp();
  try {
    const captured = await call(app, "/api/v1/inbox", { method: "POST", ...owner(app), body: { text: "Buy milk #household" } });
    expect(captured.status).toBe(201);
    expect((captured.json as { tier: string }).tier).toBe("household");

    const area = await call(app, "/api/v1/area", { method: "POST", ...owner(app), body: { title: "Example home", kind: "home", properties: { child_tier: "household" } } });
    expect(area.status).toBe(201);
    const areaId = (area.json as { id: string }).id;
    const filed = await note(app, "Example chore list", { area_id: areaId });
    const got = (await call(app, `/api/v1/note/${filed}`, owner(app))).json as { tier: string; tier_source: string };
    expect(got).toMatchObject({ tier: "household", tier_source: "area" });
  } finally {
    app.close();
  }
});

test("a household fixture shows on the lock screen, and a personal one does not", async () => {
  const app = testApp();
  try {
    const fixture = (title: string, tier: string) =>
      call(app, "/api/v1/event", {
        method: "POST",
        ...owner(app),
        body: { title, kind: "fixture", status: "upcoming", tier, due_at: "2026-11-11T10:00:00.000Z" },
      });
    expect((await fixture("Example school match", "household")).status).toBe(201);
    expect((await call(app, "/api/v1/event", {
      method: "POST",
      ...owner(app),
      body: { title: "Example private rehearsal", kind: "fixture", status: "upcoming", tier: "personal", due_at: "2026-11-11T09:00:00.000Z" },
    })).status).toBe(201);
    const lock = await call(app, "/api/v1/screens/lock", { ...owner(app), surface: "lock" });
    expect(lock.status).toBe(200);
    const body = lock.json as { ceiling: string; next: { title: string } | null; subtitle: string };
    expect(body.ceiling).toBe("household");
    expect(JSON.stringify(lock.json)).toContain("Example school match");
    expect(JSON.stringify(lock.json)).not.toContain("Example private rehearsal");
    expect(body.next?.title).toBe("Example school match");
    const display = await call(app, "/api/v1/screens/today", { key: app.secrets!.display, surface: "display" });
    expect(JSON.stringify(display.json)).not.toContain("Example school match");
    expect(JSON.stringify(display.json)).not.toContain("Example private rehearsal");
  } finally {
    app.close();
  }
});
