import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TodayScreen } from "./screens";
import { GARDEN_CSS, MONO, SANS } from "./garden";

const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="24" height="24"><path d="M49.00,52.00 L49.00,72.00 A11 11 0 0 0 71.00,72.00 L71.00,52.00 A11 11 0 0 0 49.00,52.00ZM62.94,61.56 L103.12,49.19 A5.5 5.5 0 0 0 101.03,38.45 L59.15,42.04 A10 10 0 0 0 62.94,61.56ZM60.85,42.04 L18.97,38.45 A5.5 5.5 0 0 0 16.88,49.19 L57.06,61.56 A10 10 0 0 0 60.85,42.04ZM52.82,79.67 L83.53,108.40 A6 6 0 0 0 92.56,100.61 L68.64,66.03 A10.5 10.5 0 0 0 52.82,79.67ZM51.36,66.03 L27.44,100.61 A6 6 0 0 0 36.47,108.40 L67.18,79.67 A10.5 10.5 0 0 0 51.36,66.03Z" fill="currentColor"/><circle cx="60" cy="19" r="12" fill="currentColor"/></svg>`;

function font64(name: string): string {
  return readFileSync(join(import.meta.dir, "..", "assets", "fonts", name)).toString("base64");
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function glyph(item: TodayScreen["sections"][number]["items"][number]): string {
  if (item.glyph === "date") {
    return `<div class="mark">${esc(item.date_mark ?? "")}</div>`;
  }
  if (item.glyph === "flag") {
    return `<svg class="ico" viewBox="0 0 24 24"><path d="M4 20V5M4 5h13l-2 4 2 4H4"/></svg>`;
  }
  if (item.glyph === "dashed") {
    return `<svg class="ico teal" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke-dasharray="2.5 3"/></svg>`;
  }
  return `<i class="box"></i>`;
}

export function todayHtml(screen: TodayScreen, phoneChrome: boolean): string {
  const sections = screen.sections
    .map((section) => {
      const rows = section.items
        .map((item) => {
          const badge = item.badge ? `<span class="badge">${esc(item.badge)}</span>` : "";
          return `<div class="row">${glyph(item)}<div><div class="t">${esc(item.title)} ${badge}</div><div class="s">${esc(item.subtitle)}</div></div></div>`;
        })
        .join("");
      const trailing = section.trailing ? `<span>${esc(section.trailing)}</span>` : "";
      const accent = section.accent === "teal" ? " teal" : "";
      return `<div class="lbl${accent}"><span>${esc(section.label)}</span>${trailing}</div>${rows}`;
    })
    .join("");
  const dots = [0, 1, 2, 3]
    .map((index) => `<i class="${screen.in_deck && screen.index === index + 1 ? "on" : ""}"></i>`)
    .join("");
  // The band is on a screen one time, under the greeting of Today.
  const band = screen.id === "today" || screen.id === "home" ? `<div class="band"><i></i><i></i><i></i></div>` : "";
  const card = `<article class="screen">
    <div class="body">
      <h1>${esc(screen.greeting)}</h1>
      ${band}
      <p class="sum">${esc(screen.summary)}</p>
      ${sections}
      ${screen.closing ? `<p class="sum">${esc(screen.closing)}</p>` : ""}
    </div>
    <footer><span>${esc(screen.label)}${screen.in_deck ? ` · screen ${screen.index} of ${screen.count}` : ""}</span><span>${esc(screen.updated_label)} → next ${esc(screen.next_label)}</span></footer>
  </article>`;
  const chrome = phoneChrome
    ? `<header class="top"><span class="brand">${mark}<em>HMN</em></span><span class="mono">${esc(screen.date_label)}</span></header>
      ${card}
      <div class="dots">${dots}</div>
      <nav>
        <div class="tab on"><span>Today</span></div>
        <div class="tab"><span>People</span></div>
        <div class="tab"><div class="plus"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></div></div>
        <div class="tab"><span>Projects</span></div>
        <div class="tab"><span>Review</span></div>
      </nav>`
    : `<header class="top"><span class="brand">${mark}<em>HMN</em></span><span class="mono">${esc(screen.date_label)}</span></header>${card}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HMN</title>
