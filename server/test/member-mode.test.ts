// Member mode: what a member's phone reads. Home greets the member and shows what is for them. Family lists the
// tasks for one person or more, with their steps. /api/v1/me tells the app which mode to show.
// docs/ONTOLOGY.md, section 5.4. All data is fictional.
import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { call, testApp } from "./helpers";

const AWAY = "10.7.7.8";
const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });
const as = (secret: string) => ({ key: secret, surface: "phone", ip: AWAY });

type View = { id: string; title: string; status: string };
type Screen = { greeting: string; summary: string; sections: Array<{ id: string; label: string; items: Array<{ id: string; title: string }> }> };
type FamilyTask = { task: View; for: Array<{ id: string; title: string }>; steps: { open: number; done: number } };

async function pairMember(app: App, personId: string, role: string) {
  const made = await call(app, "/api/v1/members/pairing", { method: "POST", ...owner(app), ip: AWAY, body: { person_id: personId, role } });
  expect(made.status).toBe(201);
  const paired = await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: (made.json as { code: string }).code, device_name: "Example member phone" } });
  expect(paired.status).toBe(201);
  return (paired.json as { secret: string }).secret;
}

async function make(app: App, type: string, body: Record<string, unknown>) {
  const made = await call(app, `/api/v1/${type}`, { method: "POST", ...owner(app), body });
  expect(made.status).toBe(201);
  return made.json as View;
}

async function forPerson(app: App, taskId: string, personId: string) {
  const link = await call(app, "/api/v1/links", { method: "POST", ...owner(app), body: { from_type: "task", from_id: taskId, to_type: "person", to_id: personId, rel: "for" } });
  expect(link.status).toBe(201);
}

test("/api/v1/me names the member, and not the owner", async () => {
  const app = testApp();
  try {
    const sam = await pairMember(app, "person_sam", "partner");
    const me = (await call(app, "/api/v1/me", as(sam))).json as { member: { role: string; name: string } | null; owner_name: string | null };
    expect(me.member).toMatchObject({ role: "partner", name: "Sam" });
    expect(me.owner_name).toBeNull();
    const mine = (await call(app, "/api/v1/me", owner(app))).json as { member: unknown };
    expect(mine.member).toBeNull();
  } finally {
    app.close();
  }
});

test("Home greets the member, shows what is for them, and leaves out what they cannot read", async () => {
  const app = testApp();
  try {
    const forms = await make(app, "task", { title: "Example sign the school form", kind: "task", status: "open", tier: "household", due_at: "2026-11-11" });
    await forPerson(app, forms.id, "person_sam");
    const other = await make(app, "task", { title: "Example book the boiler check", kind: "task", status: "open", tier: "household", due_at: "2026-11-11" });
    await make(app, "task", { title: "Example personal errand", kind: "task", status: "open", tier: "personal", due_at: "2026-11-11" });
    await make(app, "event", { title: "Example swimming", kind: "appointment", status: "upcoming", tier: "household", due_at: "2026-11-11T10:00:00.000Z" });

    const sam = await pairMember(app, "person_sam", "partner");
    const home = await call(app, "/api/v1/screens/home", as(sam));
    expect(home.status).toBe(200);
    const screen = home.json as Screen;
    expect(screen.greeting).toMatch(/, Sam\.$/);
    expect(screen.greeting).not.toContain("Alex");
    expect(screen.sections[0]).toMatchObject({ id: "mine", label: "For you" });
    expect(screen.sections[0]!.items.map((item) => item.id)).toEqual([forms.id]);
    const text = JSON.stringify(screen);
    expect(text).toContain(other.id);
    expect(text).toContain("Example swimming");
    expect(text).not.toContain("Example personal errand");
    expect(screen.summary).toBe("One thing for you today.");

    // A child reads Household only. The Family-area rows of the seed are not on the child's Home.
    const yves = await pairMember(app, "person_yves", "child");
    const child = JSON.stringify((await call(app, "/api/v1/screens/home", as(yves))).json);
    expect(child).toMatch(/, Yves\./);
    expect(child).not.toContain("dentist");
    expect(child).not.toContain("Example personal errand");
  } finally {
    app.close();
  }
});

test("Family lists the tasks for people, with their steps, open first and the recent done ones after", async () => {
  const app = testApp();
  try {
    const passport = await make(app, "task", { title: "Example renew a passport", kind: "task", status: "open", tier: "household", due_at: "2026-12-01" });
    await forPerson(app, passport.id, "person_sam");
    await forPerson(app, passport.id, "person_alex");
    for (const title of ["Example photo", "Example form"]) {
      expect((await call(app, "/api/v1/items", { method: "POST", ...owner(app), body: { parent_id: passport.id, title } })).status).toBe(201);
    }
    const bins = await make(app, "task", { title: "Example take the bins out", kind: "task", status: "open", tier: "household" });
    await forPerson(app, bins.id, "person_sam");
    await call(app, `/api/v1/task/${bins.id}`, { method: "PATCH", ...owner(app), body: { status: "done" } });
    // A task for nobody is not a family task.
    await make(app, "task", { title: "Example lone task", kind: "task", status: "open", tier: "household" });

    const sam = await pairMember(app, "person_sam", "partner");
    const answer = await call(app, "/api/v1/family-tasks", as(sam));
    expect(answer.status).toBe(200);
    const tasks = (answer.json as { tasks: FamilyTask[] }).tasks;
    const titles = tasks.map((entry) => entry.task.title);
    expect(titles.indexOf("Example renew a passport")).toBeLessThan(titles.indexOf("Example take the bins out"));
    expect(titles).not.toContain("Example lone task");
    const entry = tasks.find((item) => item.task.id === passport.id)!;
    expect(entry.steps).toEqual({ open: 2, done: 0 });
    // The owner's own person is Personal, so the partner sees only Sam on the task.
    expect(entry.for.map((person) => person.title)).toEqual(["Sam"]);
  } finally {
    app.close();
  }
});
