# HMN data model

One SQLite file on the Mac mini. The physical model is deliberately small: a typed entity table, a link table, API keys, proposals, and a single row of display state. Types are enforced in the server, not by adding a table per concept. New types are a registry change. New facts on an existing type are properties. That is the extensibility model.

Logical entities, their fields, and the demonstration records below are the contract for the seed and the API.

## Physical tables

### entities

| Column | Type | Notes |
| --- | --- | --- |
| id | text, primary key | Seed uses readable ids. Creates use UUIDs. |
| type | text | Registry value. See below. |
| title | text | Required. For a person this is their name. |
| body | text, nullable | Note text, task notes, descriptions. |
| status | text, nullable | Allowed values depend on type. |
| kind | text, nullable | Allowed values depend on type. |
| due_at | text, nullable | A calendar date `YYYY-MM-DD` or an instant `YYYY-MM-DDTHH:MM:SS.sssZ`. A date has no clock. The server must not invent one. |
| area_id | text, nullable | The domain used for agent scoping. Points at an `area` entity. |
| properties | text | JSON object. Unknown keys are kept. Spoiler keys are rejected. |
| origin | text | `owner`, `agent`, `plugin`, `import`, or `seed`. |
| origin_ref | text, nullable | Agent name, plugin id, or `seed`. |
| source_id | text, nullable | The `source` entity this fact came from. |
| external_id | text, nullable | Id in an external system. Unique with `source_id` among live rows. |
| tier | text, nullable | Explicit override: `public`, `household`, `personal`, `private`, `sealed`. Null inherits. |
| content_sealed | integer | `1` when title and body are field-ciphertext. The API never returns the ciphertext. |
| confirmed_at | text, nullable | When a proposal that created or changed it was approved. Null for direct owner writes. |
| created_at | text | ISO instant. |
| updated_at | text | ISO instant. Set again on every change. Quiet age uses this. |
| deleted_at | text, nullable | Set when the current head is a tombstone. Live queries omit these rows. The row is still the head, not a hard delete. |

The `entities` row is the current head. It is a projection. Content history lives in `entity_versions`, which is append-only. An edit inserts a version and then updates the head. It does not change the previous version.

### entity_versions

| Column | Type | Notes |
| --- | --- | --- |
| id | text, primary key | The version id. |
| entity_id | text | The stable id used by the API and by links. |
| supersedes_id | text, nullable | The version this one replaces. Null for the first version. |
| valid_from | text | When this version became current. |
| tombstone | integer | `1` when this version records a delete. The previous version is left as it was. |
| type, title, body, status, kind, due_at, area_id, properties, tier, content_sealed | | The snapshot, stored the same way as the head. Sealed fields stay ciphertext. |
| origin, origin_ref, source_id, external_id | | Provenance of this version. |
| prev_hash | text | The audit-chain tip immediately before this version was written. |
| hash | text | SHA-256 of the canonical snapshot plus `prev_hash`. |

A version is linked into the audit chain by an audit row whose `subject_hash` is the version hash. `GET /api/v1/audit/verify` recomputes every version hash and checks that the audit row still points at it. Editing a stored version breaks the chain.

`POST /api/v1/:type/:id/purge` is the only hard delete. It removes the head, every version, and links that mention the id. The audit row records `purge`, the id, and a hash of the version ids. It does not record the title or the body. Ordinary delete is the tombstone above.

### Plain-file mirror

When the server is running it keeps a folder of Markdown and JSONL next to the database, or in `HMN_MIRROR_DIR` if that is set. The default is `data/mirror`. The folder is rewritten on each save. A second save of an unchanged entity does not touch its files.

| Path | Contents |
| --- | --- |
| `entities/{type}/{id}.md` | One file per head, with YAML frontmatter. |
| `timelines/{id}.jsonl` | One JSON object per version, in `valid_from` order. |
| `manifest.json` | The head version id of each entity. Used to skip unchanged files. |

Public and Personal heads and versions are plain text. Private and Sealed are stubs: id, type, tier, version id, `valid_from`, and whether it is a tombstone. No title, body, properties, or area. A version that was once Personal stays a stub if the head is later Private or Sealed, and a Private version stays a stub if a later head is Personal. A purge deletes that entity's files. The mirror is not a second copy of the sealed key.

### links

A directed, typed edge. Traversal returns both directions and says which way the stored edge points.

| Column | Type | Notes |
| --- | --- | --- |
| id | text, primary key | |
| from_type, from_id | text | |
| to_type, to_id | text | |
| rel | text | See the relation catalogue. |
| origin, origin_ref | text | Same vocabulary as entities. |
| tier | text, nullable | Override. Effective tier is at least the stricter endpoint. |
| created_at | text | |
| deleted_at | text, nullable | Unlink is a soft delete. |

There is no foreign-key cascade. A tombstone hides an entity's links in reads, and the link rows remain so a mistake can be understood. Purge removes those link rows with the entity.

### credentials

API keys and paired devices are one table. The secret format is `hmn_` plus 32 random characters. The scope and the tier are not encoded in the secret.

| Column | Type | Notes |
| --- | --- | --- |
| id | text | |
| name | text | `owner`, `agent`, `display`, or a device name. |
| kind | text | `key` or `device`. |
| key_hash | text | SHA-256 of the secret. The secret is not stored. It is shown once at creation. |
| scope | text | `read`, `write`, or `agent`. A key with `read` that the owner made is a view key: it reads, and it cannot propose. |
| max_tier | text | The highest tier this credential may receive. |
| vault | integer | `1` only for a paired phone. Required to mint a vault grant. |
| allow_types | text, nullable | JSON array of types. Null means every type. |
| allow_areas | text, nullable | JSON array of area ids. Null means every area that is not denied. |
| deny_areas | text, nullable | JSON array. An entry is the id of an area, or `role:<name>` for each area whose kind has that role. Wins over allow, and wins even if a tier was set too low. |
| forced_ceiling | text, nullable | Panic. When set, the effective ceiling cannot rise above it. |
| expires_at | text, nullable | After this instant the secret is rejected. |
| private_until | text, nullable | For an agent key: the Private grant is open until this instant. After it the key reads at Personal again. Null is no grant. |
| free_busy | integer | `1` when the owner lets this key read busy times. The default is `0`. |
| guest | integer | `1` for the agent of another person. A guest is an outside client at Public, and it can propose one thing: a new event. |
| created_at | text | |
| revoked_at | text, nullable | Revoked secrets fail closed. |
| rotated_from | text, nullable | Previous credential id, for rotation. |
| created_by | text, nullable | The credential that made this one: the owner key or the phone that made a key, and the key that made the pairing code of a phone. Null for the three keys of the first boot, and for a credential from before this column. |

The seed creates three keys. Devices appear only after pairing.

| name | kind | scope | max_tier | vault | deny_areas | expires |
| --- | --- | --- | --- | --- | --- | --- |
| owner | key | write | private | no | none | 90 days, rotatable |
| agent | key | agent | personal | no | `role:health`, `role:money` | 90 days |
| display | key | read | public | no | none | 90 days |

The owner key cannot open the vault. A leaked copy of it reveals Public, Personal, and Private, and does not reveal Sealed. That is a deliberate bound.

Rotation (`POST /api/v1/credentials/:id/rotate`) issues a new secret and sets the old `revoked_at`. The new credential keeps the scope, the tier, the limits, Hide (`forced_ceiling`), the marks of an outside client, and `created_by`. It does not keep a Private grant. The new secret is returned once. A credential renews its own secret from any address. For another credential the caller is on the mini with a write key, so a phone cannot take the secret of a key.

A revoke also revokes the keys that the credential made (`kind` `key` with that `created_by`): a key of an agent, a view key, and the key of an outside client. The answer names them in `also_revoked`. A phone that the credential paired stays.

### pairing_codes

| Column | Notes |
| --- | --- |
| id | |
| code_hash | SHA-256 of the code. The code is 8 characters from an unambiguous alphabet. |
| expires_at | Ten minutes. |
| used_at | Single use. |
| created_at | |

Creating a code is localhost only. The socket address is the peer, never `X-Forwarded-For`. Redeeming a code is allowed from the network and returns a device credential with scope `write`, max tier `private`, and `vault` set.

### vault_grants

| Column | Notes |
| --- | --- |
| id | Unguessable. The client sends this id. Stored hashed. |
| credential_id | Must match the caller. |
| expires_at | Five minutes. |
| used_until | The grant covers the vault session, not a single read, so the owner can read a proposal and approve it. It still dies at the clock. |
| created_at | |

An agent credential is rejected. A grant does not raise `max_tier` on the credential itself.

### auth_attempts

`subject` (source address or secret hash), `failed_at`. Eight failures in ten minutes locks that subject for fifteen minutes. The response is `429` with a generic message. The lockout is checked before the secret compare so a locked subject does not confirm that a secret was valid.

### audit_log

| Column | Notes |
| --- | --- |
| seq | Integer, contiguous. |
| at | Instant. |
| actor | Credential id, or `anonymous`. |
| action | `read`, `write`, `approve`, `reject`, `grant`, `panic`, `panic_clear`, `pair`, `revoke`, `rotate`, `restore`, `auth_failure`, `tier_change`. |
| tier | The tier of the fact, when there is one. |
| entity_type, entity_id | Ids only. Never a title or a body. |
| surface | `phone`, `widget`, `display`, `lock`, `mcp`, `api`. |
| prev_hash | Hex SHA-256 of the previous row. The genesis previous hash is 64 zeroes. |
| hash | Hex SHA-256 of the canonical JSON of the other fields plus `prev_hash`. |
| subject_hash | Hex SHA-256, nullable. Set on `version`, `tombstone`, and `purge` rows. For a version it is the version hash. For a purge it is a hash of the removed version ids, not of the content. Rows written before this column existed leave it null, and their hash does not include it. |