<style>
@font-face{font-family:"IBM Plex Mono";src:url("data:font/ttf;base64,${font64("IBMPlexMono-Regular.ttf")}") format("truetype");font-weight:400}
@font-face{font-family:"IBM Plex Mono";src:url("data:font/ttf;base64,${font64("IBMPlexMono-Medium.ttf")}") format("truetype");font-weight:500}
@font-face{font-family:"IBM Plex Mono";src:url("data:font/ttf;base64,${font64("IBMPlexMono-SemiBold.ttf")}") format("truetype");font-weight:600}
${GARDEN_CSS}
body{width:390px;min-height:${phoneChrome ? "844px" : "480px"};padding:0;font-family:${SANS}}
.top{display:flex;justify-content:space-between;align-items:center;padding:18px 20px 0}
.brand{display:flex;gap:8px;align-items:center;color:var(--ink)}.brand em{font-style:normal;font-family:${MONO};font-weight:500;letter-spacing:.08em;font-size:11px}
.mono{font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--stone)}
.screen{margin:12px 16px 0;background:var(--card);border-radius:18px;box-shadow:0 4px 18px rgba(0,0,0,.06);min-height:${phoneChrome ? "640px" : "420px"};display:flex;flex-direction:column;position:relative}
.body{padding:22px 20px 52px}h1{font-size:30px;margin:0}
.band{margin:12px 0 2px}
.sum{font-size:14px;line-height:1.5;color:var(--graphite);margin:10px 0 0}
.lbl{display:flex;justify-content:space-between;margin:18px 0 4px;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--stone)}
.lbl.teal{color:var(--teal-dark)}
.row{display:flex;justify-content:flex-start;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--rule)}
.lbl + .row{border-top:0}
.box{width:22px;height:22px;border:1.5px solid var(--graphite);border-radius:50%;flex:none}
.mark{width:32px;height:32px;border-radius:10px;background:var(--ground);flex:none;font-family:${MONO};font-size:13px;line-height:32px;text-align:center}
.ico{width:22px;height:22px;flex:none;stroke:var(--ink);fill:none;stroke-width:1.6}
.ico.teal{stroke:var(--teal-dark)}
.t{font-size:16px;font-weight:500;line-height:1.3}.s{font-size:13px;color:var(--stone);margin-top:2px}
.badge{font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:.06em;border:1px solid var(--ink);padding:2px 7px;border-radius:999px;vertical-align:2px}
footer{position:absolute;left:20px;right:20px;bottom:16px;display:flex;justify-content:space-between;font-family:${MONO};font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--stone)}
.dots{display:flex;justify-content:center;gap:8px;margin-top:14px}.dots i{width:7px;height:7px;border-radius:999px;background:var(--hair);display:block}.dots i.on{width:18px;background:var(--ink)}
nav{display:flex;justify-content:space-around;align-items:center;margin:14px 16px 16px;height:64px;padding:0 8px;background:var(--card);border-radius:999px;box-shadow:0 10px 28px rgba(0,0,0,.12)}
.tab{flex:1;text-align:center;color:var(--stone);font-size:13px;font-weight:500}
.tab.on span{display:inline-block;background:var(--ground);color:var(--ink);border-radius:999px;padding:12px 16px}
.plus{width:52px;height:52px;border-radius:50%;background:var(--ink);display:flex;align-items:center;justify-content:center;margin:0 auto}
.plus svg{stroke:var(--paper);width:22px;height:22px;stroke-width:2;fill:none}
</style></head><body>${chrome}</body></html>`;
}

export function fontFile(name: string): Buffer | null {
  const allowed = new Set(["IBMPlexMono-Regular.ttf", "IBMPlexMono-Medium.ttf", "IBMPlexMono-SemiBold.ttf"]);
  if (!allowed.has(name)) return null;
  return readFileSync(join(import.meta.dir, "..", "assets", "fonts", name));
}
