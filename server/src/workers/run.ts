import { randomId } from "../crypto";
import type { Hmn } from "../hmn";
import { ApiError, type Tier } from "../types";
import type { ProposalView } from "../policy";
import { workerAccess, readSet, visibleGraph, type Visible } from "./context";
import type { WorkerConfig } from "./config";
import { getWorker, isDue, listWorkers, markRan, recordRun, sendTierOf, warningFor } from "./config";
import { corpusFrom, modelBrief, modelSelection } from "./guard";
import { clientFor, fallbackClient, type LlmClient } from "./llm";
import { watchLines } from "./fixtures";
import { goalDrafts } from "./goals";
import { writeJournal, type JournalItem } from "../journal";
import { peopleDrafts } from "./people";
import { zoned } from "../time";

const VERBS = new Set(["book", "send", "reply", "renew", "call", "buy", "pick", "email", "pay", "file", "wash", "fix", "ask", "write", "return"]);
const NAME_BLOCK = new Set(["ignore", "system", "admin", "vault", "health", "money", "approve", "reveal", "prompt", "instruction", "instructions", "user", "assistant", "hmn"]);

export type RunResult = {
  worker_id: string;
  name: string;
  llm: "fallback" | "local" | "cloud";
  warning: string | null;
  approved: false;
  focus?: string;
  top?: Array<{ title: string; subtitle: string }>;
  review?: string;
  proposals: Array<{ id: string; op: string; tier?: Tier; status: string; title?: string }>;
  skipped: number;
};

export async function runWorker(hmn: Hmn, id: string, options: { llm?: LlmClient; fetch?: Parameters<typeof clientFor>[1] } = {}): Promise<RunResult> {
  const nowIso = hmnNow(hmn);
  hmn.expireProposals();
  const today = zoned(hmnNowDate(hmn), hmnZone(hmn)).dateKey;
  const config = getWorker(hmn.store.db, id, nowIso);
  if (!config.enabled) throw new ApiError(422, "disabled", "That worker is off.");
  const resolved = options.llm ? { client: options.llm } : clientFor(config, options.fetch, hmn.store.db);
  let client = resolved.client;
  let llmId = client.id;
  const warning = warningFor(config);
  const ceiling = sendTierOf({ ...config, llm_mode: client.id === "cloud" ? "cloud" : config.llm_mode });
  const access = workerAccess({ ...config, tier: ceiling });
  const graph = visibleGraph(hmn, access);
  const corpus = corpusFrom(graph.flatMap((item) => [item.title, item.body, item.kind, item.status]));
  // The workers read roles. The owner's kinds and areas give the names.
  const registry = hmn.kinds();
  const world: World = { selfKinds: registry.withRole("person", "self"), fixtureKinds: registry.withRole("event", "fixture"), sportArea: hmn.areaForRole("sport") };

  let focus: string | undefined;
  let top: Array<{ title: string; subtitle: string }> | undefined;
  let review: string | undefined;
  let drafts: Draft[] = [];

  try {
    if (config.kind === "morning") {
      const brief = await composeMorning(hmn, access, corpus, client);
      focus = brief.focus;
      top = brief.top;
      llmId = brief.llm;
      drafts = [noteDraft(config, "Morning brief", brief.body, "Morning brief from Today.", "Today", today, today)];
    } else if (config.kind === "weekly") {
      const week = await composeWeek(hmn, access, corpus, client);
      review = week.text;
      llmId = week.llm;
      drafts = [noteDraft(config, week.title, week.text, "Weekly review draft.", "the week", today, plusDays(today, 6))];
    } else if (config.kind === "people") {
      const made = await composePeople(graph, hmnNowDate(hmn), hmnZone(hmn), client, world);
      llmId = made.llm;
      drafts = made.drafts;
    } else if (config.kind === "fixtures") {
      const made = await composeFixtures(graph, hmnNowDate(hmn), hmnZone(hmn), client, world);
      focus = made.focus;
      llmId = made.llm;
      drafts = made.drafts;
    } else if (config.kind === "goals") {
      const made = await composeGoals(hmn, access, graph, client);
      llmId = made.llm;
      drafts = made.drafts;
    } else if (config.kind === "triage") {
      const triage = await composeTriage(graph, client);
      llmId = triage.llm;
      drafts = triage.drafts;
    }
  } catch {
    client = fallbackClient;
    llmId = "fallback";
    if (config.kind === "morning") {
      const brief = deterministicMorning(hmn, access);
      focus = brief.focus;
      top = brief.top;
      drafts = [noteDraft(config, "Morning brief", brief.body, "Morning brief from Today.", "Today", today, today)];
    } else if (config.kind === "weekly") {
      const week = deterministicWeek(hmn, access);
      review = week.text;
      drafts = [noteDraft(config, week.title, week.text, "Weekly review draft.", "the week", today, plusDays(today, 6))];
    } else if (config.kind === "people") {
      drafts = peopleToDrafts(peopleDrafts(graph, hmnNowDate(hmn), hmnZone(hmn), world.selfKinds));
    } else if (config.kind === "fixtures") {
      const made = fixtureDraft(graph, hmnNowDate(hmn), hmnZone(hmn), world);
      focus = made.focus;
      drafts = made.drafts;
    } else if (config.kind === "goals") {
      drafts = goalToDrafts(goalDrafts(hmn, access, graph));
    } else if (config.kind === "triage") {
      drafts = deterministicTriage(graph);
    }
  }

  const journalId = randomId("journal");
  const proposals = submitDrafts(hmn, config, access.ceiling, drafts, journalId);
  const summary = focus ?? review ?? `${proposals.length} proposal${proposals.length === 1 ? "" : "s"}`;
  const read = graph.slice(0, 12).map((item) => ({ id: item.id, type: item.type, title: item.title, tier: item.tier }));
  const proposed: JournalItem[] = proposals.map((item) => ({
    id: item.id,
    type: "proposal",
    title: item.title ?? item.op,
    tier: item.tier ?? access.ceiling,
    reason: drafts.find((draft) => draft.title === item.title)?.reason,
  }));
  writeJournal(hmn, { id: journalId, actorId: config.id, name: config.name, model: llmId, why: summary, read, proposed });
  recordRun(hmn.store.db, config.id, randomId("run"), nowIso, llmId, warning, proposals.map((item) => item.id), summary);
  markRan(hmn.store.db, config.id, nowIso);
  hmn.store.persist();
  return {
    worker_id: config.id,
    name: config.name,
    llm: llmId,
    warning,
    approved: false,
    focus,
    top,
    review,
    proposals,
    skipped: drafts.length - proposals.length,
  };
}

