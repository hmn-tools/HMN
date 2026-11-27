import { fontFile, todayHtml } from "./html";
import { gardenPage, words } from "./garden";
import type { Hmn } from "./hmn";
import { handleMcp } from "./mcp";
import { todayPng } from "./png";
import { DECK, EXTRA_SCREENS } from "./screens";
import { type Access, ApiError, ENTITY_TYPES, type EntityType, type Surface, SURFACES, VERSION } from "./types";
import { handleWorkerRequest, isWorkerPath } from "./workers/route";
import { deviceDisplay, handleDeviceAdmin, handleDeviceRequest, isDevicePath } from "./devices/route";
import { hasHouseholdDisplay } from "./devices/trmnl";
import { handleExternalAdmin } from "./external/http";
import { accessConnections, accessHtml } from "./access/list";
import { getJournal } from "./journal";
import { assertScope } from "./policy";

const SECURITY: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
    "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'",
};

const BROWSE_TITLES: Record<string, string> = {
  person: "People",
  place: "Places",
  asset: "Things",
  goal: "Goals",
  note: "Notes",
  project: "Projects",
  task: "Tasks",
  event: "Events",
  area: "Areas",
};

function browseSubtitle(entity: { kind?: string | null; status?: string | null; tier?: string | null }): string {
  return [entity.kind, entity.status, entity.tier].filter((part): part is string => Boolean(part)).map(words).join(" · ");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY },
  });
}

function text(body: string, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": contentType, ...SECURITY } });
}

function bytes(body: Uint8Array, contentType: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType, ...SECURITY } });
}

function failure(error: unknown): Response {
  if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status);
  console.error("hmn request failed");
  return json({ error: { code: "internal", message: "The server could not finish that." } }, 500);
}

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const access = req.headers.get("access-token");
  if (access) return access.trim();
  return null;
}

function surfaceOf(req: Request, url: URL): Surface {
  if (url.pathname.startsWith("/api/display")) return "display";
  if (url.pathname === "/mcp") return "mcp";
  const header = req.headers.get("x-hmn-surface");
  if (header && (SURFACES as readonly string[]).includes(header)) return header as Surface;
  return "api";
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > 256_000) throw new ApiError(413, "too_large", "That request is too large.");
  const textBody = await req.text();
  if (textBody.length > 256_000) throw new ApiError(413, "too_large", "That request is too large.");
  if (!textBody) return {};
  try {
    const value = JSON.parse(textBody) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object");
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      out[key] = entry;
    }
    return out;
  } catch {
    throw new ApiError(422, "invalid", "The body was not a JSON object.");
  }
}

export async function handleRequest(hmn: Hmn, req: Request, ip: string | null, fingerprint: string): Promise<Response> {
  try {
    const response = await route(hmn, req, ip, fingerprint);
    hmnPersist(hmn);
    return response;
  } catch (error) {
    hmnPersist(hmn);
    return failure(error);
  }
}

function hmnPersist(hmn: Hmn) {
  try {
    hmn.saveSoon();
  } catch {
    // A failed checkpoint should not hide the response. The next write tries again.
  }
}

