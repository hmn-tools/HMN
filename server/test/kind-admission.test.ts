// A proposal that names a kind the type does not have stays pending. The owner adds the kind
// (with a role only when they choose one) or picks a kind that exists, then approves. The
// server never invents a kind or a role.
import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { call, testApp } from "./helpers";

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });
const agent = (app: App) => ({ key: app.secrets!.agent, surface: "mcp" });

async function propose(app: App, entity: Record<string, unknown>) {
  const reply = await call(app, "/api/v1/proposals", {
    method: "POST",
    ...agent(app),
    agent: "test-agent",
    body: { op: "create", entity, reason: "A test." },
  });
  expect(reply.status).toBe(201);
  return reply.json as {
    id: string;
    status: string;
    summary: { warning: string | null };
    kind_admission?: {
      type: string;
      type_title: string;
      kind: string;
      title: string;
      needs_role: boolean;
      roles: string[];
      existing: Array<{ kind: string; title: string }>;
    };
  };
}

test("a missing kind stays pending, warns, and does not appear on approve", async () => {
  const app = testApp();
  try {
    const proposal = await propose(app, { type: "asset", title: "Example studio computer", kind: "computer", tier: "personal" });
    expect(proposal.status).toBe("pending");
    expect(proposal.summary.warning).toMatch(/Computer is not a kind of Asset yet/);
    expect(proposal.kind_admission).toMatchObject({ type: "asset", type_title: "Asset", kind: "computer", title: "Computer", needs_role: false });
    expect(proposal.kind_admission!.existing.some((item) => item.kind === "other")).toBe(true);
    const approved = await call(app, `/api/v1/proposals/${proposal.id}/approve`, { method: "POST", ...owner(app) });
    expect(approved.status).toBe(422);
    expect((approved.json as { error: { code: string; message: string } }).error.code).toBe("bad_kind");
    expect((approved.json as { error: { message: string } }).error.message).toBe("That kind is not valid for this type. Add the kind first.");
    const listed = await call(app, "/api/v1/proposals?status=pending", owner(app));
    const ids = ((listed.json as { proposals: Array<{ id: string }> }).proposals ?? []).map((item) => item.id);
    expect(ids).toContain(proposal.id);
    const kinds = await call(app, "/api/v1/kinds", owner(app));
    const names = ((kinds.json as { kinds: Array<{ type: string; kind: string }> }).kinds).map((row) => `${row.type}:${row.kind}`);
    expect(names).not.toContain("asset:computer");
  } finally {
    app.close();
  }
});

test("the owner can add an asset kind with no role and approve in one step", async () => {
  const app = testApp();
  try {
    const proposal = await propose(app, { type: "asset", title: "Example studio computer", kind: "computer", tier: "personal" });
    const admitted = await call(app, `/api/v1/proposals/${proposal.id}/admit-kind`, {
      method: "POST",
      ...owner(app),
      body: { add: true },
    });
    expect(admitted.status).toBe(200);
    expect((admitted.json as { status: string }).status).toBe("approved");
    const kinds = await call(app, "/api/v1/kinds", owner(app));
    const computer = ((kinds.json as { kinds: Array<{ type: string; kind: string; role: string | null; title: string }> }).kinds).find(
      (row) => row.type === "asset" && row.kind === "computer",
    );
    expect(computer).toMatchObject({ title: "Computer", role: null });
    const assets = await call(app, "/api/v1/asset", owner(app));
    const titles = ((assets.json as { entities?: Array<{ title: string; kind: string }> }).entities ?? (assets.json as Array<{ title: string; kind: string }>));
    const list = Array.isArray(titles) ? titles : [];
    // list endpoint shape
    const rows = "entities" in (assets.json as object) ? (assets.json as { entities: Array<{ title: string; kind: string }> }).entities : (assets.json as Array<{ title: string; kind: string }>);
    expect(JSON.stringify(assets.json)).toContain("Example studio computer");
    expect(JSON.stringify(assets.json)).toContain("computer");
    void list;
    void rows;
  } finally {
    app.close();
  }
});

