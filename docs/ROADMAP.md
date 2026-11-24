# HMN roadmap

The product, the screens, and the data model are decided in [PRODUCT.md](PRODUCT.md), [UX.md](UX.md), and [SCHEMA.md](SCHEMA.md). This file is only the build order. A later slice should not reopen a decision that those documents already make. If a slice discovers that a decision cannot be built, change the document in the same change as the code.

Demonstration data stays fictional. Do not introduce a real name for the side project.

## Direction

Decided on 2026-11-18. The full text is [STRATEGY.md](STRATEGY.md).

- HMN is the private, structured record of one life. It is a store, not an agent runtime.
- A worker is a scheduled rule job inside HMN. An agent is an outside product that connects through MCP. A connector brings data in from an open standard. All three only propose.
- One write path: a proposal, then the approval policy, then the graph. Review is the default. The owner can turn review off for a class.
- HMN is the source of truth for tasks, notes, people, goals, projects, and areas. Calendars are mirrored. Notion is retired after a one-time migration.
- Compute goes inside HMN only when it must read above every outside ceiling, enforce an invariant with the write, or work with no agent and no model.
- HMN maintains connectors for open standards only. All other services connect through an agent. The public interface is the proposal contract, and since 2026-11-20 the read contract.
- The first release is the server on a Mac, and then the iPhone app.
- The licence is Apache-2.0.

Slices 1 to 10 built the first version. Slices 11 to 20 follow this direction. Slices 12 to 16 come first because the owner cannot use HMN with real data until they are done.

## Slice 0 — Product plan

**Status: this change.**

Write and commit `docs/PRODUCT.md`, `docs/UX.md`, `docs/SCHEMA.md`, and `docs/ROADMAP.md`.

Done when the four documents agree on types, scopes, the Today rules, the proposal flow, the deck of four screens, and the feature split between v1, v1.1, and later.

## Slice 1 — Foundation

**Status: done.**

The v1 core from the product list, minus weekly review, which is slice 2. Habits are accepted by the API and have no screen.

Server, in `server/`, Bun and TypeScript, SQLite via `bun:sqlite`:

- Schema and registry matching [SCHEMA.md](SCHEMA.md), including the demonstration seed and tiers.
- One policy layer. API, MCP, Today, and `/api/display` all go through it.
- REST API, scoped keys with a maximum tier, expiry, rotation, area denial for Health and Money.
- Device pairing, revocation, vault grants, panic.
- Proposals: create, edit, approve, reject. Agent and MCP writes propose. A proposal's tier is the strictest of its sources. Agents cannot lower it or mint a grant.
- Encrypted database file at rest, field encryption for Sealed columns, encrypted backups. Keys via the macOS Keychain on the mini.
- TLS only. Rate limit and lockout. Hash-chained audit log.
- Fixture invariant enforced on create, update, and approval.
- MCP on stdio and `POST /mcp`, with the tools listed in the schema doc. No tool writes the graph directly.
- Today JSON, Today HTML, Today PNG, and `GET /api/display`, each at the right ceiling.
- Deck metadata for all four screens. Only Today is `ready`.
- Empty plugin registry with a manifest type. No dynamic code, no scheduler that fetches anything.
- Dockerfile and docker-compose for the Mac mini. Data on a volume. The key is a Docker secret produced from the Keychain, not a value in the compose file. Port 8787, TLS.
- Tests for ceilings on the API, MCP, and display (forbidden strings absent), auth scopes, lockout, audit chain, encryption at rest, sealed fields absent from the SQLite plaintext, backup ciphertext, pairing and revoke, panic, the spoiler rejection, the Today content against the frozen clock, and MCP propose-then-list.

iOS, in `ios/`, SwiftUI, iOS 17, bundle id `org.hmn`, signing team unset:

- Tokens in `Theme.swift`. IBM Plex Mono bundled.
- Pairing, certificate pin, device key in the Keychain with this-device-only accessibility. Biometric prompt before a vault grant.
- Settings: server URL, fingerprint, connections listed as not installed, graph browse, privacy lens, activity.
- Today at the phone ceiling, Hide, Agents (including the sealed state, then approve, decline, edit first once the vault is open), capture sheet with the inbox list.
- People and Projects tabs, plus browse and detail for every type, with the tier control.
- WidgetKit widget, small and medium, from a snapshot taken at the widget ceiling only.
- App Group entitlement present and documented. It still needs a team in Xcode before the widget can share the snapshot. That limit is expected on this build, which cannot compile iOS on Linux. Face ID, the Keychain prompt, and TLS pinning have to be confirmed on a Mac.

README: thesis, architecture diagram, how to run on a Mac mini, curl for the API, a proposal, and the display, and pointers to the docs.

Done when:

- `bun test` passes in `server/`.
- The server boots on TLS, seeds the demonstration graph, and serves Today.
- The phone-ceiling HTML shows the greeting, the three due tasks, the family date, the fixture with no result, and the quiet task, and does not show the passport note or the clinic note.
- The display HTML and JSON show the fixture and do not show family names, task titles, the passport, or the clinic note.
- An agent and an MCP client at Personal do not receive Private or Sealed bodies, and search does not find them.
- The on-disk database is not a SQLite file, and sealed titles are not plaintext inside the decrypted SQLite file either.
- The iOS project opens from `ios/HMN.xcodeproj` or `ios/project.yml`.
- Weekly review, lock screen rendering, real plugins, Tailscale, and TestFlight are not pretended to exist.
- Anything that needs the owner's Mac or a review is listed in the pull request, not marked done.

## Slice 2 — Weekly review and the rest of the deck

**Status: done.**