async function route(hmn: Hmn, req: Request, ip: string | null, fingerprint: string): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (isDevicePath(pathname)) return handleDeviceRequest(hmn, req, url, ip);
  if (req.method === "GET" && pathname === "/health") {
    return json({ ok: true, service: "hmn", version: VERSION, time: new Date().toISOString(), plugins: [] });
  }
  if (req.method === "GET" && pathname === "/") {
    return text(
      gardenPage("HMN", `<h1>HMN</h1><div class="card"><p>This is a private server. It does not list your things.</p><p class="s">Open the HMN app on your phone to see your day.</p></div>`),
      "text/html; charset=utf-8",
    );
  }
  if (req.method === "GET" && pathname.startsWith("/assets/fonts/")) {
    const name = pathname.slice("/assets/fonts/".length);
    const file = fontFile(name);
    if (!file) return json({ error: { code: "not_found", message: "Not found." } }, 404);
    return bytes(file, "font/ttf");
  }
  if (req.method === "POST" && pathname === "/api/v1/pair") {
    const body = await readJson(req);
    const code = typeof body.code === "string" ? body.code : "";
    const name = typeof body.device_name === "string" ? body.device_name : "iPhone";
    return json(hmn.redeemPair(code, name, ip), 201);
  }
  if (req.method === "GET" && pathname === "/api/v1/plugins/google/start") {
    const redirect = url.searchParams.get("redirect") ?? "https://127.0.0.1:8787/api/v1/plugins/google/callback";
    return json(hmn.googleStart(ip, redirect));
  }
  if (req.method === "GET" && pathname === "/api/v1/plugins/google/callback") {
    const redirect = `${url.origin}/api/v1/plugins/google/callback`;
    return json(await hmn.googleCallback(ip, url.searchParams.get("code") ?? "", redirect));
  }
  if (req.method === "POST" && pathname === "/mcp") {
    const token = tokenFrom(req, url, false);
    if (!token) return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
    const access = hmn.accessFor(token, ip, "mcp", req.headers.get("x-hmn-grant"));
    const body = await readJson(req);
    const result = await handleMcp(hmn, access, body);
    return json(result);
  }

  const token = tokenFrom(req, url, pathname.startsWith("/api/display"));
  if (!token) return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
  if (req.method === "POST" && pathname === "/api/v1/owner/renew") {
    return json(hmn.renewOwner(hmn.accessFor(token, ip, "api", null, "main", { renewOwner: true }), ip));
  }
  const surface = surfaceOf(req, url);
  const access = hmn.accessFor(token, ip, surface, req.headers.get("x-hmn-grant"));

  if (req.method === "POST" && pathname === "/api/v1/pairing") return json(hmn.createPairing(access, ip, fingerprint));
  if (isWorkerPath(pathname)) return handleWorkerRequest(hmn, req, url, access, ip);
  if (pathname.startsWith("/api/v1/trmnl/")) return handleDeviceAdmin(hmn, req, url, access, ip);
  if (pathname.startsWith("/api/v1/external")) return handleExternalAdmin(hmn, req, url, access, ip);
  // A household member writes through the member rules: each write is applied at once (200) or waits for the owner (202).
  if (access.principal.member && req.method !== "GET") {
    const answer = await memberRoute(hmn, req, pathname, access);
    if (answer) return answer;
  }
  // The owner's household: member pairing codes, the member phones, and their revocation.
  if (req.method === "POST" && pathname === "/api/v1/members/pairing") return json(hmn.createMemberPairing(access, await readJson(req), fingerprint, url.origin), 201);
  if (req.method === "GET" && pathname === "/api/v1/members/pairing/fridge") return json({ fridge: hmn.fridgePairingStatus(access), ready: hasHouseholdDisplay(hmn) });
  if (req.method === "DELETE" && pathname === "/api/v1/members/pairing/fridge") return json(hmn.cancelFridgePairing(access));
  if (req.method === "GET" && pathname === "/api/v1/members") return json({ members: hmn.members(access) });
  const memberPath = pathname.match(/^\/api\/v1\/members\/([A-Za-z0-9_]+)$/);
  if (req.method === "DELETE" && memberPath) return json(hmn.revokeMember(access, memberPath[1]!));
  const reads = pathname.match(/^\/api\/v1\/access\/([^/]+)\/reads$/);
  if (req.method === "GET" && reads) {
    return json({ reads: hmn.clientReads(access, decodeURIComponent(reads[1]!), Number(url.searchParams.get("limit") ?? 50) || 50) });
  }
  const agentPage = pathname.match(/^\/api\/v1\/access\/([^/]+)\/(scope|today|timeline)$/);
  if (req.method === "GET" && agentPage) {
    const id = decodeURIComponent(agentPage[1]!);
    if (agentPage[2] === "scope") return json(hmn.agentScope(access, id));
    if (agentPage[2] === "today") return json(hmn.agentToday(access, id));
    return json(hmn.agentTimeline(access, id, Number(url.searchParams.get("limit") ?? 100) || 100));
  }
  if (req.method === "GET" && (pathname === "/api/v1/access" || pathname === "/api/v1/access.html")) {
    if (access.principal.scope !== "write") throw new ApiError(403, "forbidden", "The owner sees connected clients.");
    const body = accessConnections(hmn, access);
    if (pathname.endsWith(".html")) return text(accessHtml(body.connections), "text/html; charset=utf-8");
    return json(body);
  }
  const accessRevoke = pathname.match(/^\/api\/v1\/access\/([^/]+)\/revoke$/);
  if (req.method === "POST" && accessRevoke) {
    if (access.principal.scope !== "write") throw new ApiError(403, "forbidden", "The owner revokes a client.");
    const id = decodeURIComponent(accessRevoke[1]!);
    if (id.startsWith("plugin:")) throw new ApiError(422, "plugin", "A plugin has no key to revoke.");
    const result = hmn.revoke(access, id);
    return json(result);
  }
  const journalOne = pathname.match(/^\/api\/v1\/journals\/([^/]+)$/);
  if (req.method === "GET" && journalOne) {
    const entry = getJournal(hmn, access, decodeURIComponent(journalOne[1]!));
    if (!entry) return json({ error: { code: "not_found", message: "Not found." } }, 404);
    return json(entry);
  }

  if (req.method === "GET" && pathname === "/api/v1/me") return json(hmn.me(access));
  if (req.method === "GET" && pathname === "/api/v1/screens") {
    return json({
      screens: [...DECK, ...EXTRA_SCREENS].map((screen, index) => ({ ...screen, index: index + 1 })),
    });
  }
  if (req.method === "GET" && pathname === "/api/v1/plugins") return json(hmn.pluginStatus());
  const pluginTick = pathname.match(/^\/api\/v1\/plugins\/([a-z]+)\/tick$/);
  if (req.method === "POST" && pluginTick) {
    return json(await hmn.tickPlugin(access, pluginTick[1]!, await readJson(req), ip));
  }
  if (req.method === "GET" && pathname === "/api/v1/screens/lock") return json(hmn.lockPayload(access));
  const checkIn = pathname.match(/^\/api\/v1\/habits\/([^/]+)\/check-in$/);
  if (req.method === "POST" && checkIn) return json(hmn.checkIn(access, decodeURIComponent(checkIn[1]!)));
  if (req.method === "DELETE" && checkIn) return json(hmn.uncheck(access, decodeURIComponent(checkIn[1]!)));
  // Routines: habits for a person, mostly the children. docs/ONTOLOGY.md, section 2.5.
  if (req.method === "GET" && pathname === "/api/v1/routines") return json({ routines: hmn.routines(access) });
  if (req.method === "POST" && pathname === "/api/v1/routines") return json(hmn.createRoutine(access, await readJson(req)), 201);
  if (req.method === "GET" && pathname === "/api/v1/audit/tip") {
    assertScope(access, "write");
    return json(hmn.auditTip());
  }
  if (req.method === "POST" && pathname === "/api/v1/audit/tip/check") {
    assertScope(access, "write");
    const body = await readJson(req);
    return json(hmn.auditExtends(typeof body.tip === "string" ? body.tip : ""));
  }
  if (req.method === "POST" && pathname === "/api/v1/plugins/health/submit") {
    return json(await hmn.submitHealth(access, await readJson(req)), 201);
  }
  const screenPath = pathname.match(/^\/api\/v1\/screens\/([a-z]+)(\.html)?$/);
  if (req.method === "GET" && screenPath) {
    const screen = hmn.screen(access, screenPath[1]!);
    if (screenPath[2]) return text(todayHtml(screen, surface !== "display"), "text/html; charset=utf-8");
    const { entity_ids: _ids, ...rest } = screen;
    return json(rest);
  }
  const browse = pathname.match(/^\/api\/v1\/browse\/([a-z]+)(\.html)?$/);
  if (req.method === "GET" && browse) {
    const listed = hmn.browse(access, browse[1] as never);
    if (browse[2]) {
      const title = BROWSE_TITLES[listed.type] ?? `${words(listed.type)}s`;
      const count = listed.entities.length;
      const screen = {
        ...hmn.screen(access, "today"),
        id: browse[1]!,
        label: title,
        greeting: count ? title : "Nothing here yet.",
        summary: count ? `${count} in view.` : "Nothing to show at this ceiling.",
        next_label: "",
        // The stored words of a row (its tier, status, and kind) are shown as words.
        sections: count
          ? [{ id: listed.type, label: title, items: listed.items.map((item, index) => ({ ...item, subtitle: browseSubtitle(listed.entities[index]!) })) }]
          : [],
        in_deck: false,
        closing: null,
      };
      return text(todayHtml(screen, true), "text/html; charset=utf-8");
    }
    return json({ entities: listed.entities });
  }
  if (req.method === "GET" && pathname === "/api/display") {
    if (req.headers.get("id")) return deviceDisplay(hmn, req, url, token, ip);
    const forced = url.searchParams.get("screen");
    const screen = hmn.displayScreen(access, forced);
    const image = access.principal.maxTier === "public"
      ? `${url.origin}/api/display/${screen.id}.png?access_token=${encodeURIComponent(token)}`
      : `${url.origin}/api/display/${screen.id}.png`;
    return json({
      status: 0,
      image_url: image,
      filename: screen.id,
      refresh_rate: screen.refresh_seconds,
      reset_firmware: false,
      special_function: "none",
      screen: screen.id,
      screen_index: screen.in_deck ? screen.index : 1,
      screen_count: 4,
    });
  }
  const displayFile = pathname.match(/^\/api\/display\/([a-z]+)\.(html|png)$/);
  if (req.method === "GET" && displayFile) {
    const screen = hmn.screen(access, displayFile[1]!);
    if (displayFile[2] === "png") return bytes(todayPng(screen), "image/png");
    return text(todayHtml(screen, false), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/api/v1/inbox/tags") {
    return json({ tags: hmn.inboxTags(access, url.searchParams.get("q") ?? "") });
  }
  if (req.method === "GET" && pathname === "/api/v1/inbox") {
    return json({ items: hmn.listInbox(access, url.searchParams.get("status") ?? "new") });
  }
  if (req.method === "POST" && (pathname === "/api/v1/inbox" || pathname === "/api/v1/inbox/in")) {
    const body = await readJson(req);
    if (pathname.endsWith("/in") && !body.source) body.source = "webhook";
    return json(hmn.captureInbox(access, body), 201);
  }
  const history = pathname.match(/^\/api\/v1\/([a-z]+)\/([^/]+)\/history$/);
  if (req.method === "GET" && history) {
    return json({ versions: hmn.history(access, history[1] as never, decodeURIComponent(history[2]!)) });
  }
  const purge = pathname.match(/^\/api\/v1\/([a-z]+)\/([^/]+)\/purge$/);
  if (req.method === "POST" && purge) {
    return json(hmn.purge(access, purge[1] as never, decodeURIComponent(purge[2]!)));
  }
  const inboxAction = pathname.match(/^\/api\/v1\/inbox\/([^/]+)\/process$/);
  if (req.method === "POST" && inboxAction) {
    return json(hmn.processInbox(access, decodeURIComponent(inboxAction[1]!), await readJson(req)));
  }
  if (req.method === "GET" && pathname === "/api/v1/search") {
    const match = url.searchParams.get("match") === "any" ? "any" : "all";
    return json({ results: hmn.search(access, url.searchParams.get("q") ?? "", url.searchParams.get("semantic") === "1", match) });
  }
  if (req.method === "GET" && pathname === "/api/v1/models.html") {
    return text(await hmn.modelsDocument(access), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/api/v1/models/spend") return json(hmn.modelSpend(access));
  if (req.method === "GET" && pathname === "/api/v1/proposals") {
    return json({ proposals: hmn.listProposals(access, url.searchParams.get("status"), url.searchParams.get("source")) });
  }
  if (req.method === "POST" && pathname === "/api/v1/proposals/batch") return json(hmn.decideBatch(access, await readJson(req)));
  // Lists and their items, and the steps of a task. An item is a task of the kind `item`, part of its parent.
  if (req.method === "GET" && pathname === "/api/v1/lists") return json({ lists: hmn.lists(access) });
  if (req.method === "GET" && pathname === "/api/v1/family-tasks") return json({ tasks: hmn.familyTasks(access) });
  if (req.method === "GET" && pathname === "/api/v1/items") return json(hmn.items(access, url.searchParams.get("parent_id") ?? ""));
  if (req.method === "POST" && pathname === "/api/v1/items") return json(hmn.addItem(access, await readJson(req)), 201);
  if (req.method === "GET" && pathname === "/api/v1/activity") return json(hmn.activity(access, Number(url.searchParams.get("limit") ?? 100) || 100));
  if (req.method === "POST" && pathname === "/api/v1/import") return json(hmn.importRecords(access, await readJson(req)));
  if (req.method === "GET" && pathname === "/api/v1/free-busy") return json(hmn.freeBusy(access, url.searchParams.get("from"), url.searchParams.get("to")));
  if (req.method === "GET" && pathname === "/api/v1/keys") return json(hmn.keysList(access));
  if (req.method === "POST" && pathname === "/api/v1/keys") return json(hmn.keyCreate(access, ip, await readJson(req)), 201);
  const keyPath = pathname.match(/^\/api\/v1\/keys\/([A-Za-z0-9_]+)(?:\/(private|preview))?$/);
  if (keyPath) {
    const keyId = keyPath[1]!;
    if (req.method === "POST" && !keyPath[2]) return json(hmn.keyChange(access, keyId, await readJson(req)));
    if (req.method === "GET" && keyPath[2] === "preview") return json(hmn.keyPreview(access, keyId));
    if (req.method === "POST" && keyPath[2] === "private") return json(hmn.keyGrantPrivate(access, keyId, await readJson(req)));
    if (req.method === "DELETE" && keyPath[2] === "private") return json(hmn.keyEndPrivate(access, keyId));
  }
  if (req.method === "GET" && pathname === "/api/v1/kinds") return json(hmn.kindsList(access));
  if (req.method === "PUT" && pathname === "/api/v1/kinds") return json(hmn.kindSave(access, await readJson(req)));
  if (req.method === "POST" && pathname === "/api/v1/agent-requests") return json(hmn.agentRequest(access, await readJson(req)), 201);
  if (req.method === "GET" && pathname === "/api/v1/agent-requests") return json(hmn.agentRequests(access, url.searchParams.get("status")));
  if (req.method === "GET" && pathname === "/api/v1/dates/unreadable") return json(hmn.unreadableDates(access));
  if (req.method === "GET" && pathname === "/api/v1/agent-requests/mine") return json(hmn.myRequests(access));
  const requestPath = pathname.match(/^\/api\/v1\/agent-requests\/(req_[A-Za-z0-9_-]+)$/);
  if (req.method === "PATCH" && requestPath) return json(hmn.agentRequestSet(access, requestPath[1]!, await readJson(req)));
  if (req.method === "GET" && pathname === "/api/v1/schema/agent") return json(hmn.schemaForAgent(access));
  const kindFields = pathname.match(/^\/api\/v1\/kinds\/([a-z]+)\/([a-z0-9_]+)\/fields$/);
  if (req.method === "PUT" && kindFields) return json(hmn.kindFieldsSave(access, kindFields[1]!, kindFields[2]!, await readJson(req)));
  const kindPath = pathname.match(/^\/api\/v1\/kinds\/([a-z]+)\/([a-z0-9_]+)$/);
  if (req.method === "DELETE" && kindPath) return json(hmn.kindRemove(access, kindPath[1]!, kindPath[2]!));
  if (req.method === "GET" && pathname === "/api/v1/calendars") return json(hmn.calendars(access));
  if (req.method === "POST" && pathname === "/api/v1/calendars") return json(hmn.calendarSave(access, null, await readJson(req)), 201);
  if (req.method === "POST" && pathname === "/api/v1/calendars/sync") {
    assertScope(access, "write");
    return json({ results: await hmn.mirrorCalendars(true) });
  }
  const calendar = pathname.match(/^\/api\/v1\/calendars\/([^/]+)$/);
  if (req.method === "POST" && calendar) return json(hmn.calendarSave(access, decodeURIComponent(calendar[1]!), await readJson(req)));
  if (req.method === "GET" && pathname === "/api/v1/policy") return json(hmn.policyList(access));
  if (req.method === "PUT" && pathname === "/api/v1/policy") return json(hmn.policySet(access, await readJson(req)));
  if (req.method === "DELETE" && pathname.startsWith("/api/v1/policy/")) {
    return json(hmn.policyRemove(access, decodeURIComponent(pathname.slice("/api/v1/policy/".length))));
  }
  if (req.method === "POST" && pathname === "/api/v1/proposals") {
    const body = await readJson(req);
    // The owner can name the source of a proposal that it files. Each other key has the name that the owner gave it.
    const named = access.principal.name.replace(/^external:/, "");
    const agent = access.principal.scope === "write" ? (req.headers.get("x-hmn-agent") ?? named) : named;
    // A retry sends the same key in the header or in the body. It gets the first proposal back, with 200.
    const made = hmn.createProposal(access, body, agent, { idempotencyKey: req.headers.get("idempotency-key") });
    return json(made, "replayed" in made && made.replayed ? 200 : 201);
  }
  if (req.method === "POST" && pathname === "/api/v1/vault/grants") return json(hmn.mintGrant(access), 201);
  if (req.method === "POST" && pathname === "/api/v1/panic") return json(hmn.panic(access));
  if (req.method === "POST" && pathname === "/api/v1/panic/clear") {
    const body = await readJson(req);
    return json(hmn.clearPanic(access, ip, typeof body.id === "string" ? body.id : access.principal.id));
  }
  if (req.method === "POST" && pathname === "/api/v1/backup") return json(hmn.backup(access, ip));
  if (req.method === "GET" && pathname === "/api/v1/audit") return json({ entries: hmn.auditList(access) });
  if (req.method === "GET" && pathname === "/api/v1/audit/verify") {
    assertScope(access, "write");
    const result = hmn.verifyAudit();
    return json(result, result.ok ? 200 : 409);
  }
  if (req.method === "POST" && pathname === "/api/v1/admin/rotate-keys") return json(hmn.adminRotateKeys(access, ip));
  if (req.method === "GET" && pathname === "/api/v1/admin/status") return json(hmn.adminStatus(access, ip, fingerprint));
  if (req.method === "GET" && pathname === "/api/v1/admin/devices") return json(hmn.adminDevices(access, ip));
  if (req.method === "POST" && pathname === "/api/v1/admin/panic") return json(hmn.adminPanic(access, ip));
  if (req.method === "POST" && pathname === "/api/v1/admin/panic/clear") return json(hmn.adminClearPanic(access, ip));
  if (req.method === "GET" && pathname === "/api/v1/admin/backups") return json(hmn.adminBackups(access, ip));
  if (req.method === "POST" && pathname === "/api/v1/admin/restore") return json(hmn.adminRestore(access, ip, await readJson(req)));
  if (req.method === "GET" && pathname === "/api/v1/admin/models") return json(await hmn.modelsAdmin(access, ip));
  if (req.method === "POST" && pathname === "/api/v1/admin/models/route") {
    const body = await readJson(req);
    return json(hmn.modelRoute(access, ip, String(body.task ?? ""), String(body.model_id ?? ""), body.tier));
  }
  if (req.method === "POST" && pathname === "/api/v1/admin/models/pull") {
    const body = await readJson(req);
    return json(await hmn.modelPull(access, ip, String(body.model_id ?? "")));
  }
  if (req.method === "POST" && pathname === "/api/v1/admin/models/remove") {
    const body = await readJson(req);
    return json(await hmn.modelRemove(access, ip, String(body.model_id ?? "")));
  }
  if (req.method === "POST" && pathname === "/api/v1/admin/models/pin") {
    const body = await readJson(req);
    return json(hmn.modelPin(access, ip, String(body.model_id ?? ""), String(body.version ?? "")));
  }
  if (req.method === "POST" && pathname === "/api/v1/admin/models/warm") {
    const body = await readJson(req);
    return json(await hmn.modelWarm(access, ip, String(body.model_id ?? ""), body.unload === true));
  }
  if (req.method === "POST" && pathname === "/api/v1/admin/models/index") return json(await hmn.modelIndex(access, ip));
  if (req.method === "POST" && pathname === "/api/v1/admin/models/cap") {
    const body = await readJson(req);
    return json(hmn.modelCap(access, ip, Number(body.usd)));
  }
  if (req.method === "POST" && pathname === "/api/v1/links") return json(hmn.createLink(access, await readJson(req)), 201);

  const proposal = pathname.match(/^\/api\/v1\/proposals\/([^/]+)(?:\/(approve|reject|undo|clear|admit-kind))?$/);
  if (proposal) {
    const id = decodeURIComponent(proposal[1]!);
    const action = proposal[2];
    if (req.method === "POST" && action === "approve") return json(hmn.approve(access, id));
    if (req.method === "POST" && action === "admit-kind") return json(hmn.admitKind(access, id, await readJson(req)));
    if (req.method === "POST" && action === "reject") return json(hmn.reject(access, id));
    if (req.method === "POST" && action === "undo") return json(hmn.undo(access, id));
    if (req.method === "POST" && action === "clear") return json(hmn.clearDecline(access, id));
    if (req.method === "PATCH" && !action) return json(hmn.editProposal(access, id, await readJson(req)));
  }
  const device = pathname.match(/^\/api\/v1\/devices\/([^/]+)\/revoke$/);
  if (req.method === "POST" && device) return json(hmn.revoke(access, decodeURIComponent(device[1]!)));
  const rotate = pathname.match(/^\/api\/v1\/credentials\/([^/]+)\/rotate$/);
  if (req.method === "POST" && rotate) return json(hmn.rotate(access, ip, decodeURIComponent(rotate[1]!)));

  if (req.method === "DELETE" && pathname.startsWith("/api/v1/links/")) {
    return json(hmn.removeLink(access, decodeURIComponent(pathname.slice("/api/v1/links/".length))));
  }
  // The yearly review, and the owner's note for a year. docs/STRATEGY.md, role 7.
  if (req.method === "GET" && pathname === "/api/v1/review/year") {
    const raw = url.searchParams.get("year");
    return json(hmn.yearReview(access, raw ? Number(raw) : null));
  }
  const yearNote = pathname.match(/^\/api\/v1\/review\/year\/(\d{4})\/note$/);
  if (req.method === "PUT" && yearNote) return json(hmn.saveYearNote(access, Number(yearNote[1]), await readJson(req)));
  // What a client needs to show and edit any row. docs/UX-PASS.md, batch 2.
  if (req.method === "GET" && pathname === "/api/v1/schema") return json(hmn.schema(access));
  // The people, and the person page. docs/ONTOLOGY.md, section 5.2.
  if (req.method === "GET" && pathname === "/api/v1/people") return json({ people: hmn.people(access) });
  const personPage = pathname.match(/^\/api\/v1\/person\/([^/]+)\/page$/);
  if (req.method === "GET" && personPage) return json(hmn.personPage(access, decodeURIComponent(personPage[1]!)));
  const around = pathname.match(/^\/api\/v1\/([a-z]+)\/([^/]+)\/neighbours$/);
  if (req.method === "GET" && around && (ENTITY_TYPES as readonly string[]).includes(around[1]!)) {
    return json(hmn.neighbours(access, around[1] as EntityType, decodeURIComponent(around[2]!), Number(url.searchParams.get("depth") ?? 1)));
  }
  const entity = pathname.match(/^\/api\/v1\/([a-z]+)(?:\/([^/]+))?(?:\/(links))?$/);
  if (entity) {
    const type = entity[1]!;
    const id = entity[2] ? decodeURIComponent(entity[2]) : null;
    const tail = entity[3];
    if (req.method === "GET" && !id) return json({ entities: hmn.list(access, type as never, { archived: url.searchParams.get("archived") === "1" }) });
    if (req.method === "POST" && !id) return json(hmn.create(access, type as never, await readJson(req)), 201);
    if (req.method === "GET" && id && tail === "links") return json({ links: hmn.linksOf(access, type as never, id) });
    if (req.method === "GET" && id) return json(hmn.get(access, type as never, id));
    if (req.method === "PATCH" && id) return json(hmn.update(access, type as never, id, await readJson(req)));
    if (req.method === "DELETE" && id && !tail) {
      hmn.remove(access, type as never, id);
      return json({ id, deleted: true });
    }
    if (req.method === "DELETE" && pathname.startsWith("/api/v1/links/")) {
      return json(hmn.removeLink(access, decodeURIComponent(pathname.slice("/api/v1/links/".length))));
    }
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/v1/links/")) {
    return json(hmn.removeLink(access, decodeURIComponent(pathname.slice("/api/v1/links/".length))));
  }
  return json({ error: { code: "not_found", message: "Not found." } }, 404);
}

function tokenFrom(req: Request, url: URL, allowQuery: boolean): string | null {
  const header = bearer(req);
  if (header) return header;
  if (allowQuery) {
    const query = url.searchParams.get("access_token");
    if (query) return query;
  }
  return null;
}

/** The writes that a member's phone makes, as member proposals. Null for a route that is not a member write. */
async function memberRoute(hmn: Hmn, req: Request, pathname: string, access: Access): Promise<Response | null> {
  const answer = (result: { status: "applied" | "pending" }) => json(result, result.status === "applied" ? 200 : 202);
  if (req.method === "POST" && pathname === "/api/v1/items") return answer(hmn.memberAddItem(access, await readJson(req)));
  if (req.method === "POST" && pathname === "/api/v1/links") {
    const body = await readJson(req);
    return answer(hmn.memberWrite(access, "link", { link: { from_id: body.from_id, to_id: body.to_id, rel: body.rel } }));
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/v1/links/")) {
    return answer(hmn.memberWrite(access, "unlink", { id: decodeURIComponent(pathname.slice("/api/v1/links/".length)) }));
  }
  const entity = pathname.match(/^\/api\/v1\/([a-z]+)(?:\/([^/]+))?$/);
  if (!entity || !(ENTITY_TYPES as readonly string[]).includes(entity[1]!)) return null;
  const type = entity[1]!;
  const id = entity[2] ? decodeURIComponent(entity[2]) : null;
  if (req.method === "POST" && !id) {
    const { id: _ignored, ...body } = await readJson(req);
    return answer(hmn.memberWrite(access, "create", { entity: { ...body, type } }));
  }
  if (req.method === "PATCH" && id) return answer(hmn.memberWrite(access, "update", { id, patch: await readJson(req) }));
  if (req.method === "DELETE" && id) return answer(hmn.memberWrite(access, "delete", { id }));
  return null;
}
