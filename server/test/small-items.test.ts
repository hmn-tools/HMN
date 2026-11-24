// Small open items of the roadmap: search stems English words, and the read log of an agent reaches the disk
// within a second. docs/ROADMAP.md, slice 17. All data is fictional.
import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { call, testApp } from "./helpers";

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });
const titles = async (app: App, q: string) =>
  ((await call(app, `/api/v1/search?q=${encodeURIComponent(q)}`, owner(app))).json as { results: Array<{ title: string }> }).results.map((item) => item.title);

test("search finds a word in its plural or other form", async () => {
  const app = testApp();
  try {
    await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title: "Example note for the plumber", status: "open", area_id: "area_work" } });
    await call(app, "/api/v1/task", { method: "POST", ...owner(app), body: { title: "Example run club sign-up", kind: "task", status: "open", area_id: "area_work" } });
    expect(await titles(app, "notes")).toContain("Example note for the plumber");
    expect(await titles(app, "plumbers")).toContain("Example note for the plumber");
    expect(await titles(app, "running")).toContain("Example run club sign-up");
    // A part of a word still matches, and the search box still needs each word.
    expect(await titles(app, "plumb")).toContain("Example note for the plumber");
    expect(await titles(app, "notes zebra")).toEqual([]);
  } finally {
    app.close();
  }
});

test("an agent's read is in the log, and the log is saved within a second", async () => {
  const app = testApp();
  try {
    const store = app.hmn.store;
    const before = (store.db.query("SELECT COUNT(*) AS n FROM client_reads").get() as { n: number }).n;
    const read = await call(app, "/api/v1/search?q=weekly", { key: app.secrets!.agent });
    expect(read.status).toBe(200);
    const after = (store.db.query("SELECT COUNT(*) AS n FROM client_reads").get() as { n: number }).n;
    expect(after).toBeGreaterThan(before);
    // The request asks for a save. The saves come at most once a second, so the newest rows wait at most that long.
    await Bun.sleep(1200);
    expect(store.dirty()).toBe(false);
  } finally {
    app.close();
  }
});
