import { calendarDrafts, isCalendar, parseIcs, type CalendarSource } from "./calendar";
import { healthDrafts } from "./health";
import { sportDrafts } from "./sport";

type Request = { plugin?: string; now?: string; input?: Record<string, unknown> };

const raw = await new Response(Bun.stdin).text();
const request = JSON.parse(raw || "{}") as Request;
const input = request.input ?? {};
const now = request.now ?? new Date().toISOString();
let proposals: unknown[] = [];

if (request.plugin === "calendar" || request.plugin === "google") {
  const zone = typeof input.timeZone === "string" ? input.timeZone : undefined;
  const ics = typeof input.ics === "string" ? input.ics : "";
  const events = Array.isArray(input.events) ? input.events : parseIcs(ics, { now: new Date(now), timeZone: zone });
  const source = input.source && typeof input.source === "object" ? (input.source as CalendarSource) : typeof input.sourceId === "string" ? input.sourceId : null;
  proposals = calendarDrafts(events, Array.isArray(input.people) ? input.people : [], source, Array.isArray(input.existing) ? input.existing : [], {
    today: typeof input.today === "string" ? input.today : undefined,
    mirror: input.mirror === true,
    familyKinds: Array.isArray(input.familyKinds) ? input.familyKinds.filter((item): item is string => typeof item === "string") : undefined,
    // Only a full calendar document can show that an event was removed. A list of events in the request cannot.
    complete: !Array.isArray(input.events) && isCalendar(ics),
  });
} else if (request.plugin === "sport") {
  proposals = sportDrafts({
    fixtures: Array.isArray(input.fixtures) ? input.fixtures : [],
    now: new Date(now),
    sourceId: typeof input.sourceId === "string" ? input.sourceId : null,
    existing: Array.isArray(input.existing) ? input.existing : [],
  });
} else if (request.plugin === "health") {
  proposals = healthDrafts(Array.isArray(input.summaries) ? input.summaries : [], input.include_samples === true);
} else {
  process.stdout.write(JSON.stringify({ proposals: [] }));
  process.exit(0);
}

process.stdout.write(JSON.stringify({ proposals }));
