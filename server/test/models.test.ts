import { expect, test } from "bun:test";
import { call, testApp } from "./helpers";
import { defaultLocalModel } from "../src/models/catalog";
import { modelClient } from "../src/models/client";
import { catalog } from "../src/models/catalog";
import { fallbackChain, privacyAllows, egressPreview, type ModelSpec } from "../src/models/policy";
import { readNotice, setCap, setCloudGrant, setRoute } from "../src/models/store";

const cloud: ModelSpec = {
  id: "cloud:openai",
  runtime: "cloud",
  name: "Cloud",
  version: "1",
  privacy: "cloud",
  capabilities: ["chat", "embeddings"],
  context: 1000,
  diskBytes: 0,
  ramBytes: 0,
  speed: "steady",
  endpoint: null,
  usdPerMillion: 5,
};

test("private and sealed data never route to a cloud model", () => {
  const models = catalog();
  const opted = { optIn: true, ceiling: "private" as const };
  expect(privacyAllows(cloud, "private", opted).ok).toBe(false);
  expect(privacyAllows(cloud, "sealed", { optIn: true, ceiling: "sealed" }).ok).toBe(false);
  expect(privacyAllows(cloud, "public", { optIn: true, ceiling: "private" }).ok).toBe(false);
  expect(privacyAllows(cloud, "public", { optIn: false, ceiling: "public" }).ok).toBe(false);
  expect(privacyAllows(cloud, "public", { optIn: true, ceiling: "public" }).ok).toBe(true);
  expect(privacyAllows(cloud, "personal", { optIn: true, ceiling: "public" }).ok).toBe(false);
  expect(privacyAllows(cloud, "personal", { optIn: true, ceiling: "personal" }).ok).toBe(true);
  const local = models.find((model) => model.id === "hmn.fallback");
  expect(local && privacyAllows(local, "sealed", { optIn: false, ceiling: null }).ok).toBe(true);

  const chain = fallbackChain("morning_brief", "private", [cloud, ...models.filter((model) => model.installed !== false && model.privacy !== "cloud").slice(0, 3), models[0]!], "cloud:openai", opted);
  expect(chain.some((model) => model.privacy === "cloud")).toBe(false);
  expect(chain[chain.length - 1]?.id).toBe("hmn.fallback");
});

test("a refused cloud route falls through to the deterministic model", async () => {
  const app = testApp();
  let called = false;
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("sealed")) called = true;
      return new Response("{}", { status: 404 });
    };
  try {
    setRoute(app.store.db, "triage", "cloud:openai");
    const result = await modelClient(app.store.db, fetchImpl).complete("triage", "sealed", "Say the sealed note.", { title: "sealed" }, {
      optIn: true,
      ceiling: "sealed",
    });
    expect(result.modelId).toBe("hmn.fallback");
    expect(result.privacy).toBe("local");
    expect(result.text).toBe("");
    expect(called).toBe(false);
  } finally {
    app.close();
  }
});

test("proposals record the model that produced them", async () => {
  const app = testApp();
  try {
    const created = await call(app, "/api/v1/proposals", {
      method: "POST",
      key: app.secrets!.agent,
      surface: "mcp",
      agent: "Morning",
      body: {
        op: "create",
        entity: { type: "note", title: "Morning note", status: "open", area_id: "area_work" },
        reason: "A local model drafted this.",
        model_id: "ollama:qwen2.5:7b",
        model_version: "7b",
      },
    });
    expect(created.status).toBe(201);
    expect(created.text).toContain("ollama:qwen2.5:7b");
    expect(created.text).toContain("7b");
    const page = await call(app, "/api/v1/models.html", { key: app.secrets!.owner, surface: "phone" });
    expect(page.status).toBe(200);
    expect(page.text).toContain("Deterministic");
    expect(page.text).toContain("Voice stays on this Mac");
    expect(page.text).not.toContain("Yves");
    const display = await call(app, "/api/v1/models.html", { key: app.secrets!.display, surface: "display" });
    expect(display.status).toBe(404);
    const remote = await call(app, "/api/v1/admin/models", { key: app.secrets!.owner, ip: "10.1.1.1" });
    expect(remote.status).toBe(403);
    const refused = await call(app, "/api/v1/admin/models/route", {
      method: "POST",
      key: app.secrets!.owner,
      ip: "127.0.0.1",
      body: { task: "morning_brief", model_id: "cloud:openai", tier: "private" },
    });
    expect(refused.status).toBe(422);
    expect(refused.text).toContain("stay on this machine");
  } finally {
    app.close();
  }
});

