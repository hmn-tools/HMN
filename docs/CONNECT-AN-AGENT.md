# Connect an agent to HMN

HMN is a store. An agent product has the loop, the model, and the connectors to other services. It connects to HMN through MCP, reads up to a ceiling, and proposes changes. This document shows how to connect one, and what the agent can rely on.

The position behind this is in [STRATEGY.md](STRATEGY.md). An agent that runs away from the mini uses the second port in [EXTERNAL-AGENTS.md](EXTERNAL-AGENTS.md).

## What an agent gets

| Tool | Reads or proposes | Use |
| --- | --- | --- |
| `search` | reads | Find entities by words, best match first. A question in plain words works. |
| `get_entity` | reads | One entity. |
| `list_entities` | reads | Every entity of one type. |
| `list_links` | reads | The links of one entity. |
| `neighbours` | reads | The entities around one entity, out to 1, 2, or 3 links. |
| `list_proposals` | reads | The proposals that this key filed. A key does not read the proposals of another key, of a worker, or of the owner. |
| `proposal_status` | reads | The state of one proposal, and the entity that an approval wrote. |
| `free_busy` | reads | The times in which the owner is busy between two dates, as start and end instants with no title. It is in the list only when the owner allows it for the key. |
| `propose_create`, `propose_update`, `propose_delete`, `propose_link` | proposes | File a proposal. The owner decides. A proposal is at most 32,000 characters. When 100 proposals of the key wait, or the key filed 60 in the last hour, the answer is `429`: wait, and do not retry in a loop. |
| `capture_inbox` | proposes | Put raw text in the owner's inbox. |

No tool writes the graph. Each tool has the MCP annotations `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. A client that can filter tools can keep an agent to the tools that read: `search`, `get_entity`, `list_entities`, `list_links`, `neighbours`, `list_proposals`, `proposal_status`, and `free_busy` when the key has it.

Busy times need two switches, and both are off at the start. The owner switches on a calendar in Settings, Calendars, and switches on the key in Settings, Agent keys. The range of one call is at most 60 days.

The server sends its instructions at `initialize`. They are under 2,000 characters.

What the agent cannot do, and no setting in the agent changes it:

- Read above the ceiling of its key. A row above the ceiling is absent. It is not blanked. The ceiling is Public, Household, or Personal, and Private only while the owner's grant for that key is open. It is never Sealed.
- Read Health or Money with the default agent key.
- Approve a proposal, or write an entity or a link.
- Be accepted with no review. Only a worker or a plugin inside HMN can have an `auto` rule.

The owner sees a log of what each agent key read: each search with its words, and each entity. It is in Connected agents and apps, and in `GET /api/v1/access/<key id>/reads`.

An agent sends what it reads to its own model. The ceiling of the key is the only control that HMN keeps over where that data goes.

## The proposal contract

This is the public interface of HMN for a write. A plugin inside HMN and an agent outside use the same contract. There is no plugin SDK. The public interface for a read is the read contract in [STRATEGY.md](STRATEGY.md).

| Part | Who sets it | Meaning |
| --- | --- | --- |
| Source | The server | `key:<credential id>` for an agent. The agent cannot name its own source. The approval rules use it. |
| External id | The agent, in `entity.external_id` | The id of the record in the other system. It stays on the entity, so that a later run can find it. |
| Idempotency key | The agent, in `idempotency_key` | The same key from the same source returns the first proposal. Use it on each retry. 1 to 100 characters: letters, digits, dot, colon, hyphen, underscore. |
| Tier | The server | The strictest tier of the rows that the proposal touches. The agent can ask for a stricter tier in `entity.tier`. It cannot ask for a more visible one. |

A proposal is `pending`, then `approved`, `rejected`, `expired`, or `undone`. `proposal_status` gives the state. After an approval it gives the id of the entity.

Rules for a well-behaved agent:

1. Send an idempotency key with each proposal. A good key is the id in the other system and the operation, for example `mail-4411:create`.
2. Check `proposal_status` before a new run proposes the same thing with a new key.
3. Take a decline as a no. Do not propose the item again with a new key.
4. Give one clear reason. The owner reads it on the phone.

Over REST the same contract is `POST /api/v1/proposals`, with the key in the body as `idempotency_key` or in the header `Idempotency-Key`. A replay answers 200, and a new proposal answers 201.

## On the same Mac: stdio

A local MCP client starts `server/src/stdio.ts`. This program is a pipe to the running HMN server. It does not open the data directory.

It needs three things:

| Setting | Argument | Environment | Default |
| --- | --- | --- | --- |
| The agent key | `--key-file <path>` | `HMN_API_KEY`, or `HMN_API_KEY_FILE` | The macOS Keychain item `hmn.agent`, which the first boot wrote |
| The server | `--url <url>` | `HMN_URL` | `https://127.0.0.1:8787` |
| The CA certificate | `--ca <path>` | `HMN_CA` | `./data/tls/ca.crt` |

On the mini the key is in the Keychain, so only the certificate path is needed. Use absolute paths, because the client starts the program from its own folder.

### One key for each agent

Give each agent its own key. Each key has its own limits, its own read log, its own approval rules, and its own revoke.

```sh
curl --cacert "$CA" -H "Authorization: Bearer $HMN_OWNER_KEY" -H "Content-Type: application/json" \
  -d '{"name":"research"}' -X POST https://127.0.0.1:8787/api/v1/keys
```

On the mini the answer shows the key once, and the server also puts it in the Keychain as `hmn.agent.research`. Start that agent with `--key-name research`. The owner can also make a key on the phone, in Settings, Agent keys. The phone never receives the key.