export async function runDue(hmn: Hmn): Promise<RunResult[]> {
  const nowIso = hmnNow(hmn);
  // The loop calls this once a minute, so a proposal leaves the queue soon after its last day.
  hmn.expireProposals();
  const workers = listWorkers(hmn.store.db, nowIso).filter((worker) => worker.enabled);
  const due = workers.filter((worker) => isDue(worker.schedule, worker.last_run_at, hmnNowDate(hmn), hmnZone(hmn)));
  const results: RunResult[] = [];
  for (const worker of due) {
    results.push(await runWorker(hmn, worker.id));
  }
  return results;
}

/** What a run needs from the owner's kinds and areas. */
type World = { selfKinds: Set<string>; fixtureKinds: Set<string>; sportArea: string | null };

type Draft = {
  op: "create" | "link";
  /** The id that a model may select. Two drafts from one note share it. */
  sourceId?: string;
  /** The id of this one draft. A decision on it is remembered under the worker and this key. */
  key?: string;
  /** At most one pending draft of a family, for example one Morning note. */
  family?: string;
  /** The last day, in the owner's time zone, on which the draft is useful. */
  expiresOn?: string;
  /** True when an approval does not stop a later draft with the same key. A decline always stops it. */
  repeatAfterApproval?: boolean;
  title?: string;
  entity?: Record<string, unknown>;
  links?: Array<{ rel: string; to_type: string; to_id: string }>;
  link?: { rel: string; from_type: string; from_id: string; to_type: string; to_id: string };
  reason: string;
  summary: string;
};