Private and Sealed reads and writes are logged, plus the security actions above. Public and Personal reads are not, or the log becomes a second copy of the owner's ordinary day. `GET /api/v1/audit` is itself Private. `GET /api/v1/audit/verify` walks the chain. A break is an error, not a quiet skip.

The chain detects an edited or deleted middle row. It does not stop a person who can rewrite the whole table and every hash. On a Mac the server also stores the tip hash in the Keychain when `security` is available, so a later compare can see a full rewrite. That anchor is best-effort and is called out in [SECURITY.md](SECURITY.md).

### proposals

| Column | Type | Notes |
| --- | --- | --- |
| id | text | |
| agent_name | text | Display name, such as `Trip helper`. |
| key_id | text, nullable | The key that submitted it. |
| op | text | `create`, `update`, `delete`, `link`, `unlink`. |
| entity_type | text, nullable | |
| entity_id | text, nullable | Known for update, delete, and for create after approval. |
| payload | text | JSON. Shape depends on `op`. |
| reason | text, nullable | The "why". |
| tier | text | Effective tier of the proposal. Sealed proposals store payload and reason as field ciphertext, not plaintext. |
| read_set | text, nullable | JSON. What the agent says it looked at, and the domains it cannot see. Omitted from responses above the ceiling. Ciphertext when the proposal is sealed. |
| status | text | `pending`, `approved`, `rejected`, `expired`, `undone`. |
| created_at | text | |
| decided_at | text, nullable | |
| decided_by | text, nullable | `owner`, `policy` for an auto-accepted proposal, or `system` for an expired one. |
| model_id | text, nullable | The model that drafted the proposal, when one did. |
| model_version | text, nullable | The pinned or catalog version of that model. |
| source_key | text, nullable | Set by a worker. It names the subject of the draft, for example `person_x:birthday:2026-11-20`. A request body cannot set it. |
| expires_on | text, nullable | Set by a worker. The last day, in the owner's time zone, on which the proposal is useful. A request body cannot set it. |
| source | text, nullable | Named by the server: `worker:<id>`, `plugin:<id>`, or `key:<credential id>`. The `X-HMN-Agent` header does not change it. |
| agent_name | text | The name on the Review card. For a key it is the name that the owner gave the key. Only the owner can set another name with the `X-HMN-Agent` header. |
| applied | text, nullable | JSON. The entity, the version, and the links that the approval wrote. Undo reads it. It holds ids only. |
| undone_at | text, nullable | |
| idempotency_key | text, nullable | Set by the caller. One key from one source is one proposal. |

A proposal in a response has one more field, `summary`, which is not stored. The server makes it from the graph at the time of the read: `title` (the item), `lines` (each with a `label`, the value after the approval in `text`, and for a change that waits the value now in `was`), and `warning` (a sentence, or null). A client shows the summary, so that the owner reads what an approval writes and not only the words of the source.

A key that is not the owner's cannot propose a patch that makes a row more visible, a change or a removal of an area, or a row with `properties.mirror`. It reads the proposals that it filed.

### client_reads

What each agent key, each outside client, and each view key read. The audit log holds Private and Sealed reads only, and an agent reads Personal data, so this table is the read log for the owner. A worker is not here, because a worker has a journal.

| Column | Type | Notes |
| --- | --- | --- |
| seq | integer | |
| at | text | |
| principal_id | text | The credential id. |
| action | text | `read`, `search`, or `neighbours`. |
| entity_type, entity_id, tier | text, nullable | For a read. The title is not stored. The owner's screen shows the title only if the owner's ceiling covers the entity now. |
| detail | text, nullable | The words of a search, or the start of a walk. At most 200 characters. |

The newest 2,000 rows of each key are kept. A row is saved with the next save of the database, so a crash can lose the newest rows.

**Search index.** Search uses an FTS5 index with BM25, and the title has five times the weight of the body. The index is in memory, in an attached database, and is not saved. It holds no Sealed text. The server builds it again when the count or the newest change of the live entities differs. The ceiling is applied to the ranked ids, so a row above the ceiling is not in a result. A part of a word, and Sealed text that the vault opened, are found by the older substring match, after the ranked results.

### approval_policies

One row is one rule. Review is the default when no rule matches.

| Column | Type | Notes |
| --- | --- | --- |
| id | text | |
| source | text | `worker:<id>`, `plugin:<id>`, `key:<credential id>`, or `*`. |
| op | text | `create`, `update`, `delete`, `link`, `unlink`, or `*`. |
| entity_type | text | An entity type, or `*`. An update or a delete uses the type of its target. A link has no entity type, so only `*` matches it. |
| tier | text | A tier, or `*`. |
| mode | text | `review`, `auto`, or `deny`. |
| updated_at | text | |

The four fields are unique together. The rule with the most named fields wins. Between two rules with the same number of named fields, the stricter mode wins: `deny`, then `review`, then `auto`.

### inbox_items

A capture that has not been filed yet. It is not an entity. Processing it may create one, and the row keeps the provenance either way.

| Column | Type | Notes |
| --- | --- | --- |
| id | text, primary key | |
| body | text, nullable | The words, with `#tags` removed. Field ciphertext when the tier is sealed. |
| url | text, nullable | A link, when the capture had one. Field ciphertext when sealed. |
| tags | text | JSON array of tags, without the tier words. Field ciphertext when sealed, so a tag cannot leak below the ceiling. |
| tier | text | `public`, `household`, `personal`, `private`, or `sealed`. Default `personal`. `#household` sets Household. `#private` and `#sealed` raise it. A tag or a named area, project, or person raises it to that record's tier. An agent capture cannot land on `public`. |
| source | text | `app`, `share`, `siri`, `widget`, `mcp`, `email`, `webhook`, or `shortcut`. |
| status | text | `new`, `processed`, or `archived`. |
| content_sealed | integer | `1` when body, url, tags, and attachments are field ciphertext. |
| attachments | text | JSON array of `{kind, name, content_type, data_base64?}`. Photos, files, and voice notes. A voice note's transcript is the body. Capped, and ciphertext when sealed. |
| suggestion | text, nullable | Unused. The route is computed when the item is read. |
| result_type, result_id | text, nullable | What it became: a task, a note, a person, or the entity it was filed to. |
| origin, origin_ref | text | `owner` or `agent`, and the source. A created entity's `origin_ref` is `inbox:<id>`. |
| captured_at, updated_at | text | |
| deleted_at | text, nullable | Delete is a soft delete. |

`#todo` proposes a task, and a tag that names an area or project files it there. `#person` proposes a person, or a link when the words name someone already in the graph. `#read` proposes a note with `properties.reading`. Anything else waits. The triage agent, built on another branch, reads these rows through the same policy layer and does not see items above its ceiling.

`POST /api/v1/inbox` captures. `POST /api/v1/inbox/in` is the same door for a mail forwarder or a webhook: the body is data, not instructions. MCP `capture_inbox` only creates a row. Accepting a route is the owner's confirmation, so that one action writes the graph.

### display_state

One row, id `device`. `screen_index` is the last screen served to the display. `shown_at` is when it was served. Used by rotation. See [UX.md](UX.md).

### worker_configs

One row per built-in worker. The workers are `morning`, `weekly`, and `triage`. They are created on boot.

| Column | Notes |
| --- | --- |
| id | `morning`, `weekly`, or `triage`. |
| name | The name on the proposal. `Morning`, `Week`, or `Triage`. |
| kind | Same as id. |
| enabled | `1` when the schedule may run it. |
| tier | `public`, `personal`, or `private`. Sealed is refused. The effective ceiling is the lower of this tier and Personal, except People, which may be Private so a family reminder stays Private. |
| schedule | `daily:HH:MM`, `weekly:D:HH:MM` (Sunday is 0), or `hourly`. |
| llm_mode | `fallback`, `local`, or `cloud`. |
| llm_endpoint | Loopback only. Default `http://127.0.0.1:11434/api/chat` (Ollama). An OpenAI-compatible path on localhost is also accepted. |
| llm_model | Model name sent to that endpoint. |
| cloud_enabled | `1` only after the owner accepts the warning. |
| cloud_endpoint | HTTPS URL of an OpenAI-compatible host. Not a loopback, link-local, or private address. |
| cloud_tier | The highest tier that may leave the mini. Sealed is refused. The bytes that are sent are the lower of this tier and the worker's effective ceiling. |
| cloud_warning_ack | `1` when the owner has accepted the warning for this worker. |
| last_run_at | Used by the schedule. |
| updated_at | |

No API key is stored here. A cloud key is read from the Keychain item `hmn.llm.cloud` or from `HMN_LLM_CLOUD_KEY` at the moment of a run, and it is not written into a proposal or a log.

### worker_runs

One row per run. `summary` is the focus line or the review sentence the worker composed from data it was allowed to see. `proposal_ids` is a JSON list. The row does not copy sealed text, because that text was not in the run.

### trmnl_devices

One row per e-ink display. See [TRMNL.md](TRMNL.md).

| Column | Notes |
| --- | --- |
| id | |
| mac | Normalised `AA:BB:CC:DD:EE:FF`. Unique. |
| friendly_id | Six characters, shown on the setup image. |
| name | Owner's name for the display. |
| model, firmware | From the device headers. |
| status | `pending`, `claimed`, or `revoked`. |
| credential_id | The read key, maximum tier Public, `forced_ceiling` Public, no vault. |
| key_pending | The device secret, kept only until the next `GET /api/setup` after a claim, then cleared. The database file is encrypted. The secret is not returned by the list API. |
| claimed_at, delivered_at, last_seen_at | |
| battery, rssi, width, height | Last telemetry. No graph titles. |
| created_at | |

### trmnl_logs

Firmware messages from `POST /api/log`. Messages are truncated, and `hmn_` secrets and `access_token` query values are replaced before insert. The table is capped at 200 rows per device. It is not a copy of the graph.

