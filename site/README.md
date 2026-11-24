# The HMN website

**Status: a second draft from 2026-11-23. It is deployed to Vercel at hmn.tools.** It exists to test the marketing and the presentation before the public release.

The website is two static pages. [index.html](index.html) is the sales page: it is short, and it has big type and real screens. [docs.html](docs.html) is the docs page: the install, the iPhone app, the two rules, agents, calendars, workers, the display, backups, and security, each with a link to the full document. There is no build step, no script from another site, and no tracker. The typefaces and the images are files in this folder.

The look is Garden, the design system of the app since 2026-11-23 ([docs/UX.md](../docs/UX.md)): real screens as objects on a calm stone ground, white cards, one sans face, an ink button, and the band of lilac, coral, and sand one time on a page. The mono typeface stays for labels, code, and data. The sans is IBM Plex Sans, the same as the app. The first draft took its direction from trmnl.com, and it had a serif headline and a coral button.

## Look at it

```sh
cd site
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8765/`. The page also opens as a file, with no server.

## What is in it

| File | What it is |
| --- | --- |
| `index.html` | The sales page, with the script of the reader demo. |
| `sample-data.ts` | The fictional week for the screens. It runs against a test server on loopback only. |
| `docs.html` | The docs page, with the script of the section list and the Copy buttons. |
| `style.css` | The style of the two pages. |
| `fonts/` | IBM Plex Mono, the same three files as the server, IBM Plex Sans, the same three files as the iPhone app, and the text of the font license. See [THIRD_PARTY.md](../THIRD_PARTY.md). |
| `img/phone-*.webp` | Real screens of the iPhone app in the simulator, with the fictional demonstration. |
| `img/display-upcoming.png` | The shared display image that the server made for the same day, from `/api/display/upcoming.png`. |
| `img/mark.svg` | The mark. See [TRADEMARKS.md](../TRADEMARKS.md). |

## Rules for a change

- The colours are the Garden colours in [docs/UX.md](../docs/UX.md). The page adds a dark set for a dark system. A screen of the app stays light in the dark set, because the app has no dark set.
- Each claim on the page is in a document of this repository. Change the document first.
- The sales page leads with the problem: a life is spread over many apps, and the person is the one who holds it together ([docs/PHILOSOPHY.md](../docs/PHILOSOPHY.md), "From applications to personal continuity"). HMN holds it, on a Mac that the person owns. Then one line on what a calm screen does, and four panels, each from a principle in [docs/DESIGN-PRINCIPLES.md](../docs/DESIGN-PRINCIPLES.md): access at the data boundary (2), action as a proposal (5), a clear job for each surface (7), and ownership with replaceable models and devices (1, 4). The footer line is the tagline "Tools for humans", from the owner on 2026-11-23, with the domain hmn.tools. A term such as "ceiling" or "propose" needs its context on the page.
- The two documents are working drafts. The page says only what is built. A recommendation in a draft is not a claim on the page.
- The sales page stays short. A detail, a limit, or a status line goes on the docs page or in a document.
- The docs page is a summary. Change the document first, then the section that points to it.
- The sales page makes no claim about encryption before the security review. The roadmap has that rule.
- A screen on the page is a real screen. Do not draw one.
- The reader demo uses rows and tiers from the demonstration in [server/src/seed.ts](../server/src/seed.ts) and from [sample-data.ts](sample-data.ts).

## How the screens were made

A test server ran with `HMN_INSECURE_DEV_KEK=1`, its own `HMN_DATA_DIR`, `HMN_NOW=2026-11-11T04:39:00.000Z`, and `HMN_TZ=Australia/Perth`. Then [sample-data.ts](sample-data.ts) added a fuller fictional week through the API: more tasks and family dates, a football match, notes, Sealed health and money rows, three keys, a guest, and two proposals from the key `home-helper`. The simulator was an iPhone 16. The Sealed proposal of the first boot was declined, so that the Review screen shows the insurance proposal. The screens were taken on 2026-11-23. `phone-today` and `display-upcoming` were taken again on 2026-11-24, in Perth time. For `phone-asleep` the test server was stopped, and the app was opened again. The sales page uses `phone-today`, `display-upcoming`, a part of `phone-proposal`, and a part of `phone-asleep`. The docs page uses `phone-keys`, `phone-private`, and `display-upcoming`.

## Open

- The host is Vercel, project `hmn` on the personal account, with the root folder `site` and no build step. A push to `main` deploys it. `.vercelignore` keeps this file and `sample-data.ts` off the site. The domain is hmn.tools, registered on 2026-11-23.
- The links go to the repository. They work for a visitor only after the repository is public.
- A social card image for a shared link.
- Smaller font files. The six font files are TrueType, about 0.2 MB each. A WOFF2 form is smaller.