Build the weekly review specified in [UX.md](UX.md), as JSON and as a phone screen reached by a "Week" text button on Today. Same card, same type, no charts.

Render `upcoming`, `commitments`, and `quiet` with the same HTML and PNG path as Today. Mark them `ready`. Rotation then advances one ready screen per hour. Add a test that a two-screen deck advances, and that a not-ready screen is skipped.

Done when a frozen clock produces a review that matches the rules in UX (done, slipped, next week, quiet, fixtures with no results) and `/api/display` can return a screen other than Today.

## Slice 3 — Lock screen and proposal links

**Status: done.** Lock screen, StandBy, and the Live Activity read a public payload. The home-screen widget stays Personal. Proposal links can be replaced before approval, and the tier is recomputed. Habits have a today check-in and no streak.

- Lock screen and StandBy widgets from the same snapshot. Due count and next short title only.
- Edit links on a pending proposal, both in the API and on Edit first.
- Habit screen: a list of active habits with cadence. Still no streaks and no reminders.

Done when a proposal's links can be changed without approving it, and a habit row round-trips through the API onto a screen that does not show a count of completions.

## Slice 4 — Notion Life Ontology

**Status: done.** The live Notion API is optional and only runs when a token is configured. Tests use fixture pages.

First plugin. Source kind `notion`. Mapping as in [SCHEMA.md](SCHEMA.md). A tick diffs a fixture export (a JSON file in tests, not a live Notion workspace) and creates proposals. It does not write entities. Settings shows this plugin as installed once the source exists, and still shows the others as not installed.

Done when a test fixture page becomes a pending proposal, approval creates the entity with `external_id` set, and a second tick proposes an update instead of a second create.

## Slice 5 — Calendar

**Status: done for ICS text and an ICS URL.** Google Calendar OAuth came later, with the sandbox, and is read-only. A CalDAV server is used by subscribing to the calendar's ICS URL with `HMN_CALDAV_URL` and `HMN_CALDAV_PASSWORD` on the mini. Full REPORT/sync-token support is still later.

Plugin kind `calendar`, against a fixture file. All-day dates stay dates. Unknown attendees do not become people. Family events are the ones whose attendees are already family people.

## Slice 6 — Sport, still without results

**Status: done.** Motorsport sessions use the same plugin and the same ban on results. The category is `sport` or `motorsport`. Both become `event` kind `fixture`.

Plugin kind `sport`, against a fixture file that deliberately includes a score. The plugin strips it. A second test submits the score anyway and the server rejects the approval. Only future start times are proposed. Teams are a list on the source.

## Slice 7 — Health, still private

**Status: done for summaries.** The phone reads HealthKit. The server stores a sealed proposal. The daily number is included only when the owner opts in. Sample series are dropped. A real HealthKit read still has to be confirmed on a phone.

Plugin kind `health`. Approved entities land in `area_health`. The default agent key still receives 404 for them. Today still does not show them. The plugin text does not interpret a reading.

## Slice 8 — Tailscale and TestFlight

**Status: written up, not performed.** The steps are [TAILSCALE.md](TAILSCALE.md) and [TESTFLIGHT.md](TESTFLIGHT.md). They need the owner's Mac, a Tailscale account the owner already has, and an Apple Developer team. Nothing in git gained a team id.

- A runbook: install Tailscale on the Mac mini and the phone, bind HMN to the tailnet, put the tailnet URL in Settings. No public port.
- Archive the iOS app with a real team (the placeholder team stays unset in git) and ship a TestFlight build that points at that URL.
- Confirm the widget's App Group with that team.

These are operational. They do not change the model.

## Slice 9 — Workers and a TRMNL display

**Status: done.** Six workers run on the mini. A TRMNL OG or TRMNL X on the LAN can pull Public screens. Google Calendar OAuth is in the tree and is read-only.

Workers, in `server/src/workers/`:

- Morning composes the Today focus line and the first three items the worker is allowed to see, and files that as a note proposal.
- Week files the weekly review as a note proposal, including the closing line from [UX.md](UX.md).
- Triage files a task, a person, or a link from a captured note. It does not copy the note body into the proposal.
- People files a birthday, anniversary, or "haven't been in touch" task. It may read Private. Family proposals stay Private. A date field that is not a date is ignored.
- Fixtures files one public "What to watch" note for the next fourteen days. Scores, results, winners, standings, and points are not copied, and a title that already looks like a result is omitted.
- Goals, on the first of the month, files one next-step task for an active goal with no active project and no open task.
- The effective ceiling is Personal, except People, which may be Private. Sealed is refused. Health and Money are denied even if a row is mis-tagged.
- The model is Ollama or an OpenAI-compatible server on localhost. Cloud is a separate switch per worker, with a tier and a warning that must be accepted, and cloud still stops at Personal. The default with no URL set is the deterministic fallback, and tests do not open a socket.
- Source text is fenced as data. A model reply that asks to approve, or that names text the worker was not shown, is discarded. The graph changes only when the owner approves.
- `GET /api/v1/workers.html` lists tier, model, schedule, last run, and the journal lines this ceiling can see. Pause sets `enabled` to false. `GET /api/v1/access` lists paired devices, MCP keys, TRMNL displays, and plugins, with revoke. An outside assistant uses [EXTERNAL-AGENTS.md](EXTERNAL-AGENTS.md), off by default, Personal at most.

TRMNL, in `server/src/devices/` and [TRMNL.md](TRMNL.md):

