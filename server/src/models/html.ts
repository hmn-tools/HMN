import { tokens as t } from "../tokens";

export type ModelPage = {
  models: Array<{
    name: string;
    version: string;
    privacy: string;
    capabilities: string[];
    ram_bytes: number;
    speed: string;
    installed: boolean;
  }>;
  routes: Array<{ task: string; model: string }>;
  ram_bytes: number;
  voice: string;
  spend: { usd: number; cap_usd: number; notice: string | null };
};

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function modelsHtml(page: ModelPage): string {
  const rows = page.models
    .map(
      (model) =>
        `<div class="row"><div><div class="t">${esc(model.name)}</div><div class="s">${esc(model.privacy)} · ${esc(model.capabilities.join(", "))} · ${esc(model.speed)}${model.installed ? "" : " · not installed"}</div></div><div class="s">${formatRam(model.ram_bytes)}</div></div>`,
    )
    .join("");
  const routes = page.routes
    .map((route) => `<div class="row"><div class="t">${esc(route.task)}</div><div class="s">${esc(route.model)}</div></div>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>HMN models</title>
<style>
  html,body{margin:0;background:${t.paper};color:${t.ink}}
  body{font-family:"IBM Plex Mono",ui-monospace,monospace;padding:28px}
  .card{background:${t.card};border:1.5px solid ${t.ink}}
  .stripe{display:flex;height:6px}
  .stripe i{flex:1;display:block}
  h1{font-size:21px;font-weight:600;margin:16px}
  .label{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${t.stone};margin:16px 16px 8px}
  .row{display:flex;justify-content:space-between;gap:12px;padding:8px 16px;border-top:1px solid ${t.hair}}
  .t{font-size:14px}
  .s{font-size:12px;color:${t.graphite}}
  .note{font-size:12px;color:${t.graphite};margin:16px}
  .bar{background:${t.ink};color:${t.paper};font-size:10px;letter-spacing:.06em;text-transform:uppercase;padding:8px 12px}
  .cursor{display:inline-block;width:8px;height:12px;background:${t.teal};margin-left:6px}
</style></head><body><div class="card">
<div class="stripe"><i style="background:${t.lilac}"></i><i style="background:${t.coral}"></i><i style="background:${t.sand}"></i></div>
<h1>Models</h1>
<p class="note">${esc(page.voice)}</p>
<div class="label">Registry</div>
${rows}
<div class="label">Routing</div>
${routes}
<p class="note">This month ${page.spend.usd.toFixed(2)} of ${page.spend.cap_usd.toFixed(2)}. ${esc(page.spend.notice ?? "Cloud stays inside the cap.")}</p>
<p class="note">Loaded local models ask for about ${formatRam(page.ram_bytes)}.</p>
<div class="bar">&gt; models <span class="cursor"></span></div>
</div></body></html>`;
}

function formatRam(bytes: number): string {
  if (bytes <= 0) return "no extra RAM";
  return `${Math.round(bytes / 1_000_000_000)} GB`;
}
