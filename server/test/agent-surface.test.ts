import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../src/app";
import { INSTRUCTIONS, READ_ONLY_TOOLS, TOOLS } from "../src/mcp";
import { runWorker } from "../src/workers/run";
import { call, testApp } from "./helpers";

function owner(app: App) {
  return { key: app.secrets!.owner, surface: "phone" };
}

let rpcId = 0;
async function tool(app: App, key: string, name: string, args: Record<string, unknown>) {
  rpcId += 1;
  const reply = await call(app, "/mcp", { method: "POST", key, body: { jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } } });
  const result = (reply.json as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { data: JSON.parse(result.content[0]!.text) as Record<string, any>, isError: result.isError === true, text: reply.text };
}

test("an agent finds a task by a question in plain words, and the best match is first", async () => {
  const app = testApp();
  try {
    const agent = app.secrets!.agent;
    const asked = await tool(app, agent, "search", { query: "What do I need to send this week?" });
    expect(asked.data.results[0].title).toBe("Send weekly notes");
    // A row above the ceiling is absent. The dentist task is about a child, so it is Private.
    expect((await tool(app, agent, "search", { query: "Who has a dentist visit?" })).text).not.toContain("dentist");
    expect((await call(app, "/api/v1/search?q=dentist", owner(app))).text).toContain("Book Luca's dentist");

    // A word in the title is worth more than the same word in the body.
    await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title: "Example shopping list", body: "The harbour ferry leaves at nine.", status: "open", area_id: "area_work" } });
    await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title: "Example harbour walk", body: "A fictional plan.", status: "open", area_id: "area_work" } });
    const ranked = await tool(app, agent, "search", { query: "harbour" });
    expect(ranked.data.results.map((item: { title: string }) => item.title)).toEqual(["Example harbour walk", "Example shopping list"]);

    // The search box needs each word. A part of a word still matches, as before.
    const strict = await call(app, "/api/v1/search?q=harbour%20zebra", owner(app));
    expect((strict.json as { results: unknown[] }).results).toEqual([]);
    const loose = await call(app, "/api/v1/search?q=harbour%20zebra&match=any", owner(app));
    expect((loose.json as { results: unknown[] }).results).toHaveLength(2);
    expect((await call(app, "/api/v1/search?q=arbou", owner(app))).text).toContain("Example harbour walk");

    // The index follows a change, and it holds no Sealed text.
    const walk = ranked.data.results[0].id as string;
    await call(app, `/api/v1/note/${walk}`, { method: "PATCH", ...owner(app), body: { title: "Example lighthouse walk" } });
    expect((await tool(app, agent, "search", { query: "lighthouse" })).data.results[0].id).toBe(walk);
    await call(app, `/api/v1/note/${walk}`, { method: "DELETE", ...owner(app) });
    expect((await tool(app, agent, "search", { query: "lighthouse" })).data.results).toEqual([]);
    const sealed = app.hmn.store.db.query("SELECT COUNT(*) AS n FROM search.entity_fts WHERE id IN (SELECT id FROM entities WHERE content_sealed = 1)").get() as { n: number };
    expect(sealed.n).toBe(0);
    expect((app.hmn.store.db.query("SELECT COUNT(*) AS n FROM entities WHERE content_sealed = 1").get() as { n: number }).n).toBeGreaterThan(0);
  } finally {
    app.close();
  }
});

test("neighbours walks the links to a depth, and it stops at the ceiling", async () => {
  const app = testApp();
  try {
    const agent = app.secrets!.agent;
    // task_notes -> project_brief -> goal_quiet. An agent sees all three.
    const one = await tool(app, agent, "neighbours", { type: "task", id: "task_notes" });
    expect(one.data.nodes.map((node: { id: string; distance: number }) => `${node.id}:${node.distance}`).sort()).toEqual(["project_brief:1", "task_notes:0"]);
    const two = await tool(app, agent, "neighbours", { type: "task", id: "task_notes", depth: 2 });
    expect(two.data.nodes.map((node: { id: string }) => node.id).sort()).toEqual(["goal_quiet", "project_brief", "task_notes"]);
    expect(two.data.edges).toHaveLength(2);
    expect((await tool(app, agent, "neighbours", { type: "task", id: "task_notes", depth: 99 })).data.depth).toBe(3);

    // The dentist task is about a child. The owner's phone walks to the child. The agent cannot start there.
    const mine = await call(app, "/api/v1/task/task_dentist/neighbours?depth=1", owner(app));
    expect((mine.json as { nodes: Array<{ id: string }> }).nodes.map((node) => node.id).sort()).toEqual(["person_luca", "task_dentist"]);
    expect((await tool(app, agent, "neighbours", { type: "task", id: "task_dentist" })).isError).toBe(true);
    // A note about a child hangs on the trip project. The agent's walk from the project does not reach it.
    const theirs = await tool(app, agent, "neighbours", { type: "project", id: "project_trip", depth: 2 });
    expect(theirs.text).not.toContain("person_yves");
    expect(theirs.text).not.toContain("note_trip");
    expect((await tool(app, agent, "neighbours", { type: "person", id: "person_yves" })).isError).toBe(true);
  } finally {
    app.close();
  }
});

