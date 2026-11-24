import type { Hmn } from "../hmn";
import { ApiError, type Access } from "../types";
import { isLoopback } from "../external/clients";
import { getWorker, listWorkers, saveWorker, viewWorker } from "./config";
import { listJournals } from "../journal";
import { workersHtml } from "./settings";
import { runWorker, runDue } from "./run";

const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'",
};

export function isWorkerPath(pathname: string): boolean {
  return pathname === "/api/v1/workers" || pathname === "/api/v1/workers.html" || pathname.startsWith("/api/v1/workers/");
}

export async function handleWorkerRequest(hmn: Hmn, req: Request, url: URL, access: Access, ip: string | null = null): Promise<Response> {
  if (access.principal.scope !== "write") throw new ApiError(403, "forbidden", "Workers are started by the owner.");
  const { pathname } = url;
  const now = new Date().toISOString();
  if (req.method === "GET" && (pathname === "/api/v1/workers" || pathname === "/api/v1/workers.html")) {
    const workers = listWorkers(hmn.store.db, now).map(viewWorker);
    if (pathname.endsWith(".html")) {
      const journals = Object.fromEntries(workers.map((worker) => [worker.id, listJournals(hmn, access, worker.id).slice(0, 2)]));
      return html(workersHtml(workers, journals));
    }
    return json({ workers });
  }
  if (req.method === "POST" && pathname === "/api/v1/workers/run-due") {
    const results = await runDue(hmn);
    return json({ runs: results });
  }
  const run = pathname.match(/^\/api\/v1\/workers\/([a-z]+)\/run$/);
  if (req.method === "POST" && run) {
    const result = await runWorker(hmn, run[1]!);
    return json(result);
  }
  const journal = pathname.match(/^\/api\/v1\/workers\/([a-z]+)\/journal$/);
  if (req.method === "GET" && journal) return json({ entries: listJournals(hmn, access, journal[1]!) });
  const one = pathname.match(/^\/api\/v1\/workers\/([a-z]+)$/);
  if (one && req.method === "GET") return json(viewWorker(getWorker(hmn.store.db, one[1]!, now)));
  if (one && req.method === "POST") {
    const body = await readBody(req);
    // The cloud host gets the cloud key on the next run. So it changes only on the mini, with the owner there.
    const cloudChange = ["cloud_endpoint", "cloud_enabled", "cloud_tier", "cloud_warning_ack"].some((field) => field in body) || body.llm_mode === "cloud";
    if (cloudChange && !isLoopback(ip)) throw new ApiError(403, "localhost", "The cloud model of a worker is set on the mini itself.");
    const saved = saveWorker(hmn.store.db, one[1]!, body, now);
    hmn.store.persist();
    if ((req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
      return html(workersHtml(listWorkers(hmn.store.db, now).map(viewWorker)));
    }
    return json(viewWorker(saved.worker));
  }
  return json({ error: { code: "not_found", message: "Not found." } }, 404);
}

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...SECURITY,
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY } });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (text.length > 64_000) throw new ApiError(413, "too_large", "That request is too large.");
  if (type.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    const out: Record<string, unknown> = {};
    if (params.has("enabled")) out.enabled = params.get("enabled") === "true";
    return out;
  }
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object");
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(422, "invalid", "The body was not a JSON object.");
  }
}