- `GET /api/setup`, `GET /api/display` (when the device sends its `ID` header), `GET /api/display/current`, and `POST /api/log`, matching the public BYOS guide.
- OG images are 800×480, drawn on the mini: 1-bit BMP, 1-bit PNG, or 4-grey PNG. A TRMNL X (`Model: x`) gets a 1872×1404 16-grey PNG. No font or bitmap is fetched.
- Each display has its own read key, forced to Public. Claim is localhost-only. Revocation uses the same credential path as a phone.
- The existing `/api/display` response without an `ID` header is unchanged, so the phone and the tests keep the HTML and PNG paths.

Done when `bun test` passes, a malicious note does not approve a proposal or surface the sealed clinic note, a public worker does not see the work tasks, a revoked display key is rejected, and the BMP is 800×480 at 1 bit.

## Slice 10 — Mac mini companion

**Status: in the tree.** The menu bar app and the launchd install are in the tree. They were not run on the owner's Mac.

- `mac/`: a SwiftUI menu bar app, macOS 14, bundle id `org.hmn.menu`, no Apple team. It shows server status, start, stop, and restart, a pairing code and QR, paired phones with revoke, encrypted backup and restore, the audit list, whether the hash chain verifies, and one-click Hide.
- Hide calls `POST /api/v1/admin/panic`. Every live phone drops to Public. The owner key on the mini is left in place so the menu can undo it. Nothing is deleted.
- The new localhost routes are in [SCHEMA.md](SCHEMA.md). They need a write key and a loopback peer.
- `deploy/install.sh` is idempotent. It installs Bun when it is missing, keeps the data directory mode `0700`, lets the first boot put keys in the Keychain, loads a launchd job at login, and rotates the log when the process starts or the log passes a megabyte. `--local-llm` installs a localhost-only Ollama model sized for the Mac. `--dedicated-user` adds a nologin user `_hmn` and a LaunchDaemon. `deploy/uninstall.sh` removes the job and leaves the data unless `--purge`. `deploy/doctor.sh` checks permissions, the Keychain, the certificate, launchd, backup age, and whether a configured local model answers.
- Models are a layer of their own, in [MODELS.md](MODELS.md). Private and Sealed text cannot be sent to a cloud model. Cloud spend has a monthly cap. The menu and the phone settings show this month's egress.
- Docker Compose is unchanged.

Done when the layout tests pass, `bun test` passes, and `xcodebuild` on a macOS runner builds and tests the menu app without an Apple team. FileVault, the Keychain prompts, launchd after a reboot, and pairing from the QR still have to be confirmed on the mini. That list is in [MAC-MINI.md](MAC-MINI.md).

## Slice 11 — Workers, the name

**Status: done.**

The six scheduled jobs are workers. `server/src/workers/`, the tables `worker_configs` and `worker_runs`, and the routes under `/api/v1/workers`. The journal is shared with outside clients, so it is `server/src/journal.ts` with the column `actor_id`. The plugin child process is `server/src/plugins/child.ts`. The credential scope `agent` and the Agents tab did not change.

## Slice 12 — Run on the owner's Mac

**Status: the code is done. The run on the mini is open.**

The Mac is the target, and the Mac path was not proven.

Done on 2026-11-18:

- The plugin child process runs under `sandbox-exec`. Bun aborts at startup unless it can read the root directory entry and its working directory. The profile now allows a read of `/` itself, and the child starts in `/`. The sandbox test now checks isolation on macOS too.
- `HMN_KEYCHAIN` works. The server and the install scripts passed the keychain to `security` with a `-k` option that the tool does not have. Every Keychain call failed in the dedicated-user install. The keychain is now the last argument.
- The recovery passphrase is 13 words from a list of 256, which is 104 bits. One random byte selects one word, so the draw has no bias. A data directory that exists keeps its old passphrase.
- CI has a macOS job that runs `bun test`.
- The README says what is built.

Found on 2026-11-19: the iPhone app had never been compiled. `ios/HMN.xcodeproj` gave each target only a Frameworks build phase, so `xcodebuild` reported BUILD SUCCEEDED and made an app with no executable, also in CI. The project now has Sources and Resources phases, the three `Info.plist` files name their executable, and the font paths are correct. Two compile errors in old code were fixed. CI now checks that the build made the three executables.

Done on 2026-11-19, before the run on the mini:

- The install is safer. It checks the Mac before it changes anything, and it does not use a Bun inside a version manager. It shows the recovery passphrase only to a person at a terminal, so an agent that runs the install does not see it. It waits for the server to answer. A purge asks for the word `purge`.
- `deploy/hmn` is one command for the owner: `install`, `status`, `start`, `stop`, `restart`, `logs`, `pair`, `passphrase`, `update`, and `uninstall`.
- The health check also reads `/health`, the certificate pin, the Bun and the checkout of the job, and FileVault.
- CI runs a real install on a macOS runner, with a Keychain and launchd. [MAC-MINI.md](MAC-MINI.md) lists what that test shows and what it cannot show.
- `deploy/test/layout.test.sh` passes on a Mac. A layout does not read the real Keychain or launchd.
- The first real install in CI found a fault. The supervisor (`deploy/hmn-run.sh`) did not act on TERM until its 30-second sleep ended, so launchd killed the server on each stop, restart, and log out. A killed server cannot save, and it leaves a plain working copy of the database in the temporary folder. The supervisor now passes TERM at once. It also starts a crashed server after 2 seconds, not 30.
- The save of the encrypted graph was a write over the old file. A kill during that write left a part of a file. The save is now a new file and one rename. Each start removes the working copies of servers that are gone.
- The install started the job and then ran `launchctl kickstart -k`, which killed the server while it opened the graph. The `-k` is gone.
- The install stops when the Keychain has `hmn.kek` and there is no graph. A test server on the build machine left such a key in the login Keychain on 2026-11-19, and a first boot there would have used it.