## Tiers, inheritance, and encryption

Effective tier of an entity:

1. If `tier` is set, that is the override.
2. Otherwise, if `area_id` is set, use that area's `properties.child_tier`. A new area with no `child_tier` gets one from the role of its kind: Sealed for `health` and `money`, Private for `family`, and Personal for each other kind. A value from the caller stays.
3. Otherwise `personal`.

Effective tier of a link is the stricter of its override (if any) and both endpoints. A response that cannot see either endpoint omits the link. It does not return the hidden peer's title.

Effective tier of a proposal is the stricter of the declared tier, the payload's tier, every linked entity, and every source the payload was derived from. Lowering it below that floor is refused for an agent. The owner may override an existing entity's tier. That write is audited as `tier_change`. Moving an item to Public is allowed because it is the owner's data, and the phone asks the owner to confirm.

Properties may carry `_privacy`, a map of property name to a tier. A property is visible only when the ceiling covers that tier. A property at `sealed`, and any title or body of a sealed entity, is stored as AES-256-GCM ciphertext (`seal1:` prefix) under the sealed key. The policy layer decrypts after the ceiling check. Search runs on plaintext columns only, so sealed text cannot match a query at any ceiling. That is the point.

The database file at rest is AES-256-GCM ciphertext (`HMNENC1`), not a SQLite file. The running server keeps the decrypted file in memory-backed storage (`/dev/shm` on Linux, a mode `0600` file under the per-user temp directory on macOS that is removed on exit) and writes the encrypted file back after each mutation. This is the SQLCipher equivalent chosen for v1: `bun:sqlite` has no SQLCipher build, and a second native SQLite would be another supply-chain surface. The key hierarchy does not change if SQLCipher replaces the file format later.

Keys:

| Key | Where it lives | What it wraps |
| --- | --- | --- |
| KEK | macOS Keychain item `hmn.kek` via `security`. In Docker, a file mounted from that Keychain at `/run/secrets/hmn_kek`, never an environment variable and never the git tree. | The three keys below. |
| Database key | `data/keys/db.wrap`, wrapped by the KEK. | The SQLite file. |
| Sealed key | `data/keys/sealed.wrap`, wrapped by the KEK. | Sealed field ciphertext. |
| Backup key | Keychain item `hmn.backup`, and a passphrase the owner writes down once. Not in the data directory in the clear. On macOS the first boot writes `hmn.backup`. The process still unwraps `keys/recovery.wrap`. | Backup blobs. |

A development flag `HMN_INSECURE_DEV_KEK=1` writes the KEK inside the data directory so tests and a Linux sandbox can boot. The server logs that this is not for a Mac mini with real data. The flag is not the production path, and the key is still not committed.

On macOS, the first boot also stores the printed API secrets in the login Keychain as `hmn.owner`, `hmn.agent`, and `hmn.display` (account `hmn`). The database still stores only the hash. The menu bar reads `hmn.owner`. `HMN_KEYCHAIN` points the `security` commands at another keychain file when the process is not the login user. The install script is what copies `hmn.owner` into the login Keychain for that case.

Backups (`hmn.backup` files) are AES-256-GCM under the backup key. They do not contain the KEK. Restoring a copied backup needs the Keychain or the written-down passphrase. A backup of the data directory without the Keychain does not unlock the database.

## Types

Status and kind are validated. Properties are an object. Keys listed here are the ones the screens understand. Other keys are stored and ignored by the screens, except the spoiler keys, which are refused on every type.

| Type | Status | Kind | Properties the screens read |
| --- | --- | --- | --- |
| area | — | Rows in `kinds`. The defaults are `family`, `work`, `health`, `money`, `sport`, `home`, `other`. | `child_tier`: the tier inherited by items filed here. `summary`. |
| person | — | Rows in `kinds`. The defaults are `self`, `family`, `other`, `organisation`. An older graph gets `organisation` once, at its next start. | `nickname`. |
| goal | `active`, `paused`, `done` | — | `horizon`: `year`, `quarter`, `open`. |
| project | `active`, `paused`, `done`, `someday` | Free. `list` makes a list. | — |
| task | `inbox`, `open`, `done` | `task`, or `item` for a line of a list or a step of a task | `done_by`, `done_by_key`, `done_at`: written by the server when the task becomes done, removed when it opens again. |
| note | `open` | — | — |
| event | `upcoming`, `past`, `cancelled` | Rows in `kinds`. The defaults are `family`, `appointment`, `fixture`, `trip`. | `short_title`, `badge`, `tz_label`, `end_at`, `no_results`. |
| place | — | Rows in `kinds`. The defaults are `home`, `other`. | `address_line`. |
| asset | — | Rows in `kinds`. The default is `other`. | `model`, `year`. |
| source | — | Fixed in code, because the server writes them: `manual`, `notion`, `calendar`, `health`, `sport`, `agent` | `plugin`, `mapping`. |
| habit | `active`, `paused` | — | `cadence`, `time_of_day`, `days` (`mon` to `sun`, none for every day), `last_check_in`, `checked_by`, `checked_at`. A habit with a `for` link to a person is a routine. |

A fixture (`event` with kind `fixture`, or any entity whose properties contain `no_results: true`) must not carry a property named `score`, `scores`, `result`, `results`, `winner`, `standing`, `standings`, or `points`. Create, update, and proposal approval all refuse these with `422` and code `no_scores`. The renderer never prints a result line from properties. No screen says this rule in words.

### The ceiling of an agent key

One rule gives the ceiling of each agent key, local or outside (`agentCeiling` in `server/src/policy.ts`).

| Case | Ceiling |
| --- | --- |
| `max_tier` is `public`, or `forced_ceiling` is `public` | Public |
| All other keys | Personal |
| `private_until` is later than now, and the key is not held at Public | Private |
| The display or the lock surface | Public |

Nothing gives Sealed: not the vault mark, not a tier in the row, not a vault grant, and not the surface that the caller names.

A guest is always Public. `POST /api/v1/external/clients` with `guest: true` makes one, and a `ceiling` in the same body changes nothing. A guest can file one kind of proposal: `create` of an `event`. The server keeps the title, the start, `properties.end_at`, and at most 2,000 characters of text. It sets the kind to `appointment` and the status to `upcoming`, and it drops the area, the tier, the links, and each other property. The proposal is Personal, so the guest cannot read it back. The guest can read its state with `proposal_status`, which gives no entity id above the ceiling of the caller. A guest's text in the inbox is at most 2,000 characters.

`GET /api/v1/keys` lists the keys with what each one reads now, and no secret. `POST /api/v1/keys` makes a key for one local agent, with `name`, `ceiling` (`public` or `personal`), `days`, `allow_areas`, `allow_types`, and `deny_areas`. A caller on the mini sees the key once, and the server puts it in the Keychain as `hmn.agent.<name>`. A caller that is not on the mini gets no key: the server needs its Keychain for that, or it answers `make_on_mini`. `POST /api/v1/keys/:id` changes the limits or the end date.

**A view key.** `POST /api/v1/keys` with `scope: "read"` makes a key for a view, such as a display or a widget of another project. Its id starts with `view_`, and on the mini its Keychain item is `hmn.view.<name>`. Its ceiling is Public, or Personal when the body has `ceiling: "personal"`. The surface that the caller names does not raise it. A view key cannot file a proposal, cannot capture to the inbox, cannot write, and cannot open the vault. `POST /api/v1/keys/:id/private` answers `409` with the code `view_key`. The limits, the end date, the revoke, and the read log are the same as for an agent key. `GET /api/v1/keys` gives each key with its `scope`, so the list also has the display key of the first boot. The read contract is in [STRATEGY.md](STRATEGY.md).

`GET /api/v1/keys/:id/preview` shows what Private adds for that key, from the real graph: the count by type and by area, and five titles that the viewer can read. `POST /api/v1/keys/:id/private` with `{days, understood: true}` gives Private for 1 to 90 days. `DELETE /api/v1/keys/:id/private` ends it. A revoke also ends it, and removes the key from the Keychain. Each step is in the audit log.

### Kinds and roles

A kind is a row that the owner adds and renames. A role is a fixed word that the rules read. The rules never read the name of a kind. They ask for the kinds that have a role, so a kind that the owner adds works at once.

`kinds` has `type`, `kind`, `title`, `role`, `core`, and `position`. `kind` is the word stored on an entity: lower-case letters, digits, and underscores. `title` is what the owner reads. A `core` kind cannot be removed and its role does not change, because a plugin or a worker writes it. Its title can change. A kind that live entities use cannot be removed.

| Type | Role | What the rules do with it |
| --- | --- | --- |
| person | `self` | The greeting uses this person's name. The People worker does not remind the owner of the owner. |
| person | `family` | A calendar event is a family date when each attendee is a person of such a kind. |
| person | `organisation` | A school, a garage, a doctor. People lists it after the people. |
| event | `family` | Today's Family section, and the week's dates. |
| event | `fixture` | "To watch", the Fixtures worker, and the rule that a fixture has no score, result, winner, standing, or points. |
| area | `family` | A family date from a calendar goes to the first area of such a kind. |
| area | `sport` | A fixture from the sport plugin, and the "What to watch" note, go to the first such area. |
| area | `health` | A health summary goes to the first such area. An agent key, a worker, and an outside client do not read such an area. |
| area | `money` | An agent key, a worker, and an outside client do not read such an area. |
| area | `work` | The work screen lists the open tasks of each such area, and its label is the titles of those areas. |

When the owner has no area for a role, a family date is Private and a health summary is Sealed, with no area.

The demonstration adds its own kinds: `spouse` and `child` with the role `family`, `side_project` with the role `work`, `cars`, `school`, `garage`, and `car`. A graph from before this table keeps each kind that an entity uses.

