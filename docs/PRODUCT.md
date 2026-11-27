# HMN product

HMN (short for "human") is a personal data and information repository with calm surfaces and agents on top. It is the opposite of a pile of single-use apps. One graph holds the owner's life. A few quiet screens read that graph. Agents may propose changes. The owner decides what is saved.

This repository's demonstration data is fictional. It exists so the interface has something to show. It is not a record of a real household, and it deliberately has no name for the side project.

## Thesis

Single-use apps and their noisy interfaces fade. What remains is one repository that already knows the shape of a life, plus a handful of calm surfaces, plus agents that do chores against that repository.

The repository runs on the owner's own Mac mini (Apple Silicon, Docker). HMN itself sends nothing about the owner to another service by default. An agent that the owner gives a key sends what it reads to its own model. The iPhone, its widgets, and later an e-ink device are windows onto the same graph. They are not separate products with separate data.

## Who it is for

One person, the owner, is the only account. The owner runs a whole life through this system:

- Work.
- One side project. The project is a domain in the graph. Its public or commercial name is not required, and this product does not store one.
- Family: a spouse and two sons. They are people in the graph, not logins.
- Health. Sealed. Not on Today, not on a widget, not on a display, and not visible to an agent unless the owner grants one request.
- Cars and motorsport. Service, small faults, the next session. Personal: the owner's phone and the owner's widget, not a shared display.
- Sport as a fan of several teams. The owner wants the next fixture and the start time. The owner never wants a result, a score, a winner, or a standing. Fixtures default to public so a shared display can show them.

Everyone else (family, a garage, a school) appears as a record the owner acts on. They do not get a password.

## Principles

1. **Calm.** One screen at a time. No badges, no infinite feed, no streaks that scold, no notification noise. If nothing needs the owner, the screen says so and stops.
2. **Human first.** The owner captures, plans, and approves. The software does not invent obligations.
3. **Privacy first.** SQLite on the Mac mini. LAN or Tailscale only. No account at a vendor. No analytics. Logs do not contain titles or keys.
4. **Repository over apps.** Work, family, cars, and fixtures are rows and links in one graph. A new concern becomes data and a screen, not a new application.
5. **Confirm before save.** Workers, agents, and plugins propose. A worker is a scheduled job inside HMN, such as Morning or Triage. An agent is an outside client that uses an agent key or MCP. A proposal is invisible to the graph until it is approved. Review by the owner is the default. The owner can set a class of proposal from one worker or one plugin to be accepted with no review. A delete, a change to a tier or an area, Sealed data, and an outside client always wait for the owner. An accepted proposal is in the Activity list, and the owner can undo it. Decline leaves no trace in the graph.
6. **Upcoming, never results.** Sport and race fixtures store a start time and nothing about how it ended. This is an invariant, not a preference. The server rejects score, result, winner, standing, and points on a fixture.
7. **Provenance.** Every fact can say whether the owner, a plugin, or an agent created it, and which source it came from.
8. **Privacy is a tier on the data, not a promise in a settings screen.** Every entity has a tier. Surfaces have ceilings. A kitchen display, a lock screen, a widget, the phone, and an agent are not equally trusted. See Privacy below.
9. **The system has to actually be secure.** Access control without encryption, device keys, and a threat model is a label. [SECURITY.md](SECURITY.md) is part of the product.
10. **Small and true.** The screen shows what is due, what is coming, and what has gone quiet, and only what that surface is allowed to show. It does not perform productivity.
11. **Models stay inside the tier.** A local or on-device model may see what that job is allowed to see. A cloud model never receives Private or Sealed text, even if a setting says otherwise. Cloud is opt-in, has a ceiling, and stops at a monthly spend cap.

## Jobs to be done

| Job | What "done" feels like |
| --- | --- |
| Daily orientation | The owner opens Today, sees the few things that need the owner, and puts the phone down. |
| Capture | A thought becomes an inbox row in a few seconds, with no required project, date, or area. |
| Plan and review the week | Once a week the owner sees what moved, what slipped, what is coming, and what to leave alone. |
| Goals, projects, tasks | A goal can have projects. A project can have tasks. A task can also stand alone, usually because it is for a person. |
| People and relationships | Family dates and errands stay attached to a person. The Family block on Today is dates, not a social feed. |
| Agents proposing changes | An agent explains what it read, what it wants to add, and why. The owner approves, declines, or edits the proposal first. Nothing is written before that. |

## How the life is organised

Areas are the top of the graph. They are domains, not folders the owner has to tidy.

| Area | Default tier for what is filed there | What belongs there |
| --- | --- | --- |
| Work | Personal | The job, weekly notes, work projects. |
| Side project | Personal | The one side project, described without a public name. |
| Family | Private | Spouse, sons, school, family dates. The unlocked phone shows these. Widgets, the lock screen, and the shared display do not. |
| Health | Sealed | Anything bodily. Vault only. |
| Cars | Personal | A car as an asset, service, faults, motorsport admin. |
| Sport | Public | Upcoming fixtures only. Safe on a shared display. |
| Home | Personal | Trips and the house. A document such as a passport note is Sealed even though the trip is Personal. |
| Money | Sealed | Reserved. No screen in v1. |

