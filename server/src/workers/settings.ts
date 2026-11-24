import { tokens as t } from "../tokens";
import type { JournalEntry } from "../journal";
import type { viewWorker } from "./config";

type WorkerView = ReturnType<typeof viewWorker>;

function journalBlock(entries: JournalEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries
    .map((entry) => {
      const read = entry.read.map((item) => item.title).join(", ") || "nothing new";
      const proposed = entry.proposed.map((item) => item.title).join(", ") || "no proposal";
      const hidden = entry.hidden ? " Some of this entry is above this ceiling." : "";
      return `<p class="note">${esc(entry.at)} · ${esc(entry.model)} · read ${esc(read)} · proposed ${esc(proposed)}. ${esc(entry.why)}${esc(hidden)}</p>`;
    })
    .join("");
  return `<h3>Journal</h3>${lines}`;
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The owner sees each worker's ceiling, model, schedule, and last run, and can pause it. No script. */
export function workersHtml(workers: WorkerView[], journals: Record<string, JournalEntry[]> = {}): string {
  const rows = workers
    .map((worker) => {
      const model = worker.llm_mode === "local" ? `local · ${worker.llm_model}` : worker.llm_mode === "cloud" ? `cloud · ${worker.cloud_endpoint ?? ""}` : "fallback";
      const last = worker.last_run_at ?? "Not yet";
      const state = worker.enabled ? "Running" : "Paused";
      const next = worker.enabled ? "false" : "true";
      const label = worker.enabled ? "Pause" : "Resume";
      return `<article class="card">
        <h2>${esc(worker.name)}</h2>
        <dl>
          <div><dt>Tier</dt><dd>${esc(worker.tier)} · ceiling ${esc(worker.effective_ceiling)}</dd></div>
          <div><dt>Model</dt><dd>${esc(model)}</dd></div>
          <div><dt>Schedule</dt><dd>${esc(worker.schedule)}</dd></div>
          <div><dt>Last run</dt><dd>${esc(last)}</dd></div>
          <div><dt>State</dt><dd>${state}</dd></div>
        </dl>
        <form method="post" action="/api/v1/workers/${esc(worker.id)}">
          <input type="hidden" name="enabled" value="${next}">
          <button type="submit">${label}</button>
        </form>
        <p class="note">${esc(worker.limits.join(" "))}</p>
        ${journalBlock(journals[worker.id] ?? [])}
      </article>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HMN workers</title>
<style>
*{box-sizing:border-box}body{margin:0;background:${t.paper};color:${t.ink};font-family:ui-monospace,monospace;padding:28px}
h1{font-size:21px;font-weight:600;margin:0 0 8px}h2{font-size:14px;margin:0 0 8px}
p.lead,p.note{color:${t.graphite};font-size:12px}
.card{background:${t.card};border:1.5px solid ${t.ink};border-radius:4px;padding:12px 14px;margin:12px 0;max-width:520px}
dl{margin:0}div{display:flex;gap:12px;padding:4px 0;border-top:1px solid ${t.hair}}
dt{width:88px;color:${t.stone};font-size:10px;letter-spacing:.04em;text-transform:uppercase;padding-top:3px}
dd{margin:0;font-size:13px}
button{margin-top:10px;font:inherit;background:${t.ink};color:${t.paper};border:0;border-radius:4px;padding:8px 14px}
button:hover{opacity:.9}
</style></head><body>
<h1>Workers</h1>
<p class="lead">Nothing is written until you approve a proposal. Pause stops the schedule.</p>
${rows}
</body></html>`;
}