function noteDraft(config: WorkerConfig, title: string, body: string, reason: string, summary: string, day: string, lastDay: string): Draft {
  return {
    op: "create",
    key: `${config.kind}:${day}`,
    family: config.kind,
    expiresOn: lastDay,
    repeatAfterApproval: true,
    title,
    entity: { type: "note", title, status: "open", body },
    reason,
    summary,
  };
}

async function composeMorning(
  hmn: Hmn,
  access: ReturnType<typeof workerAccess>,
  corpus: string,
  client: LlmClient,
): Promise<{ focus: string; top: Array<{ title: string; subtitle: string }>; body: string; llm: "fallback" | "local" | "cloud" }> {
  const base = deterministicMorning(hmn, access);
  if (client.id === "fallback") return { ...base, llm: "fallback" };
  const raw = await client.complete(
    "Return JSON {\"focus\": string, \"top\": string[]} for the morning. focus is one sentence. top is up to three titles copied from the data, nothing else.",
    { today: { focus: base.focus, items: base.items }, ceiling: access.ceiling },
  );
  const picked = modelBrief(raw, base.focus, base.items.map((item) => item.title), corpusFrom([corpus, base.focus, ...base.items.flatMap((item) => [item.title, item.subtitle])]));
  const top = picked.top.map((title) => base.items.find((item) => item.title === title) ?? { title, subtitle: "" });
  const body = briefBody(picked.focus, top);
  return { focus: picked.focus, top, body, llm: picked.usedModel ? client.id : "fallback" };
}

async function composeWeek(
  hmn: Hmn,
  access: ReturnType<typeof workerAccess>,
  corpus: string,
  client: LlmClient,
): Promise<{ title: string; text: string; llm: "fallback" | "local" | "cloud" }> {
  const base = deterministicWeek(hmn, access);
  if (client.id === "fallback") return { ...base, llm: "fallback" };
  const raw = await client.complete(
    "Return JSON {\"focus\": string, \"top\": string[]}. focus is the week's summary sentence. top is section titles copied from the data.",
    { week: base.text, ceiling: access.ceiling },
  );
  const allowed = base.titles;
  const picked = modelBrief(raw, base.summary, allowed.length ? allowed : ["This week"], corpusFrom([corpus, base.text]));
  if (!picked.usedModel) return { ...base, llm: "fallback" };
  const text = `${picked.focus}\n\n${base.sections}\n\nDecide what next week is for. Leave the rest.`;
  return { title: base.title, text, llm: client.id };
}

async function composeTriage(graph: Visible[], client: LlmClient): Promise<{ drafts: Draft[]; llm: "fallback" | "local" | "cloud" }> {
  const drafts = deterministicTriage(graph);
  if (client.id === "fallback" || drafts.length === 0) return { drafts, llm: "fallback" };
  const allowed = drafts.map((draft) => draft.sourceId).filter((id): id is string => Boolean(id));
  const raw = await client.complete(
    "Return JSON {\"proposals\": [{\"op\": \"create\" | \"link\", \"source_id\": string}]}. source_id must be one of the ids in the data. Do not add text, titles, or ids of your own.",
    {
      notes: graph
        .filter((item) => item.type === "note" || (item.type === "task" && item.status === "inbox"))
        .map((item) => ({ id: item.id, type: item.type, title: item.title, body: item.body })),
      people: graph.filter((item) => item.type === "person").map((item) => ({ id: item.id, title: item.title })),
      candidate_ids: allowed,
    },
  );
  const selected = modelSelection(raw, allowed);
  if (!selected) return { drafts, llm: "fallback" };
  return { drafts: drafts.filter((draft) => draft.sourceId && selected.includes(draft.sourceId)), llm: client.id };
}

async function composePeople(graph: Visible[], now: Date, timeZone: string, client: LlmClient, world: World): Promise<{ drafts: Draft[]; llm: "fallback" | "local" | "cloud" }> {
  const base = peopleToDrafts(peopleDrafts(graph, now, timeZone, world.selfKinds));
  return selectById(client, base, "Return JSON {\"proposals\":[{\"op\":\"create\",\"source_id\":string}]}. source_id must be one of the ids. Do not add names or instructions.", {
    people: base.map((draft) => ({ id: draft.sourceId, title: draft.title })),
  });
}