`GET /api/v1/kinds` lists the kinds, the roles, and how many entities use each kind. `PUT /api/v1/kinds` with `{type, kind, title, role}` adds a kind or changes one. `DELETE /api/v1/kinds/:type/:kind` removes one that is not core and not in use. The three need a write credential.

**First boot.** `HMN_SEED=empty` on the first boot of a data directory writes the three keys and the default kinds, and no entity. With no setting, the first boot writes the demonstration. A row in `meta` (`seeded`) records which one ran, so a later start of an empty graph does not write the demonstration.

Area child tiers in the seed: Work, Side project, Cars, and Home are `personal`. Family is `private`. Sport is `public`. Health and Money are `sealed`. An agent key's `deny_areas` still lists Health and Money, so a mistaken Public override on a health row does not open it to the agent. Reads above the ceiling, and reads of a denied area, are omissions: lists and search drop the row, and `GET` by id is `404`. The body of a `404` does not echo the title. Ciphertext is never returned.

## Relations

| rel | From | To | Meaning |
| --- | --- | --- | --- |
| `serves` | project | goal | This project exists to move that goal. |
| `part_of` | task | project | This task is inside that project. |
| `in` | any | area | Domain, in addition to `area_id` when a second area matters. `area_id` is what scoping uses. |
| `about` | task, note, event | person, asset, project, note, event | What it concerns. |
| `with` | event | person | Who it is with. Family titles are built from this. |
| `at` | event | place | Where it is. |
| `cares_for` | person | asset | Who deals with this car or object. |
| `related` | any | any | A weak link, when none of the above is true. |

A task does not need a project. A project does not need a goal. Capture depends on that.

Today's subtitle for a task uses the first link it finds in this order: `part_of` a project, `about` a person, `about` an asset, `about` a note. The linked title is the subtitle. A due instant adds `· by HH:MM` in the owner's zone.

## Provenance

Every entity and link records `origin` and `origin_ref`.

| origin | When |
| --- | --- |
| `owner` | Direct write with a write key. `confirmed_at` stays null. |
| `agent` | Applied from an approved proposal. `origin_ref` is the agent name. `confirmed_at` is the approval time. |
| `plugin` | Applied from a proposal that a plugin made, such as the calendar mirror. `origin_ref` is the plugin id. |
| `import` | Applied from a proposal of a one-time import. `origin_ref` is the name of the import, such as `notion`. |
| `seed` | The demonstration data. |

`source_id` points at a `source` entity. Plugin rows also set `external_id` to the foreign id. The pair `(source_id, external_id)` is unique among live rows so a plugin can find the local fact on the next run and propose an update instead of a duplicate.

Detail screens show provenance as "You", the agent name, the plugin id, or "Seed".

## Proposals

Payload shapes:

```json
{ "op": "create", "entity": { "type": "task", "title": "Renew Yves' passport", "status": "open", "due_at": "2026-11-30", "area_id": "area_home", "properties": {} }, "links": [ { "rel": "about", "to_type": "person", "to_id": "person_yves" } ] }
```

```json
{ "op": "update", "id": "task_srs", "patch": { "due_at": "2026-11-18" } }
```

```json
{ "op": "delete", "id": "task_srs" }
```

```json
{ "op": "link", "link": { "rel": "about", "from_type": "task", "from_id": "task_srs", "to_type": "asset", "to_id": "asset_coupe" } }
```

```json
{ "op": "unlink", "id": "link_id" }
```

Rules:

- A write key may create, update, and delete directly, up to its `max_tier`. It may also approve, reject, and edit a pending proposal whose tier is within the ceiling. Approving a sealed proposal without a vault grant returns `403` and code `vault_required`.
- An agent key may read within its ceiling and area denylist, and may create proposals. It may not call entity writes, link writes, approve, reject, mint a grant, rotate someone else's key, or set `max_tier`. Those return `403`.
- A read key may only `GET`, and only up to its ceiling. The display key's ceiling is Public even if a caller sends a surface header asking for the phone.
- MCP tools that change data always insert a proposal, even if the key behind the MCP process is a write key. MCP is the agent path. The MCP surface ceiling is the key's `max_tier`, and never Sealed unless a vault grant for that same credential is attached. Agents cannot attach a grant they cannot mint.
- Plugins are untrusted code that this build does not load. A plugin manifest declares a maximum tier and areas. The runner accepts records as data and emits proposals. It does not call the write path and it does not evaluate record text.
- Approve runs in a transaction. It applies the payload, then sets the proposal to `approved`. A second approve returns `409`.
- Reject sets `rejected` and does not touch the graph.
- Edit (`PATCH` a pending proposal) changes title, due date, and reason. It does not apply the proposal. Write key only.
- Approval of a create sets the new entity's origin to `agent`.

`read_set` is recorded, not verified. The server does not know what an agent actually opened. The disclosure line on the Agents screen is this claim plus the key's real `deny_areas`. The denial is computed. The "I read" sentence is the agent's claim.

## API

Base path `/api/v1`. The server speaks TLS only. Authentication is `Authorization: Bearer <secret>`. Display routes also accept the header `Access-Token` and, because e-ink firmware often fetches an image URL with no header, the query `access_token`. The query form is for the display routes only. It will appear in proxy logs. Use it on LAN or Tailscale, not on a public port.

The surface is `X-HMN-Surface: phone | widget | display | lock | mcp`. Display routes force `display`. MCP forces `mcp`. A missing header is `api`, whose ceiling is Personal, not Private. The phone must send `phone` to see Private rows. A vault grant id travels in `X-HMN-Grant`.

