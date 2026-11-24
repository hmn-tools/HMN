/**
 * The shared style of the pages that the server serves: Garden, as in the app. White cards on a calm stone
 * ground, one sans face, Plex Mono for labels and data only, and an ink pill for the one main action.
 * The page loads nothing from the network: the face is IBM Plex Sans when the computer has it, else the system sans.
 * Each colour follows the light or dark setting of the reader.
 */
import { dark, tokens } from "./tokens";

const vars = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([name, value]) => `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`)
    .join(";");

export const SANS = `"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif`;
export const MONO = `"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace`;

export const GARDEN_CSS = `
:root{${vars(tokens)};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{${vars(dark)}}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--ground);color:var(--ink)}
body{font-family:${SANS};font-size:15px;line-height:1.45;padding:28px 16px;-webkit-font-smoothing:antialiased}
main{max-width:560px;margin:0 auto}
h1{font-size:30px;font-weight:600;letter-spacing:-.02em;line-height:1.15;margin:0 0 8px}
h2{font-size:16px;font-weight:500;margin:0 0 6px}
p{margin:6px 0}
.lead{color:var(--graphite);font-size:14px;margin:0 0 16px}
.note,.s{color:var(--stone);font-size:13px}
.label{font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--stone)}
.data{font-family:${MONO};font-size:13px}
.card{background:var(--card);border-radius:18px;padding:16px;margin:12px 0;box-shadow:0 4px 18px rgba(0,0,0,.06)}
.row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--rule)}
.row:first-of-type{border-top:0}
.t{font-size:16px;font-weight:500}
.band{display:flex;width:84px;height:5px;border-radius:3px;overflow:hidden;margin:12px 0 4px}
.band i{flex:1;display:block}.band i:nth-child(1){background:var(--lilac)}.band i:nth-child(2){background:var(--coral)}.band i:nth-child(3){background:var(--sand)}
button,.button{font:500 15px ${SANS};min-height:44px;padding:0 20px;border-radius:999px;border:0;background:var(--ink);color:var(--paper);cursor:pointer}
button.quiet{background:var(--card);color:var(--ink);border:1px solid var(--hair)}
button.danger{background:transparent;color:var(--danger);padding:0 4px}
button:disabled{opacity:.5}
input{font:15px ${SANS};min-height:44px;padding:0 14px;border-radius:14px;border:1px solid var(--hair);background:var(--card);color:var(--ink)}
label{display:flex;flex-direction:column;gap:6px;margin:12px 0;font-size:14px;color:var(--graphite)}
a{color:var(--ink)}
.error{color:var(--danger)}
`;

/** A whole page: the head, the Garden style, and the body inside one column. */
export function gardenPage(title: string, body: string, extraCss = "", head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${head}
<style>${GARDEN_CSS}${extraCss}</style></head><body><main>${body}</main></body></html>`;
}