## Privacy

Privacy here means two different things, and both are required.

**Access** is who and what may see a fact: tiers, ceilings, redaction.
**Security** is whether the system can keep that promise when a phone is lost, a key leaks, or a plugin misbehaves. That threat model and the v1 controls live in [SECURITY.md](SECURITY.md).

### Tiers

Every entity has one effective tier. A property may be stricter than its entity. A link or a derived fact takes the strictest tier among its sources. An item with no explicit tier inherits from its area. The owner may override an item, in either direction. An agent may not lower a tier below the inherited floor.

| Tier | Meaning |
| --- | --- |
| Public | Fine on a shared or e-ink display, a lock screen, a widget, and the phone. |
| Household | The people who live in the home: the fridge, the phones of household members, the owner's lock and StandBy widgets, and the owner's other surfaces. Not a guest agent, not a Public display. |
| Personal | Default. The owner's own phone and home-screen widget. Not the shared display, not the lock screen. |
| Private | The phone only after it is unlocked. Never a widget, a lock screen, or `/api/display`. Family defaults here. |
| Sealed | Encrypted as fields, not only as part of the database file. Hidden until the owner opens the vault for this session. Agents and MCP do not receive it unless the owner grants that one request. Health, money, and identity documents default here. |

The order is Public < Household < Personal < Private < Sealed. "Stricter" means further down that list. Household was added on 2026-11-23, for the fridge and the family: see [ONTOLOGY.md](ONTOLOGY.md).

### Ceilings

Enforcement is one policy layer on the server. Handlers, MCP, the renderer, and plugins do not each decide. The effective ceiling of a request is the stricter of the credential's maximum tier and the surface's ceiling. A panic flag on the device can only push that ceiling down.

| Surface | Ceiling |
| --- | --- |
| Shared display (`/api/display`) | Public |
| Lock screen and StandBy | Household |
| Home-screen widget | Personal |
| Phone, unlocked | Private |
| Vault lens on the phone, after a biometric prompt and a short-lived grant | Sealed |
| Agent, MCP, plugin | Personal. Private only while the owner's grant for that one key is open. Never Sealed. |

A leaked owner key used from curl is not a vault. Sealed data stays sealed. The phone holds a paired device key, and only that key can ask for a vault grant. The server cannot see Face ID. The phone is responsible for storing that key behind the Keychain and for asking for biometrics before it requests a grant. That split is deliberate and is written up under the lost-phone threat.

### What a lower surface is allowed to learn

If a fact is above the ceiling, it is omitted. It is not returned with a blanked title alongside a count, because the count would leak. Search does not match it. "3 due" does not include it. A link to it is dropped, not labelled with the hidden title.

The owner's phone, still below the vault, may be told that a sealed proposal exists, without the title, the names, the reason, or the count of sealed notes. The card is fixed: "Sealed", with the button Open the vault. Opening the vault is what reveals the approved Agents mock. The display never uses that sentence, because a kitchen screen should not announce that a sealed proposal is waiting.

### Proposals

A proposal has a tier, computed as the strictest of its payload, its links, and the records it was derived from. The demonstration proposal is Sealed because it was derived from a sealed passport note. Approving or reading it requires the vault. An agent cannot raise its own ceiling, cannot mint a grant, and cannot mark a family or health fact Public in order to route it onto the display.

### Panic

"Hide" drops that device's ceiling to Public immediately, clears the widget snapshot, and refuses Private and Sealed until the owner ends it. It is a calm control, not an alarm.

### What this does to the demonstration day

On the unlocked phone, Today still reads as the designed screen: three things due, the family concert, the fixture, the quiet car fault. The sealed passport note is not on Today.

On the widget, the family concert and the dentist errand are absent. What remains is personal and public: the weekly notes, the garage, the quiet fault, the race.

On the shared display, only the race remains, with no name in the greeting.

The spine inside an area is optional:

```
Area → Goal → Project → Task
```

Links cover the rest: a task about a person, an event with a person, an event at a place, a task about a car, a note about a trip. Capture is allowed to be a task with a title and nothing else.

## What a day looks like

Morning or whenever the owner looks: Today on the unlocked phone. A greeting, one sentence, due tasks, the next family date, the next fixture (no result), and anything that has sat without a date long enough to be called quiet. A black bar tells the owner which screen this is and when it will refresh. The widget and the shared display are showing a smaller, lower-tier slice of the same day.

During the day: capture from the plus button. If the owner has the owner key, it saves. If the owner has an agent key, it becomes a proposal. The new row inherits its area's tier.

When an agent has been busy: the Agents tab shows the proposal if the owner's ceiling may see it. A sealed proposal is a single calm line until the owner opens the vault. The owner declines it, approves it, or edits the title, date, and reason first. Nothing is written before that.

Once a week: a review screen (specified in [UX.md](UX.md), built in the next slice). It is a list, not a report.

The e-ink device, later, polls the same screens and rotates them the way TRMNL does. The phone can do the same.

