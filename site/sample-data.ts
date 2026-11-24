// A fuller fictional life for the screens of the website.
//
// The demonstration of the first boot is small on purpose, and the tests of the server depend on it.
// This script adds rows to a TEST server through the API, so that the screens show a whole week.
// Every name, date, and note here is fictional.
//
// Run it one time, against a test server that you started with HMN_INSECURE_DEV_KEK=1 and its own HMN_DATA_DIR:
//   HMN_URL=https://127.0.0.1:8811 HMN_CA=<data dir>/tls/ca.crt HMN_OWNER_KEY=<owner key> bun site/sample-data.ts
//
// It refuses an address that is not loopback. Do not run it against a real HMN.

const base = process.env.HMN_URL ?? "";
const owner = process.env.HMN_OWNER_KEY ?? "";
const caPath = process.env.HMN_CA ?? "";
if (!/^https:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error("HMN_URL must be a loopback address of a test server.");
if (!owner || !caPath) throw new Error("Set HMN_OWNER_KEY and HMN_CA.");
const ca = await Bun.file(caPath).text();

type Options = { key?: string; grant?: string; surface?: string };

async function call(method: string, path: string, body?: unknown, options: Options = {}): Promise<any> {
  const headers: Record<string, string> = { authorization: `Bearer ${options.key ?? owner}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (options.grant) headers["x-hmn-grant"] = options.grant;
  // The phone app is the surface that can write a Private row.
  headers["x-hmn-surface"] = options.surface ?? "phone";
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    tls: { ca },
  } as RequestInit);
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const add = (type: string, row: Record<string, unknown>, options?: Options) => call("POST", `/api/v1/${type}`, row, options);
const link = (from_id: string, rel: string, to_id: string, options?: Options) => call("POST", "/api/v1/links", { from_id, rel, to_id }, options);

// The day of the screens is Wednesday 11/11/2026. The times below are UTC, and the screens show Perth time.

// People and things.
await add("person", { id: "person_mara", title: "Mara", kind: "other" });
await add("person", { id: "person_jo", title: "Jo", kind: "other" });
await add("place", { id: "place_osteria", title: "Osteria Nove", kind: "other" });
await add("project", { id: "project_kitchen", title: "Kitchen repaint", status: "active", area_id: "area_home" });
await add("goal", { id: "goal_run", title: "Run a half marathon in March", status: "active", properties: { horizon: "year" } });

// Today. One more task, and a shorter title for the garage.
await call("PATCH", "/api/v1/task/task_garage", { title: "Reply to the garage" });
await add("task", { id: "task_deposit", title: "Pay the school trip deposit", status: "open", kind: "task", due_at: "2026-11-11T07:00:00.000Z", area_id: "area_family" });
await link("task_deposit", "about", "person_yves");

// The days after today.
await add("task", { id: "task_cake", title: "Order the cake for Sam", status: "open", kind: "task", due_at: "2026-11-12", area_id: "area_family" });
await link("task_cake", "about", "person_sam");
await add("task", { id: "task_flights", title: "Book the flights for December", status: "open", kind: "task", due_at: "2026-11-16", area_id: "area_home" });
await link("task_flights", "part_of", "project_trip");
await add("task", { id: "task_paint", title: "Choose the paint for the kitchen", status: "open", kind: "task", due_at: "2026-11-15", area_id: "area_home" });
await link("task_paint", "part_of", "project_kitchen");
await add("task", { id: "task_summary", title: "Draft the Q4 summary", status: "open", kind: "task", due_at: "2026-11-18", area_id: "area_work" });
await link("task_summary", "part_of", "project_brief");
await add("task", { id: "task_mara", title: "Send Mara the photos from the lake", status: "open", kind: "task", due_at: "2026-11-14" });
await link("task_mara", "about", "person_mara");

// Family dates.
await add("event", {
  id: "event_dinner",
  title: "birthday dinner",
  status: "upcoming",
  kind: "family",
  due_at: "2026-11-14T11:30:00.000Z",
  area_id: "area_family",
  properties: { short_title: "Sam's birthday" },
});
await link("event_dinner", "with", "person_sam");
await link("event_dinner", "at", "place_osteria");

// One more thing to watch. It is Public, so the shared display shows it.
await add("event", {
  id: "event_match",
  title: "Harbour City v Northfield",
  status: "upcoming",
  kind: "fixture",
  due_at: "2026-11-15T12:00:00.000Z",
  area_id: "area_sport",
  properties: { badge: "FB", tz_label: "AWST", no_results: true },
});

// Notes that an agent with the Personal limit can read.
await add("note", {
  id: "note_insurance",
  title: "Coupe insurance",
  body: "The cover ends on 30/11/2026. The renewal offer is in the post. Example note, not a real policy.",
  status: "open",
  area_id: "area_cars",
});
await link("note_insurance", "about", "asset_coupe");
await add("note", {
  id: "note_paint",
  title: "Paint colours",
  body: "Two samples on the wall by the window. Sam prefers the lighter one. Example note.",
  status: "open",
  area_id: "area_home",
});
await link("note_paint", "about", "project_kitchen");

// Sealed rows need a device that can open the vault. The script pairs one, uses it, and revokes it.
const pairing = await call("POST", "/api/v1/pairing");
const device = await call("POST", "/api/v1/pair", { code: pairing.code, device_name: "Sample loader" });
const grant = (await call("POST", "/api/v1/vault/grants", undefined, { key: device.secret, surface: "phone" })).grant;
const vault: Options = { key: device.secret, grant, surface: "phone" };
await add("note", { id: "note_blood", title: "Blood test results", body: "A fictional result. Not a real record.", status: "open", area_id: "area_health" }, vault);
await add("note", { id: "note_mortgage", title: "Mortgage renewal offer", body: "A fictional offer. Not a real document.", status: "open", area_id: "area_money" }, vault);
await add("task", { id: "task_checkup", title: "Book the yearly checkup", status: "open", kind: "task", due_at: "2026-11-20", area_id: "area_health" }, vault);
await call("POST", `/api/v1/devices/${device.credential.id}/revoke`);

// Keys, so that the screens for keys have content. The secrets stay in this process.
const helper = await call("POST", "/api/v1/keys", { name: "home-helper" });
await call("POST", "/api/v1/keys", { name: "research" });
await call("POST", "/api/v1/keys", { name: "kitchen", scope: "read" });
await call("POST", "/api/v1/external/clients", { name: "Mara", guest: true, free_busy: true });

// What an agent proposes. It read the insurance note, and it can only ask.
const helperKey: Options = { key: helper.token, surface: "mcp" };
await call(
  "POST",
  "/api/v1/proposals",
  {
    op: "create",
    payload: {
      op: "create",
      entity: { type: "task", title: "Renew the coupe insurance", status: "open", kind: "task", due_at: "2026-11-27", area_id: "area_cars" },
      links: [
        { rel: "about", to_type: "asset", to_id: "asset_coupe" },
        { rel: "about", to_type: "note", to_id: "note_insurance" },
      ],
    },
    reason: 'The note "Coupe insurance" says that the cover ends on 30/11.',
    read_set: { summary: "Tasks, Cars, one note", denied: ["Health", "Money"] },
  },
  helperKey,
);
await call(
  "POST",
  "/api/v1/proposals",
  {
    op: "update",
    payload: { op: "update", id: "task_paint", patch: { due_at: "2026-11-13" } },
    reason: 'The note "Paint colours" says that the samples are on the wall. The painter starts on 16/11.',
    read_set: { summary: "Tasks, Home, one note", denied: ["Health", "Money"] },
  },
  helperKey,
);

console.log("The sample data is in.");
