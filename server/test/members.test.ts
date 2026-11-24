// Household members: a person of the home with a phone and a role. A partner reads Household, and the Family area
// at Private on the phone. A child reads Household. A member's write is applied at once, with an undo, or it waits
// for the owner, by the rules of the role. docs/ONTOLOGY.md, section 5.4. All data is fictional.
import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { call, testApp } from "./helpers";

const MINI = "127.0.0.1";
const AWAY = "10.7.7.8";

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });

type View = { id: string; title: string; status: string; tier: string; properties: Record<string, unknown> };

async function pairPhone(app: App) {
  const made = await call(app, "/api/v1/pairing", { method: "POST", key: app.secrets!.owner, ip: MINI });
  const paired = await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: (made.json as { code: string }).code, device_name: "Example phone" } });
  expect(paired.status).toBe(201);
  const body = paired.json as { secret: string; credential: { id: string } };
  return { secret: body.secret, id: body.credential.id };
}

/** Pair a member's phone. The seed has Sam (spouse) and Yves (child) in the Family area. */
async function pairMember(app: App, personId: string, role: string, key = app.secrets!.owner) {
  const made = await call(app, "/api/v1/members/pairing", { method: "POST", key, surface: "phone", ip: AWAY, body: { person_id: personId, role } });
  expect(made.status).toBe(201);
  const paired = await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: (made.json as { code: string }).code, device_name: "Example member phone" } });
  expect(paired.status).toBe(201);
  const body = paired.json as { secret: string; credential: { id: string; scope: string }; member: { role: string; name: string } };
  expect(body.credential.scope).toBe("agent");
  return { secret: body.secret, id: body.credential.id, member: body.member };
}

async function make(app: App, type: string, body: Record<string, unknown>) {
  const made = await call(app, `/api/v1/${type}`, { method: "POST", ...owner(app), body });
  expect(made.status).toBe(201);
  return made.json as View;
}

const as = (secret: string, surface = "phone") => ({ key: secret, surface, ip: AWAY });

test("a partner reads Household and the Family area at Private, on the phone only, and a child reads Household", async () => {
  const app = testApp();
  try {
    const home = await make(app, "note", { title: "Example bins night", body: "Fictional.", tier: "household" });
    const work = await make(app, "note", { title: "Example work plan", body: "Fictional.", tier: "personal" });
    const mine = await make(app, "note", { title: "Example private plan", body: "Fictional.", tier: "private" });
    const school = await make(app, "note", { title: "Example school form", body: "Fictional.", area_id: "area_family" });
    expect(school.tier).toBe("private");
    const sealed = await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title: "Example allergy source", body: "Fictional.", area_id: "area_family", tier: "sealed" } });
    const sealedId = (sealed.json as { id?: string }).id ?? "note_missing";

    const sam = await pairMember(app, "person_sam", "partner");
    expect(sam.member).toMatchObject({ role: "partner", name: "Sam" });
    const read = (secret: string, id: string, surface = "phone") => call(app, `/api/v1/note/${id}`, as(secret, surface)).then((r) => r.status);
    expect(await read(sam.secret, home.id)).toBe(200);
    expect(await read(sam.secret, school.id)).toBe(200);
    expect(await read(sam.secret, work.id)).toBe(404);
    expect(await read(sam.secret, mine.id)).toBe(404);
    expect(await read(sam.secret, sealedId)).toBe(404);
    // The raise is for the phone. A widget of the partner shows Household only.
    expect(await read(sam.secret, school.id, "widget")).toBe(404);
    expect(await read(sam.secret, home.id, "widget")).toBe(200);
    // The children are in the Family area, so the partner reads them. The owner's own person is Personal.
    expect((await call(app, "/api/v1/person/person_yves", as(sam.secret))).status).toBe(200);
    expect((await call(app, "/api/v1/person/person_alex", as(sam.secret))).status).toBe(404);

    const yves = await pairMember(app, "person_yves", "child");
    expect(await read(yves.secret, home.id)).toBe(200);
    expect(await read(yves.secret, school.id)).toBe(404);
    expect((await call(app, "/api/v1/person/person_luca", as(yves.secret))).status).toBe(404);

    // Hide on the partner's phone ends the raise, and the ceiling falls to Public.
    expect((await call(app, "/api/v1/panic", { method: "POST", ...as(sam.secret) })).status).toBe(200);
    expect(await read(sam.secret, school.id)).toBe(404);
    expect(await read(sam.secret, home.id)).toBe(404);
  } finally {
    app.close();
  }
});

