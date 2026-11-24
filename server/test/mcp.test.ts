import { afterAll, beforeAll, expect, test } from "bun:test";
import { call, testApp } from "./helpers";
import type { App } from "../src/app";

let app: App;
beforeAll(() => {
  app = testApp();
});
afterAll(() => app.close());

test("MCP lists tools and cannot see private or sealed rows", async () => {
  const listed = await call(app, "/mcp", {
    method: "POST",
    key: app.secrets!.agent,
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect(listed.status).toBe(200);
  const tools = (listed.json as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
  expect(tools).toContain("search");
  expect(tools).toContain("propose_create");
  expect(tools).not.toContain("create_entity");
  const found = await call(app, "/mcp", {
    method: "POST",
    key: app.secrets!.agent,
    body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { query: "Yves" } } },
  });
  expect(found.text).not.toContain("Yves");
  const race = await call(app, "/mcp", {
    method: "POST",
    key: app.secrets!.agent,
    body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "Grand Prix" } } },
  });
  expect(race.text).toContain("Lakeside Grand Prix");
  const proposal = await call(app, "/mcp", {
    method: "POST",
    key: app.secrets!.agent,
    body: {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "propose_create",
        arguments: { entity: { type: "task", title: "Agent task", status: "open", kind: "task", area_id: "area_work" }, reason: "A work reminder." },
      },
    },
  });
  expect(proposal.status).toBe(200);
  expect(proposal.text).toContain("pending");
  const direct = await call(app, "/api/v1/search?q=Agent%20task", { key: app.secrets!.owner, surface: "phone" });
  expect(direct.text).not.toContain("Agent task");
});
