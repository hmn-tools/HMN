# External agents

HMN can answer an assistant that does not run on the mini. The listener is a second port. It is off until the owner turns it on. Grok Bot and other MCP clients use this port. The admin API, the phone API, and the display stay on 8787 and are not on this port.

## Turn it on

On the mini, start the server with the port open, then enable the gate. Both are required. The environment variable only binds the port. The gate is the kill switch.

```sh
HMN_EXTERNAL_MCP=1 HMN_EXTERNAL_PORT=8788 bun src/index.ts
```

```sh
curl --cacert "$CA" -H "Authorization: Bearer $HMN_OWNER_KEY" \
  -X POST https://127.0.0.1:8787/api/v1/external/enable
```

The external port is `https://<mini>:8788`. It serves `/external/mcp`, the OAuth discovery documents, and nothing else. A request for `/api/v1` or `/api/display` on 8788 is a 404.

Kill switch, from the mini:

```sh
curl --cacert "$CA" -H "Authorization: Bearer $HMN_OWNER_KEY" \
  -X POST https://127.0.0.1:8787/api/v1/external/disable
```

That takes effect on the next request. Tokens already issued start failing immediately. The menu bar on the mini has the same switch: on calls `POST /api/v1/external/enable`, off calls `POST /api/v1/external/disable`, both on localhost with the owner key. Closing the gate does not unbind the port; it refuses every request.

## What an outside client may see

The cap is Personal unless the owner chooses Public when the owner issues the credential. The owner can give one client the Private tier for a time, at most 90 days (never a guest), with `POST /api/v1/keys/<client id>/private` or on the Agent keys screen. After the end date the client reads at Personal again. Sealed is refused for each client, including by a row that was edited to say otherwise, and including a vault grant. Health and Money are denied. The tools are read, search, walk the links, propose, and read the status of a proposal. There is no approve tool and no direct write. The tools and the proposal contract are in [CONNECT-AN-AGENT.md](CONNECT-AN-AGENT.md).

Tool results are labelled untrusted data, inside a fence. Text inside a note is not an instruction.

Each client is rate limited (60 calls in 10 minutes, or `HMN_EXTERNAL_RATE_LIMIT`). At most ten registered clients wait for a sign-in. A client that does not sign in within an hour is removed. Each key has a budget for proposals and inbox items, as in [SECURITY.md](SECURITY.md). Tokens expire in 30 days. Revoke is `POST /api/v1/external/clients/:id/revoke` or the Connected screen. Every accepted call is an `external` row in the audit log, with the tool name and no title.

## A guest

A guest is the agent of another person, for example a friend who wants to find a time to meet. It is an outside client with three limits:

- It reads Public only. A `ceiling` in the request changes nothing.
- It can file one kind of proposal: a new event, with a title, a start, an end, and a short text. It can also leave a short text in the inbox. It cannot propose a change, a removal, or a link.
- Each proposal waits for the owner. No rule accepts it.

```sh
curl --cacert "$CA" -H "Authorization: Bearer $HMN_OWNER_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Example friend","guest":true,"free_busy":true}' \
  -X POST https://127.0.0.1:8787/api/v1/external/clients
```

With `free_busy: true` the guest can call the `free_busy` tool. The tool answers only from the calendars on which the owner switched busy times on, in Settings, Calendars. The answer is a list of start and end instants, with no title. The owner can stop it for one key on the Agent keys screen, or with `POST /api/v1/keys/<client id>` and `{"free_busy": false}`.

A usual exchange: the guest calls `free_busy` for a week, proposes an event in a free hour with `propose_create`, and reads `proposal_status` until the owner decides. After an approval the event is in the owner's graph at Personal. The guest learns that it was approved, and it cannot read the event.

## Bearer token

```sh
curl --cacert "$CA" -H "Authorization: Bearer $HMN_OWNER_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Grok","ceiling":"personal"}' \
  -X POST https://127.0.0.1:8787/api/v1/external/clients
```

The token is shown once. Send it as `Authorization: Bearer` to `POST /external/mcp`. The first call is `initialize`. Later calls send the `Mcp-Session-Id` from that response. `GET /external/mcp` with `Accept: text/event-stream` is the SSE listen. A client that asks for `text/event-stream` on POST gets one SSE event instead of JSON.

## OAuth 2.1

Discovery:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`

`POST /oauth/register` is dynamic client registration for a public client. PKCE S256 is required. There is no client secret.

The consent page names the client, as the client named itself, and asks for a setup code. The code is 12 characters. Ten wrong codes in ten minutes close the form for ten minutes. Create the code on the mini, and type it only there:

```sh
curl --cacert "$CA" -H "Authorization: Bearer $HMN_OWNER_KEY" -H "Content-Type: application/json" \
  -d '{"ceiling":"personal"}' \
  -X POST https://127.0.0.1:8787/api/v1/external/setup-codes
```

The code lasts ten minutes and works once. `POST /oauth/token` with `grant_type=authorization_code` and the `code_verifier` returns the bearer token.

## Grok Bot

In the bot's custom MCP servers, set the URL to the funnel or tunnel address plus `/external/mcp`, for example `https://hmn.example.ts.net/external/mcp`. Prefer OAuth if the bot can open the consent page. If it only has a token field, paste the bearer token from the command above and leave the ceiling at Personal.

## OpenBot and other MCP clients

Use the Streamable HTTP transport against that same URL. The protocol version returned is the one the local MCP handler speaks. Point the client at the authorization server metadata if it supports OAuth. Otherwise set the bearer token in the client's header configuration.

## Reaching it from the internet

Do not publish 8787 or 8788 on the router. Do not put the admin port behind a public name.

Tailscale Funnel, only the external port:

```sh
tailscale funnel --bg 8788
```

That publishes 8788, which has no admin routes and no display. It does not publish 8787. Turn the funnel off with `tailscale funnel reset` when the assistant is not in use, and also hit the kill switch.

Cloudflare Tunnel, one hostname, one path. The ingress should send only the MCP host to `https://127.0.0.1:8788` and should not have a rule for the admin port. Do not use a wildcard service that forwards every path to 8787.

A stolen token can read Personal data, or Private data while a grant for that client is open, and file proposals until it expires or is revoked. It cannot approve them, and it cannot read family, health, or sealed notes. Notes can still contain text that tries to instruct the assistant. The fence is there so the client can treat that text as data. The owner should read proposals before approving them.

The Connected screen lists this client, its cap, the tools it called, the words it searched for, and the entities it read. `GET /api/v1/access/<client id>/reads` on the admin port has the longer log.
