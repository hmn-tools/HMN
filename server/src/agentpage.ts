import type { Database } from "bun:sqlite";
import type { EntityView } from "./policy";
import type { TodayScreen } from "./screens";
import { type Access, ApiError, TIERS, type Tier } from "./types";

/**
 * The page of one agent key, for the owner: what the key can see now, the Today screen as the key gets it,
 * and what the key did. The scope is counts only, with no title of a row. docs/UX.md, "The agent page".
 */
export type AgentPageContext = {
  db: Database;
  /** Every live row that one access can read, with no read log and no audit row. */
  visibleFor(access: Access): EntityView[];
  /** The title of a proposal for the owner, or null when the owner cannot read it. */
  proposalTitle(row: ProposalLine): string | null;
};

export type ProposalLine = { id: string; op: string; status: string; created_at: string; key_id: string | null };

export type TimelineItem = {
  at: string;
  kind: "read" | "proposal" | "request";
  text: string;
  status?: string;
  proposal_id?: string;
  request_id?: string;
};

const GAP_MS = 3000;
const TIMELINE_CAP = 200;
const READ_ROWS = 1000;
const TIER_WORDS: Record<string, string> = { public: "Public", household: "Household", personal: "Personal", private: "Private", sealed: "Sealed" };
const PLURAL: Record<string, string> = { person: "people", place: "places", asset: "things", note: "notes", task: "tasks", event: "events", project: "projects", goal: "goals", habit: "habits", area: "areas", list: "lists" };

export function refuseMember(access: Access) {
  if (access.principal.member) throw new ApiError(403, "forbidden", "The owner sees the page of an agent.");
}

function plural(type: string, count: number): string {
  if (count === 1) return `1 ${type}`;
  return `${count} ${PLURAL[type] ?? `${type}s`}`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What the key can see now, as counts. `keyAccess` is the key's own access, built without its secret. */
export function agentScope(ctx: AgentPageContext, owner: Access, keyAccess: Access, id: string, name: string) {
  const mine = new Map(ctx.visibleFor(owner).map((view) => [view.id, view]));
  const views = ctx.visibleFor(keyAccess);
  const byType = new Map<string, number>();
  const byArea = new Map<string, number>();
  for (const view of views) {
    byType.set(view.type, (byType.get(view.type) ?? 0) + 1);
    const area = view.type === "area" ? view.id : view.area_id ?? "";
    byArea.set(area, (byArea.get(area) ?? 0) + 1);
  }
  const principal = keyAccess.principal;
  const closed: string[] = ["Sealed rows"];
  for (const tier of TIERS.slice(TIERS.indexOf(keyAccess.ceiling) + 1)) {
    if (tier !== "sealed") closed.unshift(`${TIER_WORDS[tier]} rows`);
  }
  for (const item of principal.denyAreas) {
    if (item.startsWith("role:")) closed.push(`The ${capital(item.slice(5))} area`);
    else closed.push(`The ${mine.get(item)?.title ?? "closed"} area`);
  }
  if (principal.allowAreas) closed.push("Every area that is not on its list");
  if (principal.allowTypes) closed.push("Every type that is not on its list");
  return {
    id,
    name,
    ceiling: keyAccess.ceiling as Tier,
    total: views.length,
    by_type: [...byType.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    by_area: [...byArea.entries()]
      .map(([area, count]) => ({ area_id: area || null, title: area ? mine.get(area)?.title ?? null : null, count }))
      .sort((a, b) => b.count - a.count || String(a.area_id).localeCompare(String(b.area_id))),
    closed,
  };
}

type ReadRow = { seq: number; at: string; action: string; entity_type: string | null; detail: string | null };

/** One search or one view is one line. A row of the log that follows a search, within a short gap, belongs to it. */
function readLines(rows: ReadRow[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  let group: { start: ReadRow; last: number; types: Map<string, number>; count: number } | null = null;
  const close = () => {
    if (!group) return;
    const { start, types, count } = group;
    const kinds = [...types.entries()].map(([type, n]) => plural(type, n)).join(", ");
    let text: string;
    if (start.action === "search") text = `Searched for "${start.detail ?? ""}": ${count === 0 ? "no rows" : plural("row", count)}`;
    else if (start.action === "neighbours") text = `Followed the links of a row: ${count === 0 ? "no rows" : plural("row", count)}`;
    else if (start.action === "changes_since") text = `Asked for what changed: ${count === 0 ? "no rows" : plural("row", count)}`;
    else if (start.action === "free_busy") text = "Checked the free and busy times";
    else if (start.action === "read") text = `Read ${plural("row", count)}${kinds ? ` (${kinds})` : ""}`;
    else text = `${capital(start.action.replaceAll("_", " "))}${start.detail ? `: ${start.detail}` : ""}`;
    out.push({ at: start.at, kind: "read", text });
    group = null;
  };
  for (const row of rows) {
    const time = Date.parse(row.at);
    const isRead = row.action === "read";
    if (isRead && group && time - group.last <= GAP_MS) {
      group.last = time;
      group.count += 1;
      if (row.entity_type) group.types.set(row.entity_type, (group.types.get(row.entity_type) ?? 0) + 1);
      continue;
    }
    close();
    group = { start: row, last: time, types: new Map(), count: 0 };
    if (isRead) {
      group.count = 1;
      if (row.entity_type) group.types.set(row.entity_type, 1);
    }
  }
  close();
  return out;
}

/** What the key did, newest first: reads, proposals, and requests. */
export function agentTimeline(ctx: AgentPageContext, id: string, limit: number) {
  const cap = Math.max(1, Math.min(TIMELINE_CAP, Math.floor(limit) || 100));
  const reads = (ctx.db.query("SELECT seq, at, action, entity_type, detail FROM client_reads WHERE principal_id = ? ORDER BY seq DESC LIMIT ?").all(id, READ_ROWS) as ReadRow[]).reverse();
  const items: TimelineItem[] = readLines(reads).reverse();
  const proposals = ctx.db
    .query("SELECT id, op, status, created_at, key_id FROM proposals WHERE key_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(id, TIMELINE_CAP) as ProposalLine[];
  for (const row of proposals) {
    const title = ctx.proposalTitle(row);
    items.push({ at: row.created_at, kind: "proposal", text: title ?? `A ${row.op} proposal`, status: row.status === "rejected" ? "declined" : row.status, proposal_id: row.id });
  }
  const requests = ctx.db
    .query("SELECT id, need, status, created_at FROM agent_requests WHERE key_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(id, TIMELINE_CAP) as Array<{ id: string; need: string; status: string; created_at: string }>;
  for (const row of requests) items.push({ at: row.created_at, kind: "request", text: row.need, status: row.status, request_id: row.id });
  items.sort((a, b) => b.at.localeCompare(a.at));
  const count = (sql: string) => (ctx.db.query(sql).get(id) as { n: number }).n;
  return {
    summary: {
      approved: count("SELECT COUNT(*) AS n FROM proposals WHERE key_id = ? AND status = 'approved'"),
      declined: count("SELECT COUNT(*) AS n FROM proposals WHERE key_id = ? AND status = 'rejected'"),
      pending: count("SELECT COUNT(*) AS n FROM proposals WHERE key_id = ? AND status = 'pending'"),
      open_requests: count("SELECT COUNT(*) AS n FROM agent_requests WHERE key_id = ? AND status = 'open'"),
    },
    items: items.slice(0, cap),
  };
}

export type { TodayScreen };
