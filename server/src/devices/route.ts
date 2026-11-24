import type { Hmn } from "../hmn";
import { ApiError, type Access } from "../types";
import {
  byosBody,
  claimDevice,
  currentBody,
  displayAccess,
  displayChoice,
  fridgeBody,
  listDevices,
  paletteOf,
  noteTelemetry,
  publicDisplayAccess,
  registerDevice,
  renderPublic,
  renderSetup,
  revokeDevice,
  setupDevice,
  writeLogs,
  type Depth,
} from "./trmnl";
import { panelFor, TRMNL_X } from "./image";
import { FRIDGE_SCREENS, renderFridge, type FridgeScreenId } from "../fridge";

const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'",
};

export function isDevicePath(pathname: string): boolean {
  return pathname === "/api/setup" || pathname === "/api/log" || pathname === "/api/display/current" || pathname.startsWith("/api/trmnl/");
}

export async function handleDeviceRequest(hmn: Hmn, req: Request, url: URL, ip: string | null): Promise<Response> {
  const { pathname } = url;
  if (req.method === "GET" && pathname === "/api/setup") {
    const body = setupDevice(hmn, req.headers.get("id"), req.headers.get("model"), req.headers.get("fw-version"), url.origin, ip);
    return json(body);
  }
  if (req.method === "GET" && pathname === "/api/trmnl/setup.bmp") {
    const friendly = url.searchParams.get("friendly_id");
    return bytes(renderSetup(friendly, "bmp"), "image/bmp");
  }
  if (req.method === "POST" && pathname === "/api/log") {
    const token = tokenFrom(req, url, false);
    if (!token) return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
    const access = hmn.accessFor(token, ip, "display", null);
    const body = await readJson(req);
    const logs = Array.isArray(body.logs) ? body.logs : null;
    if (!logs) throw new ApiError(422, "invalid", "Logs are a list.");
    writeLogs(hmn, access, logs);
    return new Response(null, { status: 204, headers: SECURITY });
  }
  const image = pathname.match(/^\/api\/trmnl\/image\.(bmp|png)$/);
  if (req.method === "GET" && image) {
    const token = tokenFrom(req, url, true);
    if (!token) return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
    const access = publicDisplayAccess(hmn, token, ip);
    noteTelemetry(hmn, req.headers.get("id"), req.headers);
    const screen = url.searchParams.get("screen") ?? "today";
    const panel = panelFor(url.searchParams.get("model") ?? req.headers.get("model"), Number(req.headers.get("width")), Number(req.headers.get("height")));
    const x = panel.id === "x";
    const asked = url.searchParams.get("depth");
    const depth: Depth = x ? "16" : asked === "4" ? "4" : asked === "bwry" ? "bwry" : "1";
    const format = x || depth === "bwry" ? "png" : image[1] === "png" ? "png" : "bmp";
    const rendered = renderPublic(hmn, access, screen, format, depth, panel);
    return bytes(rendered, format === "png" ? "image/png" : "image/bmp");
  }
  const fridge = pathname.match(/^\/api\/trmnl\/fridge\.(bmp|png)$/);
  if (req.method === "GET" && fridge) {
    const token = tokenFrom(req, url, true);
    if (!token) return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
    const { access, device } = displayAccess(hmn, token, ip);
    // Only the key of a household display draws the fridge.
    if (device?.ceiling !== "household") return json({ error: { code: "not_found", message: "Not found." } }, 404);
    const screen = url.searchParams.get("screen") ?? hmn.fridgeWindowNow();
    if (!(FRIDGE_SCREENS as readonly string[]).includes(screen)) return json({ error: { code: "not_found", message: "Not found." } }, 404);
    const palette = paletteOf(device, url.searchParams.get("palette") === "bwry" ? "og_bwry" : req.headers.get("model"));
    const rendered = renderFridge(hmn.fridgeScreen(access, screen as FridgeScreenId, url.origin), palette);
    return bytes(rendered, palette === "bwry" ? "image/png" : "image/bmp");
  }
  if (req.method === "GET" && (pathname === "/api/display/current" || pathname === "/api/trmnl/display")) {
    const token = tokenFrom(req, url, true);
    if (!token) return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
    const { access, device } = displayAccess(hmn, token, ip);
    noteTelemetry(hmn, req.headers.get("id"), req.headers);
    if (pathname === "/api/display/current") return json(currentBody(hmn, access, token, url.origin));
    return json(displayBody(hmn, req, url, access, device, token));
  }
  return json({ error: { code: "not_found", message: "Not found." } }, 404);
}

export async function handleDeviceAdmin(hmn: Hmn, req: Request, url: URL, access: Access, ip: string | null): Promise<Response> {
  if (access.principal.scope !== "write") throw new ApiError(403, "forbidden", "This credential cannot manage displays.");
  const { pathname } = url;
  if (req.method === "GET" && pathname === "/api/v1/trmnl/devices") return json({ devices: listDevices(hmn) });
  if (req.method === "POST" && pathname === "/api/v1/trmnl/devices") {
    const body = await readJson(req);
    const name = typeof body.name === "string" ? body.name : "Display";
    const mac = typeof body.mac === "string" ? body.mac : "";
    return json(registerDevice(hmn, access, name, mac, ip, displayChoice(body)), 201);
  }
  const claim = pathname.match(/^\/api\/v1\/trmnl\/devices\/([^/]+)\/claim$/);
  if (req.method === "POST" && claim) {
    const body = await readJson(req);
    const name = typeof body.name === "string" ? body.name : "Display";
    return json(claimDevice(hmn, access, decodeURIComponent(claim[1]!), name, ip, displayChoice(body)));
  }
  const revoke = pathname.match(/^\/api\/v1\/trmnl\/devices\/([^/]+)\/revoke$/);
  if (req.method === "POST" && revoke) return json(revokeDevice(hmn, access, decodeURIComponent(revoke[1]!)));
  return json({ error: { code: "not_found", message: "Not found." } }, 404);
}

export function deviceDisplay(hmn: Hmn, req: Request, url: URL, token: string, ip: string | null): Response {
  const { access, device } = displayAccess(hmn, token, ip);
  noteTelemetry(hmn, req.headers.get("id"), req.headers);
  return json(displayBody(hmn, req, url, access, device, token));
}

/** The BYOS answer for one display: the fridge for a household display, else the Public deck in its inks. */
function displayBody(hmn: Hmn, req: Request, url: URL, access: Access, device: ReturnType<typeof displayAccess>["device"], token: string) {
  const palette = paletteOf(device, req.headers.get("model"));
  if (device?.ceiling === "household") return fridgeBody(hmn, access, token, url.origin, palette);
  const panel = panelFor(req.headers.get("model"), Number(req.headers.get("width")), Number(req.headers.get("height")));
  if (panel.id === "x") return byosBody(hmn, access, token, url.origin, "png", "16", TRMNL_X);
  if (palette === "bwry") return byosBody(hmn, access, token, url.origin, "png", "bwry", panel);
  const png = url.searchParams.get("format") === "png";
  const depth: Depth = url.searchParams.get("depth") === "4" ? "4" : "1";
  return byosBody(hmn, access, token, url.origin, png ? "png" : "bmp", depth, panel);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY } });
}

function bytes(body: Uint8Array, contentType: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType, ...SECURITY } });
}

function tokenFrom(req: Request, url: URL, allowQuery: boolean): string | null {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const access = req.headers.get("access-token");
  if (access) return access.trim();
  if (allowQuery) return url.searchParams.get("access_token");
  return null;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 64_000) throw new ApiError(413, "too_large", "That request is too large.");
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "invalid", "The body was not a JSON object.");
  }
}