test("one idempotency key makes one proposal, and the status tool follows it", async () => {
  const app = testApp();
  try {
    const agent = app.secrets!.agent;
    const args = { entity: { type: "task", title: "Renew the example permit", status: "open", kind: "task", area_id: "area_work", external_id: "mail-4411" }, reason: "A reminder in a message.", idempotency_key: "mail-4411:create" };
    const first = await tool(app, agent, "propose_create", args);
    const second = await tool(app, agent, "propose_create", args);
    expect(second.data.id).toBe(first.data.id);
    expect(first.data.replayed).toBeUndefined();
    expect(second.data.replayed).toBe(true);
    const count = () => (app.hmn.store.db.query("SELECT COUNT(*) AS n FROM proposals WHERE idempotency_key IS NOT NULL").get() as { n: number }).n;
    expect(count()).toBe(1);

    // The same key from another caller is another proposal. A new key from the same caller is too.
    const mine = await call(app, "/api/v1/proposals", { method: "POST", ...owner(app), body: { op: "create", entity: args.entity, idempotency_key: "mail-4411:create" } });
    expect(mine.status).toBe(201);
    expect((mine.json as { id: string }).id).not.toBe(first.data.id);
    expect((await tool(app, agent, "propose_create", { ...args, idempotency_key: "mail-4411:again" })).data.id).not.toBe(first.data.id);
    expect(count()).toBe(3);
    expect((await tool(app, agent, "propose_create", { ...args, idempotency_key: "has a space" })).isError).toBe(true);

    // REST: the header works, and a replay answers 200.
    const body = { op: "create", entity: { type: "task", title: "Example header task", status: "open", kind: "task", area_id: "area_work" } };
    const send = () => app.fetch(new Request("https://hmn.local/api/v1/proposals", {
      method: "POST",
      headers: { authorization: `Bearer ${agent}`, "x-hmn-surface": "mcp", "content-type": "application/json", "idempotency-key": "header-1" },
      body: JSON.stringify(body),
    }), "127.0.0.1");
    const a = await send();
    const b = await send();
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(((await a.json()) as { id: string }).id).toBe(((await b.json()) as { id: string }).id);

    // Status: pending, then approved with the entity that the agent can read.
    expect((await tool(app, agent, "proposal_status", { id: first.data.id })).data).toMatchObject({ status: "pending", entity_id: null, source: "key:key_agent" });
    await call(app, `/api/v1/proposals/${first.data.id}/approve`, { method: "POST", ...owner(app) });
    const status = await tool(app, agent, "proposal_status", { id: first.data.id });
    expect(status.data).toMatchObject({ status: "approved", decided_by: "owner" });
    const entity = await tool(app, agent, "get_entity", { type: "task", id: status.data.entity_id });
    expect(entity.data).toMatchObject({ title: "Renew the example permit", external_id: "mail-4411", origin: "agent" });
    // A retry after the decision still returns the first proposal, now approved.
    expect((await tool(app, agent, "propose_create", args)).data).toMatchObject({ id: first.data.id, status: "approved", replayed: true });
    expect((await tool(app, agent, "proposal_status", { id: "proposal_none" })).isError).toBe(true);
  } finally {
    app.close();
  }
});

test("the owner sees what an agent key read", async () => {
  const app = testApp();
  try {
    const agent = app.secrets!.agent;
    await tool(app, agent, "search", { query: "weekly notes" });
    await tool(app, agent, "get_entity", { type: "project", id: "project_brief" });
    await tool(app, agent, "neighbours", { type: "task", id: "task_notes" });
    // A worker and the owner are not in this log.
    await runWorker(app.hmn, "morning");
    await call(app, "/api/v1/search?q=weekly", owner(app));

    const log = await call(app, "/api/v1/access/key_agent/reads", owner(app));
    const reads = (log.json as { reads: Array<{ action: string; id: string | null; title: string | null }> }).reads;
    expect(reads.some((row) => row.action === "search" && row.title === "weekly notes")).toBe(true);
    expect(reads.some((row) => row.action === "read" && row.id === "project_brief" && row.title === "Weekly brief")).toBe(true);
    expect(reads.some((row) => row.action === "neighbours")).toBe(true);
    const principals = app.hmn.store.db.query("SELECT DISTINCT principal_id FROM client_reads").all() as Array<{ principal_id: string }>;
    expect(principals).toEqual([{ principal_id: "key_agent" }]);

    const connected = await call(app, "/api/v1/access", owner(app));
    const row = (connected.json as { connections: Array<{ name: string; reads: Array<{ title: string | null }> }> }).connections.find((item) => item.name === "agent")!;
    expect(row.reads.length).toBeGreaterThan(0);
    expect(JSON.stringify(row.reads)).toContain("Weekly brief");

    expect((await call(app, "/api/v1/access/key_agent/reads", { key: agent, surface: "mcp" })).status).toBe(403);
    expect((await call(app, "/api/v1/access/key_agent/reads", { key: app.secrets!.display })).status).toBe(403);
  } finally {
    app.close();
  }
});