test("semantic search stays inside the ceiling", async () => {
  const app = testApp();
  try {
    const indexed = await call(app, "/api/v1/admin/models/index", { method: "POST", key: app.secrets!.owner, surface: "phone", ip: "127.0.0.1" });
    expect(indexed.status).toBe(200);
    const found = await call(app, "/api/v1/search?q=passport&semantic=1", { key: app.secrets!.owner, surface: "phone" });
    expect(found.text).not.toContain("passport");
    const agent = await call(app, "/api/v1/search?q=weekly&semantic=1", { key: app.secrets!.agent, surface: "mcp" });
    expect(agent.text).not.toContain("Luca");
    expect(agent.text).not.toContain("clinic");
  } finally {
    app.close();
  }
});

test("cloud egress is logged, and private text never leaves", async () => {
  const app = testApp();
  let sent = "";
  const fetchImpl: typeof fetch = async (url, init) => {
    sent += `${url}\n${typeof init?.body === "string" ? init.body : ""}`;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  try {
    setCloudGrant(app.store.db, true, "public", "https://example.test/v1/chat/completions");
    setRoute(app.store.db, "chat", "cloud:openai");
    const preview = egressPreview("Summarise.", { id: "note_public", tier: "public", title: "Race day" }, "example.test", 5);
    expect(preview.entities).toEqual([{ id: "note_public", tier: "public" }]);
    expect(preview.tokens).toBe(Math.ceil(preview.chars / 4));
    expect(JSON.stringify(preview.entities)).not.toContain("Race day");

    const allowed = await modelClient(app.store.db, fetchImpl).complete(
      "chat",
      "public",
      "Summarise.",
      { id: "note_public", tier: "public", title: "Race day" },
      { optIn: true, ceiling: "public" },
      "2026-11-11T04:39:00.000Z",
    );
    expect(allowed.modelId).toBe("cloud:openai");
    expect(sent).toContain("example.test");
    expect(sent).not.toContain("passport");

    sent = "";
    const blocked = await modelClient(app.store.db, fetchImpl).complete(
      "chat",
      "public",
      "Summarise.",
      { id: "note_sealed", tier: "sealed", title: "passport expires" },
      { optIn: true, ceiling: "public" },
      "2026-11-11T04:39:00.000Z",
    );
    expect(blocked.modelId).toBe("hmn.fallback");
    expect(sent).not.toContain("example.test");
    expect(sent).not.toContain("passport");

    setCap(app.store.db, 0.000001);
    sent = "";
    const capped = await modelClient(app.store.db, fetchImpl).complete(
      "chat",
      "public",
      "Summarise.",
      { id: "note_public", tier: "public", title: "Race day" },
      { optIn: true, ceiling: "public" },
      "2026-11-11T04:39:00.000Z",
    );
    expect(capped.modelId).toBe("hmn.fallback");
    expect(sent).not.toContain("example.test");
    const spend = await call(app, "/api/v1/models/spend", { key: app.secrets!.owner, surface: "phone" });
    expect(spend.status).toBe(200);
    const body = spend.json as { cap_usd: number; notice: string | null; usd: number };
    expect(body.cap_usd).toBe(0.000001);
    expect(body.notice).toContain("monthly cap");
    expect(spend.text).not.toContain("passport");
    expect(spend.text).not.toContain("Race day");
    const rows = app.store.db.query("SELECT destination, entities, blocked, capped FROM model_egress").all() as Array<{
      destination: string;
      entities: string;
      blocked: number;
      capped: number;
    }>;
    expect(rows.some((row) => row.blocked === 1 && row.entities.includes("note_sealed") && row.destination === "example.test")).toBe(true);
    expect(rows.some((row) => row.capped === 1)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("passport");
    expect(readNotice(app.store.db, "2026-11")).toContain("monthly cap");
  } finally {
    app.close();
  }
});

test("the default local model follows the memory table", () => {
  expect(defaultLocalModel(8, "apple")).toBe("ollama:qwen2.5:3b");
  expect(defaultLocalModel(16, "apple")).toBe("ollama:qwen2.5:7b");
  expect(defaultLocalModel(24, "apple")).toBe("ollama:qwen2.5:14b");
  expect(defaultLocalModel(48, "apple")).toBe("ollama:qwen2.5:32b");
  expect(defaultLocalModel(64, "intel")).toBe("ollama:qwen2.5:3b");
});