async function composeFixtures(graph: Visible[], now: Date, timeZone: string, client: LlmClient, world: World): Promise<{ drafts: Draft[]; focus: string; llm: "fallback" | "local" | "cloud" }> {
  const made = fixtureDraft(graph, now, timeZone, world);
  if (client.id === "fallback" || made.lines.length === 0) return { ...made, llm: "fallback" };
  const raw = await client.complete(
    "Return JSON {\"proposals\":[{\"op\":\"create\",\"source_id\":string}]}. source_id must be a fixture id from the data. Do not add scores, results, winners, standings, or points.",
    { fixtures: made.lines.map((line) => ({ id: line.id, line: line.line })) },
  );
  const selected = modelSelection(raw, made.lines.map((line) => line.id));
  if (!selected) return { ...made, llm: "fallback" };
  const kept = made.lines.filter((line) => selected.includes(line.id));
  return { ...fixtureNote(kept, zoned(now, timeZone).dateKey, world.sportArea), llm: client.id };
}

async function composeGoals(hmn: Hmn, access: ReturnType<typeof workerAccess>, graph: Visible[], client: LlmClient): Promise<{ drafts: Draft[]; llm: "fallback" | "local" | "cloud" }> {
  const base = goalToDrafts(goalDrafts(hmn, access, graph));
  return selectById(client, base, "Return JSON {\"proposals\":[{\"op\":\"create\",\"source_id\":string}]}. source_id must be a goal id from the data.", {
    goals: base.map((draft) => ({ id: draft.sourceId, title: draft.title })),
  });
}

async function selectById(client: LlmClient, drafts: Draft[], instructions: string, data: unknown): Promise<{ drafts: Draft[]; llm: "fallback" | "local" | "cloud" }> {
  const ids = drafts.map((draft) => draft.sourceId).filter((id): id is string => Boolean(id));
  if (client.id === "fallback" || ids.length === 0) return { drafts, llm: "fallback" };
  const raw = await client.complete(instructions, data);
  const selected = modelSelection(raw, ids);
  if (!selected) return { drafts, llm: "fallback" };
  return { drafts: drafts.filter((draft) => draft.sourceId && selected.includes(draft.sourceId)), llm: client.id };
}

function peopleToDrafts(items: ReturnType<typeof peopleDrafts>): Draft[] {
  return items.map((item) => ({
    op: "create" as const,
    sourceId: item.sourceId,
    title: item.title,
    entity: {
      type: "task",
      title: item.title,
      status: item.sourceId.includes(":quiet:") ? "inbox" : "open",
      kind: "task",
      area_id: item.area_id,
    },
    links: [{ rel: "about", to_type: "person", to_id: item.personId }],
    reason: item.reason,
    summary: item.summary,
    expiresOn: item.expiresOn,
  }));
}

function fixtureDraft(graph: Visible[], now: Date, timeZone: string, world: World): { drafts: Draft[]; focus: string; lines: Array<{ id: string; line: string }> } {
  const lines = watchLines(graph, now, timeZone, world.fixtureKinds);
  return { ...fixtureNote(lines, zoned(now, timeZone).dateKey, world.sportArea), lines };
}

function fixtureNote(lines: Array<{ id: string; line: string }>, day: string, areaId: string | null): { drafts: Draft[]; focus: string; lines: Array<{ id: string; line: string }> } {
  if (lines.length === 0) return { drafts: [], focus: "Nothing to watch.", lines };
  const body = lines.map((line) => line.line).join("\n");
  return {
    focus: "What to watch",
    lines,
    drafts: [
      {
        op: "create",
        sourceId: "watch",
        key: `watch:${day}`,
        family: "watch",
        expiresOn: plusDays(day, 6),
        repeatAfterApproval: true,
        title: "What to watch",
        entity: { type: "note", title: "What to watch", status: "open", body, area_id: areaId },
        reason: "Upcoming fixtures. Results are not stored.",
        summary: "Fixtures",
      },
    ],
  };
}