test("a partner's add and tick are applied with an undo, and the record keeps the partner's name", async () => {
  const app = testApp();
  try {
    const list = await make(app, "project", { title: "Example groceries", kind: "list", status: "active", tier: "household" });
    const sam = await pairMember(app, "person_sam", "partner");

    const added = await call(app, "/api/v1/items", { method: "POST", ...as(sam.secret), body: { parent_id: list.id, title: "Example milk" } });
    expect(added.status).toBe(200);
    const item = (added.json as { status: string; entity: View }).entity;
    expect(item).toMatchObject({ title: "Example milk", tier: "household" });

    const ticked = await call(app, `/api/v1/task/${item.id}`, { method: "PATCH", ...as(sam.secret), body: { status: "done" } });
    expect(ticked.status).toBe(200);
    const done = (await call(app, `/api/v1/task/${item.id}`, owner(app))).json as View;
    expect(done.properties).toMatchObject({ done_by: "Sam" });

    // The owner sees the tick in Activity, and can undo it.
    const activity = (await call(app, "/api/v1/activity", owner(app))).json as { activity: Array<{ id: string; can_undo: boolean; source_name: string | null; op: string }> };
    const tick = activity.activity.find((entry) => entry.op === "update");
    expect(tick).toMatchObject({ can_undo: true, source_name: "Sam" });
    const undone = await call(app, `/api/v1/proposals/${tick!.id}/undo`, { method: "POST", ...owner(app) });
    expect(undone.status).toBe(200);
    expect(((await call(app, `/api/v1/task/${item.id}`, owner(app))).json as View).status).toBe("open");

    // A family task in the Family area is within the partner's reach, and it is applied.
    const task = await call(app, "/api/v1/task", { method: "POST", ...as(sam.secret), body: { title: "Example renew a passport", kind: "task", status: "open", area_id: "area_family" } });
    expect(task.status).toBe(200);
    const taskView = (task.json as { entity: View }).entity;
    expect(taskView.tier).toBe("private");

    // A change of area, and a removal, wait for the owner. A tier that makes a row more visible is refused, as for every key.
    expect((await call(app, `/api/v1/task/${item.id}`, { method: "PATCH", ...as(sam.secret), body: { area_id: "area_family" } })).status).toBe(202);
    expect((await call(app, `/api/v1/task/${item.id}`, { method: "PATCH", ...as(sam.secret), body: { tier: "private" } })).status).toBe(403);
    expect((await call(app, `/api/v1/task/${taskView.id}`, { method: "PATCH", ...as(sam.secret), body: { tier: "household" } })).status).toBe(422);
    expect((await call(app, `/api/v1/task/${item.id}`, { method: "DELETE", ...as(sam.secret) })).status).toBe(202);
    expect(((await call(app, `/api/v1/task/${item.id}`, owner(app))).status)).toBe(200);
    // A partner cannot write above its reach, or Sealed.
    expect((await call(app, "/api/v1/note", { method: "POST", ...as(sam.secret), body: { title: "Example", body: "Fictional.", tier: "private" } })).status).toBe(403);
    expect((await call(app, "/api/v1/note", { method: "POST", ...as(sam.secret), body: { title: "Example", body: "Fictional.", area_id: "area_family", tier: "sealed" } })).status).toBe(403);
  } finally {
    app.close();
  }
});

