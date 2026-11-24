# Run and operate HMN

The short install is in the [README](../README.md). This document has the detail: a run from the source, Docker, the credentials, the API with `curl`, the iPhone app, the first run, and the plugins. The install on a Mac with launchd is in [MAC-MINI.md](MAC-MINI.md).

## Run it from the source

The server has no npm dependencies. The supply-chain surface is Bun itself. Install [Bun](https://bun.sh), from the repository:

```sh
cd server
bun install
bun test
bun run start
```

On macOS the key-encryption key is created in the login Keychain (`hmn.kek`). The process listens on TLS, default `https://0.0.0.0:8787`. The first boot prints three credentials and a recovery passphrase of 13 words. Write the passphrase on paper. It is not stored in the clear. Do not commit `data/`.

Do not publish port 8787 on the router. Use the LAN, or Tailscale, when the phone is away. There is no HTTP listener.

`HMN_SEED=empty` on the first boot starts a graph with no demonstration data: the three keys, the default kinds, and nothing else. Add your own areas and kinds after that. Without it, the first boot writes the fictional demonstration.

`HMN_INSECURE_DEV_KEK=1` writes the key into the data directory so a Linux machine, or a test server on a Mac, can boot. With this flag the server does not read or write the Keychain. Do not use it for real data.

### Docker

The container does not have the Keychain. Create the key on the host and mount it as a secret. The compose file does not contain the key.

```sh
scripts/keychain-kek.sh > server/kek.secret
chmod 600 server/kek.secret
cd server && docker compose up --build
```

`server/kek.secret` is gitignored, and `server/.dockerignore` keeps it, `data/`, and each encrypted or wrapped file out of the image. The image is `oven/bun:1.2.21`, and the server runs as the user `bun`, not as root. The compose file publishes the port on `127.0.0.1` only. In a container, a request from the host does not come from loopback, so pairing, backups, and the menu bar routes are refused there: use the launchd install for those. Docker was not run while this was written.

### Menu bar and launchd

The login install and the menu bar app are in [docs/MAC-MINI.md](MAC-MINI.md).

```sh
deploy/hmn install
```

Running it again restarts the server. It does not delete the graph. The install shows the recovery passphrase only to a person at a terminal. `deploy/hmn` also has `status`, `start`, `stop`, `restart`, `logs`, `pair`, `passphrase`, `update`, and `uninstall`. Docker remains an alternative.

### Credentials

| Name | Scope | Maximum tier |
| --- | --- | --- |
| owner | write | Private. Cannot open the vault. |
| agent | agent | Personal. Health and Money are denied as well. |
| display | read | Public. |

Pair the phone instead of copying the owner key onto it. A pairing code makes a device that reads Private data, so the server gives a code only to the owner key, and only on the mini. With `OWNER` set to the owner key:

```sh
printf 'Authorization: Bearer %s\n' "$OWNER" | curl --cacert data/tls/ca.crt -H @- -X POST https://127.0.0.1:8787/api/v1/pairing
```

The key goes to curl on standard input, so it is not on a command line that other programs can read.

The phone redeems the code once. The device secret is stored in the iOS Keychain and can be revoked.

### curl

Set `CA=server/data/tls/ca.crt` after the first boot, and the printed keys.

```sh
curl --cacert "$CA" -H "Authorization: Bearer $HMN_OWNER_KEY" -H "X-HMN-Surface: phone" \
  https://127.0.0.1:8787/api/v1/screens/today

curl --cacert "$CA" -H "Authorization: Bearer $HMN_OWNER_KEY" -H "X-HMN-Surface: phone" \
  https://127.0.0.1:8787/api/v1/proposals

curl --cacert "$CA" -H "Authorization: Bearer $HMN_AGENT_KEY" -H "X-HMN-Surface: mcp" \
  -H "Content-Type: application/json" \
  -d '{"op":"create","entity":{"type":"task","title":"Send the brief","status":"open","kind":"task","area_id":"area_work"},"reason":"It is Thursday."}' \
  https://127.0.0.1:8787/api/v1/proposals

curl --cacert "$CA" -H "Authorization: Bearer $HMN_DISPLAY_KEY" \
  https://127.0.0.1:8787/api/display
```

The display response is the TRMNL shape: `image_url`, `filename`, `refresh_rate`. The HTML is `/api/display/today.html` and the PNG is `/api/display/today.png`. Both are Public, even if the caller holds the owner key. Family names, tasks, and sealed notes are not in that response.

A real TRMNL on the LAN uses `GET /api/setup`, `GET /api/display`, and `POST /api/log`. An OG image is an 800×480 1-bit BMP or a greyscale PNG. A TRMNL X image is 1872×1404 and sixteen greys. Both are drawn on the mini, still at the Public ceiling. Pairing and revocation are in [docs/TRMNL.md](TRMNL.md).

A missing `X-HMN-Surface` header is treated as Personal, not Private. The phone sends `phone`.

Opening the vault is `POST /api/v1/vault/grants` from a paired device, then `X-HMN-Grant` on the following calls. The owner key cannot mint a grant. Agents cannot either.

Hide is `POST /api/v1/panic` from a paired phone. It forces that phone down to Public. The phone cannot undo it. The owner key ends it on the mini: Show my things in the menu bar, or `POST /api/v1/panic/clear` with `{ "id": "<the device>" }`. A hidden phone also cannot pair a phone, make or change a key, or give a Private grant.

MCP is `POST /mcp`, and `bun src/stdio.ts` for a local client such as Claude Code, OpenClaw, or OpenJarvis. There is no tool that writes the graph. Proposals only. [docs/CONNECT-AN-AGENT.md](CONNECT-AN-AGENT.md) shows how to connect an agent, and what the agent can rely on.

The workers (Morning, Week, Triage, People, Fixtures, and Goals) run on the mini and also only propose. With no model URL they use a deterministic fallback and do not open a socket. A local model is Ollama or another OpenAI-compatible server on localhost. Cloud stays off until it is enabled on that one worker, at a tier, with the warning accepted. Sealed data is never in the prompt. Family reminders stay Private. Fixture lists do not carry scores. `GET /api/v1/workers.html` is the settings screen. `GET /api/v1/access` is the list of connected devices, keys, displays, and plugins. An assistant that runs off the mini uses a separate port, off by default. See [docs/EXTERNAL-AGENTS.md](EXTERNAL-AGENTS.md).

## iPhone

Open `ios/HMN.xcodeproj` in Xcode, or generate it again with XcodeGen from `ios/project.yml`. The bundle id is `org.hmn`. The signing team is unset.

CI compiles the app for the simulator and checks that the build made the three executables. The app was run in the iPhone 16 simulator on 2026-11-19 against a test server: pairing, Today, a batch decision, Undo, the rules, and the calendar list. It was not run on a real iPhone. On a Mac, confirm:

- The certificate pin rejects a different certificate.
- Face ID or the device passcode runs before a vault grant.
- The App Group `group.org.hmn` shares the widget snapshot only after a team is selected. Until then the widget shows the unset state. The snapshot is requested at the widget ceiling. Private and Sealed rows are not written into it.
- ATS allows the private certificate because the app pins it. That is deliberate. See [docs/SECURITY.md](SECURITY.md).

Settings takes the server URL, the certificate fingerprint printed at startup, and a pairing code.

## First run

Do this once, on the mini and the phone, before any real notes go in. The commands assume that the server is running, and that `CA` is the address of its `tls/ca.crt`. After `deploy/hmn install`, the command `deploy/hmn pair` does steps 1 and 2 and prints the three values for the phone.

1. On the mini, read the certificate fingerprint printed at startup. You will type it into the phone. Do not skip the pin.
2. Create a pairing code. This works only on the mini itself, and only with the owner key:

```sh
printf 'Authorization: Bearer %s\n' "$OWNER" | curl --cacert "$CA" -H @- -X POST https://127.0.0.1:8787/api/v1/pairing
```

3. On the phone, open HMN, tap the mark, and enter the server URL (`https://` plus the mini's LAN or Tailscale address, port 8787), the fingerprint, and the code. Tap Pair this phone. The device key is saved in the Keychain and is not shown again.
4. With the demonstration (`--demo`), Today shows the demonstration day: three things due, the concert, the race, and the quiet fault. The widget and the lock-screen widgets show less. The race is public. The family names are not.
5. Open Agents. In the demonstration, the waiting proposal is sealed. Tap Open vault, confirm with Face ID or the passcode, read it, then Approve or Decline. Nothing is written before that.
6. Capture something with the plus button. It is yours, so it saves. A worker, an agent, an import, the calendar, or health can only leave a proposal.
7. Write down the recovery passphrase from the first boot. Keep it out of the backup folder.

If Today says the server did not answer, the fingerprint does not match or the phone is not on the LAN or tailnet. See [docs/TAILSCALE.md](TAILSCALE.md).

## Plugins

Calendar, Google Calendar, and sport tick on the mini and only propose. Health summaries come from the phone and become Sealed proposals.

```sh
curl --cacert "$CA" -H "Authorization: Bearer $HMN_OWNER_KEY" -H "X-HMN-Surface: phone" \
  https://127.0.0.1:8787/api/v1/plugins
```

A tick is refused unless it comes from loopback. The diff itself runs in a separate process that cannot see the database or the tokens. A calendar is mirrored from its ICS address: `POST /api/v1/calendars` with `{title, url, area_id}`, and the mini reads it every 15 minutes. HMN does not write back to the calendar. For Google Calendar, use the calendar's "Secret address in iCal format". Calendar ICS can also be posted to the tick, or fetched from `HMN_CALDAV_URL`. Google Calendar is read-only: set `HMN_GOOGLE_CLIENT_ID` and `HMN_GOOGLE_CLIENT_SECRET` (or the Keychain items `hmn.google.client_id` and `hmn.google.client_secret`), open `GET /api/v1/plugins/google/start` on the mini, and finish the redirect. The refresh token stays encrypted on the mini. Sport and motorsport fixtures never keep a score.

A one-time import from another system, such as Notion, is `POST /api/v1/import`. Each record becomes a proposal, and you approve a pass with one batch decision. HMN holds no Notion token. The record format is in [docs/SCHEMA.md](SCHEMA.md) under "Import".

Each time the phone opens Today it copies the audit-chain tip into its Keychain and checks the previous copy. A banner appears if the mini's chain no longer contains that tip.

Away from home, follow [docs/TAILSCALE.md](TAILSCALE.md). A phone build follows [docs/TESTFLIGHT.md](TESTFLIGHT.md).