| Method and path | Scopes | Behaviour |
| --- | --- | --- |
| `GET /health` | none | Liveness. No personal data. |
| `POST /api/v1/pairing` | localhost and write, not hidden | Mint a pairing code. The code records the key that made it. |
| `POST /api/v1/pair` | the code | Exchange a code for a device secret, returned once. |
| `POST /api/v1/devices/:id/revoke` | write | Revoke a device or a key, and the keys that it made. |
| `POST /api/v1/credentials/:id/rotate` | itself; or localhost and write for another credential | New secret, old secret dead. |
| `POST /api/v1/vault/grants` | device with `vault` | Five-minute sealed ceiling for that device. |
| `POST /api/v1/panic` | a paired device | Force that device's ceiling to Public. The owner key answers `409`. |
| `POST /api/v1/panic/clear` | localhost and write, not hidden | Remove the force from the device in `id`. Audited as `panic_clear`. A hidden device cannot do this for itself. |
| `GET /api/v1/audit` | phone ceiling Private | The log, without titles. |
| `GET /api/v1/audit/verify` | phone ceiling Private | `{ "ok": true, "tip": "..." }` or a `409`. |
| `POST /api/v1/backup` | localhost and write | Write an encrypted backup. |
| `GET /api/v1/admin/status` | localhost and write | Version, certificate fingerprint, paired-phone counts, backup count. No titles and no paths. |
| `GET /api/v1/admin/devices` | localhost and write | Paired phones. No key hash. |
| `POST /api/v1/admin/panic` | localhost and write | Quick-hide. Every live phone drops to Public. The owner key is not changed. |
| `POST /api/v1/admin/panic/clear` | localhost and write | Clear that force. Audited as `panic_clear`. |
| `GET /api/v1/admin/backups` | localhost and write | Backup file names, sizes, and times. Not absolute paths. |
| `POST /api/v1/admin/restore` | localhost and write | Body `{ "name": "backup-….hmn" }`. Replaces the graph. The name is a file in the backup directory. Audited as `restore`. |
| `GET /api/v1/models/spend` | phone ceiling | This month's cloud egress: characters, token estimate, dollars, cap, and the cap notice. No titles. |
| `GET /api/v1/models.html` | phone ceiling | Read-only model registry and routing. Not on the display. |
| `GET /api/v1/me` | read, write, agent | Key name, scope, max tier, denied area titles. The owner name is included only when the person is within the ceiling. `member` is `{ role, person_id, name }` on a member's phone, else null. The app shows member mode when it is set. |
| `GET /api/v1/:type` | read, write, agent | Live entities of that type, scoped. |
| `POST /api/v1/:type` | write | Create. Agent receives `403`. |
| `GET /api/v1/:type/:id` | read, write, agent | One entity. Denied or deleted is `404`. |
| `PATCH /api/v1/:type/:id` | write | Partial update. Changes `updated_at`. |
| `DELETE /api/v1/:type/:id` | write | Soft delete. |
| `GET /api/v1/:type/:id/links` | read, write, agent | Both directions, with a peer summary. |
| `POST /api/v1/links` | write | Create a link. |
| `DELETE /api/v1/links/:id` | write | Soft-delete a link. |
| `GET /api/v1/review/year?year=` | read, write, agent | The yearly review: `year`, `greeting`, `summary`, `closing`, `sections` (as a screen), `note` (the owner's note for the year, or null), and `years` (from the first row to now, the newest first). No `year` means this year. A year after this one gets 422. |
| `PUT /api/v1/review/year/:year/note` | write, owner | `{ body }`. Makes or changes the one Private note of the year (`properties.year_review`). A member gets 403. |
| `GET /api/v1/schema` | read, write, agent | `{ statuses, kinds, relations, fields, kind_fields, field_types }`. The statuses of each type, the kinds with their titles, the relations with the words for each direction (`out`, `in`), the typed fields of each type, and the fields that each kind adds. A client builds its editors from this. Only a write key sees `in_use` and `core` on the kinds. See "Typed fields". |
| `PUT /api/v1/kinds/:type/:kind/fields` | write | `{ fields: [{ label, type, key?, choices? }] }`. The fields that one kind adds. The list replaces the one before. At most 20. A key is made from the label when it is not given. A key of the type's own fields is refused. A value already kept in a row stays when its field goes. |
| `POST /api/v1/agent-requests` | agent, write | `{ need, why, example? }`. An agent says what it needed and did not have. It changes nothing and grants nothing. The same open need from the same key adds one to `asks`. At most 10 new requests a day for each key (429). A member, a view key, and a hidden key cannot send one. |
| `GET /api/v1/agent-requests?status=` | write | The requests, open first. `status` is `open`, `done`, `dismissed`, or `all`. |
| `PATCH /api/v1/agent-requests/:id` | write | `{ status }`: `open`, `done`, or `dismissed`. |
| `GET /api/v1/agent-requests/mine` | agent, write | The requests of the key that asks, and their states. |
| `GET /api/v1/people` | read, write, agent | Each person, with `line` (the kind, and the next date with them) and `organisation`. People first, by name, then organisations. |
| `GET /api/v1/person/:id/page` | read, write, agent | The person page: `person`, `kind_title`, `organisation`, `line`, and the linked rows in `next` (events from today, at most 5), `tasks` (open), `done` (the last 14 days), `notes`, `things` (assets and places), `people`, `other`, and `routines`. Each row has `entity`, `rel`, and `when`. A row the caller cannot read is absent. |
| `GET /api/v1/routines` | read, write, agent | Each habit that is `for` a person, with those people (`for`), its `days`, `due_today`, and `done_today`. By person, then title. |
| `POST /api/v1/routines` | write, owner | `{ title, person_id, days? }`. A routine at Household. The person must be at Household or below (422). A member gets 403. |
| `POST /api/v1/habits/:id/check-in` | write, member | Today's check-in, with `checked_by` and `checked_at` from the server. A child checks in only on a routine that is `for` the child (403). A second check-in on the same day changes nothing. |
| `DELETE /api/v1/habits/:id/check-in` | write, member | Takes back today's check-in. An earlier day is not changed. The same rule for a child. |
| `GET /api/v1/family-tasks` | read, write, agent | Each task that is `for` one person or more, with those people (`for`) and its step counts (`steps: { open, done }`). Open tasks first, by date, then the tasks done in the last 14 days. |
| `GET /api/v1/lists` | read, write, agent | Each project of the kind `list`, with its open count and its items: open items in the order added, then the last 20 done items. |
| `GET /api/v1/items?parent_id=` | read, write, agent | The items of one list, or the steps of one task, in the same order. `404` for any other parent. |
| `POST /api/v1/items` | write, member | Body `{ parent_id, title }`. Adds a task of the kind `item`, `part_of` the parent, with the tier and the area of the parent. |
| `POST /api/v1/members/pairing` | write | Body `{ person_id, role, fridge? }`, role `partner` or `child`. A pairing code for a member's phone, for ten minutes. With `fridge: true` the fridge shows it as a QR code for twenty minutes, and the answer has `on_fridge: true`. `payload` is the `hmn://pair?url=…&code=…&fp=…` link. `POST /api/v1/pair` with the code returns a member credential and `member: { role, person_id, name }`. |
| `GET /api/v1/members/pairing/fridge` | write | `{ fridge: { person_name, expires_at } \| null, ready }`. `ready` is true when a display is claimed at Household. Never the code. |
| `DELETE /api/v1/members/pairing/fridge` | write, owner | Takes the code off the fridge. The code stops working. |
| `GET /api/v1/members` | write | The member phones: name, role, person, hidden, last use. |
| `DELETE /api/v1/members/:id` | write | Revoke one member phone. |

A member's phone writes with the same routes as the owner (`POST /api/v1/:type`, `PATCH` and `DELETE /api/v1/:type/:id`, `POST /api/v1/items`, `POST` and `DELETE /api/v1/links`). Each write is a proposal with the source `member:<id>`. The answer is `200` with `{ status: "applied", proposal_id, entity }`, or `202` with `{ status: "pending", proposal_id }` when it waits for the owner.
| `GET /api/v1/search?q=` | read, write, agent | Title and body, scoped, ranked, limit 40. Each word must match. `&match=any` accepts one matching word. |
| `GET /api/v1/:type/:id/neighbours?depth=` | read, write, agent | The entities around one entity, to a depth of 1 to 3 links. |
| `GET /api/v1/access/:id/reads` | write | What one agent key read: each search with its words, and each entity. |
| `GET /api/v1/proposals?status=pending` | read, write, agent | Pending by default. |
| `POST /api/v1/proposals` | write, agent | Create a proposal. An `idempotency_key` in the body, or an `Idempotency-Key` header, makes a retry return the first proposal with 200. |
| `PATCH /api/v1/proposals/:id` | write | Edit a pending proposal's title, due date, or reason. |
| `POST /api/v1/proposals/:id/approve` | write | Apply it. |
| `POST /api/v1/proposals/:id/reject` | write | Reject it. |
| `POST /api/v1/proposals/:id/undo` | write | Undo an applied proposal. A create is removed, an update goes back one version, a removal comes back, and a link change is reversed. |
| `POST /api/v1/proposals/:id/clear` | write | Forget a decline, an expiry, or an undo, so that the worker can propose the item again. |
| `POST /api/v1/proposals/batch` | write | `{decision, source, ids}`. One decision for 1 to 200 named proposals from one source. |
| `GET /api/v1/proposals?source=` | read, write, agent | Limit the list to one source. |
| `GET /api/v1/activity` | write | Decided proposals, newest first, with `can_undo` and `can_clear`. For a source that is a key, `source_name` is the name that the owner gave the key, and `source_guest` says if it is a guest. |
| `GET /api/v1/policy` | write | The rules, the defaults, the known sources, and the limits that no rule changes. A source that is a key has `source_name` and `source_guest`, as in the Activity list. |
| `PUT /api/v1/policy` | write | `{source, op, entity_type, tier, mode}`. Add or change one rule. |
| `DELETE /api/v1/policy/:id` | write | Remove one rule. |
| `POST /api/v1/import` | write | A one-time import of records. Each record becomes a proposal. See "Import". |
| `GET /api/v1/calendars` | write | The calendars: area, tier, approval, event count, and the last read. Never the address. |
| `POST /api/v1/calendars` | write | Add a calendar: `{title, url, area_id, event_tier, approval, free_busy}`. |
| `POST /api/v1/calendars/:id` | write | Change one calendar. A field that is not in the body stays. |
| `POST /api/v1/calendars/sync` | write | Read each calendar now. |
| `GET /api/v1/free-busy?from=&to=` | write, agent with the permission | The times in which the owner is busy. See "Busy times". |
| `GET /api/v1/screens` | read, write, agent | The deck. |
| `GET /api/v1/screens/today` | read, write, agent | Today as JSON. |
| `GET /api/v1/screens/:id` | read, write, agent | `ready: false` for screens not yet rendered. |
| `GET /api/display` | read, write, agent | TRMNL-style JSON. `image_url`, `filename`, `refresh_rate`, `reset_firmware`, `screen`. A request that sends the device `ID` header is answered in the BYOS shape from [TRMNL.md](TRMNL.md), still at Public. |
| `GET /api/setup` | none | TRMNL setup. Trades a MAC address for a device key after the owner claims it. No graph data. |
| `POST /api/log` | the device key | Firmware log lines. Secrets in the text are redacted. |
| `GET /api/v1/workers` | write | The workers, their ceilings, and whether cloud is on. |
| `GET /api/v1/workers.html` | write | Settings screen: tier, model, schedule, last run, pause. |
| `POST /api/v1/workers/:id` | write | Change tier, schedule, or model. Sealed is refused. Cloud requires the warning to be accepted. |
| `POST /api/v1/workers/:id/run` | write | Run one worker now. It files proposals. It does not approve them. |
| `POST /api/v1/workers/run-due` | write | Run the workers whose schedule is due. |
| `GET /api/v1/trmnl/devices` | write | Paired and pending displays. No secrets. |
| `POST /api/v1/trmnl/devices` | write, localhost | Pair a display by MAC. The key is returned once. |
| `POST /api/v1/trmnl/devices/:id/claim` | write, localhost | Claim a display that has already called setup. |
| `POST /api/v1/trmnl/devices/:id/revoke` | write | Revoke that display's key. |
| `GET /api/display/today.html` | read, write, agent | Phone-faithful HTML. |
| `GET /api/display/today.png` | read, write, agent | Display PNG of the same Today content. |
| `POST /mcp` | read, write, agent | MCP JSON-RPC. Changing tools propose. |

Errors are `{ "error": { "code": "...", "message": "..." } }` with `401`, `403`, `404`, `409`, or `422`.

List responses are `{ "entities": [ ... ] }`. There is no pagination in v1. The cap is 200 rows.

## MCP

The MCP server speaks JSON-RPC on `POST /mcp`. `bun src/stdio.ts` is the stdio transport for a local client: one JSON message on each line. It is a pipe to `POST /mcp` on the running server, and it does not open the data directory. It takes the agent key from `HMN_API_KEY`, from `--key-file`, or from the Keychain item `hmn.agent`, and the CA certificate from `--ca`. The guide is [CONNECT-AN-AGENT.md](CONNECT-AN-AGENT.md).

The answer to `initialize` has the protocol version that the client asked for, when it is `2024-11-05`, `2025-03-26`, or `2025-06-18`, and the server's instructions, which are under 2,000 characters. Each tool has the annotations `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`.

Tools:

| Tool | Effect |
| --- | --- |
| `search` | Ranked search, scoped. One matching word is sufficient, so a question in plain words works. |
| `get_entity` | One entity, if in scope. |
| `list_entities` | One type, if in scope. |
| `list_links` | Links for one entity, scoped. |
| `neighbours` | The entities around one entity, to a depth of 1 to 3 links, scoped at both ends of each link. |
| `propose_create` | Insert a create proposal. |
| `propose_update` | Insert an update proposal. |
| `propose_delete` | Insert a delete proposal. |
| `propose_link` | Insert a link proposal. |
| `list_proposals` | Read proposals. |
| `proposal_status` | The state of one proposal, and the id of the entity after an approval. The key that filed a proposal can always read its state. |
| `free_busy` | The times in which the owner is busy between two dates. Only for a key that the owner allows. |
| `capture_inbox` | Put raw text in the inbox. |
| `describe_schema` | The statuses, the kinds with their titles, the relations, and the typed fields of each type and kind. No counts and no rows. |
| `request_feature` | Tell the owner what the agent needed and did not have: a tool, a field, a type, a kind, or access. It grants nothing. The same need again adds one to its count. |
| `my_requests` | The requests of this key, and what the owner did with them. |

Each `propose_*` tool takes an optional `idempotency_key`. The same key from the same source returns the first proposal, with `replayed: true`, and stores nothing.

There is no `create_entity` tool. A model with a write key that wants to save directly uses HTTP, which is the owner's path. The agent's path always proposes.

Tool calls are checked against the key. A denied area fails the tool with a not-found style message, not the entity body.

A view key gets only the tools that read. The four `propose_*` tools, `capture_inbox`, and `request_feature` are not in its list, and a call to one of them is refused.

## The read format

This is part 3 of the read contract in [STRATEGY.md](STRATEGY.md). It is the format of one entity and of one screen, as a reader gets them. A view and an agent can rely on the fields in these tables.

- The test `server/test/read-format.test.ts` reads these tables and compares them with real answers, for the owner, an agent key, and a view key. A change to a field must change the table and pass that test.
- A reader ignores a field that it does not know. A later version can add a field.
- "Optional" means that the field can be absent. Each other field is in each answer.
- The stability rule of the read contract is not decided yet. Until then, these tables and the test are the format.

### One entity

`GET /api/v1/:type/:id` and the MCP tool `get_entity` give one entity. `GET /api/v1/:type` and `list_entities` give `{ "entities": [ ... ] }` with at most 200 of them. REST and MCP give the same fields for the same key.

<!-- format:entity -->
| Field | Type | Meaning |
| --- | --- | --- |
| `id` | text | The id of the entity. It does not change. |
| `type` | text | One of the types in "Types". |
| `title` | text | The title, as plain text. It is never ciphertext. |
| `body` | text or null | The text of the entity. |
| `status` | text or null | A status from "Types", for a type that has one. |
| `kind` | text or null | A kind from "Types", for a type that has one. |
| `due_at` | text or null | A date as `YYYY-MM-DD`, or an instant in ISO 8601. For an event it is the start. |
| `area_id` | text or null | The id of the area. The area itself can be above the ceiling of the reader, and then a request for it answers `404`. |
| `properties` | object | Only the properties that the ceiling of the reader covers. `_privacy` is not here. A fixture has no result in it. |
| `tier` | text | The effective tier: `public`, `household`, `personal`, `private`, or `sealed`. |
| `tier_source` | text | Where the tier comes from: `override`, `area`, or `default`. |
| `origin` | text | Who made the entity. See "Provenance". |
| `origin_ref` | text or null | The name of the agent, the plugin, or the import. |
| `source_id` | text or null | The id of a `source` entity. |
| `external_id` | text or null | The id of the record in another system. |
| `confirmed_at` | text or null | The instant of the approval, for an entity that came from a proposal. |
| `created_at` | text | An instant in ISO 8601. |
| `updated_at` | text | An instant in ISO 8601. |
| `deleted_at` | null | Always null. A removed entity is absent. |
<!-- /format:entity -->

### One screen

`GET /api/v1/screens/:id` gives one screen. The ids are `today`, `upcoming`, `commitments`, `quiet`, `week`, `inbox`, `agents`, and `home`. `home` is the Home of member mode: it greets the member, and its sections are `mine` (For you), `today`, `soon` (Coming up), and `watch`. Each one has this format. A screen has only the rows that the ceiling of the reader covers, and its counts are counts of those rows.

A text field of a screen is for a person to read. A view shows it as it is, and it does not take a date or a number out of it.

<!-- format:screen -->
| Field | Type | Meaning |
| --- | --- | --- |
| `id` | text | The id of the screen. |
| `ready` | true or false | True for a screen that the server can make. |
| `index` | number | The position in the deck, from 1. |
| `count` | number | The number of screens in the deck. |
| `label` | text | The short name of the screen. |
| `closing` | text or null | A last line for the screen, when it has one. |
| `in_deck` | true or false | True for a screen that the shared display shows in turn. |
| `generated_at` | text | The instant at which the server made the screen. |
| `timezone` | text | The time zone of the owner, as an IANA name. |
| `date_label` | text | The date, for a person to read. |
| `clock_label` | text | The time, for a person to read. |
| `greeting` | text | The first line. It has the name of the owner only when the ceiling covers that person. |
| `summary` | text | One sentence about the rows on the screen. |
| `updated_label` | text | The time of this answer, for a person to read. |
| `next_label` | text | The time of the next change, for a person to read. |
| `refresh_seconds` | number | How long a view waits before it reads again. |
| `surface` | text | The surface that the server used for this answer. |
| `ceiling` | text | The ceiling that the server used for this answer. |
| `due_count` | number | The number of rows that are due. |
| `next` | object or null | The next thing, or null. See the next table. |
| `sections` | list | The sections, in the order to show them. A section with no row is not in the list. |
<!-- /format:screen -->

The field `next`, when it is not null:

<!-- format:next -->
| Field | Type | Meaning |
| --- | --- | --- |
| `title` | text | The title of the next thing. |
| `subtitle` | text | A line about it, for a person to read. |
<!-- /format:next -->

One section:

<!-- format:section -->
| Field | Type | Meaning |
| --- | --- | --- |
| `id` | text | The id of the section. Today has `due`, `family`, `calendar`, `watch`, `routines`, and `quiet`. |
| `label` | text | The heading, for a person to read. |
| `trailing` | text, optional | A short text at the right of the heading, such as a count. |
| `accent` | text, optional | `teal` for a section that the app shows in teal. |
| `items` | list | The rows of the section. |
<!-- /format:section -->

One row of a section:

<!-- format:item -->
| Field | Type | Meaning |
| --- | --- | --- |
| `id` | text | The id of the entity. On `inbox` it is the id of an inbox item, and on `agents` it is the id of a proposal. |
| `title` | text | The title of the row. |
| `subtitle` | text | A line about the row, for a person to read. |
| `glyph` | text | The mark of the row: `checkbox`, `date`, `flag`, or `dashed`. |
| `done` | true or false | True for a row that is done. |
| `badge` | text, optional | A short mark, such as the badge of a fixture. |
| `date_mark` | text, optional | The day of the month, for a row with the glyph `date`. |
| `accent` | text, optional | `teal` for a row that the app shows in teal. |
| `type` | text, optional | The type of the row's entity, such as `task` or `event`, so that a tap can open it. Absent when the row is not an entity, such as a month of the yearly review. |
<!-- /format:item -->

## Workers

A worker is a scheduled job inside HMN. An agent is an outside client that uses an agent key or MCP. Both only propose.

Six workers run on the mini. Morning composes Today's focus line and the first three visible items. Week drafts the weekly review. Triage turns a captured note into a proposed task, person, or link. People proposes a gentle reminder for a birthday, an anniversary, or a long gap since `properties.last_contact`. Fixtures drafts a "What to watch" note from upcoming fixture events. Goals proposes one next step for an active goal that has no active project and no open task.

Each one reads through the policy layer. The ceiling is never Sealed, and Health and Money stay denied. Morning, Week, Triage, Fixtures, and Goals stop at Personal. People may be set to Private so family records can be read; a proposal that touches a family record stays Private and does not appear on the display. Fixtures copy a title, a badge, and a start time. A title or badge that already looks like a score or a result is left off the list. Spoiler property values are not read.

A run files proposals. It does not call approve, reject, or the entity write path. `GET /api/v1/workers.html` is the settings screen: tier, model, schedule, last run, a pause button, and the latest journal lines the caller is allowed to see. `GET /api/v1/workers/:id/journal` is the full journal. A proposal's `read_set.journal_id` points at the entry. A journal line whose tier is above the caller is omitted. The entry can say that some of it is above the ceiling, without a count.

`GET /api/v1/access` is Connected agents and apps: paired devices, MCP keys, TRMNL displays, and plugins. Each row has the tier cap, scopes, last access, and recent reads taken from the audit log and the journal. A title is included only when the caller can already see that entity. `POST /api/v1/access/:id/revoke` revokes the credential immediately.

### Approval policy

The server finds the class of each proposal: the source, the operation, the entity type, and the tier. It then reads the rules.

| Mode | Result |
| --- | --- |
| `review` | The proposal waits for the owner. This is the default. |
| `auto` | The server applies the proposal at once, through the same write path as an approval. `decided_by` is `policy`, and the audit log records `auto_approve`. |
| `deny` | The server refuses the proposal with `policy_deny`. No row is stored. A worker or a plugin tick continues with its other drafts. |

These always wait for the owner, and no rule changes that:

- A delete.
- A patch that sets `tier` or `area_id`, and any patch to an area, because that can lower a tier.
- A Sealed proposal.
- A proposal from a source that is not a worker or a plugin. An outside client has no grant yet.

The server also refuses an `auto` rule that names no worker or plugin, that names `delete`, or that names the Sealed tier. If the write path refuses an auto-accepted proposal, the proposal stays pending.

An applied proposal can be undone, also one that the owner approved. Undo does not remove history. A removed item gets a tombstone version, and a reverted update gets a new version with `origin_ref` `undo`. Undo of an update is refused when the item changed after the approval. Undo of a removal brings the item back as a new version, and the tombstone stays in the history. It is refused after a purge, because the row is gone, and for a removal that was approved before 2026-11-19, because that record does not name the earlier version. `can_undo` in the Activity list is false for those.

A worker remembers a decision. Each draft has a source key, and the server keeps the key on the proposal with the worker's principal id. Before a worker files a draft, it reads the earlier proposals with that key:

| Earlier proposal with the same key | Result |
| --- | --- |
| `pending`, `rejected`, `expired`, or `undone` | The draft is not filed. |
| `approved` | The draft is not filed. The exceptions are Goals, Morning, Week, and Fixtures, which can file again. |

| Worker | Source key | Last day |
| --- | --- | --- |
| People, birthday or anniversary | The person, the kind, and the date of this occurrence | That date |
| People, quiet contact | The person and the `last_contact` date | None |
| Triage | The note or task, the operation, and the link target | None |
| Goals | The goal | None |
| Morning | `morning` and the day | That day |
| Week | `weekly` and the day | Six days later |
| Fixtures | `watch` and the day | Six days later |

A decline has no end date for a key. A birthday next year has a new key, and a new `last_contact` date has a new key. Morning, Week, and Fixtures also file nothing while an earlier note of the same worker is pending.

A pending proposal with a last day leaves the queue on the day after. Its status becomes `expired`, `decided_by` is `system`, and the audit log records `expire`. The graph does not change. The check runs once a minute with the worker loop, and at the start of each run.

Outside MCP clients are described in [EXTERNAL-AGENTS.md](EXTERNAL-AGENTS.md). They are not on port 8787.

Source text is placed in a data block and is not instructions. A model reply is kept only when it names ids the deterministic pass already chose. Anything else is discarded and the deterministic draft is filed instead. With no model configured, the deterministic draft is the whole run, and the process does not open a socket.

Schedules are `hourly`, `daily:HH:MM`, `weekly:D:HH:MM` (Sunday is 0), and `monthly:D:HH:MM` (the day is 1–28).

The model is local by choice: Ollama at `http://127.0.0.1:11434/api/chat`, or an OpenAI-compatible server on localhost. Set `HMN_LLM_URL` to that URL, or set the worker's `llm_mode` to `local`. Cloud is off until that worker is switched on, with an HTTPS endpoint, a tier, and the warning accepted. Cloud still stops at Personal, even for People. The cloud key is `HMN_LLM_CLOUD_KEY` or the Keychain item `hmn.llm.cloud`.

## How plugins map

Plugins are code in the server, not files the owner drops in. Each one declares a maximum tier and `propose` as its only permission. A manifest that asks to write is rejected. A tick submits proposals. It never calls the write API.

`POST /api/v1/plugins/:id/tick` is localhost only, and it needs a write key. The body can carry fixture data. That is how the tests run. On the mini, a tick with an empty body uses a configured token if there is one.

The calendar password is read from the login Keychain first (`hmn.caldav.password`) and otherwise from `HMN_CALDAV_PASSWORD`. There is no default. The status endpoint says whether a token is configured. It does not return the token.

`GET /api/v1/plugins` lists calendar, sport, google, and health. `installed` means a source row of that kind exists. Health has no tick yet.

**Import.** A one-time move from another system, for example the Notion Life Ontology. It is not a sync, and HMN holds no token for the other system. `POST /api/v1/import` takes records, and each record becomes a `create` proposal from the source `import:<name>`. A person, or an agent that can read the other system, makes the list of records.

```json
{
  "source": "notion",
  "title": "Notion Life Ontology",
  "dry_run": false,
  "records": [
    { "external_id": "<Notion page id>", "type": "area", "title": "Garden", "kind": "home" },
    { "external_id": "<Notion page id>", "type": "task", "title": "Order the seeds", "due_at": "2026-11-20",
      "area": "Garden", "links": [{ "rel": "about", "to": "<Notion page id of a project>" }] }
  ]
}
```

| Field | Notes |
| --- | --- |
| `external_id` | Required. The id in the other system. It is stored on the entity, with the source entity of the import. |
| `type`, `title` | Required. Any entity type except `source`. |
| `body`, `status`, `kind`, `due_at`, `tier`, `properties` | Optional. A status has a default for each type: a task is `open`, a goal is `active`. |
| `area` | The id or the title of an area, or the `external_id` of an area record in the import. |
| `links` | `{rel, to}`. `to` is the `external_id` of another record, or the id of an entity. |

The reply has one result for each record:

| Result | Meaning |
| --- | --- |
| `proposed` | A proposal now waits for review. |
| `waiting` | The area or a linked record is in this import and is not approved yet. The tier of a record depends on its area and its links, so the server does not propose it before they exist. Approve, then run the same import again. |
| `exists`, `pending` | The record is in the graph, or its proposal waits. No second copy is made. |
| `declined`, `removed` | The owner declined the proposal, or removed the entity, in the last 90 days. The record does not come back in that time. |
| `invalid` | The record has an error. The reply names it. The other records continue. |

An import runs in passes: areas and people first, then goals and projects, then tasks and notes. Each pass ends with a batch decision: `GET /api/v1/proposals?status=pending&source=import:notion`, then `POST /api/v1/proposals/batch`. An import is never auto-accepted, because only a worker or a plugin can be. `dry_run` reports the plan and writes nothing.

**Health.** A source of kind `health`, `area_id` Health, child tier Sealed. Samples and notes stay sealed. The default agent key cannot read them, and a health proposal is itself Sealed, so it appears on the Agents screen only inside the vault. The plugin does not interpret readings and does not propose medical advice. Source text is stored as data. It is never treated as instructions to the model or the server.

**Sport and motorsport.** One source of kind `sport`. It proposes `event` rows of kind `fixture` with a future `due_at`, a title, an optional `badge` (the series), `properties.category` of `sport` or `motorsport`, and `no_results: true`. It strips score, result, winner, standing, and points before submit. The server rejects the proposal at approval time if a stripped field was put back. Past fixtures are not imported. Several teams are a list on the source (`properties.teams`), not several apps.

**Calendar.** A calendar is the source of truth for its events. HMN mirrors it and does not write back. Each calendar is one `source` entity of kind `calendar`. `POST /api/v1/calendars` adds one.

| Setting | Where | Notes |
| --- | --- | --- |
| Address | `properties.url`, sealed | The ICS address, `https://` or `webcal://`. It is a secret. No response returns it. `HMN_CALDAV_URL` with a username and a password still works for one calendar. |
| Area | `area_id` of the source | The area of each mirrored event. The tier comes from the area. |
| Tier | `properties.event_tier` | A tier for the events of this calendar. It is never below the tier of the area. |
| Approval | `properties.approval` | `auto` by default. `review` makes this one calendar wait for the owner. |

The server reads each calendar that has an address every 15 minutes, with the worker loop. `POST /api/v1/calendars/sync` reads them now. The reply must be a calendar document. A sign-in page, an error status, or an empty reply stops that read, and no event changes.

The plugin child parses the document and compares it with the mirror of that calendar:

| The calendar | The mirror |
| --- | --- |
| Has a new event | A `create` proposal. |
| Changed the title, the time, or the text | An `update` proposal with only the changed fields. The row and its id stay. |
| No longer has an event that is today or later | An `update` proposal to `status: cancelled`. The row and its history stay. It is not a delete. |
| No longer has an event in the past | No change. A past event is a record. |
| Has the event again | An `update` proposal back to `upcoming`. |

The proposals have the source `plugin:calendar`. With no rule from the owner, `create` and `update` of an `event` from that source are `auto`. A rule from the owner comes first, so `PUT /api/v1/policy` with `{source: "plugin:calendar", mode: "review"}` makes every calendar wait.

What the parser reads: a time with `TZID`, a UTC time, and a time with no zone, which is read in the owner's zone. An all-day value stays a date. A repeating event becomes one row for each date, with `external_id` `<UID>#<YYYYMMDD>`. It reads `FREQ` (daily, weekly, monthly, yearly), `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY` for a week, `BYDAY` or `BYMONTHDAY` for a month, `EXDATE`, and a changed occurrence (`RECURRENCE-ID`). For a month, `BYDAY` can be a list, each weekday with or without a number, and `BYSETPOS` selects from the dates of the month. So "the last weekday" and "the first and the third Monday" are read. A rule with another part, such as `BYWEEKNO`, gives one row, for the first date. Events from 30 days back are mirrored, and a repeating event is expanded 90 days ahead. A cancelled event is not mirrored.

A mirrored event has `properties.mirror: true`. The entity routes refuse a change to it with `mirrored`, also from an agent's proposal. The exception is a patch that sets only `tier`. If the calendar source is removed, its events can be edited again.

**Busy times.** The parser also reads the end of an event (`DTEND`, or `DURATION`) and whether the event blocks time (`TRANSP`). A mirrored event has `properties.end_at` and `properties.busy`. For an event with a time, `end_at` is an instant. For a day with no time, `end_at` is the next day, which is not in the event. An event with a time is busy unless the calendar says `TRANSPARENT`. A day with no time is free unless the calendar says `OPAQUE`. An event with no length is not a busy time.

`free_busy` takes `from` and `to`. Each one is a date, which is a day in the owner's zone, or an instant. The range is at most 60 days. The answer is `{from, to, time_zone, busy: [{start, end}]}`. The server makes it at read time from the mirrored events that are busy and not cancelled, in the calendars that have `properties.free_busy: true`. It joins intervals that overlap or touch, and it cuts them at the ends of the range. The answer has no title, no id, no area, and no count of events.

The tier of an event does not change the answer. The owner chose to give this one fact about the calendar, so a calendar of Private events gives its busy times to a key at Personal or at Public. The key still cannot read the events. Two switches must be on: `free_busy` on the calendar (`POST /api/v1/calendars/:id`) and `free_busy` on the key (`POST /api/v1/keys/:id`). Both are off at the start. Without the permission the call is refused with `no_free_busy`, and the tool is not in the tool list of that key. Each call is a row in `client_reads` with the action `free_busy`.

Google Calendar is a separate plugin id, `google`, with OAuth scope `https://www.googleapis.com/auth/calendar.readonly`. It does not mirror. The refresh token is encrypted with the sealed key. Google also gives each calendar a secret ICS address, and that address works with the calendar mirror. An event is `family` only when every attendee already matches a spouse, child, or family person. Other names stay in `properties.unmatched` and do not become people. Family events land in `area_family` and inherit Private. The mapping runs in the plugin sandbox. The parent process does the network read, then hands the plugin the calendar text and the people's names.

## Demonstration records

Zone used when reading these instants on a screen: `Australia/Perth`. "Today" in the seed is 11 November 2026. The quiet task was last updated on 21 October 2026, which is 21 calendar days earlier. All of these rows use `origin: seed`, `origin_ref: seed`, `source_id: source_demo`.

### Areas

| id | title | kind | child_tier |
| --- | --- | --- | --- |
| area_work | Work | work | personal |
| area_side | Side project | side_project | personal |
| area_family | Family | family | private |
| area_health | Health | health | sealed |
| area_cars | Cars | cars | personal |
| area_sport | Sport | sport | public |
| area_home | Home | home | personal |
| area_money | Money | money | sealed |

The side project area has no product name on purpose.

### People

| id | title | kind |
| --- | --- | --- |
| person_alex | Alex | self |
| person_sam | Sam | spouse |
| person_yves | Yves | child |
| person_luca | Luca | child |

### Goals

| id | title | status | area | horizon |
| --- | --- | --- | --- | --- |
| goal_quiet | A quieter year | active | — | year |
| goal_family | Show up at the things that matter | active | area_family | year |

### Projects

| id | title | status | area | serves |
| --- | --- | --- | --- | --- |
| project_brief | Weekly brief | active | area_work | goal_quiet |
| project_side | Side project | active | area_side | — |
| project_trip | Dec trip | active | area_home | — |

`project_side` has the body "A placeholder for the one side project. No product name is stored here."

### Places and assets

| id | type | title | kind | properties |
| --- | --- | --- | --- | --- |
| place_school | place | School | school | |
| place_garage | place | Garage | garage | |
| asset_coupe | asset | Coupe | car | `{ "model": "1998" }` |

Link: `person_alex` `cares_for` `asset_coupe`.

### Tasks

| id | title | status | due | area | links | notes |
| --- | --- | --- | --- | --- | --- | --- |
| task_notes | Send weekly notes | open | `2026-11-11T09:00:00.000Z` (17:00 AWST) | area_work | part_of project_brief | |
| task_dentist | Book Luca's dentist | open | `2026-11-11` | area_family | about person_luca | |
| task_garage | Reply to garage about the coupe service | open | `2026-11-11` | area_cars | about asset_coupe | |
| task_srs | Coupe SRS light | open | — | area_cars | about asset_coupe | `updated_at` `2026-10-21T04:39:00.000Z` |

### Events

| id | title | kind | due | area | properties | links |
| --- | --- | --- | --- | --- | --- | --- |
| event_concert | school concert | family | `2026-11-13T08:30:00.000Z` (Fri 16:30 AWST) | area_family | `short_title`: Yves' concert | with person_yves, at place_school |
| event_race | Lakeside Grand Prix | fixture | `2026-11-22T06:00:00.000Z` (Sun 14:00 AWST) | area_sport | `badge` GT, `tz_label` AWST, `no_results` true | |

### Note and source

| id | title | body | links |
| --- | --- | --- | --- |
| note_trip | Dec trip | Yves' passport expires 02/2027. Example note, not a real document. | about person_yves, about project_trip |
| note_health | Example clinic note | Fictional reminder to book a checkup. Not a real record. | area_health |
| source_demo | Demonstration seed | Fictional data for the interface. | kind manual |

`note_trip` is area `area_home` with an explicit tier `sealed`. Home would have made it Personal. A passport note is an identity document, so the override is stricter than the area. `note_health` inherits Sealed from Health. Both titles and bodies are field-encrypted. They do not appear as plaintext in the SQLite file or in the encrypted blob.

### Pending proposal

| Field | Value |
| --- | --- |
| id | proposal_01 |
| agent_name | Trip helper |
| op | create |
| reason | Passport in note "Dec trip" expires 02/2027. |
| created_at | `2026-11-11T04:36:00.000Z` (12:36 AWST) |
| tier | sealed, because it is derived from `note_trip` and names a child |
| read_set.summary | People, Tasks, one note |
| read_set.denied | Health, Money |

The payload creates a task "Renew Yves' passport", status open, due `2026-11-30`, area `area_home`, about `person_yves` and about `note_trip`. Payload and reason are field-encrypted. The phone below the vault sees the fixed sealed line and not this text. The vault sees the Agents mock.

### Keys

Three keys, generated on first boot and printed once. They are not written into a plaintext env file. Hashes live in the encrypted database. The cleartext is shown on the terminal and then only the hash remains. See the credentials table for tiers.

The agent key is the one MCP uses. The display key is the one the e-ink device uses. The phone should pair, rather than reuse the owner key, so that vault grants and revocation are per device. The owner key is for the terminal on the mini.

## Time

The server zone is `HMN_TZ`. With no value it is the zone of the machine, and the install writes the zone of the Mac into the launchd job. A container has no zone of its own, so the compose file uses UTC unless `HMN_TZ` is set. Tests use `Australia/Perth` and set `HMN_NOW` to `2026-11-11T04:39:00.000Z`, which is 12:39 in that zone, a Wednesday, and the afternoon greeting. Quiet age is the difference in calendar dates in that zone, not a raw 24-hour divide.

## Archive, note kinds, fields, and links

Added on 2026-11-27, in the pass of [UX-PASS.md](UX-PASS.md), batch 2.

- **Archive.** `archived` is a status of a note, a goal, a project, a person, a place, an asset, and an area. An archived row leaves `GET /api/v1/<type>` (unless `?archived=1`), search, People, and the screens. It stays readable by its id, and its links stay. A row with no status is the first status of its type.
- **Lists.** `GET /api/v1/<type>` puts open rows first, then by date (a time on a day before "that day"), then the newest. The cut at 200 comes after that order.
- **Note kinds.** A note has a kind: `note`, `reference`, `decision`, `fact`, `reading` (role `reading`), `review` (role `review`, the owner's note for a year), and `capture` (filed from the inbox). At the first start of this version, a note with `properties.reading` gets the kind `reading`, one with `properties.year_review` gets `review`, and one with `properties.from_inbox` gets `capture`. A Sealed note keeps no kind until the owner edits it.
- **Fields.** `PATCH /api/v1/<type>/<id>` takes `properties_patch`: the keys it names change, a key set to null is removed, and every other key stays. The fields that a client shows are in `GET /api/v1/schema`.
- **Links.** A link's relation is one of `part_of`, `for`, `with`, `about`, `at`, `in`, `from`, `cares_for`, `serves`, `related` (422 `bad_rel` for another). A row cannot link to itself (422 `self_link`). A second request for the same live link returns the first one, and an approved link proposal for a link that is there already makes no copy.
- **Dates.** `due_at` is a date (YYYY-MM-DD) or a full instant. Another value is refused with 422 `bad_date`. An empty string for `due_at`, `status`, `kind`, or `area_id` is no value.
- **Areas.** An area that still has items cannot be removed (409 `area_in_use`), because its items take their tier from it.
- **Inbox.** `POST /api/v1/inbox/<id>/process` with `{ "action": "accept", "route": "task" | "note" | "person" }` makes that item in one step, with no tag. `{ "action": "file", "entity_id": … }` makes a note of the kind `capture` with the text, at the stricter tier of the capture and the record, linked `about` the record.

## Typed fields

Added on 2026-11-27.

A type has a few fields of its own: a person's birthday, an asset's make and model. A kind adds more: a car's registration and insurance, a document's number, holder, and expiry. The values are in `properties`, under the field's key. `GET /api/v1/schema` gives `fields` (each type) and `kind_fields` (each kind that the graph has). A client shows one form: the type's fields, then the kind's. A change of kind keeps every value: the form only shows other fields.

| Field type | A value |
| --- | --- |
| `text` | Text, at most 500 characters. |
| `long` | Text, at most 20,000 characters. |
| `date` | A day, `2026-12-01`. |
| `yearly` | A day that comes back each year, such as a birthday: `1990-04-02`, or `04-02` when the year is not known. |
| `expiry` | A day on which something ends: a passport, an insurance. A client says "Ends in 12 days". |
| `number` | A number. A number in text is stored as a number. |
| `url` | A link that starts with `http://` or `https://`. |
| `choice` | One of the field's `choices`. |
| `person` | The id of a person that the writer can see. |
| `thing` | The id of an asset that the writer can see. |

The server checks each value that a write changes, on every path: the owner's write, a member's write, and an approved proposal. A bad value is `422 bad_field` with the field's name and an example. An empty string removes the value. A value that the write does not change is not checked again, so a value from before the checks never blocks a save. A key that has no field is kept as it is.

A new graph has default fields for the kinds `document` (a new asset kind), `car`, `organisation`, `decision`, `fact`, `school`, and `garage`. They are in `server/src/kinds.ts`. The owner changes the list of a kind in Settings > Areas and kinds > Fields, or with `PUT /api/v1/kinds/:type/:kind/fields`. The table `kind_fields` holds one list for each kind.

## Requests from agents

Added on 2026-11-27.

An agent that needs a tool, a field, a type, a kind, or access that it does not have says so with the MCP tool `request_feature`, or `POST /api/v1/agent-requests`. A request changes nothing and grants nothing. The owner reads the requests in Review > Requests, and marks each one done or dismissed. More access is a change in Agents and apps, made by the owner.

The text is the agent's. A screen shows it as data and never acts on it. No other agent reads it. One key can open at most 10 new requests a day, and the same open need from the same key only adds one to its count. The table `agent_requests` holds them, with the key, the agent's name, the need, why, an example, the state, and the count.