Not corrected:

- Restart in the menu bar app still uses `launchctl kickstart -k`. With the two corrections above this does not damage the graph, but the server gets no time to close. `deploy/hmn restart` is a stop and a start.
- `deploy/hmn` and the health check read the manifest in the home folder. In the dedicated-user install the manifest belongs to root, so `status` there needs `sudo`, and that path was not run.
- The install was read and tested from a MacBook Air on 2026-11-19. `bun test` passed there with 94 tests. No install was made on that machine.

Found on 2026-11-19: a missing keychain file did not isolate anything. `security add-generic-password` writes to the login keychain, and reports success, when the keychain file it is given does not exist. A test server and the local test runs of the build session wrote `hmn.kek`, `hmn.owner`, `hmn.agent`, `hmn.display`, `hmn.backup`, and `hmn.audit.tip` to the login Keychain of the build machine. The server now makes no Keychain call when `HMN_KEYCHAIN` names a missing file, `HMN_INSECURE_DEV_KEK=1` works on a Mac and makes no Keychain call, and the tests never use a real Keychain. The six items were removed from the build machine on 2026-11-19, with the owner's agreement. No first boot was made on that machine while the items were there. With the test `hmn.kek` in the Keychain, a first boot uses that key as its own, with no message.

Open, and they need the owner's devices:

- Run `deploy/hmn install` on the mini and work through the list in [MAC-MINI.md](MAC-MINI.md). The reboot, the login, the Keychain after a login, the menu bar app, and the phone are not proven.

Done when `bun test` passes on macOS, the server runs from launchd after a reboot, and the phone pairs from the QR code.

## Slice 13 — Proposals that stay declined

**Status: done on 2026-11-18.** The rules are in the Workers section of [SCHEMA.md](SCHEMA.md).

- A worker remembers a decision. Each draft has a source key. The key is stored on the proposal with the worker's principal id. A pending, declined, or expired proposal with the same key stops the draft. The check does not use the ceiling, so a proposal that the worker cannot read still stops a repeat.
- An approved proposal also stops a repeat for People and Triage. Before this slice an approved birthday reminder returned on the next day, and an approved Triage task returned in the next hour.
- A birthday or an anniversary has its date in the key, so next year is a new item. A quiet-contact draft has the last contact date in the key.
- A pending proposal with a last day expires on the day after. The status is `expired`, the audit log records it, and the graph does not change.
- Morning, Week, and Fixtures file no second note while an earlier one is pending. A note declined today stops a second note today.

Not in this slice:

- A decline of a Goals step has no end date. The owner cannot clear a decline yet. The Activity list in slice 14 is the place for that.
- An outside agent has no source key. Slice 17 adds the idempotency key.
- The iPhone app does not show the last day of a proposal. The API returns it as `expires_on`.

## Slice 14 — Approval policy by class

**Status: the server is done on 2026-11-18, and the screens on 2026-11-19.** The rules are in "Approval policy" in [SCHEMA.md](SCHEMA.md).

Review is the default. The owner can turn it off for a class. A class is a source, an operation, an entity type, and a tier.

Done:

- A policy table: for each class, `review`, `auto`, or `deny`. The server names the source of each proposal, so a caller cannot take a plugin's name.
- Never `auto`: a delete, a patch that sets the tier or the area, a patch to an area, anything Sealed, and anything from a source that is not a worker or a plugin.
- An auto-accepted write goes through the same write path as an approval, so the provenance and the history are the same. The owner can undo an applied proposal.
- `GET /api/v1/activity` lists approved, auto-accepted, declined, expired, and undone proposals. The owner can clear a decline, so that the worker can propose the item again.
- `POST /api/v1/proposals/batch` takes one decision for a named list of proposals from one source. The caller names each id, so nothing unseen is decided.
- Principle 5 in [PRODUCT.md](PRODUCT.md) is corrected.
- The audit tip goes to the Keychain when the database is saved, not for each audit row. One Keychain call for each row made a batch of 40 slow on a Mac.

Open:

- The screens are built since 2026-11-19: Review (a batch decision), Activity with Undo, Rules, and Calendars. They were run in the iPhone 16 simulator against a test server, not on a real iPhone. The Rules screen sets a rule for a whole source. A rule for one operation, one type, or one tier is set through the API.
- Done on 2026-11-19 in slice 19C: undo of an approved removal.
- An `auto` rule for an outside agent. It needs the grant model from slice 19.

Done when a class set to `auto` writes with provenance and can be undone, a delete from the same source still waits for review, and a batch of 40 takes one decision. The tests in `server/test/approval.test.ts` show the three on the server.

## Slice 15 — Calendar mirror

**Status: the server is done on 2026-11-18. One test with the owner's own calendar is open.** The rules are under "Calendar" in [SCHEMA.md](SCHEMA.md).

The calendar is the source of truth for events. HMN mirrors it and does not write back.

Done:

- Mirror from an ICS address. `POST /api/v1/calendars` adds a calendar, and the server reads it every 15 minutes. The address is sealed.
- A change in the calendar updates the same row. A removal sets the row to `cancelled` and keeps its history. The mirror does not delete, so the rule that a delete always waits for the owner still holds.
- A reply that is not a calendar document changes nothing. A past event that leaves the feed stays.
- The parser reads time zones and repeating events. Before this slice a time with a `TZID` was stored as raw text, and a weekly event was one row on its first date.
- A mirrored event is read-only in HMN. The owner can make one event more private, and can add notes and links around it.
- The class for a calendar is `auto` by default. The owner can set one calendar, or the class, to `review`.
- The tier comes from the calendar's area, and each calendar can have its own tier. A family date stays Private.
- Today has a section, "On the calendar", for today's mirrored events.