test("a child adds and ticks on a list, ticks a task for the child, and all else waits", async () => {
  const app = testApp();
  try {
    const list = await make(app, "project", { title: "Example groceries", kind: "list", status: "active", tier: "household" });
    const forYves = await make(app, "task", { title: "Example pack the bag", kind: "task", status: "open", tier: "household" });
    expect((await call(app, "/api/v1/links", { method: "POST", ...owner(app), body: { from_type: "task", from_id: forYves.id, to_type: "person", to_id: "person_yves", rel: "for" } })).status).toBe(201);
    const notForYves = await make(app, "task", { title: "Example book the plumber", kind: "task", status: "open", tier: "household" });
    const yves = await pairMember(app, "person_yves", "child");

    const added = await call(app, "/api/v1/items", { method: "POST", ...as(yves.secret), body: { parent_id: list.id, title: "Example apples" } });
    expect(added.status).toBe(200);
    const item = (added.json as { entity: View }).entity;
    expect((await call(app, `/api/v1/task/${item.id}`, { method: "PATCH", ...as(yves.secret), body: { status: "done" } })).status).toBe(200);
    expect(((await call(app, `/api/v1/task/${item.id}`, owner(app))).json as View).properties.done_by).toBe("Yves");

    expect((await call(app, `/api/v1/task/${forYves.id}`, { method: "PATCH", ...as(yves.secret), body: { status: "done" } })).status).toBe(200);
    // A step of a task for the child is the child's to add and tick.
    const step = await call(app, "/api/v1/items", { method: "POST", ...as(yves.secret), body: { parent_id: forYves.id, title: "Example shoes" } });
    expect(step.status).toBe(200);

    expect((await call(app, `/api/v1/task/${notForYves.id}`, { method: "PATCH", ...as(yves.secret), body: { status: "done" } })).status).toBe(202);
    expect(((await call(app, `/api/v1/task/${notForYves.id}`, owner(app))).json as View).status).toBe("open");
    // A tick with another field is not a tick.
    expect((await call(app, `/api/v1/task/${forYves.id}`, { method: "PATCH", ...as(yves.secret), body: { status: "open", title: "Example renamed" } })).status).toBe(202);
    // A new household date waits. A removal waits.
    expect((await call(app, "/api/v1/event", { method: "POST", ...as(yves.secret), body: { title: "Example sleepover", due_at: "2026-11-20T10:00:00.000Z", status: "upcoming", kind: "appointment" } })).status).toBe(202);
    expect((await call(app, `/api/v1/task/${item.id}`, { method: "DELETE", ...as(yves.secret) })).status).toBe(202);
    // The owner sees each wait in the review queue, with the child's name.
    const pending = (await call(app, "/api/v1/proposals", owner(app))).json as { proposals: Array<{ source_name?: string | null; agent_name: string }> };
    expect(pending.proposals.filter((entry) => entry.agent_name === "Yves").length).toBe(4);
  } finally {
    app.close();
  }
});

test("member pairing needs an owner write key, a person the owner reads, and a role", async () => {
  const app = testApp();
  try {
    const code = (key: string, body: Record<string, unknown>) => call(app, "/api/v1/members/pairing", { method: "POST", key, surface: "phone", ip: AWAY, body });
    expect((await code(app.secrets!.agent, { person_id: "person_sam", role: "partner" })).status).toBe(403);
    expect((await code(app.secrets!.owner, { person_id: "person_sam", role: "guardian" })).status).toBe(422);
    expect((await code(app.secrets!.owner, { person_id: "person_nobody", role: "child" })).status).toBe(404);
    const sam = await pairMember(app, "person_sam", "partner");
    expect((await code(sam.secret, { person_id: "person_yves", role: "child" })).status).toBe(403);
    // A member cannot make a pairing code for a phone of the owner either.
    expect((await call(app, "/api/v1/pairing", { method: "POST", key: sam.secret, ip: MINI })).status).toBe(403);

    // A member made from a phone ends when the owner revokes that phone.
    const phone = await pairPhone(app);
    const yves = await pairMember(app, "person_yves", "child", phone.secret);
    expect((await call(app, "/api/v1/today", as(yves.secret))).status).not.toBe(401);
    expect((await call(app, `/api/v1/devices/${phone.id}/revoke`, { method: "POST", ...owner(app) })).status).toBe(200);
    expect((await call(app, "/api/v1/note", as(yves.secret))).status).toBe(401);

    // The owner lists the members, and revokes one.
    const listed = (await call(app, "/api/v1/members", owner(app))).json as { members: Array<{ id: string; name: string; role: string }> };
    expect(listed.members.map((entry) => [entry.name, entry.role])).toEqual([["Sam", "partner"]]);
    expect((await call(app, "/api/v1/members", as(sam.secret))).status).toBe(403);
    expect((await call(app, `/api/v1/members/${sam.id}`, { method: "DELETE", ...owner(app) })).status).toBe(200);
    expect((await call(app, "/api/v1/note", as(sam.secret))).status).toBe(401);
  } finally {
    app.close();
  }
});