test("the owner can retarget a missing kind to one that exists, without adding the new word", async () => {
  const app = testApp();
  try {
    const proposal = await propose(app, { type: "asset", title: "Example mixer", kind: "audio", tier: "personal" });
    const admitted = await call(app, `/api/v1/proposals/${proposal.id}/admit-kind`, {
      method: "POST",
      ...owner(app),
      body: { use: "other" },
    });
    expect(admitted.status).toBe(200);
    expect((admitted.json as { status: string }).status).toBe("approved");
    const kinds = await call(app, "/api/v1/kinds", owner(app));
    const names = ((kinds.json as { kinds: Array<{ type: string; kind: string }> }).kinds).map((row) => `${row.type}:${row.kind}`);
    expect(names).not.toContain("asset:audio");
    expect(JSON.stringify((await call(app, "/api/v1/asset", owner(app))).json)).toContain("\"kind\":\"other\"");
  } finally {
    app.close();
  }
});

test("a person kind needs an explicit role or no role, and the server does not guess", async () => {
  const app = testApp();
  try {
    const proposal = await propose(app, { type: "person", title: "Example neighbour", kind: "neighbour", tier: "personal" });
    expect(proposal.kind_admission).toMatchObject({ type: "person", needs_role: true });
    expect(proposal.kind_admission!.roles).toContain("family");
    const guessed = await call(app, `/api/v1/proposals/${proposal.id}/admit-kind`, {
      method: "POST",
      ...owner(app),
      body: { add: true },
    });
    expect(guessed.status).toBe(422);
    expect((guessed.json as { error: { code: string } }).error.code).toBe("need_role");
    const still = await call(app, "/api/v1/proposals?status=pending", owner(app));
    expect(JSON.stringify(still.json)).toContain(proposal.id);
    const kindsBefore = ((await call(app, "/api/v1/kinds", owner(app))).json as { kinds: Array<{ type: string; kind: string }> }).kinds.map((row) => `${row.type}:${row.kind}`);
    expect(kindsBefore).not.toContain("person:neighbour");
    const admitted = await call(app, `/api/v1/proposals/${proposal.id}/admit-kind`, {
      method: "POST",
      ...owner(app),
      body: { add: true, role: null },
    });
    expect(admitted.status).toBe(200);
    expect((admitted.json as { status: string }).status).toBe("approved");
    const kinds = ((await call(app, "/api/v1/kinds", owner(app))).json as { kinds: Array<{ type: string; kind: string; role: string | null }> }).kinds;
    expect(kinds.find((row) => row.type === "person" && row.kind === "neighbour")).toMatchObject({ role: null });
  } finally {
    app.close();
  }
});

test("an event kind can take a chosen role, and a guessed fixture role is refused", async () => {
  const app = testApp();
  try {
    const proposal = await propose(app, { type: "event", title: "Example club night", kind: "club_night", status: "upcoming", due_at: "2026-11-20T10:00:00.000Z", tier: "personal" });
    expect(proposal.kind_admission).toMatchObject({ type: "event", needs_role: true, kind: "club_night", title: "Club night" });
    const missing = await call(app, `/api/v1/proposals/${proposal.id}/admit-kind`, { method: "POST", ...owner(app), body: { add: true } });
    expect(missing.status).toBe(422);
    const admitted = await call(app, `/api/v1/proposals/${proposal.id}/admit-kind`, {
      method: "POST",
      ...owner(app),
      body: { add: true, role: "fixture" },
    });
    expect(admitted.status).toBe(200);
    const kinds = ((await call(app, "/api/v1/kinds", owner(app))).json as { kinds: Array<{ type: string; kind: string; role: string | null }> }).kinds;
    expect(kinds.find((row) => row.type === "event" && row.kind === "club_night")).toMatchObject({ role: "fixture" });
  } finally {
    app.close();
  }
});