Open:

- The owner's own calendar. Add the secret ICS address of the Google calendar and check the events on the phone. The parser was tested on a public Google feed of 280 events, not on a private one.
- Remove the Google Calendar API client (`server/src/plugins/google.ts`) after that check. It stays until then.
- A CalDAV server that has no ICS address. The mirror reads one ICS document. It does not run a CalDAV REPORT.
- Done on 2026-11-19 in slice 19C: a monthly rule with a list of weekdays, and with `BYSETPOS`. A rule with `BYWEEKNO`, `BYYEARDAY`, or a time part still gives one row.
- Done on 2026-11-19 in slice 19C: the Week screen has a section for the mirrored events of the next seven days.

Done when a calendar with 40 events appears with no approvals, a changed event updates in place, and a removed event leaves Today. The tests in `server/test/calendar-mirror.test.ts` show the three on the server.

## Slice 16 — Notion migration, then retirement

**Status: the tool is done on 2026-11-19. The move of the owner's data is open.** The record format is under "Import" in [SCHEMA.md](SCHEMA.md).

HMN replaces the Notion Life Ontology. This is a one-time move, not a sync.

Done:

- `POST /api/v1/import` takes records with the Notion page id as `external_id`. Each record becomes a proposal from the source `import:notion`.
- A record waits until its area and its linked records are approved. Its tier depends on them, so a family task is Private from its first moment.
- Each pass is reviewed by batch, with the tools from slice 14. An import is never auto-accepted.
- A second import does not duplicate. A declined or removed record stays away for 90 days.
- The Notion plugin and its token are removed from the code and the docs. The plugin had no network read. It only mapped pages that the owner posted, and the import does that now.

Open:

- The move itself. It needs HMN on the owner's Mac mini, and a reader for the owner's own Notion workspace. The Notion workspace that was connected to the build session on 2026-11-19 was a company workspace with no Life Ontology, so no personal page was read.
- The list of records. An agent with a Notion connector can make it, or the owner can make it from a Notion export. HMN has no converter for the export file.
- Entities keep their `external_id` after 90 days. Only the memory of a decline or a removal ends.

Done when the owner's Notion areas, projects, tasks, people, and notes are in HMN, and the Notion plugin is gone from the tree.

## Checkpoint — Real use

After slice 16 the owner uses HMN with real data for two to four weeks. The owner records what the owner opens each day and what the owner ignores. Slices 17 to 20 are reordered or cut from what that shows. No public release happens before this checkpoint.

## Slice 17 — The agent surface

**Status: done on 2026-11-19, before the real-use checkpoint, at the owner's request.** The guide is [CONNECT-AN-AGENT.md](CONNECT-AN-AGENT.md).

Make HMN a good store for an outside agent. See "What an agent gets" in [STRATEGY.md](STRATEGY.md).

Done:

- Ranked search with SQLite FTS5 and BM25, under the ceiling. The index is in memory and holds no Sealed text. No embedding is required.
- `neighbours`: the entities around one entity, to a depth of 1 to 3 links, under the ceiling at both ends of each link.
- Read-only labels on each tool, so a client can keep an agent to the tools that read.
- An idempotency key on a proposal. The same key from the same source returns the first proposal. `proposal_status` gives the state of a proposal.
- The proposal contract is written down: a source, an external id, an idempotency key, and a tier.
- A read log for each agent key: each search with its words, and each entity. It is in Connected agents and apps.
- Server instructions under 2,000 characters.
- A guide for Claude Code, Claude Desktop, OpenClaw, and OpenJarvis, with one worked example of a mail service.

Found and fixed: `server/src/stdio.ts` did not work with an MCP client. It framed each message with a `Content-Length` header, and MCP on stdio is one JSON message on each line. It also opened the data directory in a second process, and two processes that open one encrypted store overwrite each other. It is now a pipe to the running server.

Open:

- The OpenClaw and OpenJarvis settings in the guide come from their documents. They were not run against HMN.
- The read log is saved with the next save of the database. A crash can lose the newest rows.
- Search has no stemming. "notes" does not match "note" unless the query is the shorter word, because a word matches as a prefix.
- The iPhone app does not use `neighbours` or the longer read log.

Done when an agent with a Personal grant finds a task by a natural question, proposes a change twice with one key and creates one proposal, and the owner sees what that agent read. The tests in `server/test/agent-surface.test.ts` show the three.

## Slice 18 — Areas and kinds as data

**Status: done on 2026-11-19, on the server.** The rules are under "Kinds and roles" in [SCHEMA.md](SCHEMA.md).

`KIND` in `server/src/policy.ts` listed `spouse`, `child`, `garage`, `car`, and `side_project`. That was one life in code.

Done:

- The entity types stay fixed. Kinds are rows that the owner adds and renames: `GET`, `PUT`, and `DELETE /api/v1/kinds`.
- A role is the fixed word between the owner's kinds and the rules. Today, the Week, the work screen, the calendar mirror, the sport and health plugins, the People and Fixtures workers, and the no-results rule read roles. No rule reads the name of a kind or the id of an area.
- An agent key, a worker, and an outside client do not read an area whose kind has the role `health` or `money`. Before this slice the deny list named two area ids of the demonstration, so a new owner's health area had no such protection.
- The seed stays as the demonstration. `HMN_SEED=empty` on the first boot starts a graph with the three keys and the default kinds, and no entity.
- The server text and the app text name no gender, and a test keeps it so. The documents say "the owner".
- A test reads the server code and fails if a rule names a kind or an area of the demonstration.

Open:

