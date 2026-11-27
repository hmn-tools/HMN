import { gardenPage, words } from "../garden";

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
        `<div class="row"><div><div class="t">${esc(model.name)}</div><div class="s">${esc(model.privacy === "local" ? "On this Mac" : words(model.privacy))} · ${esc(model.capabilities.map(words).join(", "))} · ${esc(words(model.speed))}${model.installed ? "" : " · not installed"}</div></div><div class="s">${formatRam(model.ram_bytes)}</div></div>`,
    )
    .join("");
  const routes = page.routes
    .map((route) => `<div class="row"><div class="t">${esc(words(route.task))}</div><div class="s">${esc(route.model.includes(":") ? route.model.split(":").slice(1).join(":") : route.model)}</div></div>`)
    .join("");
  return gardenPage(
    "HMN models",
    `<h1>Models</h1>
<p class="lead">${esc(page.voice)}</p>
<div class="label">Registry</div>
<div class="card">${rows}</div>
<div class="label">Routing</div>
<div class="card">${routes || `<p class="note">No job has a model yet.</p>`}</div>
<p class="note">This month <span class="data">${page.spend.usd.toFixed(2)}</span> of <span class="data">${page.spend.cap_usd.toFixed(2)}</span>. ${esc(page.spend.notice ?? "Cloud stays inside the cap.")}</p>
<p class="note">${page.ram_bytes <= 0 ? "No local model is loaded, so no extra memory is in use." : `Loaded local models use about ${formatRam(page.ram_bytes)} of memory.`}</p>`,
    `.label{margin:20px 4px 0}.row > .s{white-space:nowrap}`,
  );
}

function formatRam(bytes: number): string {
  if (bytes <= 0) return "no extra memory";
  return `${Math.round(bytes / 1_000_000_000)} GB`;
}
