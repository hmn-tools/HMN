import { gardenPage } from "../garden";
import type { Hmn } from "../hmn";
import { handleMcp } from "../mcp";
import { type Access, ApiError, isTier } from "../types";
import {
  allowedRedirect,
  clientName,
  clientRedirects,
  noteSetupFailure,
  setupLocked,
  consumeSetupCode,
  externalCap,
  gateStatus,
  hitRate,
  issueBearer,
  issueSetupCode,
  openSession,
  redeemAuthCode,
  registerClient,
  requireOwner,
  saveAuthCode,
  sessionOk,
  setGate,
} from "./clients";
import { fenceRpc } from "./fence";
import { writeJournal, type JournalItem } from "../journal";
import { externalEnabled } from "./tables";

const ALLOWED_TOOLS = new Set(["search", "get_entity", "list_entities", "list_links", "neighbours", "free_busy", "propose_create", "propose_update", "propose_delete", "propose_link", "list_proposals", "proposal_status"]);
/** A guest reads Public data and busy times. It writes a new event for review, or an inbox item. */
const GUEST_TOOLS = new Set(["search", "get_entity", "list_entities", "list_links", "neighbours", "free_busy", "propose_create", "proposal_status", "capture_inbox"]);

const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

export async function handleExternalAdmin(hmn: Hmn, req: Request, url: URL, access: Access, ip: string | null): Promise<Response> {
  requireOwner(hmn, access, ip);
  const maker = access.principal.id;
  const { pathname } = url;
  if (req.method === "GET" && pathname === "/api/v1/external") return json(gateStatus(hmn));
  if (req.method === "POST" && pathname === "/api/v1/external/enable") return json(setGate(hmn, true));
  if (req.method === "POST" && pathname === "/api/v1/external/disable") return json(setGate(hmn, false));
  if (req.method === "POST" && pathname === "/api/v1/external/clients") {
    const body = await readBody(req);
    const guest = body.guest === true;
    return json(issueBearer(hmn, str(body, "name") || (guest ? "Guest" : "Grok"), guest ? "public" : capOf(body.ceiling), { guest, freeBusy: body.free_busy === true, createdBy: maker }), 201);
  }
  if (req.method === "POST" && pathname === "/api/v1/external/setup-codes") {
    const body = await readBody(req);
    return json(issueSetupCode(hmn, capOf(body.ceiling ?? "personal"), maker), 201);
  }
  const revoke = pathname.match(/^\/api\/v1\/external\/clients\/([^/]+)\/revoke$/);
  if (req.method === "POST" && revoke) {
    const id = decodeURIComponent(revoke[1]!);
    const outside = hmn.store.db.query("SELECT id FROM credentials WHERE id = ? AND external = 1").get(id);
    if (!outside) return json({ error: { code: "not_found", message: "Not found." } }, 404);
    return json(hmn.revoke(access, id));
  }
  return json({ error: { code: "not_found", message: "Not found." } }, 404);
}

export async function handleExternal(hmn: Hmn, req: Request, ip: string | null): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (path.startsWith("/api/") || path === "/mcp" || path.startsWith("/api/display")) {
    return json({ error: { code: "not_found", message: "Not found." } }, 404);
  }
  if (!externalEnabled(hmn.store.db)) return json({ error: { code: "not_found", message: "Not found." } }, 404);
  try {
    if (req.method === "GET" && path === "/.well-known/oauth-protected-resource") return json(resourceMeta(url));
    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") return json(serverMeta(url));
    if (req.method === "POST" && path === "/oauth/register") {
      const body = await readBody(req);
      return json(registerClient(hmn, str(body, "client_name") || "MCP client", stringList(body, "redirect_uris")), 201);
    }
    if (req.method === "GET" && path === "/oauth/authorize") return html(consentPage(url, clientName(hmn, url.searchParams.get("client_id") ?? "")));
    if (req.method === "POST" && path === "/oauth/authorize") return authorize(hmn, await formBody(req));
    if (req.method === "POST" && path === "/oauth/token") return token(hmn, await formBody(req));
    if (path === "/external/mcp") return await mcp(hmn, req, ip);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status);
    return json({ error: { code: "invalid", message: "The request could not be read." } }, 422);
  }
  return json({ error: { code: "not_found", message: "Not found." } }, 404);
}