- Done on 2026-11-19 in slice 19C: the iPhone app has a screen to add an area and to add or remove a kind. A new title for a kind is still set through the API.
- Done on 2026-11-19: `deploy/install.sh` has `--empty` and `--demo`. A new graph needs one of them, or an answer from a person at a terminal. The install does not select the demonstration by default, because the demonstration cannot be removed later as a whole.
- The demonstration's area ids are still in `server/src/seed.ts`, which is correct, and in old credentials of an existing data directory.

Done when a new owner can set other areas and kinds with no code change, and the demonstration tests still pass. The tests in `server/test/kinds.test.ts` show a new owner with an empty start.

## Slice 19 — Evaluations

**Status: the access evaluation is decided. The attention evaluation has its method and waits for real use.** The two are in [STRATEGY.md](STRATEGY.md). The connector question was decided on 2026-11-18.

- **Access for agents.** Evaluated on 2026-11-19 against the code and the demonstration data. The owner confirmed the design on 2026-11-19: one key for each client, Private as a grant for a named client with an end date, Sealed never, free and busy times as a tool, and a guest as an outside client at Public. Grants come before the public release.
- **Attention.** The method is fixed: the base for two weeks, then one candidate at a time for two weeks each, in the order Prune worker, a reminder for one task, one digest each day. Each has a number and a pass mark. The server cannot push to the phone, so a digest or a reminder is a local notification that the app schedules.

Found in the evaluation and corrected: four documents said that an agent can read more with "a one-request grant". No such grant exists for an agent. The ceiling of an agent stops at Personal in three places in the code.

Done when each evaluation has a decision in STRATEGY.md and, if it changes the product, a slice here.

## Slice 19A — A grant for each client

**Status: done on 2026-11-19.** Confirmed by the owner on the same day. The rules are under "The ceiling of an agent key" in [SCHEMA.md](SCHEMA.md).

- One key for each local agent: `POST /api/v1/keys`, with a name, a ceiling, an end date, and limits by area and by type. Each key has its own read log, approval rules, and revoke. On the mini the key goes into the Keychain as `hmn.agent.<name>`, and `stdio.ts --key-name <name>` reads it.
- Private is a grant for one key, local or outside, for 1 to 90 days. After the end the key reads at Personal again and still works. Health and Money stay closed by role unless the owner opens one for that key.
- A preview before the grant: how many rows Private adds, by type and by area, and five titles.
- No key reads Sealed. One function now gives the ceiling of each agent key. Before this slice three rules in three places held an agent at Personal.
- The iPhone app has an Agent keys screen: the list, a new key, the preview and the grant, the end of a grant, and a revoke. It ran in the iPhone 16 simulator against a test server.

Not proven:

- The Keychain write for a new key. The tests and the simulator run used no Keychain, so the answer had the key itself. `rememberAgentKey` and `--key-name` are not tested on a real Mac install.
- A real iPhone.

Done when two local agents have two keys, one of them reads Private until its end date and the other does not, and the owner revokes one with no effect on the other. The first test in `server/test/keys.test.ts` shows it.

## Slice 19B — Free and busy times, and a guest

**Status: done on the server and in the phone code on 2026-11-19. Two items need the owner's devices.** Confirmed by the owner on 2026-11-19.

- The calendar parser reads `DTEND` and stores the end of an event.
- A `free_busy` tool: a start and an end in, joined busy intervals out, for the calendars that the owner switched on. No title, no id, no count of events.
- A guest: an outside client at Public, with the `free_busy` permission if the owner gives it. It can propose an event or an inbox item, and its proposals always wait for review.

Done when a friend's agent asks for the owner's free time in a week, gets intervals with no titles, proposes a meeting, and the owner approves it on the phone. The fourth test in `server/test/free-busy.test.ts` shows it through the routes that the phone calls.

What was built:

- The parser reads `DTEND`, `DURATION`, and `TRANSP`. A mirrored event has `properties.end_at` and `properties.busy`. An event with a time is busy unless the calendar says that it is free. A day with no time is free unless the calendar says that it is busy.
- `free_busy` as an MCP tool and as `GET /api/v1/free-busy`. Two switches must be on: one for the calendar, and one for the key. Both are off at the start. The owner key can always read the answer.
- A guest: `POST /api/v1/external/clients` with `guest: true`. It is Public. Its tools are the read tools, `free_busy` if the owner allows it, `propose_create` for one event, `proposal_status`, and `capture_inbox`.
- The phone: **Give busy times** on a calendar and on a key, and a guest label on the Agent keys screen. Both were checked in the simulator against a test server.

Open items:

- A real calendar on the Mac mini. The busy flag of events that are already mirrored is written at the next read of the calendar.
- A real guest away from the mini. That needs the outside port (`HMN_EXTERNAL_MCP=1`) and a route to it from the internet. See [EXTERNAL-AGENTS.md](EXTERNAL-AGENTS.md).

## Slice 19C — Open items that need no device

**Status: done on 2026-11-19.** These items were open in slices 14, 15, and 18. None of them needs the owner's Mac mini or iPhone.

- **Areas and kinds on the phone.** Settings has **Areas and kinds**. A new owner who starts with an empty graph can add the areas and the kinds there. The screen was run in the iPhone 16 simulator against an empty test graph.
- **A safe tier for a new area.** An area with no `child_tier` gets one from the role of its kind: Sealed for health and money, Private for family. Before this, a health area that was made with no tier held Personal items.
- **Mirrored events on the Week screen.** A section, "On the calendar", shows the next seven days, at most 12 events.
- **Undo of a removal.** An approved removal can be undone from Activity. It is refused after a purge.
- **Monthly repeat rules.** The calendar parser reads a list of weekdays and a position in the month, for example the last weekday of each month.

