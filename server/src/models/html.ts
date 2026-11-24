import { gardenPage } from "../garden";

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
  return gardenPage(
    "HMN models",
    `<h1>Models</h1>
<p class="lead">${esc(page.voice)}</p>
<div class="label">Registry</div>
<div class="card">${rows}</div>
<div class="label">Routing</div>
<div class="card">${routes || `<p class="note">No route yet.</p>`}</div>
<p class="note">This month <span class="data">${page.spend.usd.toFixed(2)}</span> of <span class="data">${page.spend.cap_usd.toFixed(2)}</span>. ${esc(page.spend.notice ?? "Cloud stays inside the cap.")}</p>
<p class="note">Loaded local models ask for about ${formatRam(page.ram_bytes)}.</p>`,
    `.label{margin:20px 4px 0}.row > .s{white-space:nowrap}`,
  );
}

function formatRam(bytes: number): string {
  if (bytes <= 0) return "no extra RAM";
  return `${Math.round(bytes / 1_000_000_000)} GB`;
}
