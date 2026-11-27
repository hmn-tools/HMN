/**
 * Views for agents. The owner's phone gets server-built screens. An agent gets the same answers, cut to its key's
 * ceiling, as compact JSON. Every view is built by the same code as the phone screen, through the agent's own
 * Access, and the read log records each row that a view returns.
 */
import type { Hmn } from "./hmn";
import { endsPhrase } from "./screens";
import type { Access } from "./types";
import { ApiError } from "./types";

export type AgentItem = { id: string; type: string | null; title: string; subtitle: string; done?: boolean };
export type AgentView = { title: string; summary: string; sections: Array<{ id: string; label: string; items: AgentItem[] }> };

/** One of the screens `today`, `upcoming`, or `week`. */
export function screenView(hmn: Hmn, access: Access, id: "today" | "upcoming" | "week"): AgentView {
  const screen = hmn.screen(access, id);
  return {
    title: screen.label,
    summary: screen.summary,
    sections: screen.sections.map((section) => ({
      id: section.id,
      label: section.label,
      items: section.items.map((item) => {
        const out: AgentItem = { id: item.id, type: item.type ?? null, title: item.title, subtitle: item.subtitle };
        if (item.type === "task") out.done = item.done;
        return out;
      }),
    })),
  };
}

const PERSON_SECTIONS = [
  ["next", "Next dates"],
  ["tasks", "Open tasks"],
  ["done", "Done lately"],
  ["notes", "Notes"],
  ["things", "Things"],
  ["people", "People"],
  ["other", "Other"],
] as const;

/** The person page. A person above the ceiling answers as a missing row does, because `personPage` reads through `get`. */
export function personPageView(hmn: Hmn, access: Access, id: string): AgentView {
  const page = hmn.personPage(access, id);
  return {
    title: page.person.title,
    summary: page.line,
    sections: PERSON_SECTIONS.map(([key, label]) => ({
      id: key,
      label,
      items: page[key].map((row) => {
        const out: AgentItem = { id: row.entity.id, type: row.entity.type, title: row.entity.title, subtitle: [row.rel, row.when].filter(Boolean).join(" · ") };
        if (row.entity.type === "task") out.done = row.entity.status === "done";
        return out;
      }),
    })).filter((section) => section.items.length),
  };
}

/** The "Expiring soon" list, from 30 days ago to `days` ahead. */
export function expiringView(hmn: Hmn, access: Access, days: unknown): AgentView {
  const wanted = days === undefined || days === null ? 60 : Number(days);
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > 90) throw new ApiError(422, "days", "Days must be a whole number from 1 to 90.");
  const list = hmn.expiring(access, wanted);
  return {
    title: "Expiring soon",
    summary: list.length ? `${list.length} ending within ${wanted} days.` : `Nothing ends within ${wanted} days.`,
    sections: list.length
      ? [{ id: "renewals", label: "Expiring soon", items: list.map((row) => ({ id: row.entity.id, type: row.entity.type, title: row.entity.title, subtitle: `${row.label} · ${endsPhrase(row.days)}` })) }]
      : [],
  };
}