Open:

- A new title for a kind on the phone.
- A CalDAV server with no ICS address. It stays open in slice 15.

Done when the tests show the five. They are in `server/test/kinds.test.ts`, `server/test/calendar-mirror.test.ts`, and `server/test/approval.test.ts`.

## Slice 20 — Public release

**Status: the parts that publish nothing are done on 2026-11-19. The repository is still private, and nothing is released.** The owner asked for these parts before the real-use checkpoint.

Done:

- The licence file: Apache-2.0, confirmed on 2026-11-18. `LICENSE` is the standard text. `NOTICE` names "The HMN authors" as the copyright holder. `server/package.json` names the licence.
- No contributor agreement. [CONTRIBUTING.md](../CONTRIBUTING.md) asks for a sign-off line on each commit, and it has the two rules that a change must keep.
- The name and the mark stay out of the licence. [TRADEMARKS.md](../TRADEMARKS.md) says what a person can do with them.
- A README for a stranger: the position line, the two rules, the status, an install on a Mac in four commands, and a trial with no install. The operating detail moved to [RUNNING.md](RUNNING.md). The trial commands were run on 2026-11-19.
- The network claim is corrected in the README and in PRODUCT.md: HMN itself sends nothing about the owner to another service, and an agent with a key sends what it reads to its own model.
- The server and the install used one fixed zone when no zone was set. They now use the zone of the Mac. A stranger in another zone had the wrong day.
- A trial run with `HMN_INSECURE_DEV_KEK=1` no longer prints that it could not store a key in the Keychain.

Open, and each one needs the owner:

- The wording of [TRADEMARKS.md](../TRADEMARKS.md) and the copyright line in `NOTICE`. A person with legal knowledge has not read them.
- Done on 2026-11-24: the bundle ids, the App Group, and the launchd labels are `org.hmn`. An install with an older label is moved to the new one by `deploy/hmn update`. On the phone, the app with the new bundle id is a new app: pair it again, and delete the old app.
- Turn on private vulnerability reports on GitHub when the repository becomes public. CONTRIBUTING.md points to them.
- A security review by a second person, before any public claim about encryption. Who does it is not decided. The README says that no such review was made.
- The website. Since 2026-11-20, at the request of the owner, the sales page leads with the person ("Your whole life in one quiet place. You are the human at the centre of your digital world"), and then with the thesis in PRODUCT.md: calm screens, and agents that do the chores. The two rules come second. It does not use the name "life OS". A first draft is in [site/](../site/README.md) since 2026-11-20, to test the marketing and the presentation. It is a short sales page with real screens of the fictional demonstration, and a docs page that is a summary of the documents. Since 2026-11-23 the look is Garden, the same as the app: a calm stone ground, white cards, one sans face, an ink button, and the band one time. The sales page then has the measure from PHILOSOPHY.md and four panels from DESIGN-PRINCIPLES.md (principles 2, 5, 7, and 8). The first look, from trmnl.com, had a serif headline and a coral button. It is not deployed, and it has no domain. Its links go to the repository, so they work only for the owner while the repository is private.
- iPhone distribution. Deferred until the server release is in use.
- The change of the repository from private to public. It comes after the real-use checkpoint.

## Slice 21 — Design system and UX cleanup

**Status: part A is in the code since 2026-11-23, and parts B to E since 2026-11-24. Part D drops one item, see below.** The owner asked for a full review of the UI on 2026-11-23. Five review agents read the code, and the findings were checked in the code and on screens in the simulator. The owner then chose the direction from a canvas of options: Garden (white cards on a stone ground), in sans, with ink as the lead colour. [UX.md](UX.md) has the system under "Design system".

Done in part A:

- The theme of the iPhone app: the colours, a type scale of eight roles, space and corner values, and the components (card, pill button, text button, chip, field, label, message, empty state, band).
- Today, the tab bar, Review, and the capture sheet are rewritten in the system. Each other screen takes the new type, cards, and buttons through the shared parts, and it keeps its old layout.
- A task on Today can be marked as done, with Undo. Before this, the circle of a row did nothing.
- The phone says "Hello." before a pairing, and "Your HMN is sleeping." when it gets no answer. After a pairing, Settings closes and Today loads.
- The inbox actions are buttons in the open row. Before this, they were swipe actions that could not be reached.
- Review shows the result of a decision, with Undo for an approval. A second tap cannot decide the next proposal.
- The text that explained rules is gone from the screens: "no results, ever", "Nothing is saved until you say so.", "upcoming only", and others. The app says "your HMN", not "the mini".
- A border on the worker settings page had a colour that does not exist. It is corrected.

Open:

- **A, the rest.** Done on 2026-11-23: the files of IBM Plex Sans are in the iPhone app and the website, and the screens of the website were taken again with them. The widget and the menu bar app keep the mono face until their own part of this slice.
- **B, rules for each screen. Done on 2026-11-24.** A confirmation before each removal: a kind, a link, a rule, and a routine (keys, members, and phones had one before). One `LoadingState` in place of an empty card while a screen waits. A selected state on each choice: the kind of a new key is a pair of chips. Activity and Rules are rows in cards, with text buttons and the message next to them. The old names `InkCard`, `InkButtonStyle`, and `RuledPaper` are gone, and the edit sheet of Review uses fields, not a form.
- **C, flows. Done on 2026-11-24.** The QR pairing and the pages that swipe were done before. A row on Today that is an entity opens it: the screen rows have `type` (SCHEMA.md, the read format), and a person opens the person page. A Sealed proposal waits at the end of the Review queue, and it can be declined without reading. Change on a calendar sets its name, a new address, its area, and the tier of its events.
- **D, structure. Done on 2026-11-24.** One screen, Agents and apps, holds the connected clients and the keys, with two chips. Settings has the groups People and agents, Your record, Privacy, and The graph. The item "People and Projects in one Browse tab" is dropped: [ONTOLOGY.md](ONTOLOGY.md), section 5.2, decided on 2026-11-23 that the tabs follow the verbs, with People and Projects as two tabs.
- **E, other surfaces. Done on 2026-11-24.** The menu bar app, the widget, and the pages that the server serves use Garden, with the same tokens in light and dark. The menu bar app and the widget bundle IBM Plex Sans for text and keep Plex Mono for labels and data. The server pages name Plex Sans first and use the system sans when the computer does not have it, so they load nothing from the network. The Public TRMNL deck stays one-bit black and white: it has no ink band at the top, and a thin rule and a plain label replace the ink footer bar.