## Feature list

### v1 — the life system

The data model and the owner loop. This is the product, not a demo graph.

- Areas, people, goals, projects, tasks, notes, events, places, assets, sources. Habits are accepted by the API. A habit for a child is a routine, with a screen on the member's phone and on the fridge.
- Typed links between any two records. Flexible properties. Provenance. Soft delete.
- Privacy tiers on every entity, inheritance from areas, stricter-of-sources for links and proposals, and one policy layer. A Public display stays Public. Lock screen and StandBy are Household. The home-screen widget is Personal. The unlocked phone is Private. The vault is Sealed and per request.
- Field-level encryption for Sealed values, and an encrypted database file at rest. Keys in the macOS Keychain on the mini, not in the repo.
- TLS everywhere, device pairing, per-device keys with revocation, hashed credentials, expiry, rotation, rate limit and lockout.
- A hash-chained audit log of Private and Sealed reads and writes, and of security events, viewable in the app.
- Scoped API keys: read, write, agent, each with a maximum tier. Agent keys also deny Health and Money even if a tier is mis-set.
- Confirm-before-save proposals: list, edit, approve, reject. MCP writes are proposals. Agents cannot raise their own tier.
- Today, as JSON for the phone and as HTML and PNG for a display, each filtered by that surface's ceiling.
- A screen deck of four. Only Today is rendered in the first build. The deck, the index, and the refresh rule exist so rotation does not need a new model later.
- Capture into an inbox. Inbox rows stay off Today until they have a date or are made open.
- Browse and detail for every entity type.
- Agent inbox with approve, decline, and edit-first.
- Settings: server URL, pairing, the device key in the iOS Keychain, a privacy lens, panic, an audit list, and an honest connections list (nothing is installed).
- Home-screen widget for the Personal slice of Today. The widget never receives Private or Sealed rows.
- Fixture invariant: no scores, results, winners, standings, or points.
- Seed data that is obviously an example, including one pending proposal.
- Mac mini run path: Bun on the metal, or Docker.

The first code slice in [ROADMAP.md](ROADMAP.md) builds this list except the weekly review screen. Weekly review is specified now so the next slice does not reopen the product.

### v1.1 — the rest of the calm surfaces

- Weekly review screen.
- The other three deck screens rendered, and hourly rotation across the ready ones.
- Lock screen, StandBy.
- Habits and routines as a surface, not only a type.
- Editing links on a proposal.
- A connections page that can show a plugin as installed, still with propose-only writes.

### Later

- A one-time import from the Notion Life Ontology. Notion is then retired.
- Calendar plugin.
- Health plugin, still Sealed, still off every surface except the vault.
- Sports fixture plugin that only proposes future start times and is rejected if it includes a result.
- Tailscale as the remote path, written as a runbook.
- TestFlight.
- Live Activities.
- Money, if it is ever wanted, as its own Sealed area with no agent access.
- A physical TRMNL on the LAN. The server side is [TRMNL.md](TRMNL.md): setup, display, and log, Public only, one key per device. OG is 800×480. TRMNL X is 1872×1404.

## Non-goals

- Shared accounts, or a second graph for each person. The household uses member phones on the owner's server, with the roles Partner and Child. See [ONTOLOGY.md](ONTOLOGY.md), section 5.4.
- A chat transcript as the interface. Agents propose a structured change. They do not keep a thread in this product.
- Scores, results, spoilers, tables, or "how did they get on". Not on Today, not in the graph, not in a plugin payload.
- Streaks, points, leaderboards, unread counts, or red badges. The Agents tab may show a single teal mark when something is waiting. That is the only mark.
- An infinite second brain: no graph canvas, no backlink garden, no daily prompt to write more.
- Replacing maps, camera, mail, banking, or a medical record. Health notes can be stored. The product does not diagnose, remind about medication, or give training advice.
- Cloud sync, an account, or a phone that works while the Mac mini is off. If the server is unreachable, surfaces show the last snapshot and say they are stale.
- Plugins that write straight into the graph. Plugins propose, the same as agents.
- A public API, a marketplace, or a theme gallery.
- Notifications that fire on their own. The phone shows a widget. It does not tap the owner on the shoulder.
- Telemetry, crash reporting to a vendor, or a phone-home of any kind.
- A tier that is only a colour in the interface. If the server will return the bytes, the tier is not doing its job.
- A store for secrets: passwords, 2FA seeds, card numbers, or document numbers. The password manager keeps them. HMN keeps the expiry date, the renewal task, and a link.
- A library of files or photos. HMN links to a file, a folder, or an album.
- Streams of metrics: daily health, sleep, or training data. HMN keeps monthly summaries and notable events.
- A two-way sync with another app. An app is a source that proposes, or it receives a one-way export.
- A bulk import of a data dump. An agent reads the dump outside HMN and proposes the facts worth keeping.
- An issue tracker or a code host. A coding project is one row with a link to its repository.

[STRATEGY.md](STRATEGY.md), "Boundaries", has the map of what HMN keeps and what it links.
