import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TodayScreen } from "./screens";
import { tokens as t } from "./tokens";

const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="24" height="24"><path d="M49.00,52.00 L49.00,72.00 A11 11 0 0 0 71.00,72.00 L71.00,52.00 A11 11 0 0 0 49.00,52.00ZM62.94,61.56 L103.12,49.19 A5.5 5.5 0 0 0 101.03,38.45 L59.15,42.04 A10 10 0 0 0 62.94,61.56ZM60.85,42.04 L18.97,38.45 A5.5 5.5 0 0 0 16.88,49.19 L57.06,61.56 A10 10 0 0 0 60.85,42.04ZM52.82,79.67 L83.53,108.40 A6 6 0 0 0 92.56,100.61 L68.64,66.03 A10.5 10.5 0 0 0 52.82,79.67ZM51.36,66.03 L27.44,100.61 A6 6 0 0 0 36.47,108.40 L67.18,79.67 A10.5 10.5 0 0 0 51.36,66.03Z" fill="${t.icon}"/><circle cx="60" cy="19" r="12" fill="${t.icon}"/></svg>`;

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
  const card = `<article class="screen">
    <div class="stripe"><i></i><i></i><i></i></div>
    <div class="body">
      <h1>${esc(screen.greeting)}</h1>
      <p class="sum">${esc(screen.summary)}</p>
      ${sections}
      ${screen.closing ? `<p class="sum">${esc(screen.closing)}</p>` : ""}
    </div>
    <footer><span>&gt; ${esc(screen.label)}${screen.in_deck ? ` · screen ${screen.index} of ${screen.count}` : ""}<b></b></span><span class="dim">${esc(screen.updated_label)} → next ${esc(screen.next_label)}</span></footer>
  </article>`;
  const chrome = phoneChrome
    ? `<header class="top"><span class="brand">${mark}<em>HMN</em></span><span class="mono">${esc(screen.date_label)}</span></header>
      ${card}
      <div class="dots">${dots}</div>
      <nav>
        <div class="tab on"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5"/></svg><span>Today</span></div>
        <div class="tab"><svg viewBox="0 0 24 24"><circle cx="8" cy="9" r="2.2"/><circle cx="16" cy="9" r="2.2"/><path d="M4 19c.6-2.4 2.4-3.5 4-3.5s3.2 1 4 2.2c.8-1.2 2.4-2.2 4-2.2s3.4 1.1 4 3.5"/></svg><span>People</span></div>
        <div class="tab"><div class="plus"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></div></div>
        <div class="tab"><svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16"/></svg><span>Projects</span></div>
        <div class="tab"><svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/></svg><span>Agents</span></div>
      </nav>`
    : `<header class="top"><span class="brand">${mark}<em>HMN</em></span><span class="mono">${esc(screen.date_label)}</span></header>${card}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HMN</title>
<style>
@font-face{font-family:"IBM Plex Mono";src:url("data:font/ttf;base64,${font64("IBMPlexMono-Regular.ttf")}") format("truetype");font-weight:400}
@font-face{font-family:"IBM Plex Mono";src:url("data:font/ttf;base64,${font64("IBMPlexMono-Medium.ttf")}") format("truetype");font-weight:500}
@font-face{font-family:"IBM Plex Mono";src:url("data:font/ttf;base64,${font64("IBMPlexMono-SemiBold.ttf")}") format("truetype");font-weight:600}
*{box-sizing:border-box}html,body{margin:0;background:${t.paper};color:${t.ink}}
body{width:390px;min-height:${phoneChrome ? "844px" : "480px"};font-family:"IBM Plex Mono",ui-monospace,monospace;background-image:linear-gradient(${t.rule} 1px,transparent 1px);background-size:100% 28px}
.top{display:flex;justify-content:space-between;align-items:center;padding:18px 20px 0}
.brand{display:flex;gap:8px;align-items:center}.brand em{font-style:normal;font-weight:500;letter-spacing:.08em;font-size:11px}
.mono{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${t.stone}}
.screen{margin:12px 16px 0;background:${t.card};border:1.5px solid ${t.ink};border-radius:4px;min-height:${phoneChrome ? "640px" : "420px"};display:flex;flex-direction:column;position:relative}
.stripe{display:flex;height:6px}.stripe i{flex:1;display:block}.stripe i:nth-child(1){background:${t.lilac}}.stripe i:nth-child(2){background:${t.coral}}.stripe i:nth-child(3){background:${t.sand}}
.body{padding:20px 20px 58px}h1{font-size:21px;font-weight:600;letter-spacing:-.01em;line-height:1.15;margin:0}
.sum{font-size:12px;line-height:1.5;color:${t.graphite};margin:8px 0 0}
.lbl{display:flex;justify-content:space-between;margin:14px 0 4px;font-size:10px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:${t.stone}}
.lbl.teal{color:${t.teal}}
.row{display:flex;gap:12px;padding:7px 0;border-top:1px solid ${t.hair}}
.box{width:18px;height:18px;border:1.5px solid ${t.ink};border-radius:2px;flex:none;margin-top:1px}
.mark{width:18px;height:18px;border:1.5px solid ${t.ink};border-radius:2px;flex:none;font-size:9px;font-weight:600;line-height:16px;text-align:center}
.ico{width:18px;height:18px;flex:none;margin-top:1px;stroke:${t.ink};fill:none;stroke-width:1.6}
.ico.teal{stroke:${t.teal}}
.t{font-size:13.5px;font-weight:500;line-height:1.3}.s{font-size:11px;color:${t.graphite};margin-top:2px}
.badge{font-size:9px;font-weight:600;background:${t.coral};color:#fff;padding:1px 4px;border-radius:2px;vertical-align:1px}
footer{position:absolute;left:0;right:0;bottom:0;height:42px;background:${t.ink};color:${t.paper};display:flex;justify-content:space-between;align-items:center;padding:0 14px;font-size:10px;letter-spacing:.06em;text-transform:uppercase}
footer b{display:inline-block;width:7px;height:11px;background:${t.teal};margin-left:4px;vertical-align:-1px}
footer .dim{color:#9a9a9a}
.dots{display:flex;justify-content:center;gap:8px;margin-top:12px}.dots i{width:8px;height:8px;border-radius:2px;border:1.5px solid ${t.stone};display:block}.dots i.on{background:${t.ink};border-color:${t.ink}}
nav{display:flex;justify-content:space-around;padding:10px 0 16px;margin-top:8px;border-top:1px solid ${t.hair}}
.tab{width:62px;display:flex;flex-direction:column;align-items:center;gap:4px;color:${t.stone};font-size:10px}
.tab.on{color:${t.ink}}.tab svg{width:24px;height:24px;stroke:currentColor;fill:none;stroke-width:1.6}
.plus{width:48px;height:48px;border-radius:6px;background:${t.ink};display:flex;align-items:center;justify-content:center;margin-top:-16px}
.plus svg{stroke:${t.paper};width:22px;height:22px;stroke-width:2}
</style></head><body>${chrome}</body></html>`;
}

export function fontFile(name: string): Buffer | null {
  const allowed = new Set(["IBMPlexMono-Regular.ttf", "IBMPlexMono-Medium.ttf", "IBMPlexMono-SemiBold.ttf"]);
  if (!allowed.has(name)) return null;
  return readFileSync(join(import.meta.dir, "..", "assets", "fonts", name));
}
