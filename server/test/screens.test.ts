import { afterAll, beforeAll, expect, test } from "bun:test";
import { call, testApp } from "./helpers";
import type { App } from "../src/app";
import { nextDeckIndex } from "../src/screens";

let app: App;
beforeAll(() => {
  app = testApp();
});
afterAll(() => app.close());

const secretWords = ["passport", "clinic", "expires 02/2027", "Renew Yves"];

async function html(path: string, key: string, surface: string) {
  return call(app, path, { key, surface });
}

test("deck index skips a screen that is not ready", () => {
  expect(nextDeckIndex(0, [true, false, true, false], true)).toBe(2);
  expect(nextDeckIndex(2, [true, false, true, false], true)).toBe(0);
  expect(nextDeckIndex(0, [true, true, true, true], false)).toBe(0);
});

test("weekly review and the other screens keep each ceiling", async () => {
  const phoneWeek = await html("/api/v1/screens/week.html", app.secrets!.owner, "phone");
  expect(phoneWeek.text).toContain("This week.");
  expect(phoneWeek.text).toContain("Nothing done, nothing slipped, and no project moved.");
  expect(phoneWeek.text).toContain("Decide what next week is for. Leave the rest.");
  expect(phoneWeek.text).toContain("Yves · school concert");
  expect(phoneWeek.text).toContain("A quieter year");
  expect(phoneWeek.text).toContain("Coupe SRS light");
  for (const word of secretWords) expect(phoneWeek.text.includes(word), word).toBe(false);

  const widgetWeek = await html("/api/v1/screens/week.html", app.secrets!.owner, "widget");
  expect(widgetWeek.text).not.toContain("Yves");
  expect(widgetWeek.text).not.toContain("Luca");
  expect(widgetWeek.text).not.toContain("school concert");
  expect(widgetWeek.text).toContain("A quieter year");
  for (const word of secretWords) expect(widgetWeek.text.includes(word)).toBe(false);

  const displayWeek = await html("/api/display/week.html", app.secrets!.owner, "phone");
  expect(displayWeek.text).not.toContain("Alex");
  expect(displayWeek.text).not.toContain("Yves");
  expect(displayWeek.text).not.toContain("quieter");
  expect(displayWeek.text).not.toContain("SRS");
  for (const word of secretWords) expect(displayWeek.text.includes(word)).toBe(false);

  const phoneUp = await html("/api/v1/screens/upcoming.html", app.secrets!.owner, "phone");
  expect(phoneUp.text).toContain("Yves · school concert");
  expect(phoneUp.text).toContain("Lakeside Grand Prix");
  expect(phoneUp.text).not.toContain("no results");
  const widgetUp = await html("/api/v1/screens/upcoming.html", app.secrets!.owner, "widget");
  expect(widgetUp.text).not.toContain("Yves");
  expect(widgetUp.text).toContain("Lakeside Grand Prix");
  const displayUp = await html("/api/display/upcoming.html", app.secrets!.display, "phone");
  expect(displayUp.text).not.toContain("Yves");
  expect(displayUp.text).not.toContain("Luca");
  expect(displayUp.text).toContain("Lakeside Grand Prix");
  expect(displayUp.text).not.toContain("no results");

  const phoneWork = await html("/api/v1/screens/commitments.html", app.secrets!.owner, "phone");
  expect(phoneWork.text).toContain("Send weekly notes");
  expect(phoneWork.text).not.toContain("Luca");
  expect(phoneWork.text).not.toContain("SRS");
  const displayWork = await html("/api/display/commitments.html", app.secrets!.owner, "phone");
  expect(displayWork.text).not.toContain("weekly notes");
  expect(displayWork.text).not.toContain("Yves");

  const phoneQuiet = await html("/api/v1/screens/quiet.html", app.secrets!.owner, "phone");
  expect(phoneQuiet.text).toContain("Coupe SRS light");
  expect(phoneQuiet.text).not.toContain("Yves");
  const displayQuiet = await html("/api/display/quiet.html", app.secrets!.display, "display");
  expect(displayQuiet.text).not.toContain("SRS");
  expect(displayQuiet.text).not.toContain("Yves");

  const phoneAgents = await html("/api/v1/screens/agents.html", app.secrets!.owner, "phone");
  expect(phoneAgents.text).toContain("sealed proposal");
  expect(phoneAgents.text).not.toContain("passport");
  const displayAgents = await html("/api/display/agents.html", app.secrets!.owner, "phone");
  expect(displayAgents.text).not.toContain("Trip helper");
  expect(displayAgents.text).not.toContain("passport");
  expect(displayAgents.text).not.toContain("Yves");

  const inbox = await html("/api/v1/screens/inbox", app.secrets!.owner, "phone");
  expect(inbox.text).toContain("Nothing waiting to be placed.");

  const people = await html("/api/v1/browse/person.html", app.secrets!.owner, "widget");
  expect(people.text).not.toContain("Yves");
  expect(people.text).not.toContain("Luca");
  const peoplePhone = await html("/api/v1/browse/person.html", app.secrets!.owner, "phone");
  expect(peoplePhone.text).toContain("Yves");
});

test("the display rotates to the next ready screen after an hour", async () => {
  app.store.db.query("UPDATE display_state SET screen_index = 0, shown_at = ? WHERE id = 'device'").run("2026-11-11T00:00:00.000Z");
  const first = await call(app, "/api/display", { key: app.secrets!.display });
  expect((first.json as { screen: string }).screen).toBe("upcoming");
  const second = await call(app, "/api/display", { key: app.secrets!.display });
  expect((second.json as { screen: string }).screen).toBe("upcoming");
  const forced = await call(app, "/api/display?screen=today", { key: app.secrets!.display });
  expect((forced.json as { screen: string }).screen).toBe("today");
  const stayed = await call(app, "/api/display", { key: app.secrets!.display });
  expect((stayed.json as { screen: string }).screen).toBe("upcoming");
});