async function mcp(hmn: Hmn, req: Request, ip: string | null): Promise<Response> {
  const token = bearer(req);
  if (!token) return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
  const access = hmn.accessFor(token, ip, "mcp", null, "external");
  if (!access.principal.external) return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
  if (!hitRate(hmn, access.principal.id)) return json({ error: { code: "rate", message: "Too many requests." } }, 429);
  if (req.method === "GET") {
    const session = req.headers.get("mcp-session-id");
    if (!sessionOk(hmn, session, access.principal.id)) return json({ error: { code: "session", message: "Missing session." } }, 400);
    hmn.noteExternal(access, "listen");
    hmn.saveSoon();
    return sse({ jsonrpc: "2.0", method: "notifications/ready", params: {} }, session);
  }
  if (req.method !== "POST") return json({ error: { code: "not_found", message: "Not found." } }, 404);
  const message = await readBody(req);
  const method = str(message, "method");
  const params = message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};
  const tool = method === "tools/call" ? String(params.name ?? "") : method || "rpc";
  const allowed = access.principal.guest ? GUEST_TOOLS : ALLOWED_TOOLS;
  if (method === "tools/call" && !allowed.has(String(params.name ?? ""))) {
    return json({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "Unknown tool." } }, 400);
  }
  let session = req.headers.get("mcp-session-id");
  if (method !== "initialize" && !sessionOk(hmn, session, access.principal.id)) {
    return json({ error: { code: "session", message: "Missing session." } }, 400);
  }
  const resultRaw = (await handleMcp(hmn, access, message)) as Record<string, unknown>;
  const result = fenceRpc(resultRaw);
  if (method === "tools/list" && result.result && typeof result.result === "object") {
    const tools = (result.result as { tools?: Array<{ name: string }> }).tools ?? [];
    // A key with no permission for busy times does not see the tool.
    (result.result as { tools: unknown }).tools = tools.filter((item) => allowed.has(item.name) && (item.name !== "free_busy" || access.principal.freeBusy));
  }
  if (method === "tools/call") journalExternal(hmn, access.principal.id, access.principal.name, tool, resultRaw);
  if (method === "initialize") session = openSession(hmn, access.principal.id);
  hmn.noteExternal(access, tool);
  hmn.saveSoon();
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream")) return sse(result, session ?? undefined);
  return json(result, 200, session);
}

function authorize(hmn: Hmn, form: URLSearchParams): Response {
  const clientId = form.get("client_id") ?? "";
  const redirect = form.get("redirect_uri") ?? "";
  const challenge = form.get("code_challenge") ?? "";
  const method = form.get("code_challenge_method") ?? "";
  const state = form.get("state") ?? "";
  const setup = (form.get("setup_code") ?? "").trim().toUpperCase();
  if (method !== "S256" || challenge.length < 20) return json({ error: { code: "pkce", message: "PKCE S256 is required." } }, 400);
  const redirects = clientRedirects(hmn, clientId);
  if (!redirects.includes(redirect) || !allowedRedirect(redirect)) return json({ error: { code: "redirect", message: "That redirect is not registered." } }, 400);
  const name = clientName(hmn, clientId);
  if (setupLocked(hmn)) return html(consentPage(form, name, "Too many wrong codes. Wait ten minutes, then ask for a new code."), 429);
  const setupCode = consumeSetupCode(hmn, setup);
  if (!setupCode) {
    noteSetupFailure(hmn);
    hmn.saveSoon();
    return html(consentPage(form, name, "The setup code is not valid. Ask for a new one and try again."), 401);
  }
  const code = saveAuthCode(hmn, { clientId, redirect, challenge, ceiling: setupCode.ceiling, createdBy: setupCode.createdBy });
  const target = new URL(redirect);
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  // A 303 leaves a blank page if the assistant callback is slow or the webview
  // does not follow it, so a second Allow burns the already-used setup code.
  return html(continuePage(target.toString()));
}