function goalToDrafts(items: ReturnType<typeof goalDrafts>): Draft[] {
  return items.map((item) => ({
    op: "create" as const,
    sourceId: item.sourceId,
    title: item.title,
    entity: { type: "task", title: item.title, status: "inbox", kind: "task", area_id: item.area_id },
    links: [{ rel: "about", to_type: "goal", to_id: item.goalId }],
    reason: item.reason,
    summary: item.summary,
    // A goal can need a next step again after the first one is done. A declined step stays declined.
    repeatAfterApproval: true,
  }));
}

function deterministicMorning(hmn: Hmn, access: ReturnType<typeof workerAccess>) {
  const screen = hmn.screen(access, "today");
  const items = screen.sections.flatMap((section) => section.items.map((item) => ({ id: item.id, title: item.title, subtitle: item.subtitle })));
  const top = items.slice(0, 3);
  return { focus: screen.summary, items, top, body: briefBody(screen.summary, top) };
}

function deterministicWeek(hmn: Hmn, access: ReturnType<typeof workerAccess>) {
  const screen = hmn.screen(access, "week");
  const zone = screen.date_label;
  const lines = [screen.summary, ""];
  const titles: string[] = [];
  for (const section of screen.sections) {
    lines.push(section.label);
    for (const item of section.items) {
      lines.push(item.title);
      titles.push(item.title);
    }
    lines.push("");
  }
  lines.push("Decide what next week is for. Leave the rest.");
  return {
    title: `Week of ${zone}`,
    summary: screen.summary,
    sections: lines.slice(2, -2).join("\n").trim(),
    text: lines.join("\n").trim(),
    titles,
  };
}