## Slice 22 — Security audit and hardening

On 2026-11-23 seven auditors read the code and attacked throwaway test servers with fictional data, one lane each: authentication, the tier policy, proposals, workers, outside clients, storage, and the client apps. The findings are in the audit report of that day. This is not the review by a second person that [SECURITY.md](SECURITY.md) asks for, and it did not test the owner's live deployment.

- **Batch 1, the agent boundary. Done on 2026-11-23.** A key cannot make a row more visible through a proposal, also with an approval. Each proposal has a summary from the server, and the Review card and the batch screen show it. The batch screen ticks only new items. A key reads its own proposals. History and the inbox have the limits of the key. The server names the source on the card. Tests: `server/test/agent-boundary.test.ts`.
- **Batch 2, the admin plane. Done on 2026-11-23.** A pairing code needs the owner key on the mini. A hidden phone cannot end Hide, and Hide is for a phone only. Each credential records its maker, and a revoke takes the keys that the credential made. A phone cannot take the secret of a key. The key of an outside client works on the outside port only. The lockout counts each port apart. A writer changes only a row that it can read: this gap was found during batch 2, and it was not in the audit report. Tests: `server/test/admin-plane.test.ts`.
- **Batch 3, the cost of a request, and floods. Done on 2026-11-23.** A read saves nothing, and saves come at most once a second after a request. A key has a budget for proposals and inbox items. A declined proposal keeps a short record, and the file is compacted. At most ten outside clients wait for a sign-in. Tests: `server/test/floods.test.ts`.
- **Batch 4, storage and recovery. Done on 2026-11-23.** The working copy is in memory only. A failed Keychain read stops the start. Purge also removes proposals and journals. A restore keeps revokes and Hide, and `deploy/hmn restore` works with the paper passphrase alone. A daily backup keeps fourteen files and can copy them to a second disk. `deploy/hmn renew-owner` renews the owner key. The mirror follows area tiers and Private fields. Tests: `server/test/storage.test.ts`.
- **Batch 5, inputs and clients. Done on 2026-11-23.** The worker cloud path has the egress record, the cap, and a size limit, and its host changes only on the mini. The model reply check reads every script and refuses links. Calendar reads have scheme, host, time, size, and redirect limits, and family dates from a feed wait for review. The e-ink key goes only to the first address. The OAuth setup code is 60 bits with a limit on wrong codes. The iPhone app accepts only https, keeps the audit alarm until the owner acknowledges it, covers the app switcher, closes the vault in the background, refreshes the widgets on Hide, keeps unsent captures, and asks before a revoke. Tests: `server/test/inputs.test.ts`.
- **The low findings (29 and 30). Done on 2026-11-23, in 0.2.1.** One answer for a hidden row and a missing row, a fixed inbox answer for keys, no journal reason for a reader who cannot see its items, owner-only audit routes, the guest inbox, a head-row check in the audit, a wrapped TLS key with no CA key, AEAD ciphers only, certificate renewal, database key rotation, absolute tool paths, plugin secrets and model names, Docker, CI, the Bun download hash, and the update listing. Documented and not changed: the secret on the `security` command line, AES-GCM associated data for Sealed values, and the rotation of the KEK and the Sealed key (reasons in SECURITY.md). Tests: `server/test/low-findings.test.ts`.
- Open: the review by a second person, a test on a real iPhone, and a test of the live mini.

## Later, unscheduled

- Live Activities. The lock screen, StandBy, and the public next-event card are in. A Live Activity that updates on its own is not.
- Money as a Sealed area with a screen. Default remains no agent access.
- Third-party plugins. HMN does not run the code of a third party, and it has no plugin SDK. Software of a third party runs outside, on top of HMN, through the read contract and the proposal contract.
- The read contract. Decided on 2026-11-20 and written in [STRATEGY.md](STRATEGY.md). Built on 2026-11-20: a view key with the scope `read`, which cannot propose, and the read log for such a key. Built on 2026-11-23: the written format of each screen and of one entity, in SCHEMA.md under "The read format", with a test that reads the tables. Open work, in order: a stability rule for `/api/v1`, and later pages and a `changed_after` parameter. The owner has two points to decide there.
- Docker, Android, and a web client as supported targets.

## Working agreements for every slice

- One slice, one pull request, tests green before the request.
- Schema changes update [SCHEMA.md](SCHEMA.md) in the same commit.
- Screen changes update [UX.md](UX.md) in the same commit.
- Plugins propose. They do not gain a direct write.
- No scores, results, winners, standings, or points, in fixtures or in copy.
- No real name for the side project, in seed data, tests, or docs.
- Secrets stay in the Keychain or a wrapped file under the data directory, never in git and never in a plaintext env file. The dev-only KEK flag is not used on a mini that holds real data.