A new key is Personal or Public. It can have `allow_areas`, `allow_types`, and `deny_areas`, and it ends after `days` (90 by default). Areas with the role `health` or `money` are closed unless the owner removes that role from `deny_areas` for this key.

**A view.** Software that only shows rows, such as a display or a widget, gets a view key: `{"name":"kitchen","scope":"read"}` in the same call. A view key reads Public rows, or Personal rows if the owner asks, and it cannot propose. A local MCP client starts with `--view-name kitchen`, and it gets only the tools that read.

**Private for a time.** The owner can give one key the Private tier, at most 90 days, after a preview of what it adds. When the grant ends the key reads at Personal again, and it still works. No key reads Sealed.

### Claude Code

```sh
claude mcp add hmn -- bun /path/to/HMN/server/src/stdio.ts --ca /path/to/HMN/server/data/tls/ca.crt
```

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hmn": {
      "command": "bun",
      "args": ["/path/to/HMN/server/src/stdio.ts", "--ca", "/path/to/HMN/server/data/tls/ca.crt"]
    }
  }
}
```

### OpenClaw

```sh
openclaw mcp add hmn \
  --command bun \
  --arg /path/to/HMN/server/src/stdio.ts \
  --arg --ca \
  --arg /path/to/HMN/server/data/tls/ca.crt
openclaw mcp doctor hmn --probe
```

To keep an OpenClaw agent to the tools that read, set a tool filter on the server entry in its config:

```json5
{
  mcp: {
    servers: {
      hmn: {
        toolFilter: {
          include: ["search", "get_entity", "list_entities", "list_links", "neighbours", "list_proposals", "proposal_status"],
        },
      },
    },
  },
}
```

OpenClaw runs commands on its host with no approval by default. HMN's limits do not depend on that setting, because the key cannot write. Other software on the same Mac does not have that protection.

### OpenJarvis

In `config.toml`:

```toml
[tools.mcp]
enabled = true
servers = "mcp-servers.json"
```

In `mcp-servers.json`, next to it:

```json
[
  {
    "name": "hmn",
    "command": "bun",
    "args": ["/path/to/HMN/server/src/stdio.ts", "--ca", "/path/to/HMN/server/data/tls/ca.crt"],
    "exclude_tools": ["propose_delete"]
  }
]
```

`include_tools` and `exclude_tools` are OpenJarvis fields. The example stops the agent from proposing a removal.

The OpenClaw and OpenJarvis forms come from their documents as read on 2026-11-18. They were not run against HMN. Check them with the product's own probe command.

## Away from the mini

Use the second port and a credential for that client. See [EXTERNAL-AGENTS.md](EXTERNAL-AGENTS.md). The tools are the same. Each result is in a fence that marks it as data, and the cap is Personal.

## A worked example: a service that HMN does not connect to

HMN has no mail connector, and it will not have one. An agent with a mail connector does this work.

The owner asks the agent each morning: "Read my inbox. If a message asks me to do something by a date, propose a task in HMN."

For one message, with the id `4411` in the mail system, the agent does this:

1. It calls `search` with "permit renewal" to see if HMN has the task. It finds nothing.
2. It calls `search` with the sender's name. It finds the person, `person_ab12`.
3. It calls `propose_create`:

```json
{
  "entity": {
    "type": "task",
    "title": "Renew the parking permit",
    "status": "open",
    "kind": "task",
    "due_at": "2026-12-01",
    "external_id": "mail-4411"
  },
  "links": [{ "rel": "about", "to_type": "person", "to_id": "person_ab12" }],
  "reason": "A message from the council on 18 November asks for the renewal by 1 December.",
  "idempotency_key": "mail-4411:create"
}
```

4. The connection drops, and the agent sends the same call again. HMN returns the first proposal with `"replayed": true`. The owner sees one proposal.
5. The next morning the agent reads the same message again. It calls `propose_create` with the same key and gets the first proposal back, now `approved`. It does nothing more.
6. If the owner declined, the answer is `rejected`. The agent does not propose that message again.

What the owner controls: the ceiling of the agent's key, each approval, and a `deny` rule for that key if the agent is too loud. What the agent brings: the mail connector, the model, and the schedule.

## A one-time move from another system

HMN does not read Notion, a spreadsheet, or another app. An agent that can read it makes the move. There are two ways.

**A few dozen records: the agent proposes each one.** The agent calls `propose_create` for each record. It puts the id of the record in the other system in `entity.external_id`, and it uses `<system>-<id>:create` as the idempotency key. A second run sends the same keys and makes no copies. A key can have 100 proposals waiting, and it can file 60 in an hour, so the agent works in rounds. Review all, on the Review tab, takes the decision for a round in one step.

**Hundreds of records: the agent writes an import file, and you post it one time.** The agent writes the records in the import format: `external_id`, `type`, and `title` for each record, and an optional `area`, `links`, `status`, `kind`, `due_at`, and `body`. [SCHEMA.md](SCHEMA.md), "Import", has the full format. An agent key cannot post the file, because the import needs the owner key. On the mini, run a dry run first:

```sh
printf 'Authorization: Bearer %s\n' "$(security find-generic-password -s hmn.owner -a hmn -w)" |
  curl --cacert "$HOME/Library/Application Support/HMN/data/tls/ca.crt" -H @- -H "X-HMN-Surface: phone" \
    -H "Content-Type: application/json" -d @import.json https://127.0.0.1:8787/api/v1/import
```

Set `"dry_run": true` in the file for the first run. The reply has one result for each record and changes nothing. Then set it to `false` and run the same command. Each record becomes a proposal from the source `import:<name>`, and you approve them with Review all. A record whose area or link is another record in the same file waits. Approve the first round, then post the same file again. A record that is in HMN already, or that you declined in the last 90 days, is not proposed again.