function deterministicTriage(graph: Visible[]): Draft[] {
  const people = graph.filter((item) => item.type === "person" && item.title.trim().length >= 3);
  const assets = graph.filter((item) => (item.type === "asset" || item.type === "project") && item.title.trim().length >= 4);
  const notes = graph.filter((item) => item.type === "note" && item.status === "open");
  const inbox = graph.filter((item) => item.type === "task" && item.status === "inbox");
  const drafts: Draft[] = [];
  for (const note of notes) {
    const meet = /^meet\s+([A-Za-z][A-Za-z'-]{1,40})$/i.exec(note.title.trim());
    if (meet) {
      const name = meet[1]!;
      const known = people.some((person) => person.title.toLowerCase() === name.toLowerCase());
      if (!known && !NAME_BLOCK.has(name.toLowerCase())) {
        drafts.push({
          sourceId: note.id,
          key: `${note.id}:person`,
          op: "create",
          title: name,
          entity: { type: "person", title: name, kind: "other" },
          reason: "From a captured note.",
          summary: "one note",
        });
      }
      continue;
    }
    const first = note.title.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
    if (VERBS.has(first)) {
      const links = mentioned(note.title, people, assets);
      drafts.push({
        sourceId: note.id,
        key: `${note.id}:task`,
        op: "create",
        title: note.title.trim().slice(0, 200),
        entity: { type: "task", title: note.title.trim().slice(0, 200), status: "inbox", kind: "task" },
        links,
        reason: "From a captured note.",
        summary: links.length ? "one note, People" : "one note",
      });
      continue;
    }
    const named = mentioned(note.title, people, []);
    for (const link of named) {
      drafts.push({
        sourceId: note.id,
        key: `${note.id}:link:${link.to_id}`,
        op: "link",
        link: { rel: "about", from_type: "note", from_id: note.id, to_type: link.to_type, to_id: link.to_id },
        reason: "The note names a person.",
        summary: "one note, People",
      });
    }
  }
  for (const task of inbox) {
    for (const link of mentioned(task.title, people, assets)) {
      drafts.push({
        sourceId: task.id,
        key: `${task.id}:link:${link.to_id}`,
        op: "link",
        link: { rel: "about", from_type: "task", from_id: task.id, to_type: link.to_type, to_id: link.to_id },
        reason: "The note names a person.",
        summary: "Inbox, People",
      });
    }
  }
  return drafts;
}

function mentioned(title: string, people: Visible[], others: Visible[]): Array<{ rel: string; to_type: string; to_id: string }> {
  const links: Array<{ rel: string; to_type: string; to_id: string }> = [];
  for (const person of people) {
    if (wholeWord(title, person.title)) links.push({ rel: "about", to_type: "person", to_id: person.id });
  }
  for (const other of others) {
    if (wholeWord(title, other.title)) links.push({ rel: "about", to_type: other.type, to_id: other.id });
  }
  return links;
}

function wholeWord(hay: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z])${escaped}([^A-Za-z]|$)`, "i").test(hay);
}

function briefBody(focus: string, top: Array<{ title: string; subtitle: string }>): string {
  const lines = [focus, ""];
  top.forEach((item, index) => lines.push(`${index + 1}. ${item.title}`));
  return lines.join("\n").trim();
}

function submitDrafts(hmn: Hmn, config: WorkerConfig, ceiling: Tier, drafts: Draft[], journalId?: string) {
  const access = workerAccess(config);
  access.ceiling = ceiling;
  const pending = hmn.listProposals(access, "pending");
  // The decisions are read by principal, not through the ceiling. A proposal above the ceiling still stops a repeat.
  const decisions = hmn.proposalDecisions(access.principal.id);
  const created: RunResult["proposals"] = [];
  for (const draft of drafts) {
    const key = draft.key ?? draft.sourceId;
    if (remembered(decisions, draft, key) || duplicate(pending, config.name, draft)) continue;
    try {
      const view = hmn.createProposal(
        access,
        {
          op: draft.op,
          payload:
            draft.op === "link"
              ? { op: "link", link: draft.link }
              : { op: "create", entity: draft.entity, links: draft.links ?? [] },
          reason: draft.reason,
          read_set: readSet(draft.summary, ceiling, journalId),
        },
        config.name,
        { sourceKey: key, expiresOn: draft.expiresOn },
      );
      if (key) decisions.push({ source_key: key, status: "pending" });
      created.push({
        id: view.id,
        op: draft.op,
        tier: "tier" in view ? view.tier : undefined,
        status: "status" in view ? String(view.status) : "pending",
        title: draft.title,
      });
    } catch (error) {
      if (error instanceof ApiError && (error.code === "ceiling" || error.code === "sealed" || error.code === "not_found" || error.code === "tier_floor" || error.code === "policy_deny")) {
        continue;
      }
      throw error;
    }
  }
  return created;
}

/** A pending, declined, or expired proposal with the same key stops the draft. An approved one stops it too, unless the draft can repeat. */
function remembered(decisions: Array<{ source_key: string; status: string }>, draft: Draft, key: string | undefined): boolean {
  return decisions.some((row) => {
    if (draft.family && row.status === "pending" && row.source_key.startsWith(`${draft.family}:`)) return true;
    if (!key || row.source_key !== key) return false;
    if (row.status === "approved") return !draft.repeatAfterApproval;
    return true;
  });
}

function plusDays(dateKey: string, days: number): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The older check, by title. It covers a pending proposal that has no source key. */
function duplicate(pending: ProposalView[], workerName: string, draft: Draft): boolean {
  return pending.some((proposal) => {
    if (proposal.agent_name !== workerName || proposal.redacted) return false;
    const payload = proposal.payload && typeof proposal.payload === "object" ? (proposal.payload as Record<string, unknown>) : {};
    if (draft.op === "create") {
      const entity = payload.entity && typeof payload.entity === "object" ? (payload.entity as { title?: string }) : {};
      return entity.title === draft.title;
    }
    const link = payload.link && typeof payload.link === "object" ? (payload.link as { from_id?: string; to_id?: string }) : {};
    return link.from_id === draft.link?.from_id && link.to_id === draft.link?.to_id;
  });
}

function hmnNow(hmn: Hmn): string {
  return hmnNowDate(hmn).toISOString();
}

function hmnNowDate(hmn: Hmn): Date {
  const screen = hmn.screen(workerAccess({ id: "morning", name: "Morning", tier: "public" }), "today");
  return new Date(screen.generated_at);
}

function hmnZone(hmn: Hmn): string {
  const screen = hmn.screen(workerAccess({ id: "morning", name: "Morning", tier: "public" }), "today");
  return screen.timezone;
}