function token(hmn: Hmn, form: URLSearchParams): Response {
  if (form.get("grant_type") !== "authorization_code") return json({ error: "unsupported_grant" }, 400);
  const redeemed = redeemAuthCode(hmn, form.get("code") ?? "", form.get("code_verifier") ?? "", form.get("redirect_uri") ?? "");
  if (!redeemed) return json({ error: "invalid_grant" }, 400);
  const expiresIn = Math.max(0, Math.floor((Date.parse(redeemed.expires_at) - Date.now()) / 1000));
  return json({ access_token: redeemed.token, token_type: "Bearer", expires_in: expiresIn, scope: `hmn:${redeemed.ceiling}` });
}

function resourceMeta(url: URL) {
  return {
    resource: `${url.origin}/external/mcp`,
    authorization_servers: [url.origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["hmn:personal", "hmn:household", "hmn:public"],
  };
}

function serverMeta(url: URL) {
  return {
    issuer: url.origin,
    authorization_endpoint: `${url.origin}/oauth/authorize`,
    token_endpoint: `${url.origin}/oauth/token`,
    registration_endpoint: `${url.origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function consentPage(source: URL | URLSearchParams, client: string | null, error?: string): string {
  const get = (name: string) => (source instanceof URL ? source.searchParams.get(name) : source.get(name)) ?? "";
  const fields = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource"]
    .map((name) => `<input type="hidden" name="${esc(name)}" value="${esc(get(name))}">`)
    .join("");
  const notice = error ? `<p class="error">${esc(error)}</p>` : "";
  return gardenPage(
    "HMN",
    `<h1>Let this assistant in?</h1>
<div class="card">
<p>It calls itself <strong>${esc(client ?? "an unknown client")}</strong>. That name comes from the client, so check that you started this sign-in yourself.</p>
<p class="s">It can read up to Personal and propose changes. It cannot see Private or Sealed, and it cannot approve.</p>
${notice}<form method="post" action="/oauth/authorize" onsubmit="this.querySelector('button').disabled=true">${fields}
<label>Setup code from the mini <input name="setup_code" autocomplete="off"></label>
<button type="submit">Allow</button></form>
</div>`,
  );
}

function continuePage(target: string): string {
  const safe = esc(target);
  return gardenPage("HMN", `<div class="card"><p>Continue to the assistant.</p><p><a href="${safe}">Continue</a></p></div>`, "", `<meta http-equiv="refresh" content="0;url=${safe}">`);
}

function json(body: unknown, status = 200, session?: string | null): Response {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", ...SECURITY };
  if (session) headers["mcp-session-id"] = session;
  return new Response(JSON.stringify(body), { status, headers });
}

function sse(body: unknown, session?: string | null): Response {
  const headers: Record<string, string> = { "content-type": "text/event-stream", ...SECURITY };
  if (session) headers["mcp-session-id"] = session;
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { status: 200, headers });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'", ...SECURITY } });
}

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return null;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 64_000) throw new ApiError(413, "too_large", "That request is too large.");
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(422, "invalid", "The body was not a JSON object.");
  return value as Record<string, unknown>;
}

async function formBody(req: Request): Promise<URLSearchParams> {
  const text = await req.text();
  if (text.length > 16_000) throw new ApiError(413, "too_large", "That request is too large.");
  return new URLSearchParams(text);
}

function str(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key] : "";
}

function stringList(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function capOf(value: unknown) {
  if (value === "public" || value === "household" || value === "personal") return externalCap(value);
  if (isTier(value)) return externalCap(value);
  return externalCap("personal");
}

function esc(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function journalExternal(hmn: Hmn, actorId: string, name: string, tool: string, raw: Record<string, unknown>) {
  const text = textOf(raw);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const items = collectItems(parsed);
  const proposed = tool.startsWith("propose") ? items.map((item) => ({ ...item, type: "proposal" })) : [];
  const read = tool.startsWith("propose") ? [] : items;
  writeJournal(hmn, { actorId, name, model: "external", why: tool, read, proposed });
}

function textOf(raw: Record<string, unknown>): string {
  const result = raw.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? "";
}

function collectItems(value: unknown): JournalItem[] {
  const out: JournalItem[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.title === "string" && typeof obj.id === "string" && isTier(obj.tier)) {
      out.push({ id: obj.id, type: typeof obj.type === "string" ? obj.type : "entity", title: obj.title, tier: obj.tier });
    }
    for (const key of ["results", "entities", "proposals", "entity", "payload"]) visit(obj[key]);
  };
  visit(value);
  return out.slice(0, 12);
}