test("the tool list has read-only labels, and the instructions are short", async () => {
  const app = testApp();
  try {
    expect(INSTRUCTIONS.length).toBeLessThan(2000);
    expect(INSTRUCTIONS).toContain("idempotency_key");
    expect(READ_ONLY_TOOLS.sort()).toEqual(["describe_schema", "free_busy", "get_entity", "list_entities", "list_links", "list_proposals", "my_requests", "neighbours", "proposal_status", "search"]);
    for (const item of TOOLS) {
      expect(item.annotations.destructiveHint).toBe(false);
      expect(item.annotations.openWorldHint).toBe(false);
      expect(item.name.startsWith("propose_") || item.name === "capture_inbox" || item.name === "request_feature").toBe(!item.annotations.readOnlyHint);
    }
    const hello = await call(app, "/mcp", { method: "POST", key: app.secrets!.agent, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } } });
    const result = (hello.json as { result: { protocolVersion: string; instructions: string } }).result;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.instructions).toBe(INSTRUCTIONS);
    const old = await call(app, "/mcp", { method: "POST", key: app.secrets!.agent, body: { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } } });
    expect((old.json as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2024-11-05");
    const listed = await call(app, "/mcp", { method: "POST", key: app.secrets!.agent, body: { jsonrpc: "2.0", id: 3, method: "tools/list" } });
    const first = (listed.json as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } }).result.tools[0]!;
    expect(first).toMatchObject({ name: "search", annotations: { readOnlyHint: true } });
  } finally {
    app.close();
  }
});

test("the stdio entry point is a pipe to the server: one JSON message on each line, and no answer to a notification", async () => {
  const app = testApp();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app.fetch(req, "127.0.0.1") });
  try {
    const proc = Bun.spawn({
      cmd: [process.execPath, new URL("../src/stdio.ts", import.meta.url).pathname],
      env: { PATH: process.env.PATH ?? "", HMN_API_KEY: app.secrets!.agent, HMN_URL: `http://127.0.0.1:${server.port}`, HMN_CA: new URL("../src/stdio.ts", import.meta.url).pathname },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { query: "weekly notes" } } },
    ];
    proc.stdin.write(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    proc.stdin.end();
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    const answers = out.trim().split("\n").map((line) => JSON.parse(line) as { id: number; result: Record<string, any> });
    expect(answers.map((answer) => answer.id)).toEqual([1, 2]);
    expect(answers[0]!.result.serverInfo.name).toBe("hmn");
    expect(answers[1]!.result.content[0].text).toContain("Send weekly notes");
    expect(out).not.toContain("Content-Length");

    // With no key the entry point stops, and it never opens the data directory.
    const script = new URL("../src/stdio.ts", import.meta.url).pathname;
    const bare = Bun.spawnSync({ cmd: [process.execPath, script], env: { PATH: process.env.PATH ?? "", HMN_NO_KEYCHAIN: "1" }, stderr: "pipe" });
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr.toString()).toContain("No agent key");

    // The key can come from a file, and the address and the certificate from arguments. No environment value is needed.
    const dir = mkdtempSync(join(tmpdir(), "hmn-stdio-"));
    writeFileSync(join(dir, "agent.key"), `${app.secrets!.agent}\n`, { mode: 0o600 });
    const byFile = Bun.spawn({
      cmd: [process.execPath, script, "--key-file", join(dir, "agent.key"), "--url", `http://127.0.0.1:${server.port}`, "--ca", script],
      env: { PATH: process.env.PATH ?? "", HMN_NO_KEYCHAIN: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    byFile.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })}\n`);
    byFile.stdin.end();
    const listed = JSON.parse((await new Response(byFile.stdout).text()).trim()) as { id: number; result: { tools: unknown[] } };
    expect(listed.id).toBe(7);
    // The key has no permission for busy times, so that one tool is not in its list.
    expect(listed.result.tools.length).toBe(TOOLS.length - 1);

    // A wrong key gives an error answer, not a stop.
    const wrong = Bun.spawn({ cmd: [process.execPath, script], env: { PATH: process.env.PATH ?? "", HMN_API_KEY: "hmn_wrong", HMN_URL: `http://127.0.0.1:${server.port}`, HMN_CA: script }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    wrong.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })}\n`);
    wrong.stdin.end();
    const refused = JSON.parse((await new Response(wrong.stdout).text()).trim()) as { id: number; error: { message: string } };
    expect(refused).toMatchObject({ id: 9, error: { message: "The key was refused." } });
  } finally {
    server.stop(true);
    app.close();
  }
});
