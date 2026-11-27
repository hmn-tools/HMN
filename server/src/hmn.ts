import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aesDecrypt, aesEncrypt, decryptBackup, encryptBackup, isSealed, openString, randomCode, randomId, randomSecret, sealString, sha256hex } from "./crypto";
import { modelsHtml, type ModelPage } from "./models/html";
import { ensureModelSchema, monthSpend, readCap, readNotice, setCap } from "./models/store";
import { assignRoute, indexEntities, modelSnapshot, pinVersion, pullModel, removeModel, semanticRank, voiceNote, warmModel, type ModelFetch } from "./models/client";
import { MODEL_TASKS } from "./models/policy";
import {
  agentTierFloor,
  areaDenied,
  asObject,
  assertCanSeeTier,
  assertNoSpoilers,
  assertNotHidden,
  assertScope,
  assertShape,
  childTierOf,
  makeAccess,
  ownTier,
  principalFromRow,
  projectEntity,
  projectLinks,
  projectProposal,
  requireVaultFor,
  rowCeiling,
  STATUS,
  type AreaInfo,
  type EntityView,
  type ProposalSummary,
  type ProposalView,
} from "./policy";
import { calendarUrlAllowed, fetchIcs, isCalendar, startOfDay } from "./plugins/calendar";
import { exchangeGoogleCode, googleAuthURL, GOOGLE_SCOPE, listGoogleEvents, refreshGoogleAccess } from "./plugins/google";
import { runPlugin } from "./plugins/sandbox";
import { clampTier, mentionsTitle, parseCapture, slug, suggestRoute, titleFromBody, type InboxSuggestion } from "./inbox";
import { versionHash, type VersionRow } from "./history";
import { DEMO_KINDS, KIND_TYPES, Kinds, MEMBER_ROLES, PARTNER_ROLE, ROLES, ensureKindTables, roleSets, seedKinds, titleOf } from "./kinds";
import { ANY, APPROVAL_MODES, autoBlocked, DEFAULT_RULES, ensureApprovalTables, isMemberSource, modeFor, POLICY_OPS, sourceCanAuto, sourceOf, type ApprovalMode, type PolicyRule, type ProposalClass } from "./approval";
import { syncMirror } from "./mirror";
import { ensureJournals } from "./journal";
import { ensureDeviceTables } from "./devices/tables";
import { ensureExternalTables } from "./external/tables";
import { readPluginSecret, secretConfigured } from "./plugins/secrets";
import { readableDue, zoned } from "./time";
import { ensureRequestTables, fileRequest, listRequests, requestsOfKey, setRequestStatus } from "./requests";
import { BASE_FIELDS, cleanSpecs, cleanValues, FIELD_TYPES, fieldsFor, kindFieldList, type FieldSpec } from "./fields";
import { buildFridge, fridgeWindow, secondsToNextWindow, type FridgeScreen, type FridgeScreenId } from "./fridge";
import {
  buildAgents,
  buildCommitments,
  buildHome,
  buildInboxQueue,
  buildQuiet,
  buildToday,
  buildUpcoming,
  buildWeek,
  browseItems,
  DECK,
  nextDeckIndex,
  renewalsIn,
  RENEWAL_PAST_DAYS,
  type SourcedLink,
  type TodayScreen,
} from "./screens";
import { buildPersonPage, type PersonPage } from "./people";
import { buildYear, yearOf } from "./year";
import { cadenceLabel, dueOn, routineDays } from "./routines";
import { seedDatabase, type SeedSecrets } from "./seed";
import type { Store } from "./store";
import { anchorAuditTip, forgetAgentKey, forgetViewKey, rememberAgentKey, rememberViewKey } from "./store";
import {
  type Access,
  type CredentialRow,
  type EntityRow,
  type EntityType,
  type LinkRow,
  type Listener,
  type Principal,
  type ProposalRow,
  type Surface,
  type Tier,
  ApiError,
  ENTITY_TYPES,
  VERSION,
  covers,
  stricter,
  isTier,
} from "./types";

const AUDIT_GENESIS = "0".repeat(64);

type InboxRow = {
  id: string;
  body: string | null;
  url: string | null;
  tags: string;
  tier: string;
  source: string;
  status: string;
  content_sealed: number;
  attachments: string;
  result_type: string | null;
  result_id: string | null;
  origin: string;
  origin_ref: string | null;
  captured_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type InboxView = {
  id: string;
  body: string;
  url: string | null;
  tags: string[];
  tier: Tier;
  source: string;
  status: string;
  attachments: unknown;
  suggestion: InboxSuggestion | null;
  result_type: string | null;
  result_id: string | null;
  origin: string;
  origin_ref: string | null;
  captured_at: string;
};

export class Hmn {
  secrets: SeedSecrets | null = null;
  private mirrorDir: string | null = null;
  /** The member whose proposal is being applied, so a completed task records the member's name. */
  private actingMember: { id: string; name: string } | null = null;
  /**
   * The member pairing code that the fridge shows, in memory only. The database keeps only the hash of a code, and
   * the fridge must draw the code itself. A restart drops it. The code dies when it is used, ended, or old.
   */
  private fridgePairing: { code: string; codeHash: string; fingerprint: string; origin: string | null; name: string | null; expiresAt: string; createdBy: string } | null = null;
  /** The newest audit hash that the Keychain does not hold yet. */
  private pendingTip: string | null = null;
  /** The connection that holds the in-memory search index, and the state of the entities it was built from. */
  private searchDb: unknown = null;
  private searchStamp: string | null = null;
  /** The last read of each calendar. It is kept in memory, so a restart reads each calendar again. */
  private calendarSync = new Map<string, { at: string; ok: boolean; changes: number; error: string | null }>();

  constructor(
    readonly store: Store,
    private now: () => Date,
    private timeZone: string,
  ) {
    ensureModelSchema(store.db);
    ensureKindTables(store.db);
    ensureRequestTables(store.db);
    // Copy the audit tip to the Keychain with each save. The saved file and the copy then describe the same chain.
    const persist = store.persist.bind(store);
    store.persist = (force = false) => {
      persist(force);
      if (this.pendingTip) {
        anchorAuditTip(this.pendingTip);
        this.pendingTip = null;
      }
    };
  }

  /** Save now, also with no change. For a start and a restore. */
  checkpoint() {
    this.store.persist(true);
  }

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSaveAt = 0;

  /**
   * The save after a request. A request that changed nothing saves nothing. A change is saved at once, or at
   * most one second after the last save, so a stream of requests does not write the whole graph for each one.
   */
  saveSoon() {
    if (!this.store.dirty()) return;
    const wait = this.lastSaveAt + SAVE_GAP_MS - Date.now();
    if (wait <= 0) {
      this.saveNow();
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this.saveNow();
      } catch {
        // The next request or the close tries again.
      }
    }, wait);
    (this.saveTimer as { unref?: () => void }).unref?.();
  }

  private saveNow() {
    this.store.persist();
    this.lastSaveAt = Date.now();
  }

  /** Stop a timed save. The close of the store saves what is left. */
  cancelSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  attachMirror(dir: string) {
    this.mirrorDir = dir;
    const persist = this.store.persist.bind(this.store);
    this.store.persist = (force = false) => {
      if (!force && !this.store.dirty()) return;
      this.syncMirror();
      persist(force);
    };
  }

  syncMirror() {
    if (!this.mirrorDir) return;
    try {
      syncMirror(this.store.db, this.mirrorDir);
    } catch (error) {
      console.error("mirror skipped", error instanceof Error ? error.message : "error");
    }
  }

  /**
   * The first boot of a data directory. `demo` writes the fictional demonstration. `empty` writes the three
   * keys and the default kinds, and no entity. A mark in `meta` stops a second seed, also when the graph is empty.
   */
  migrateSeed(mode: "demo" | "empty" = "demo") {
    const db = this.store.db;
    if (db.query("SELECT value FROM meta WHERE key = 'seeded'").get()) return;
    const entities = db.query("SELECT COUNT(*) AS n FROM entities").get() as { n: number };
    const keys = db.query("SELECT COUNT(*) AS n FROM credentials").get() as { n: number };
    if (entities.n > 0 || keys.n > 0) {
      // A graph from before the mark. It was seeded with the demonstration.
      db.query("INSERT INTO meta (key, value) VALUES ('seeded', 'demo')").run();
      return;
    }
    const tx = db.transaction(() => {
      this.secrets = seedDatabase(db, (value) => sealString(this.store.sealedKey, value), this.now().toISOString(), mode === "demo");
      if (mode === "demo") seedKinds(db, DEMO_KINDS);
      db.query("INSERT INTO meta (key, value) VALUES ('seeded', ?)").run(mode);
    });
    tx();
    this.store.persist();
  }

  backfillVersions() {
    const rows = this.store.db.query("SELECT * FROM entities").all() as EntityRow[];
    for (const row of rows) {
      const existing = this.store.db.query("SELECT id FROM entity_versions WHERE entity_id = ? LIMIT 1").get(row.id) as { id: string } | null;
      if (existing) continue;
      this.appendEntityVersion({
        entityId: row.id,
        supersedes: null,
        tombstone: row.deleted_at ? 1 : 0,
        type: row.type,
        title: row.title,
        body: row.body,
        status: row.status,
        kind: row.kind,
        dueAt: row.due_at,
        areaId: row.area_id,
        properties: row.properties,
        tier: row.tier,
        contentSealed: row.content_sealed,
        origin: row.origin,
        originRef: row.origin_ref,
        sourceId: row.source_id,
        externalId: row.external_id,
        validFrom: row.deleted_at ?? row.updated_at ?? row.created_at,
        actor: "migration",
        surface: "api",
      });
    }
  }

  accessFor(token: string, ip: string | null, surface: Surface, grantToken: string | null, listener: Listener = "main", options: { renewOwner?: boolean } = {}): Access {
    const principal = this.authenticate(token, ip, listener, options);
    const grant = grantToken ? this.grantValid(principal.id, grantToken) : false;
    return makeAccess(principal, surface, grant);
  }

  /**
   * `listener` is the port that the request came in on. Each listener has its own count of failures, so a
   * flood of bad tokens on the outside port cannot lock the owner out of the main port.
   */
  authenticate(token: string, ip: string | null, listener: Listener = "main", options: { renewOwner?: boolean } = {}) {
    const subject = lockSubject(listener, ip);
    this.assertUnlocked(subject);
    const row = this.store.db
      .query("SELECT * FROM credentials WHERE key_hash = ?")
      .get(sha256hex(token)) as CredentialRow | null;
    const now = this.now().toISOString();
    // The owner key renews itself on the mini, also in the 30 days after its end. With no grace, a missed date
    // would lock the owner out of the menu bar, and only a restore would let them in.
    const grace = Boolean(
      options.renewOwner && row && isLoopback(ip) && listener === "main" && row.kind === "key" && row.scope === "write" && row.external !== 1 &&
        row.expires_at && Date.parse(now) - Date.parse(row.expires_at) < OWNER_GRACE_MS,
    );
    if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now && !grace)) {
      this.recordFailure(subject);
      this.appendAudit({
        actor: "anonymous",
        action: "auth_failure",
        tier: null,
        entity_type: null,
        entity_id: null,
        surface: "api",
      });
      throw new ApiError(401, "unauthorized", "Unauthorized.");
    }
    // The key of an outside client works on the outside port only. That port has the fence, the rate limit, and the
    // switch that the owner turns off. This is not a guess, so it does not count toward the lockout.
    if (listener === "main" && row.external === 1) {
      this.appendAudit({ actor: row.id, action: "auth_failure", tier: null, entity_type: "credential", entity_id: row.id, surface: "api" });
      throw new ApiError(401, "unauthorized", "Unauthorized.");
    }
    // The time of last use is for the owner's list. A write for each request would make each read a save.
    if (!row.last_used_at || Date.parse(now) - Date.parse(row.last_used_at) >= LAST_USED_STEP_MS) {
      this.store.db.query("UPDATE credentials SET last_used_at = ? WHERE id = ?").run(now, row.id);
    }
    return principalFromRow(row, now);
  }

  /**
   * The rows of one type. An item of a list, or a step, is read with its list or its task, so it does not fill the
   * list of tasks. An archived row is left out unless `archived` is true. Open rows come first, then by date, then
   * the newest, and the cut at 200 comes after that order, so the newest rows are never the ones cut.
   */
  list(access: Access, type: EntityType, options: { archived?: boolean } = {}): EntityView[] {
    this.knownType(type);
    const closed = new Set(["done", "archived", "cancelled", "past"]);
    const views = this.visible(access)
      .filter((view) => view.type === type && !(type === "task" && view.kind === "item"))
      .filter((view) => options.archived || view.status !== "archived")
      .sort(
        (a, b) =>
          Number(closed.has(a.status ?? "")) - Number(closed.has(b.status ?? "")) ||
          dueSortKey(a.due_at).localeCompare(dueSortKey(b.due_at)) ||
          b.updated_at.localeCompare(a.updated_at),
      )
      .slice(0, 200);
    for (const view of views) this.noteRead(access, view);
    return views;
  }

  get(access: Access, type: EntityType, id: string): EntityView {
    this.knownType(type);
    const view = this.visible(access).find((item) => item.type === type && item.id === id);
    if (!view) throw new ApiError(404, "not_found", "Not found.");
    this.noteRead(access, view);
    return view;
  }

  /**
   * Search titles and bodies under the ceiling. `match` "all" needs each word and is for a search box.
   * "any" is for a question in plain words: it drops the small words, and one matching word is sufficient.
   * The order is BM25, with the title five times the weight of the body.
   */
  search(access: Access, q: string, semantic = false, match: "all" | "any" = "all"): EntityView[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const views = this.visible(access);
    this.noteQuery(access, "search", q.trim());
    if (semantic) {
      const ids = semanticRank(this.store.db, "hmn.fallback", needle, access.ceiling, new Set(views.map((view) => view.id)));
      const ranked = ids
        .map((id) => views.find((view) => view.id === id))
        .filter((view): view is EntityView => Boolean(view));
      if (ranked.length) {
        for (const view of ranked.slice(0, 40)) this.noteRead(access, view);
        return ranked.slice(0, 40);
      }
    }
    const byId = new Map(views.map((view) => [view.id, view]));
    const found: EntityView[] = [];
    const seen = new Set<string>();
    for (const id of this.rankedIds(needle, match)) {
      const view = byId.get(id);
      if (view && !seen.has(id)) {
        seen.add(id);
        found.push(view);
      }
    }
    // A part of a word, and text in a Sealed row that the vault opened, are not in the index. The older match finds them.
    for (const view of views) {
      if (!seen.has(view.id) && `${view.title}\n${view.body ?? ""}`.toLowerCase().includes(needle)) found.push(view);
    }
    // An archived row is kept, and it is not in a search.
    const live = found.filter((view) => view.status !== "archived");
    for (const view of live.slice(0, 40)) this.noteRead(access, view);
    return live.slice(0, 40);
  }

  /** Entity ids in rank order, for every tier except Sealed. The caller removes what the ceiling does not allow. */
  private rankedIds(needle: string, match: "all" | "any"): string[] {
    let words = (needle.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 16);
    if (match === "any") {
      const kept = words.filter((word) => word.length > 1 && !SEARCH_SMALL_WORDS.has(word));
      if (kept.length) words = kept;
    }
    if (words.length === 0 || !this.ensureSearchIndex()) return [];
    const run = (joiner: string) =>
      (this.store.db
        .query("SELECT id FROM search.entity_fts WHERE entity_fts MATCH ? ORDER BY bm25(entity_fts, 5.0, 1.0) LIMIT 200")
        .all(words.map((word) => `"${word}"*`).join(joiner)) as Array<{ id: string }>).map((row) => row.id);
    try {
      const all = run(" AND ");
      if (match === "all" || all.length > 0) return all;
      return run(" OR ");
    } catch {
      return [];
    }
  }

  /**
   * The full-text index is in memory and is not saved. It holds no Sealed text.
   * It is built again when the count or the newest change of the live entities differs.
   */
  private ensureSearchIndex(): boolean {
    try {
      const db = this.store.db;
      if (this.searchDb !== db) {
        db.exec("ATTACH DATABASE ':memory:' AS search");
        // Porter stems English words, so "notes" finds "note" and "running" finds "run". The index is built again at each start.
        db.exec("CREATE VIRTUAL TABLE search.entity_fts USING fts5(id UNINDEXED, title, body, tokenize = 'porter unicode61 remove_diacritics 2')");
        this.searchDb = db;
        this.searchStamp = null;
      }
      const state = db.query("SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM entities WHERE deleted_at IS NULL").get() as { n: number; u: string | null };
      const stamp = `${state.n}:${state.u ?? ""}`;
      if (stamp !== this.searchStamp) {
        db.exec("DELETE FROM search.entity_fts");
        db.exec("INSERT INTO search.entity_fts (id, title, body) SELECT id, title, COALESCE(body, '') FROM entities WHERE deleted_at IS NULL AND content_sealed = 0");
        this.searchStamp = stamp;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** The entities around one entity, to a depth of 1 to 3 links. Only what the ceiling allows, at both ends of each link. */
  neighbours(access: Access, type: EntityType, id: string, depth = 1) {
    const root = this.get(access, type, id);
    const limit = Math.max(1, Math.min(3, Math.floor(depth) || 1));
    const views = new Map(this.visible(access).map((view) => [view.id, view]));
    const links = (this.store.db.query("SELECT * FROM links WHERE deleted_at IS NULL").all() as LinkRow[]).filter((link) => views.has(link.from_id) && views.has(link.to_id));
    const distance = new Map<string, number>([[root.id, 0]]);
    let frontier = [root.id];
    for (let step = 1; step <= limit && frontier.length && distance.size < NEIGHBOUR_MAX; step++) {
      const next: string[] = [];
      for (const link of links) {
        for (const [here, there] of [[link.from_id, link.to_id], [link.to_id, link.from_id]] as Array<[string, string]>) {
          if (frontier.includes(here) && !distance.has(there) && distance.size < NEIGHBOUR_MAX) {
            distance.set(there, step);
            next.push(there);
          }
        }
      }
      frontier = next;
    }
    this.noteQuery(access, "neighbours", `${root.type} ${root.id} depth ${limit}`);
    const nodes = [...distance.entries()].map(([nodeId, steps]) => {
      const view = views.get(nodeId) ?? root;
      if (steps > 0) this.noteRead(access, view);
      return { id: view.id, type: view.type, title: view.title, kind: view.kind, status: view.status, due_at: view.due_at, tier: view.tier, distance: steps };
    });
    const edges = links.filter((link) => distance.has(link.from_id) && distance.has(link.to_id)).map((link) => ({ from: link.from_id, to: link.to_id, rel: link.rel }));
    return { root: root.id, depth: limit, nodes, edges, truncated: distance.size >= NEIGHBOUR_MAX };
  }

  async modelsAdmin(access: Access, ip: string | null, fetchImpl?: ModelFetch) {
    this.requireLocalWrite(access, ip);
    return modelSnapshot(this.store.db, fetchImpl ?? quietFetch);
  }

  async modelsDocument(access: Access, fetchImpl?: ModelFetch): Promise<string> {
    if (access.surface === "display" || access.surface === "widget" || access.surface === "lock") {
      throw new ApiError(404, "not_found", "Not found.");
    }
    const snap = await modelSnapshot(this.store.db, fetchImpl ?? quietFetch);
    const page: ModelPage = {
      models: snap.models.map((model) => ({
        name: model.name,
        version: model.version,
        privacy: model.privacy,
        capabilities: model.capabilities,
        ram_bytes: model.ram_bytes,
        speed: model.speed,
        installed: model.installed,
      })),
      routes: MODEL_TASKS.map((task) => ({ task, model: snap.routes[task] ?? "hmn.fallback" })),
      ram_bytes: snap.ram_bytes,
      voice: voiceNote(),
      spend: snap.spend,
    };
    return modelsHtml(page);
  }

  modelRoute(access: Access, ip: string | null, task: string, modelId: string, tierValue: unknown) {
    this.requireLocalWrite(access, ip);
    if (!isTier(tierValue)) throw new ApiError(422, "bad_tier", "Unknown tier.");
    return assignRoute(this.store.db, task, modelId, tierValue, { optIn: false, ceiling: null });
  }

  async modelPull(access: Access, ip: string | null, modelId: string, fetchImpl?: ModelFetch) {
    this.requireLocalWrite(access, ip);
    return pullModel(this.store.db, modelId, fetchImpl ?? quietFetch);
  }

  async modelRemove(access: Access, ip: string | null, modelId: string, fetchImpl?: ModelFetch) {
    this.requireLocalWrite(access, ip);
    return removeModel(this.store.db, modelId, fetchImpl ?? quietFetch);
  }

  modelPin(access: Access, ip: string | null, modelId: string, version: string) {
    this.requireLocalWrite(access, ip);
    return pinVersion(this.store.db, modelId, version);
  }

  async modelWarm(access: Access, ip: string | null, modelId: string, unload: boolean, fetchImpl?: ModelFetch) {
    this.requireLocalWrite(access, ip);
    return warmModel(modelId, unload, fetchImpl ?? quietFetch);
  }

  async modelIndex(access: Access, ip: string | null, fetchImpl?: ModelFetch) {
    this.requireLocalWrite(access, ip);
    const entities = this.visible(access).map((view) => ({
      id: view.id,
      title: view.title,
      body: view.body,
      tier: view.tier,
    }));
    return indexEntities(this.store.db, access.ceiling, entities, { fetchImpl: fetchImpl ?? quietFetch, now: this.now().toISOString() });
  }

  modelSpend(access: Access) {
    if (access.surface === "display" || access.surface === "widget" || access.surface === "lock") {
      throw new ApiError(404, "not_found", "Not found.");
    }
    const month = this.now().toISOString().slice(0, 7);
    const spend = monthSpend(this.store.db, month);
    return { month, chars: spend.chars, tokens: spend.tokens, usd: spend.usd, cap_usd: readCap(this.store.db), notice: readNotice(this.store.db, month) };
  }

  modelCap(access: Access, ip: string | null, usd: number) {
    this.requireLocalWrite(access, ip);
    if (!Number.isFinite(usd) || usd < 0 || usd > 1000) throw new ApiError(422, "bad_cap", "The cap is a dollar amount from 0 to 1000.");
    setCap(this.store.db, usd);
    return { cap_usd: usd };
  }

  linksOf(access: Access, type: EntityType, id: string) {
    this.get(access, type, id);
    const views = new Map(this.visible(access).map((view) => [view.id, view]));
    const rows = this.store.db
      .query("SELECT * FROM links WHERE deleted_at IS NULL AND (from_id = ? OR to_id = ?)")
      .all(id, id) as LinkRow[];
    return projectLinks(id, rows, views);
  }

  create(access: Access, type: EntityType, input: Record<string, unknown>): EntityView {
    assertScope(access, "write");
    this.knownType(type);
    const id = typeof input.id === "string" ? input.id : randomId(type);
    this.writeEntity(access, id, type, input, null);
    const view = this.get(access, type, id);
    this.store.persist();
    return view;
  }

  update(access: Access, type: EntityType, id: string, patch: Record<string, unknown>): EntityView {
    assertScope(access, "write");
    const existing = this.raw(id);
    if (!existing || existing.type !== type || existing.deleted_at) throw new ApiError(404, "not_found", "Not found.");
    // The owner can make one mirrored event more private. All other fields belong to the calendar.
    if (this.isMirrored(existing) && Object.keys(patch).some((key) => key !== "tier")) {
      throw new ApiError(409, "mirrored", "This event comes from a calendar. Change it in the calendar.");
    }
    // `properties_patch` changes some keys and keeps the rest, so a client that shows a few fields never drops the
    // others. A key set to null is removed.
    if (patch.properties_patch !== undefined) {
      const { properties_patch: changes, ...rest } = patch;
      const properties = { ...asObject(this.plain(existing).properties) };
      for (const [key, value] of Object.entries(asObject(changes))) {
        if (value === null) delete properties[key];
        else properties[key] = value;
      }
      patch = { ...rest, properties };
    }
    this.writeEntity(access, id, type, patch, existing);
    const view = this.get(access, type, id);
    this.store.persist();
    return view;
  }

  remove(access: Access, type: EntityType, id: string) {
    assertScope(access, "write");
    const existing = this.mustRaw(type, id);
    if (this.isMirrored(existing)) throw new ApiError(409, "mirrored", "This event comes from a calendar. Remove it in the calendar.");
    this.tombstoneEntity(access, existing);
    this.store.persist();
  }

  history(access: Access, type: EntityType, id: string) {
    this.knownType(type);
    const head = this.raw(id);
    if (!head || head.type !== type) throw new ApiError(404, "not_found", "Not found.");
    const areas = this.areaMap();
    const headTier = ownTier(head, areas).tier;
    // The same limits as a read of the row: the areas and the types of the key, then the tier.
    if (areaDenied(head, access, areas)) throw new ApiError(404, "not_found", "Not found.");
    if (!covers(access.ceiling, headTier)) throw new ApiError(404, "not_found", "Not found.");
    const rows = this.store.db.query("SELECT * FROM entity_versions WHERE entity_id = ? ORDER BY valid_from ASC, rowid ASC").all(id) as VersionRow[];
    return rows.map((version) => {
      const declared = version.tier && isTier(version.tier) ? version.tier : null;
      const tier = stricterTier(ownTier({ type: version.type, tier: declared, area_id: version.area_id }, areas).tier, headTier);
      if (version.tombstone) {
        return { id: version.id, supersedes_id: version.supersedes_id, valid_from: version.valid_from, tombstone: true, tier };
      }
      // A version can be above the reader when the head is not: the owner lowered the tier, or moved the row out of a closed area.
      const closed = !covers(access.ceiling, tier) || areaDenied({ id: head.id, type: version.type, area_id: version.area_id }, access, areas);
      if (closed || (version.content_sealed && !covers(access.ceiling, "sealed"))) {
        return { id: version.id, supersedes_id: version.supersedes_id, valid_from: version.valid_from, tombstone: false, tier, redacted: true };
      }
      const title = version.content_sealed ? openString(this.store.sealedKey, version.title ?? "") : version.title;
      const body = version.content_sealed && version.body ? openString(this.store.sealedKey, version.body) : version.body;
      return {
        id: version.id,
        supersedes_id: version.supersedes_id,
        valid_from: version.valid_from,
        tombstone: false,
        tier,
        title,
        body,
      };
    });
  }

  purge(access: Access, type: EntityType, id: string) {
    assertScope(access, "write");
    this.knownType(type);
    const existing = this.raw(id);
    if (!existing || existing.type !== type) throw new ApiError(404, "not_found", "Not found.");
    const tier = ownTier(existing, this.areaMap()).tier;
    assertCanSeeTier(access, tier);
    const versions = this.store.db.query("SELECT id FROM entity_versions WHERE entity_id = ? ORDER BY id ASC").all(id) as Array<{ id: string }>;
    const subject = sha256hex(JSON.stringify({ entity_id: id, versions: versions.map((version) => version.id) }));
    this.store.db.query("DELETE FROM entity_versions WHERE entity_id = ?").run(id);
    this.store.db.query("DELETE FROM links WHERE from_id = ? OR to_id = ?").run(id, id);
    this.store.db.query("DELETE FROM entities WHERE id = ?").run(id);
    // The text can also be in the proposal that made or changed the row, in a worker's journal, and in the inbox item
    // that became the row. Those records go too. A backup taken before the purge still holds the text.
    // `instr` and not LIKE: an id has `_`, which LIKE reads as any character. The quotes match the whole JSON string.
    const quoted = JSON.stringify(id);
    this.store.db.query("DELETE FROM proposals WHERE entity_id = ? OR instr(payload, ?) > 0 OR instr(COALESCE(applied, ''), ?) > 0").run(id, quoted, quoted);
    ensureJournals(this.store.db);
    this.store.db.query("DELETE FROM journals WHERE instr(read_json, ?) > 0 OR instr(proposed_json, ?) > 0").run(quoted, quoted);
    this.store.db.query("DELETE FROM inbox_items WHERE result_id = ?").run(id);
    this.appendAudit({
      actor: access.principal.id,
      action: "purge",
      tier,
      entity_type: type,
      entity_id: id,
      surface: access.surface,
      subjectHash: subject,
    });
    this.store.persist();
    return { id, purged: true };
  }

  createLink(access: Access, input: Record<string, unknown>) {
    assertScope(access, "write");
    const fromId = requiredString(input.from_id);
    const toId = requiredString(input.to_id);
    const rel = requiredString(input.rel);
    const from = this.mustLive(fromId);
    const to = this.mustLive(toId);
    const tier = stricterTier(ownTier(from, this.areaMap()).tier, ownTier(to, this.areaMap()).tier);
    assertCanSeeTier(access, tier);
    const same = this.checkLink(from.id, to.id, rel);
    if (same) return { id: same, rel, from_id: from.id, to_id: to.id, tier };
    const id = randomId("link");
    const now = this.now().toISOString();
    this.store.db
      .query(
        `INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, origin, origin_ref, tier, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, 'owner', 'owner', NULL, ?, NULL)`,
      )
      .run(id, from.type, from.id, to.type, to.id, rel, now);
    this.noteWrite(access, "write", tier, "link", id);
    this.store.persist();
    return { id, rel, from_id: from.id, to_id: to.id, tier };
  }

  /**
   * The lists: projects of the kind `list`, each with its items. Open items come first, in the order they were
   * added. Then the last 20 done items, so "Again" can bring one back. docs/ONTOLOGY.md, section 2.4.
   */
  lists(access: Access) {
    const views = this.visible(access);
    const byId = new Map(views.map((view) => [view.id, view]));
    const lists = views
      .filter((view) => view.type === "project" && view.kind === "list" && view.status !== "done")
      .sort((a, b) => a.title.localeCompare(b.title));
    return lists.map((list) => {
      this.noteRead(access, list);
      const items = this.itemsUnder(byId, list.id);
      for (const item of items) this.noteRead(access, item);
      return { list, open: items.filter((item) => item.status !== "done").length, items };
    });
  }

  /** The items of one list, or the steps of one task. */
  items(access: Access, parentId: string) {
    const views = this.visible(access);
    const byId = new Map(views.map((view) => [view.id, view]));
    const parent = byId.get(parentId);
    if (!parent || !isItemParent(parent)) throw new ApiError(404, "not_found", "Not found.");
    this.noteRead(access, parent);
    const items = this.itemsUnder(byId, parent.id);
    for (const item of items) this.noteRead(access, item);
    return { parent, items };
  }

  /**
   * Add an item to a list, or a step to a task. The item takes the tier and the area of its parent, so the grocery
   * list stays Household and a gift list stays Private.
   */
  addItem(access: Access, input: Record<string, unknown>) {
    assertScope(access, "write");
    const parentId = requiredString(input.parent_id);
    const title = requiredString(input.title).trim();
    if (!title) throw new ApiError(422, "title", "A title is required.");
    const parent = this.visible(access).find((view) => view.id === parentId);
    if (!parent || !isItemParent(parent)) throw new ApiError(404, "not_found", "Not found.");
    const id = randomId("task");
    this.writeEntity(access, id, "task", { title, status: "open", kind: "item", area_id: parent.area_id, tier: parent.tier }, null);
    this.store.db
      .query(
        `INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, origin, origin_ref, tier, created_at, deleted_at)
         VALUES (?, 'task', ?, ?, ?, 'part_of', 'owner', 'owner', NULL, ?, NULL)`,
      )
      .run(randomId("link"), id, parent.type, parent.id, this.now().toISOString());
    const view = this.get(access, "task", id);
    this.store.persist();
    return view;
  }

  private itemsUnder(byId: Map<string, EntityView>, parentId: string): EntityView[] {
    const rows = this.store.db
      .query("SELECT from_id FROM links WHERE deleted_at IS NULL AND rel = 'part_of' AND to_id = ?")
      .all(parentId) as Array<{ from_id: string }>;
    const items = [...new Set(rows.map((row) => row.from_id))]
      .map((id) => byId.get(id))
      .filter((view): view is EntityView => Boolean(view && view.type === "task" && view.kind === "item"));
    const open = items.filter((item) => item.status !== "done").sort((a, b) => a.created_at.localeCompare(b.created_at));
    const done = items
      .filter((item) => item.status === "done")
      .sort((a, b) => String(b.properties.done_at ?? b.updated_at).localeCompare(String(a.properties.done_at ?? a.updated_at)))
      .slice(0, 20);
    return [...open, ...done];
  }

  /**
   * Who completed a task, and when. The server writes this, so a client cannot claim another name. A task that
   * opens again loses it. The owner's own devices are "owner"; a member key, later, is its own name.
   */
  private markCompletion(access: Access, properties: Record<string, unknown>, status: string | null, existing: EntityRow | null) {
    const before = existing ? asObject(this.plain(existing).properties) : {};
    if (status === "done" && existing?.status !== "done") {
      properties.done_at = this.now().toISOString();
      const member = this.actingMember;
      properties.done_by = member ? member.name : access.principal.scope === "write" && !access.principal.external ? "owner" : access.principal.name;
      properties.done_by_key = member ? member.id : access.principal.id;
    } else if (status === "done") {
      for (const key of ["done_at", "done_by", "done_by_key"]) {
        if (key in before) properties[key] = before[key];
        else delete properties[key];
      }
    } else {
      delete properties.done_at;
      delete properties.done_by;
      delete properties.done_by_key;
    }
  }

  // ---- household members ----------------------------------------------------------------------------
  // A member is a person of the household with a phone and a role. docs/ONTOLOGY.md, section 5.4. A member's
  // write is a proposal with the source `member:<id>`. The role decides if it is applied at once (with an undo in
  // Activity) or waits for the owner. A removal, and a change of tier or area, always wait.

  /** A pairing code for a member: one person, one role, ten minutes. The owner makes it on a phone or on the mini. */
  createMemberPairing(access: Access, input: Record<string, unknown>, fingerprint: string, origin: string | null = null) {
    assertScope(access, "write");
    assertNotHidden(access);
    if (access.principal.external || access.principal.member) throw new ApiError(403, "forbidden", "The owner adds a member.");
    const role = input.role;
    if (typeof role !== "string" || !(MEMBER_ROLES as readonly string[]).includes(role)) {
      throw new ApiError(422, "bad_role", "A member is a partner or a child.");
    }
    const person = this.get(access, "person", requiredString(input.person_id));
    const code = randomCode();
    // A code on the fridge lasts twenty minutes: the fridge asks for a new picture only every few minutes.
    const fridge = input.fridge === true;
    const expires = new Date(this.now().getTime() + (fridge ? 20 : 10) * 60_000).toISOString();
    this.store.db
      .query("INSERT INTO pairing_codes (id, code_hash, expires_at, used_at, created_at, created_by, member_role, person_id) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)")
      .run(randomId("pair"), sha256hex(code), expires, this.now().toISOString(), access.principal.id, role, person.id);
    this.appendAudit({ actor: access.principal.id, action: fridge ? "pair_member_fridge" : "pair_member", tier: null, entity_type: "person", entity_id: person.id, surface: access.surface });
    this.store.persist();
    const payload = pairingLink(code, fingerprint, origin);
    if (fridge) {
      this.endFridgePairing();
      // The fridge reads Household. The name of a person above Household stays off it.
      const name = person.tier === "public" || person.tier === "household" ? person.title.slice(0, 40) : null;
      this.fridgePairing = { code, codeHash: sha256hex(code), fingerprint, origin, name, expiresAt: expires, createdBy: access.principal.id };
    }
    return { code, expires_at: expires, role, person: { id: person.id, title: person.title }, payload, on_fridge: fridge };
  }

  /** The code on the fridge now, for the owner's app: whose it is and until when. Never the code. */
  fridgePairingStatus(access: Access) {
    assertScope(access, "write");
    const current = this.liveFridgePairing();
    return current ? { person_name: current.name, expires_at: current.expiresAt } : null;
  }

  /** Take the code off the fridge. The code dies too, so a photo of the fridge does not pair a phone later. */
  cancelFridgePairing(access: Access) {
    assertScope(access, "write");
    if (access.principal.external || access.principal.member) throw new ApiError(403, "forbidden", "The owner adds a member.");
    const had = this.endFridgePairing();
    if (had) {
      this.appendAudit({ actor: access.principal.id, action: "pair_member_fridge_end", tier: null, entity_type: null, entity_id: null, surface: access.surface });
      this.store.persist();
    }
    return { on_fridge: false };
  }

  /** The fridge pairing while its code can still be used. */
  private liveFridgePairing() {
    const current = this.fridgePairing;
    if (!current) return null;
    if (current.expiresAt <= this.now().toISOString()) {
      this.fridgePairing = null;
      return null;
    }
    return current;
  }

  /** Forget the fridge pairing, and mark its code used so that it cannot pair a phone. */
  private endFridgePairing(): boolean {
    const current = this.fridgePairing;
    if (!current) return false;
    this.fridgePairing = null;
    this.store.db.query("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL").run(this.now().toISOString(), current.codeHash);
    return true;
  }

  /** The member credential for a used code. It reads Household, and a partner also the Family area at Private. */
  private redeemMember(row: { member_role: string; person_id: string; created_by?: string | null }, ip: string | null) {
    const person = this.raw(row.person_id);
    if (!person || person.deleted_at || person.type !== "person") throw new ApiError(401, "unauthorized", "Unauthorized.");
    const name = this.plain(person).title.slice(0, 80) || "Member";
    const secret = randomSecret();
    const id = randomId("device");
    const now = this.now().toISOString();
    const expires = new Date(this.now().getTime() + 90 * 86_400_000).toISOString();
    this.store.db
      .query(
        `INSERT INTO credentials (
          id, name, kind, key_hash, scope, max_tier, vault, allow_types, allow_areas, deny_areas,
          forced_ceiling, expires_at, created_at, revoked_at, rotated_from, created_by, member_role, person_id
        ) VALUES (?, ?, 'device', ?, 'agent', 'household', 0, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(id, name, sha256hex(secret), expires, now, row.created_by ?? null, row.member_role, row.person_id);
    this.appendAudit({ actor: id, action: "pair", tier: null, entity_type: "device", entity_id: id, surface: "api" });
    void ip;
    this.store.persist();
    return {
      secret,
      credential: { id, name, scope: "agent", max_tier: "household", vault: false },
      member: { role: row.member_role, person_id: row.person_id, name },
    };
  }

  /** The member phones, for the owner. */
  members(access: Access) {
    assertScope(access, "write");
    const rows = this.store.db
      .query(
        `SELECT id, name, member_role, person_id, forced_ceiling, expires_at, created_at, last_used_at FROM credentials
         WHERE member_role IS NOT NULL AND revoked_at IS NULL ORDER BY created_at ASC`,
      )
      .all() as Array<{ id: string; name: string; member_role: string; person_id: string; forced_ceiling: string | null; expires_at: string | null; created_at: string; last_used_at: string | null }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.member_role,
      person_id: row.person_id,
      hidden: row.forced_ceiling !== null,
      expires_at: row.expires_at,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    }));
  }

  revokeMember(access: Access, id: string) {
    assertScope(access, "write");
    const row = this.store.db.query("SELECT id FROM credentials WHERE id = ? AND member_role IS NOT NULL AND revoked_at IS NULL").get(id);
    if (!row) throw new ApiError(404, "not_found", "Not found.");
    return this.revoke(access, id);
  }

  /** A member's write. It is applied at once, or it waits for the owner, by the rules of the member's role. */
  memberWrite(access: Access, op: string, payload: Record<string, unknown>) {
    if (!access.principal.member) throw new ApiError(403, "forbidden", "Forbidden.");
    const made = this.createProposal(access, { op, payload }, access.principal.name) as { id: string };
    const row = this.proposal(made.id);
    if (row.status === "approved") {
      const entity = row.entity_id ? (this.visible(access).find((view) => view.id === row.entity_id) ?? null) : null;
      return { status: "applied" as const, proposal_id: row.id, entity };
    }
    return { status: "pending" as const, proposal_id: row.id };
  }

  /** A member adds an item to a list, or a step to a task. The item takes the tier and the area of its parent. */
  memberAddItem(access: Access, input: Record<string, unknown>) {
    const parentId = requiredString(input.parent_id);
    const title = requiredString(input.title).trim();
    if (!title) throw new ApiError(422, "title", "A title is required.");
    const parent = this.visible(access).find((view) => view.id === parentId);
    if (!parent || !isItemParent(parent)) throw new ApiError(404, "not_found", "Not found.");
    return this.memberWrite(access, "create", {
      entity: { type: "task", kind: "item", title, status: "open", tier: parent.tier, area_id: parent.area_id },
      links: [{ rel: "part_of", to_type: parent.type, to_id: parent.id }],
    });
  }

  /** The tier of a member's proposal is within the member's reach: the ceiling, or the ceiling of an area it names. */
  private assertMemberReach(access: Access, payload: Record<string, unknown>, tier: Tier) {
    if (tier === "sealed") throw new ApiError(403, "sealed", "A member cannot write Sealed data.");
    const areas = this.areaMap();
    let reach = access.ceiling;
    const entity = asObject(payload.entity);
    if (typeof entity.area_id === "string") {
      reach = looserOf(reach, rowCeiling(access, { type: String(entity.type ?? ""), id: "", area_id: entity.area_id }, areas));
    }
    for (const id of collectIds(payload)) {
      const row = this.raw(id);
      if (row) reach = looserOf(reach, rowCeiling(access, row, areas));
    }
    if (!covers(reach, tier)) throw new ApiError(403, "ceiling", "This surface cannot receive that tier.");
  }

  /**
   * The rules of a role. A partner's add, change, and link are applied, for the shapes of daily life. A child's
   * add and tick on a list, and a tick on a task that is for the child, are applied. All else waits for the owner.
   */
  private memberMode(access: Access, op: string, payload: Record<string, unknown>, target: EntityRow | null): ApprovalMode {
    const member = access.principal.member!;
    if (op === "delete" || op === "unlink") return "review";
    const entity = asObject(payload.entity);
    const type = op === "create" ? String(entity.type ?? "") : (target?.type ?? "");
    if (member.role === PARTNER_ROLE) return op === "link" || PARTNER_TYPES.has(type) ? "auto" : "review";
    if (op === "create" && type === "task" && entity.kind === "item") {
      const parents = (Array.isArray(payload.links) ? payload.links : []).map(asObject).filter((link) => link.rel === "part_of").map((link) => String(link.to_id));
      return parents.length > 0 && parents.every((id) => this.childMayTouch(id, member.personId)) ? "auto" : "review";
    }
    if (op === "update" && target?.type === "task" && Object.keys(asObject(payload.patch)).every((key) => key === "status")) {
      if (target.kind === "item") return this.parentsOf(target.id).some((id) => this.childMayTouch(id, member.personId)) ? "auto" : "review";
      return this.isFor(target.id, member.personId) ? "auto" : "review";
    }
    return "review";
  }

  /** A child may add to and tick a list, and the steps of a task that is for the child. */
  private childMayTouch(parentId: string, personId: string): boolean {
    const row = this.raw(parentId);
    if (!row || row.deleted_at) return false;
    if (row.type === "project" && row.kind === "list") return true;
    return row.type === "task" && row.kind !== "item" && this.isFor(row.id, personId);
  }

  private isFor(taskId: string, personId: string): boolean {
    return Boolean(this.store.db.query("SELECT 1 FROM links WHERE deleted_at IS NULL AND rel = 'for' AND from_id = ? AND to_id = ?").get(taskId, personId));
  }

  private parentsOf(itemId: string): string[] {
    return (this.store.db.query("SELECT to_id FROM links WHERE deleted_at IS NULL AND rel = 'part_of' AND from_id = ?").all(itemId) as Array<{ to_id: string }>).map((row) => row.to_id);
  }

  /**
   * A link has a relation that HMN knows, and it joins two different rows. Returns the id of the same live link when
   * it is there already, so a second tap or a second proposal makes no copy.
   */
  private checkLink(fromId: string, toId: string, rel: string): string | null {
    if (!RELATIONS.some((item) => item.rel === rel)) throw new ApiError(422, "bad_rel", `A link is one of: ${RELATIONS.map((item) => item.rel).join(", ")}.`);
    if (fromId === toId) throw new ApiError(422, "self_link", "A row cannot link to itself.");
    const same = this.store.db.query("SELECT id FROM links WHERE deleted_at IS NULL AND from_id = ? AND to_id = ? AND rel = ?").get(fromId, toId, rel) as { id: string } | null;
    return same?.id ?? null;
  }

  /** What a client needs to show and edit any row: the statuses, the kinds, the relations, and the typed fields. */
  schema(access: Access) {
    // Only the owner sees how many rows use each kind. Another key gets the shape alone.
    if (access.principal.scope !== "write") return this.schemaForAgent(access);
    return { statuses: STATUS, kinds: this.kindsList(access).kinds, relations: RELATIONS, fields: FIELDS, kind_fields: kindFieldList(this.store.db), field_types: FIELD_TYPES };
  }

  /**
   * The shape of the record for an agent: the statuses, the kinds with their titles, the relations, and the typed
   * fields. No counts and no rows, so a read key learns nothing about the owner's data from it.
   */
  schemaForAgent(access: Access) {
    // The names of the kinds and of their fields are the owner's words. A key of the owner's own agents reads them,
    // so it can propose a row of a kind. A guest, an outside client, a view key, and a hidden key read the shape only.
    const own = access.principal.scope === "agent" && !access.principal.external && !access.principal.guest && !access.principal.member && !access.principal.forcedCeiling;
    if (!own) return { statuses: STATUS, kinds: [], relations: RELATIONS, fields: FIELDS, kind_fields: [], field_types: FIELD_TYPES };
    const kinds = this.kinds().list().map((row) => ({ type: row.type, kind: row.kind, title: row.title, role: row.role }));
    return { statuses: STATUS, kinds, relations: RELATIONS, fields: FIELDS, kind_fields: kindFieldList(this.store.db), field_types: FIELD_TYPES };
  }

  /** The type of a row that this writer can see, for a field that names a person or a thing. */
  private fieldTarget(access: Access, id: string): string | null {
    const row = this.raw(id);
    if (!row || row.deleted_at) return null;
    if (!covers(access.ceiling, ownTier(row, this.areaMap()).tier)) return null;
    return row.type;
  }

  removeLink(access: Access, id: string) {
    assertScope(access, "write");
    const link = this.store.db.query("SELECT * FROM links WHERE id = ? AND deleted_at IS NULL").get(id) as LinkRow | null;
    if (!link) throw new ApiError(404, "not_found", "Not found.");
    this.store.db.query("UPDATE links SET deleted_at = ? WHERE id = ?").run(this.now().toISOString(), id);
    this.store.persist();
    return { id, deleted: true };
  }

  listProposals(access: Access, status: string | null, source: string | null = null): ProposalView[] {
    const rows = this.store.db.query("SELECT * FROM proposals ORDER BY created_at ASC").all() as ProposalRow[];
    const filtered = rows
      .filter((row) => (status && status !== "all" ? row.status === status : status === "all" ? true : row.status === "pending"))
      .filter((row) => (source ? sourceOf(row) === source : true));
    const views: ProposalView[] = [];
    for (const row of filtered) {
      const view = this.viewProposal(row, access);
      if (!view) continue;
      if (!view.redacted) this.noteRead(access, { tier: row.tier, type: "proposal", id: row.id });
      views.push(view);
    }
    return views;
  }

  /** `meta` comes from a worker inside the server. It is never read from a request body. */
  createProposal(access: Access, input: Record<string, unknown>, agentName: string, meta: { sourceKey?: string; expiresOn?: string; source?: string; forceReview?: boolean; idempotencyKey?: string | null } = {}) {
    if (access.principal.scope === "read") throw new ApiError(403, "forbidden", "This credential cannot propose.");
    const op = requiredString(input.op);
    if (!["create", "update", "delete", "link", "unlink"].includes(op)) {
      throw new ApiError(422, "bad_op", "Unknown proposal.");
    }
    // The server names the source. A worker is its principal, a plugin is named by the tick, and all other callers are a key.
    const source = meta.source ?? (access.principal.id.startsWith("worker:") ? access.principal.id : access.principal.member ? `member:${access.principal.id}` : `key:${access.principal.id}`);
    const rawKey = meta.idempotencyKey ?? (typeof input.idempotency_key === "string" ? input.idempotency_key : null);
    if (rawKey !== null && !/^[A-Za-z0-9._:-]{1,100}$/.test(rawKey)) {
      throw new ApiError(422, "bad_key", "An idempotency key is 1 to 100 letters, digits, dots, colons, hyphens, or underscores.");
    }
    if (rawKey) {
      // A retry with the same key from the same source gets the first proposal back. Nothing new is stored.
      const first = this.store.db.query("SELECT * FROM proposals WHERE source = ? AND idempotency_key = ? ORDER BY created_at ASC LIMIT 1").get(source, rawKey) as ProposalRow | null;
      if (first) {
        const view = this.viewProposal(first, access);
        return view ? { ...view, replayed: true } : { id: first.id, tier: first.tier, status: first.status, redacted: true, agent_name: first.agent_name, op: first.op, replayed: true };
      }
    }
    let payload = input.payload && typeof input.payload === "object" ? asObject(input.payload) : asObject(input);
    if (access.principal.guest) payload = guestEvent(op, payload);
    // A key that is not the owner's: an agent key, an outside client, or a guest. A worker and a plugin are named by the server.
    const fromKey = (source.startsWith("key:") || isMemberSource(source)) && access.principal.scope !== "write";
    payload = tidyPayload(payload);
    agentName = tidyText(agentName, false) || "agent";
    const reason = typeof input.reason === "string" ? tidyText(input.reason, true).slice(0, 500) : null;
    let readSet = input.read_set && typeof input.read_set === "object" ? input.read_set : null;
    // A journal is the record of a worker run. A key cannot point the owner at one.
    if (fromKey && readSet && !Array.isArray(readSet)) {
      const { journal_id: _journal, ...rest } = readSet as Record<string, unknown>;
      readSet = rest;
    }
    // A row that the key cannot read gets the answer for a row that does not exist. Before this, the tier error of
    // a hidden row told the key that the id exists, and its tier.
    if (fromKey) this.assertKeyTargets(access, payload);
    const tier = this.proposalTier(access, op, payload);
    if (access.principal.guest) {
      // A guest writes an event into the owner's review queue. The event is Personal there, and the guest cannot read it back.
      if (tier !== "public" && tier !== "household" && tier !== "personal") throw new ApiError(403, "external", "A guest cannot propose Private or Sealed data.");
    } else if (access.principal.external) {
      if (tier === "private" || tier === "sealed") {
        throw new ApiError(403, "external", "An outside client cannot propose Private or Sealed data.");
      }
      assertCanSeeTier(access, tier);
    } else if (access.principal.member) {
      this.assertMemberReach(access, payload, tier);
    } else if (access.principal.scope === "agent") {
      if (tier === "sealed") throw new ApiError(403, "sealed", "Agents cannot propose Sealed data.");
      assertCanSeeTier(access, tier);
    }
    if (fromKey) {
      this.assertKeyPayload(access, op, payload);
      this.assertProposalBudget(source, payload, readSet);
    }
    const entityType = typeof payload.entity === "object" && payload.entity ? ((asObject(payload.entity).type as string) ?? null) : ((payload.type as string) ?? null);
    // An update or a delete names its target by id. The class uses the type of that target.
    const target = (op === "update" || op === "delete") && typeof payload.id === "string" ? this.raw(payload.id) : null;
    const cls: ProposalClass = { source, op, entityType: entityType ?? target?.type ?? null, tier };
    if (target && source !== "plugin:calendar" && this.isMirrored(target)) {
      throw new ApiError(409, "mirrored", "This event comes from a calendar. Change it in the calendar.");
    }
    // A member's write follows the rules of the member's role. The owner's rules are for agents, workers, and plugins.
    let mode = isMemberSource(source) ? this.memberMode(access, op, payload, target) : modeFor(this.policyRules(), cls);
    // One calendar can be set to review. It then waits, also when the class is auto.
    if (mode === "auto" && meta.forceReview) mode = "review";
    if (mode === "deny") throw new ApiError(403, "policy_deny", "The owner does not accept this kind of proposal.");
    const id = randomId("proposal");
    const stored = this.packSecret(tier, payload, reason, readSet);
    const now = this.now().toISOString();
    const modelId = typeof input.model_id === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(input.model_id) ? input.model_id : null;
    const modelVersion = typeof input.model_version === "string" ? input.model_version.slice(0, 40) : null;
    this.store.db
      .query(
        `INSERT INTO proposals (
          id, agent_name, key_id, op, entity_type, entity_id, payload, reason, read_set, tier, status, created_at, decided_at, decided_by,
          model_id, model_version, source_key, expires_on, source, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        agentName.slice(0, 80),
        access.principal.id,
        op,
        entityType,
        typeof payload.id === "string" ? payload.id : null,
        stored.payload,
        stored.reason,
        stored.read_set,
        tier,
        now,
        modelId,
        modelVersion,
        meta.sourceKey ? meta.sourceKey.slice(0, 200) : null,
        meta.expiresOn && /^\d{4}-\d{2}-\d{2}$/.test(meta.expiresOn) ? meta.expiresOn : null,
        source,
        rawKey,
      );
    if (mode === "auto" && autoBlocked(cls, payload) === null) {
      // The policy applies it through the same path as the owner. If that path refuses it, it waits for review.
      try {
        this.applyProposal(this.proposal(id), this.policyAccess(), "policy");
        this.appendAudit({ actor: "policy", action: "auto_approve", tier, entity_type: "proposal", entity_id: id, surface: "api" });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
      }
    }
    this.store.persist();
    const row = this.store.db.query("SELECT * FROM proposals WHERE id = ?").get(id) as ProposalRow;
    const view = this.viewProposal(row, access);
    if (!view) {
      return { id, tier, status: "pending", redacted: true, agent_name: agentName, op };
    }
    return view;
  }

  editProposal(access: Access, id: string, patch: Record<string, unknown>) {
    assertScope(access, "write");
    const row = this.proposal(id);
    if (row.status !== "pending") throw new ApiError(409, "decided", "That proposal is already decided.");
    requireVaultFor(access, row.tier);
    const payload = asObject(this.unpack(row.payload));
    const edits = cleanFields({
      ...(typeof patch.title === "string" ? { title: patch.title.slice(0, 200) } : {}),
      ...("due_at" in patch ? { due_at: patch.due_at } : {}),
    });
    // A new item changes its entity. A change changes its patch. A removal or a link has no title or date to edit.
    if (row.op === "create") payload.entity = { ...asObject(payload.entity), ...edits };
    else if (row.op === "update" && Object.keys(edits).length) payload.patch = { ...asObject(payload.patch), ...edits };
    if (Array.isArray(patch.links)) {
      payload.links = patch.links.map((item) => {
        const link = asObject(item);
        return {
          rel: typeof link.rel === "string" ? link.rel : "about",
          to_type: typeof link.to_type === "string" ? link.to_type : "",
          to_id: typeof link.to_id === "string" ? link.to_id : "",
        };
      }).filter((link) => link.to_id && link.to_type);
    }
    const reason = typeof patch.reason === "string" ? patch.reason.slice(0, 500) : this.unpackText(row.reason);
    const readSet = this.unpack(row.read_set);
    const tier = this.proposalTier(access, row.op, payload);
    requireVaultFor(access, tier);
    const stored = this.packSecret(tier, payload, reason, readSet);
    this.store.db
      .query("UPDATE proposals SET payload = ?, reason = ?, read_set = ?, tier = ? WHERE id = ?")
      .run(stored.payload, stored.reason, stored.read_set, tier, id);
    this.noteWrite(access, "write", row.tier, "proposal", id);
    this.store.persist();
    return this.viewProposal(this.proposal(id), access);
  }

  approve(access: Access, id: string, persist = true) {
    assertScope(access, "write");
    const row = this.proposal(id);
    if (row.status !== "pending") throw new ApiError(409, "decided", "That proposal is already decided.");
    requireVaultFor(access, row.tier);
    this.applyProposal(row, access, "owner");
    this.appendAudit({
      actor: access.principal.id,
      action: "approve",
      tier: row.tier,
      entity_type: "proposal",
      entity_id: id,
      surface: access.surface,
    });
    if (persist) this.store.persist();
    return this.viewProposal(this.proposal(id), access);
  }

  /** The one write path for a proposal. The owner and the approval policy both use it, so the provenance and the history are the same. */
  private applyProposal(row: ProposalRow, access: Access, decidedBy: "owner" | "policy") {
    const id = row.id;
    const payload = asObject(this.unpack(row.payload));
    const entityForCheck = asObject(payload.entity);
    const patchForCheck = asObject(payload.patch);
    const fixtureKinds = this.kinds().withRole("event", "fixture");
    assertNoSpoilers(String(entityForCheck.type ?? ""), (entityForCheck.kind as string) ?? null, asObject(entityForCheck.properties), fixtureKinds);
    assertNoSpoilers(String(patchForCheck.kind ? entityForCheck.type ?? "" : entityForCheck.type ?? ""), (patchForCheck.kind as string) ?? (entityForCheck.kind as string) ?? null, asObject(patchForCheck.properties), fixtureKinds);
    // The server named the source. A caller cannot take the origin of an import or of a plugin by its name.
    const named = sourceOf(row);
    const origin = named.startsWith("import:") ? "import" : named.startsWith("key:") && !row.source ? pluginOrigin(row.agent_name) : named.startsWith("plugin:") ? "plugin" : "agent";
    // What this approval wrote. Undo reads it.
    const applied: Applied = { entity_id: null, version_id: null, prev_version_id: null, link_ids: [], unlinked_id: null };
    const tx = this.store.db.transaction(() => {
      let entityId = row.entity_id;
      if (row.op === "create") {
        const entity = asObject(payload.entity);
        const type = requiredString(entity.type) as EntityType;
        this.knownType(type);
        entityId = randomId(type);
        this.writeEntity(access, entityId, type, { ...entity, tier: entity.tier ?? row.tier }, null, origin, row.agent_name);
        const links = Array.isArray(payload.links) ? payload.links : [];
        for (const link of links) {
          const item = asObject(link);
          const toId = requiredString(item.to_id);
          const to = this.mustLive(toId);
          const now = this.now().toISOString();
          const linkId = randomId("link");
          this.store.db
            .query(
              `INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, origin, origin_ref, tier, created_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, 'agent', ?, NULL, ?, NULL)`,
            )
            .run(linkId, type, entityId, to.type, to.id, requiredString(item.rel), row.agent_name, now);
          applied.link_ids.push(linkId);
        }
        applied.entity_id = entityId;
        applied.version_id = this.headVersionId(entityId);
      } else if (row.op === "update") {
        const target = requiredString(payload.id);
        const existing = this.mustLive(target);
        if (this.fromLimitedKey(row)) {
          const change = this.patchedTier(existing, asObject(payload.patch), this.areaMap());
          if (existing.type === "area" || !covers(change.to, change.from)) {
            throw new ApiError(422, "tier_floor", "A proposal from a key cannot make a row more visible. Change the tier yourself.");
          }
        }
        applied.prev_version_id = this.headVersionId(target);
        this.writeEntity(access, target, existing.type, asObject(payload.patch), existing, origin, row.agent_name);
        entityId = target;
        applied.entity_id = target;
        applied.version_id = this.headVersionId(target);
      } else if (row.op === "delete") {
        const target = requiredString(payload.id);
        if (this.fromLimitedKey(row) && this.mustLive(target).type === "area") {
          throw new ApiError(422, "area", "A proposal from a key cannot remove an area.");
        }
        // The version before the removal, so that the owner can undo it.
        applied.prev_version_id = this.headVersionId(target);
        this.tombstoneEntity(access, this.mustLive(target));
        entityId = target;
        applied.entity_id = target;
        applied.version_id = this.headVersionId(target);
      } else if (row.op === "link") {
        const link = asObject(payload.link);
        const from = this.mustLive(requiredString(link.from_id));
        const to = this.mustLive(requiredString(link.to_id));
        // A link that is there already is not made twice. The proposal is still approved.
        if (!this.checkLink(from.id, to.id, requiredString(link.rel))) {
          const linkId = randomId("link");
          this.store.db
            .query(
              `INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, origin, origin_ref, tier, created_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, 'agent', ?, NULL, ?, NULL)`,
            )
            .run(linkId, from.type, from.id, to.type, to.id, requiredString(link.rel), row.agent_name, this.now().toISOString());
          applied.link_ids.push(linkId);
        }
      } else if (row.op === "unlink") {
        const linkId = requiredString(payload.id);
        this.store.db.query("UPDATE links SET deleted_at = ? WHERE id = ?").run(this.now().toISOString(), linkId);
        applied.unlinked_id = linkId;
      }
      this.store.db
        .query("UPDATE proposals SET status = 'approved', decided_at = ?, decided_by = ?, entity_id = ?, applied = ? WHERE id = ?")
        .run(this.now().toISOString(), decidedBy, entityId, JSON.stringify(applied), id);
    });
    // A task that a member completes records the member's name, also when the owner approves it later.
    const member = isMemberSource(named) && row.key_id ? (this.store.db.query("SELECT id, name FROM credentials WHERE id = ?").get(row.key_id) as { id: string; name: string } | null) : null;
    this.actingMember = member;
    try {
      tx();
    } finally {
      this.actingMember = null;
    }
  }

  /** The approval policy writes as this principal. It has the owner's write path, up to Private, and it cannot open the vault. */
  private policyAccess(): Access {
    const principal: Principal = {
      id: "policy",
      name: "Approval policy",
      kind: "key",
      scope: "write",
      maxTier: "private",
      vault: false,
      denyAreas: [],
      allowAreas: null,
      allowTypes: null,
      forcedCeiling: "private",
    };
    return { principal, surface: "api", grant: false, ceiling: "private" };
  }

  reject(access: Access, id: string, persist = true) {
    assertScope(access, "write");
    const row = this.proposal(id);
    if (row.status !== "pending") throw new ApiError(409, "decided", "That proposal is already decided.");
    requireVaultFor(access, row.tier);
    this.store.db
      .query("UPDATE proposals SET status = 'rejected', decided_at = ?, decided_by = 'owner' WHERE id = ?")
      .run(this.now().toISOString(), id);
    this.shrinkDecided(id);
    this.appendAudit({
      actor: access.principal.id,
      action: "reject",
      tier: row.tier,
      entity_type: "proposal",
      entity_id: id,
      surface: access.surface,
    });
    if (persist) this.store.persist();
    return this.viewProposal(this.proposal(id), access);
  }

  /** Undo an applied proposal. A create is removed, an update goes back one version, and a link change is reversed. History keeps every step. */
  undo(access: Access, id: string) {
    assertScope(access, "write");
    const row = this.proposal(id);
    if (row.status !== "approved") throw new ApiError(409, "not_applied", "Only an applied proposal can be undone.");
    requireVaultFor(access, row.tier);
    const applied = row.applied ? (asObject(JSON.parse(row.applied)) as unknown as Applied) : null;
    if (!applied) throw new ApiError(409, "no_record", "This approval has no undo record.");
    // A removal from before the record of the earlier version existed cannot be undone here.
    if (row.op === "delete" && !applied.prev_version_id) throw new ApiError(409, "no_record", "This approval has no undo record.");
    const now = this.now().toISOString();
    const tx = this.store.db.transaction(() => {
      const linkIds = Array.isArray(applied.link_ids) ? applied.link_ids : [];
      if (row.op === "create") {
        const entity = applied.entity_id ? this.raw(applied.entity_id) : null;
        if (entity && !entity.deleted_at) this.tombstoneEntity(access, entity);
      } else if (row.op === "update") {
        const entity = this.mustLive(requiredString(applied.entity_id));
        if (this.headVersionId(entity.id) !== applied.version_id) {
          throw new ApiError(409, "changed", "The item changed after this approval. Edit it by hand.");
        }
        const previous = applied.prev_version_id
          ? (this.store.db.query("SELECT * FROM entity_versions WHERE id = ?").get(applied.prev_version_id) as VersionRow | null)
          : null;
        if (!previous || previous.tombstone) throw new ApiError(409, "no_record", "This approval has no undo record.");
        this.restoreVersion(access, entity, previous);
      } else if (row.op === "delete") {
        // The row is still there, with a mark that it is removed. A purge takes the row away, and then nothing can come back.
        const entity = applied.entity_id ? this.raw(applied.entity_id) : null;
        if (!entity) throw new ApiError(409, "no_record", "The item is gone. It cannot come back.");
        if (!entity.deleted_at || this.headVersionId(entity.id) !== applied.version_id) {
          throw new ApiError(409, "changed", "The item changed after this approval. Edit it by hand.");
        }
        const previous = this.store.db.query("SELECT * FROM entity_versions WHERE id = ?").get(applied.prev_version_id) as VersionRow | null;
        if (!previous || previous.tombstone) throw new ApiError(409, "no_record", "This approval has no undo record.");
        this.store.db.query("UPDATE entities SET deleted_at = NULL WHERE id = ?").run(entity.id);
        this.restoreVersion(access, entity, previous);
      } else if (row.op === "unlink" && applied.unlinked_id) {
        this.store.db.query("UPDATE links SET deleted_at = NULL WHERE id = ?").run(applied.unlinked_id);
      }
      for (const linkId of linkIds) {
        this.store.db.query("UPDATE links SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, linkId);
      }
      this.store.db.query("UPDATE proposals SET status = 'undone', undone_at = ? WHERE id = ?").run(now, id);
    });
    tx();
    this.appendAudit({ actor: access.principal.id, action: "undo", tier: row.tier, entity_type: "proposal", entity_id: id, surface: access.surface });
    this.store.persist();
    return this.viewProposal(this.proposal(id), access);
  }

  /** Write an earlier version back as a new head version. Nothing is removed from history. */
  private restoreVersion(access: Access, existing: EntityRow, previous: VersionRow) {
    const areas = this.areaMap();
    // An area that is gone cannot give its tier. The row would come back less private than it was, so it stays.
    if (previous.area_id && !areas.has(previous.area_id)) {
      throw new ApiError(409, "area_gone", "Its area was removed. Make the area again, or move the item by hand.");
    }
    assertCanSeeTier(access, ownTier(existing, areas).tier);
    const declared = previous.tier && isTier(previous.tier) ? previous.tier : null;
    assertCanSeeTier(access, ownTier({ type: previous.type, tier: declared, area_id: previous.area_id }, areas).tier);
    const now = this.now().toISOString();
    this.store.db
      .query(
        `UPDATE entities SET title = ?, body = ?, status = ?, kind = ?, due_at = ?, area_id = ?, properties = ?, tier = ?,
         content_sealed = ?, updated_at = ? WHERE id = ?`,
      )
      .run(previous.title, previous.body, previous.status, previous.kind, previous.due_at, previous.area_id, previous.properties, declared, previous.content_sealed, now, existing.id);
    this.appendEntityVersion({
      entityId: existing.id,
      supersedes: this.headVersionId(existing.id),
      tombstone: 0,
      type: existing.type,
      title: previous.title,
      body: previous.body,
      status: previous.status,
      kind: previous.kind,
      dueAt: previous.due_at,
      areaId: previous.area_id,
      properties: previous.properties,
      tier: declared,
      contentSealed: previous.content_sealed,
      origin: "owner",
      originRef: "undo",
      sourceId: existing.source_id,
      externalId: existing.external_id,
      validFrom: now,
      actor: access.principal.id,
      surface: access.surface,
    });
    this.noteWrite(access, "write", ownTier(existing, areas).tier, existing.type, existing.id);
  }

  /** Decided proposals, newest first: approved, auto-accepted, declined, expired, and undone. */
  /**
   * The name that the owner gave a key, for a source of the form `key:<id>`.
   * The phone shows this name. The id of a key means nothing to the owner.
   */
  private keySource(source: string): { source_name: string | null; source_guest: boolean } {
    if (!source.startsWith("key:") && !isMemberSource(source)) return { source_name: null, source_guest: false };
    const row = this.store.db.query("SELECT name, guest FROM credentials WHERE id = ?").get(source.slice(source.indexOf(":") + 1)) as { name: string; guest: number } | null;
    return { source_name: row ? row.name.replace(/^external:/, "") : null, source_guest: Boolean(row?.guest) };
  }

  activity(access: Access, limit = 100) {
    assertScope(access, "write");
    const rows = this.store.db
      .query("SELECT * FROM proposals WHERE status != 'pending' ORDER BY COALESCE(undone_at, decided_at, created_at) DESC, rowid DESC LIMIT ?")
      .all(Math.max(1, Math.min(500, limit))) as ProposalRow[];
    const items = [];
    for (const row of rows) {
      const view = this.viewProposal(row, access);
      if (!view || view.redacted) continue;
      this.noteRead(access, { tier: row.tier, type: "proposal", id: row.id });
      const payload = asObject(view.payload);
      const title = (asObject(payload.entity).title ?? asObject(payload.patch).title ?? null) as string | null;
      items.push({
        id: row.id,
        agent_name: row.agent_name,
        source: sourceOf(row),
        ...this.keySource(sourceOf(row)),
        op: row.op,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        tier: row.tier,
        status: row.status,
        decided_by: row.decided_by,
        decided_at: row.decided_at,
        undone_at: row.undone_at ?? null,
        title: typeof title === "string" ? title : null,
        reason: view.reason ?? null,
        can_undo: row.status === "approved" && Boolean(row.applied) && (row.op !== "delete" || String(row.applied).includes('"prev_version_id":"')),
        can_clear: CLEARABLE.includes(row.status) && Boolean(row.source_key),
      });
    }
    return { activity: items };
  }

  /** Forget a decline, an expiry, or an undo, so that the worker can propose the item again. The record stays. */
  clearDecline(access: Access, id: string) {
    assertScope(access, "write");
    const row = this.proposal(id);
    requireVaultFor(access, row.tier);
    if (!CLEARABLE.includes(row.status) || !row.source_key) {
      throw new ApiError(409, "nothing_to_clear", "There is no decision to clear on this proposal.");
    }
    this.store.db.query("UPDATE proposals SET source_key = NULL WHERE id = ?").run(id);
    this.appendAudit({ actor: access.principal.id, action: "clear_decline", tier: row.tier, entity_type: "proposal", entity_id: id, surface: access.surface });
    this.store.persist();
    return { id, cleared: true };
  }

  /** One decision for a list of proposals from one source. The caller names each id, so nothing unseen is decided. */
  decideBatch(access: Access, body: Record<string, unknown>) {
    assertScope(access, "write");
    const decision = body.decision === "approve" || body.decision === "reject" ? body.decision : null;
    if (!decision) throw new ApiError(422, "bad_decision", "A batch is approve or reject.");
    const source = requiredString(body.source);
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((item): item is string => typeof item === "string"))] : [];
    if (ids.length === 0 || ids.length > 200) throw new ApiError(422, "bad_batch", "A batch has 1 to 200 proposals.");
    const rows = ids.map((id) => this.proposal(id));
    if (rows.some((row) => sourceOf(row) !== source)) {
      throw new ApiError(422, "mixed_source", "Every proposal in a batch comes from one source.");
    }
    const results: Array<{ id: string; status: string; error?: string }> = [];
    for (const row of rows) {
      try {
        const view = decision === "approve" ? this.approve(access, row.id, false) : this.reject(access, row.id, false);
        results.push({ id: row.id, status: view?.status ?? decision });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        results.push({ id: row.id, status: this.proposal(row.id).status, error: error.code });
      }
    }
    this.store.persist();
    const remaining = (this.store.db.query("SELECT * FROM proposals WHERE status = 'pending'").all() as ProposalRow[]).filter((row) => sourceOf(row) === source).length;
    return { decision, source, decided: results.filter((item) => !item.error).length, failed: results.filter((item) => item.error).length, remaining, results };
  }

  /**
   * The times in which the owner is busy, between two instants. The answer is made now, from the events of
   * the calendars that the owner switched on. Intervals that touch are joined, so the answer does not show
   * how many events there are. It has no title, no id, and no area. The events can be above the caller's ceiling:
   * the owner chose to give this one fact about them.
   */
  freeBusy(access: Access, fromValue: unknown, toValue: unknown) {
    if (access.principal.scope !== "write" && !access.principal.freeBusy) {
      throw new ApiError(403, "no_free_busy", "This key cannot read busy times. The owner turns that on for one key.");
    }
    const instant = (value: unknown, endOfDay: boolean): number => {
      const text = typeof value === "string" ? value.trim() : "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(startOfDay(text, this.timeZone)) + (endOfDay ? 86_400_000 : 0);
      const parsed = /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : NaN;
      if (Number.isNaN(parsed)) throw new ApiError(422, "bad_date", "Give a date or an instant, for example 2026-11-16 or 2026-11-16T09:00:00Z.");
      return parsed;
    };
    const from = instant(fromValue, false);
    const to = instant(toValue, true);
    if (to <= from) throw new ApiError(422, "bad_range", "The end is after the start.");
    if (to - from > FREE_BUSY_DAYS_MAX * 86_400_000) throw new ApiError(422, "bad_range", `The range is at most ${FREE_BUSY_DAYS_MAX} days.`);

    const calendars = (this.store.db.query("SELECT id FROM entities WHERE deleted_at IS NULL AND type = 'source' AND kind = 'calendar'").all() as Array<{ id: string }>)
      .filter((row) => this.calendarSettings(row.id)?.freeBusy)
      .map((row) => row.id);
    const spans: Array<[number, number]> = [];
    for (const sourceId of calendars) {
      const rows = this.store.db
        .query("SELECT * FROM entities WHERE deleted_at IS NULL AND type = 'event' AND source_id = ? AND status != 'cancelled' AND content_sealed = 0")
        .all(sourceId) as EntityRow[];
      for (const row of rows) {
        const properties = asObject(JSON.parse(row.properties || "{}"));
        if (properties.mirror !== true || properties.busy !== true) continue;
        if (!row.due_at || typeof properties.end_at !== "string") continue;
        const allDay = row.due_at.length === 10;
        const start = allDay ? Date.parse(startOfDay(row.due_at, this.timeZone)) : Date.parse(row.due_at);
        const end = allDay ? Date.parse(startOfDay(properties.end_at, this.timeZone)) : Date.parse(properties.end_at);
        if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
        if (end <= from || start >= to) continue;
        spans.push([Math.max(start, from), Math.min(end, to)]);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    const joined: Array<[number, number]> = [];
    for (const span of spans) {
      const last = joined[joined.length - 1];
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else joined.push([span[0], span[1]]);
    }
    this.noteQuery(access, "free_busy", `${new Date(from).toISOString()} to ${new Date(to).toISOString()}`);
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      time_zone: this.timeZone,
      busy: joined.map(([start, end]) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() })),
    };
  }

  /** The keys of agents, outside clients, and views, with what each one can read now. No secret is in the answer. */
  keysList(access: Access) {
    assertScope(access, "write");
    const now = this.now().toISOString();
    const rows = this.store.db.query("SELECT * FROM credentials WHERE scope = 'agent' OR (scope = 'read' AND kind = 'key') ORDER BY created_at ASC, id ASC").all() as CredentialRow[];
    return { keys: rows.map((row) => this.keyView(row, now)), private_days_max: PRIVATE_DAYS_MAX };
  }

  private keyView(row: CredentialRow, now: string) {
    const principal = principalFromRow(row, now);
    const ended = Boolean(row.expires_at && row.expires_at <= now);
    return {
      id: row.id,
      name: row.name,
      // `agent` reads and proposes. `read` is the key of a view: it reads, and it cannot propose.
      scope: row.scope,
      outside: row.external === 1,
      // What the key reads now. Private is here only while the grant is open.
      ceiling: makeAccess(principal, "mcp", false).ceiling,
      private_until: principal.privateGrant ? row.private_until ?? null : null,
      expires_at: row.expires_at,
      deny_areas: principal.denyAreas,
      allow_areas: principal.allowAreas,
      allow_types: principal.allowTypes,
      last_used_at: row.last_used_at ?? null,
      state: row.revoked_at ? "revoked" : ended ? "ended" : "active",
      source: `key:${row.id}`,
      free_busy: row.free_busy === 1,
      guest: row.guest === 1,
      // The phone or the owner key that made this key. The key is revoked with its maker.
      made_by: this.makerOf(row),
    };
  }

  private makerOf(row: CredentialRow): { id: string; name: string } | null {
    if (!row.created_by) return null;
    const maker = this.store.db.query("SELECT id, name FROM credentials WHERE id = ?").get(row.created_by) as { id: string; name: string } | null;
    return maker ? { id: maker.id, name: maker.name } : null;
  }

  /** The key of an agent, of an outside client, or of a view. A paired phone and a TRMNL display are not here. */
  private agentKey(id: string): CredentialRow {
    const row = this.store.db.query("SELECT * FROM credentials WHERE id = ? AND (scope = 'agent' OR (scope = 'read' AND kind = 'key'))").get(id) as CredentialRow | null;
    if (!row) throw new ApiError(404, "not_found", "Not found.");
    return row;
  }

  /** The limits of a key, from a request. A list that is absent keeps the value that the caller gives as `before`. */
  private keyLimits(body: Record<string, unknown>, before: { deny: string[]; areas: string[] | null; types: string[] | null }) {
    const list = (value: unknown, what: string): string[] => {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ApiError(422, "bad_limit", `${what} is a list of text values.`);
      return [...new Set(value as string[])].slice(0, 100);
    };
    const areaIds = this.areaMap();
    const areaOrRole = (item: string) => areaIds.has(item) || /^role:[a-z]+$/.test(item);
    let deny = before.deny;
    if ("deny_areas" in body) {
      deny = list(body.deny_areas, "deny_areas");
      if (!deny.every(areaOrRole)) throw new ApiError(422, "bad_area", "Unknown area.");
    }
    let areas = before.areas;
    if ("allow_areas" in body) {
      areas = body.allow_areas === null ? null : list(body.allow_areas, "allow_areas");
      if (areas && !areas.every((item) => areaIds.has(item))) throw new ApiError(422, "bad_area", "Unknown area.");
    }
    let types = before.types;
    if ("allow_types" in body) {
      types = body.allow_types === null ? null : list(body.allow_types, "allow_types");
      if (types && !types.every((item) => (ENTITY_TYPES as readonly string[]).includes(item))) throw new ApiError(422, "bad_type", "Unknown type.");
    }
    return { deny, areas, types };
  }

  /**
   * Make a key for one local agent, or for one view. On the mini the key goes into the Keychain as
   * `hmn.agent.<name>`, or as `hmn.view.<name>` for a view.
   * The answer has the key itself only for a caller on the mini. A phone never receives it.
   *
   * A view key has the scope `read`. It reads up to its ceiling, and it cannot propose or capture.
   * Its ceiling is Public unless the owner asks for Personal, and it cannot get the Private grant.
   */
  keyCreate(access: Access, ip: string | null, body: Record<string, unknown>) {
    assertScope(access, "write");
    assertNotHidden(access);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new ApiError(422, "bad_name", "A key name is lower-case letters, digits, and hyphens, and it starts with a letter.");
    const now = this.now();
    const taken = this.store.db.query("SELECT id FROM credentials WHERE name = ? AND revoked_at IS NULL").get(name) as { id: string } | null;
    if (taken) throw new ApiError(409, "name_taken", "A key with this name exists. Revoke it first, or use another name.");
    const days = body.days === undefined ? KEY_DAYS_DEFAULT : Number(body.days);
    if (!Number.isInteger(days) || days < 1 || days > KEY_DAYS_MAX) throw new ApiError(422, "bad_days", `A key lasts 1 to ${KEY_DAYS_MAX} days.`);
    const scope = body.scope === undefined || body.scope === "agent" ? "agent" : body.scope === "read" ? "read" : null;
    if (!scope) throw new ApiError(422, "bad_scope", "A new key is for an agent, or it is a view key with the scope read.");
    // A view is often a screen that other people see, so a view key starts at Public.
    const fallback = scope === "read" ? "public" : "personal";
    const ceiling = body.ceiling === undefined ? fallback : body.ceiling === "public" || body.ceiling === "household" || body.ceiling === "personal" ? body.ceiling : null;
    if (!ceiling) throw new ApiError(422, "bad_tier", "A new key is Public, Household, or Personal. Private is a grant that you give after this, with an end date.");
    const limits = this.keyLimits(body, { deny: ["role:health", "role:money"], areas: null, types: null });
    const local = isLoopback(ip);
    const secret = randomSecret();
    const stored = scope === "read" ? rememberViewKey(name, secret) : rememberAgentKey(name, secret);
    if (!local && !stored) {
      throw new ApiError(409, "make_on_mini", "This server cannot put the key in its Keychain. Make the key on the mini, where the key is shown once.");
    }
    let id = `${scope === "read" ? "view" : "key"}_${name.replaceAll("-", "_")}`;
    if (this.store.db.query("SELECT id FROM credentials WHERE id = ?").get(id)) id = `${id}_${randomCode(4).toLowerCase()}`;
    const expires = new Date(now.getTime() + days * 86_400_000).toISOString();
    this.store.db
      .query(
        `INSERT INTO credentials (
          id, name, kind, key_hash, scope, max_tier, vault, allow_types, allow_areas, deny_areas,
          forced_ceiling, expires_at, created_at, revoked_at, rotated_from, created_by
        ) VALUES (?, ?, 'key', ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?)`,
      )
      .run(id, name, sha256hex(secret), scope, ceiling, limits.types ? JSON.stringify(limits.types) : null, limits.areas ? JSON.stringify(limits.areas) : null, JSON.stringify(limits.deny), expires, now.toISOString(), access.principal.id);
    this.appendAudit({ actor: access.principal.id, action: "key_create", tier: ceiling, entity_type: "credential", entity_id: id, surface: access.surface });
    this.store.persist();
    return {
      ...this.keyView(this.agentKey(id), now.toISOString()),
      keychain_item: stored ? `hmn.${scope === "read" ? "view" : "agent"}.${name}` : null,
      // Shown once, and only on the mini.
      token: local ? secret : null,
    };
  }

  /** Change the limits or the end date of a key. The ceiling changes only through the Private grant. */
  keyChange(access: Access, id: string, body: Record<string, unknown>) {
    assertScope(access, "write");
    assertNotHidden(access);
    const row = this.agentKey(id);
    if (row.revoked_at) throw new ApiError(409, "revoked", "That key is revoked.");
    const before = principalFromRow(row);
    const limits = this.keyLimits(body, { deny: before.denyAreas, areas: before.allowAreas, types: before.allowTypes });
    let expires = row.expires_at;
    if ("days" in body) {
      const days = Number(body.days);
      if (!Number.isInteger(days) || days < 1 || days > KEY_DAYS_MAX) throw new ApiError(422, "bad_days", `A key lasts 1 to ${KEY_DAYS_MAX} days.`);
      expires = new Date(this.now().getTime() + days * 86_400_000).toISOString();
    }
    let freeBusy = row.free_busy === 1;
    if ("free_busy" in body) {
      if (typeof body.free_busy !== "boolean") throw new ApiError(422, "bad_value", "free_busy is true or false.");
      freeBusy = body.free_busy;
    }
    this.store.db
      .query("UPDATE credentials SET allow_types = ?, allow_areas = ?, deny_areas = ?, expires_at = ?, free_busy = ? WHERE id = ?")
      .run(limits.types ? JSON.stringify(limits.types) : null, limits.areas ? JSON.stringify(limits.areas) : null, JSON.stringify(limits.deny), expires, freeBusy ? 1 : 0, id);
    this.appendAudit({ actor: access.principal.id, action: "key_change", tier: null, entity_type: "credential", entity_id: id, surface: access.surface });
    this.store.persist();
    return this.keyView(this.agentKey(id), this.now().toISOString());
  }

  /** Give one key the Private tier until an end date, at most 90 days from now. It is never Sealed. */
  keyGrantPrivate(access: Access, id: string, body: Record<string, unknown>) {
    assertScope(access, "write");
    assertNotHidden(access);
    const row = this.agentKey(id);
    if (row.revoked_at) throw new ApiError(409, "revoked", "That key is revoked.");
    if (row.scope === "read") throw new ApiError(409, "view_key", "A view key is Public, Household, or Personal. The Private grant is for the key of an agent.");
    if (row.max_tier === "public" || row.max_tier === "household" || row.forced_ceiling === "public") {
      throw new ApiError(409, "public_key", "This key is Public only. Make another key for a client that you trust.");
    }
    const days = Number(body.days);
    if (!Number.isInteger(days) || days < 1 || days > PRIVATE_DAYS_MAX) throw new ApiError(422, "bad_days", `A Private grant lasts 1 to ${PRIVATE_DAYS_MAX} days.`);
    if (body.understood !== true) {
      throw new ApiError(422, "not_confirmed", "Confirm that this client's model receives Private text, and that HMN cannot take that text back.");
    }
    const until = new Date(this.now().getTime() + days * 86_400_000).toISOString();
    this.store.db.query("UPDATE credentials SET private_until = ? WHERE id = ?").run(until, id);
    this.appendAudit({ actor: access.principal.id, action: "grant_private", tier: "private", entity_type: "credential", entity_id: id, surface: access.surface });
    this.store.persist();
    return this.keyView(this.agentKey(id), this.now().toISOString());
  }

  /** End the Private grant now. The key goes on at its own ceiling. */
  keyEndPrivate(access: Access, id: string) {
    assertScope(access, "write");
    this.agentKey(id);
    this.store.db.query("UPDATE credentials SET private_until = NULL WHERE id = ?").run(id);
    this.appendAudit({ actor: access.principal.id, action: "end_private", tier: "private", entity_type: "credential", entity_id: id, surface: access.surface });
    this.store.persist();
    return this.keyView(this.agentKey(id), this.now().toISOString());
  }

  /**
   * What a Private grant adds for one key, before the owner gives it: the count by type and by area, and
   * five titles. It reads the real graph with the limits of that key. The viewer sees only titles that the
   * viewer's own ceiling covers.
   */
  keyPreview(access: Access, id: string) {
    assertScope(access, "write");
    const row = this.agentKey(id);
    if (row.scope === "read") throw new ApiError(409, "view_key", "A view key is Public, Household, or Personal. The Private grant is for the key of an agent.");
    const base = principalFromRow(row);
    const at = (privateGrant: boolean) => {
      const principal = { ...base, privateGrant };
      return new Map(this.visibleFor(makeAccess(principal, "mcp", false)).map((view) => [view.id, view]));
    };
    const now = at(false);
    const next = at(true);
    const added = [...next.values()].filter((view) => !now.has(view.id));
    const mine = new Map(this.visibleFor(access).map((view) => [view.id, view]));
    const byType: Record<string, number> = {};
    const byArea = new Map<string, number>();
    for (const view of added) {
      byType[view.type] = (byType[view.type] ?? 0) + 1;
      const area = view.type === "area" ? view.id : view.area_id ?? "";
      byArea.set(area, (byArea.get(area) ?? 0) + 1);
    }
    return {
      id: row.id,
      name: row.name,
      outside: row.external === 1,
      reads_now: now.size,
      adds: added.length,
      by_type: byType,
      by_area: [...byArea.entries()].map(([area, count]) => ({ area_id: area || null, title: area ? mine.get(area)?.title ?? null : null, count })).sort((a, b) => b.count - a.count),
      examples: added.filter((view) => mine.has(view.id)).slice(0, 5).map((view) => ({ type: view.type, title: view.title })),
      still_closed: ["Sealed rows", ...base.denyAreas.filter((item) => item.startsWith("role:")).map((item) => `areas with the role ${item.slice(5)}`)],
      warnings: [
        "The model of this client receives the text of these rows.",
        "HMN cannot take that text back after the client reads it.",
        `The grant ends on a date that you set, at most ${PRIVATE_DAYS_MAX} days from now.`,
      ],
    };
  }

  /** Every live entity that one access can read, with no audit row and no read log. For a preview. */
  private visibleFor(access: Access): EntityView[] {
    const areas = this.areaMap();
    const rows = this.store.db.query("SELECT * FROM entities WHERE deleted_at IS NULL").all() as EntityRow[];
    const out: EntityView[] = [];
    for (const row of rows) {
      const view = projectEntity(row, areas, access, this.store.sealedKey);
      if (view) out.push(view);
    }
    return out;
  }

  /** The owner's kinds, with the count of live entities that use each one, and the roles that a kind can have. */
  kindsList(access: Access) {
    assertScope(access, "write");
    const used = new Map(
      (this.store.db.query("SELECT type, kind, COUNT(*) AS n FROM entities WHERE deleted_at IS NULL AND kind IS NOT NULL GROUP BY type, kind").all() as Array<{ type: string; kind: string; n: number }>).map((row) => [`${row.type}:${row.kind}`, row.n]),
    );
    return {
      kinds: this.kinds().list().map((row) => ({ type: row.type, kind: row.kind, title: row.title, role: row.role, core: row.core === 1, in_use: used.get(`${row.type}:${row.kind}`) ?? 0 })),
      roles: ROLES,
      types: KIND_TYPES,
    };
  }

  /** Add a kind, or change its title or its role. The rules read the role, so a new kind with a role works at once. */
  kindSave(access: Access, body: Record<string, unknown>) {
    assertScope(access, "write");
    const type = typeof body.type === "string" ? body.type : "";
    const kind = typeof body.kind === "string" ? body.kind : "";
    if (!KIND_TYPES.includes(type)) throw new ApiError(422, "bad_type", "Kinds are for an area, a person, an event, a place, or an asset.");
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(kind)) throw new ApiError(422, "bad_kind", "A kind is lower-case letters, digits, and underscores, and it starts with a letter.");
    const existing = this.kinds().list().find((row) => row.type === type && row.kind === kind) ?? null;
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 60) : existing?.title ?? titleOf(kind);
    const role = "role" in body ? (body.role === null || body.role === "" ? null : String(body.role)) : existing?.role ?? null;
    if (role !== null && !(ROLES[type] ?? []).includes(role)) throw new ApiError(422, "bad_role", "That role is not valid for this type.");
    // A plugin or a worker writes a core kind and relies on its role.
    if (existing?.core && role !== existing.role) throw new ApiError(409, "core_kind", "The role of a built-in kind does not change. Its title can change.");
    if (existing) {
      this.store.db.query("UPDATE kinds SET title = ?, role = ? WHERE type = ? AND kind = ?").run(title, role, type, kind);
    } else {
      seedKinds(this.store.db, [[type, kind, title, role, 0]]);
    }
    this.appendAudit({ actor: access.principal.id, action: "kind_save", tier: null, entity_type: "kind", entity_id: `${type}:${kind}`.slice(0, 80), surface: access.surface });
    this.store.persist();
    return this.kindsList(access).kinds.find((row) => row.type === type && row.kind === kind)!;
  }

  /**
   * An agent says what it needs and does not have. It changes nothing and grants nothing: the owner reads it.
   * A member uses the app instead, and a hidden key or a read key cannot file one.
   */
  agentRequest(access: Access, body: Record<string, unknown>) {
    if (access.principal.member) throw new ApiError(403, "forbidden", "Tell the owner in person.");
    // A guest or an outside client may propose an event or an inbox item only. It cannot add to this list.
    if (access.principal.scope === "read" || access.principal.external || access.principal.guest) {
      throw new ApiError(403, "forbidden", "This credential cannot send a request.");
    }
    assertNotHidden(access);
    const result = fileRequest(this.store.db, this.now(), access.principal.id, access.principal.name, body);
    this.appendAudit({ actor: access.principal.id, action: "agent_request", tier: null, entity_type: "request", entity_id: result.id, surface: access.surface });
    this.store.persist();
    return result;
  }

  /** The requests of the key that asks. */
  myRequests(access: Access) {
    return { requests: requestsOfKey(this.store.db, access.principal.id) };
  }

  agentRequests(access: Access, status: string | null) {
    assertScope(access, "write");
    // A request can quote what an agent read. A hidden phone shows Public only, so it shows no request.
    assertNotHidden(access);
    return { requests: listRequests(this.store.db, status) };
  }

  /**
   * The dates that HMN cannot read, in the rows that the owner can see: `due_at`, and each field of type date,
   * yearly, or expiry. A screen skips such a value, so this list is the only place that shows it. A sealed row is skipped.
   */
  unreadableDates(access: Access) {
    assertScope(access, "write");
    if (access.principal.member) throw new ApiError(403, "forbidden", "The owner sees this list.");
    assertNotHidden(access);
    const found: Array<{ id: string; type: string; title: string | null; field: string; value: string }> = [];
    const shown = (value: unknown) => (typeof value === "string" ? value.slice(0, 60) : JSON.stringify(value) ?? "").slice(0, 60);
    for (const view of this.visible(access)) {
      if (view.tier === "sealed") continue;
      const add = (field: string, value: unknown) => found.push({ id: view.id, type: view.type, title: view.title, field, value: shown(value) });
      if (view.due_at !== null && view.due_at !== undefined && !readableDue(view.due_at)) add("Date", view.due_at);
      for (const spec of fieldsFor(this.store.db, view.type, view.kind)) {
        if (spec.type !== "date" && spec.type !== "yearly" && spec.type !== "expiry") continue;
        const value = view.properties[spec.key];
        if (value === undefined || value === null || value === "") continue;
        const full = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
        const good = typeof value === "string" && (full ? readableDue(value) : spec.type === "yearly" && /^\d{2}-\d{2}$/.test(value) && readableDue(`2000-${value}`));
        if (!good) add(spec.label, value);
      }
    }
    found.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "") || a.field.localeCompare(b.field));
    return { dates: found.slice(0, 200) };
  }

  agentRequestSet(access: Access, id: string, body: Record<string, unknown>) {
    assertScope(access, "write");
    assertNotHidden(access);
    const row = setRequestStatus(this.store.db, this.now(), id, body.status);
    this.appendAudit({ actor: access.principal.id, action: "agent_request_status", tier: null, entity_type: "request", entity_id: id, surface: access.surface });
    this.store.persist();
    return row;
  }

  /** The fields that one kind adds. The list replaces the one before. A value already kept stays in the row. */
  kindFieldsSave(access: Access, type: string, kind: string, body: Record<string, unknown>) {
    assertScope(access, "write");
    if (!this.kinds().list().some((row) => row.type === type && row.kind === kind)) throw new ApiError(404, "not_found", "Not found.");
    const fields = cleanSpecs(type, body.fields);
    this.store.db.query("INSERT OR REPLACE INTO kind_fields (type, kind, fields) VALUES (?, ?, ?)").run(type, kind, JSON.stringify(fields));
    this.appendAudit({ actor: access.principal.id, action: "kind_fields", tier: null, entity_type: "kind", entity_id: `${type}:${kind}`.slice(0, 80), surface: access.surface });
    this.store.persist();
    return { type, kind, fields };
  }

  kindRemove(access: Access, type: string, kind: string) {
    assertScope(access, "write");
    const existing = this.kinds().list().find((row) => row.type === type && row.kind === kind);
    if (!existing) throw new ApiError(404, "not_found", "Not found.");
    if (existing.core) throw new ApiError(409, "core_kind", "A built-in kind stays. Its title can change.");
    const used = this.store.db.query("SELECT COUNT(*) AS n FROM entities WHERE deleted_at IS NULL AND type = ? AND kind = ?").get(type, kind) as { n: number };
    if (used.n > 0) throw new ApiError(409, "in_use", "Entities use this kind. Change their kind first.");
    this.store.db.query("DELETE FROM kinds WHERE type = ? AND kind = ?").run(type, kind);
    this.store.db.query("DELETE FROM kind_fields WHERE type = ? AND kind = ?").run(type, kind);
    this.appendAudit({ actor: access.principal.id, action: "kind_remove", tier: null, entity_type: "kind", entity_id: `${type}:${kind}`.slice(0, 80), surface: access.surface });
    this.store.persist();
    return { type, kind, removed: true };
  }

  private policyRules(): PolicyRule[] {
    return this.store.db.query("SELECT * FROM approval_policies ORDER BY updated_at ASC").all() as PolicyRule[];
  }

  /** The rules, the sources the owner can name, and the limits that no rule can change. */
  policyList(access: Access) {
    assertScope(access, "write");
    const sources = new Set<string>();
    for (const row of this.store.db.query("SELECT id FROM worker_configs").all() as Array<{ id: string }>) sources.add(`worker:${row.id}`);
    for (const id of ["calendar", "google", "sport", "health"]) sources.add(`plugin:${id}`);
    for (const row of this.store.db.query("SELECT DISTINCT source, key_id FROM proposals").all() as Array<{ source: string | null; key_id: string | null }>) sources.add(sourceOf(row));
    return {
      default_mode: "review" as ApprovalMode,
      rules: this.policyRules(),
      // These hold when no rule of the owner matches the class.
      defaults: DEFAULT_RULES,
      sources: [...sources].sort().map((source) => ({ source, can_auto: sourceCanAuto(source), ...this.keySource(source) })),
      never_auto: ["delete", "sealed", "a patch that sets the tier or the area", "a patch to an area", "a source that is not a worker or a plugin"],
    };
  }

  policySet(access: Access, body: Record<string, unknown>) {
    assertScope(access, "write");
    const source = typeof body.source === "string" ? body.source : ANY;
    const op = typeof body.op === "string" ? body.op : ANY;
    const entityType = typeof body.entity_type === "string" ? body.entity_type : ANY;
    const tier = typeof body.tier === "string" ? body.tier : ANY;
    const mode = APPROVAL_MODES.find((item) => item === body.mode);
    if (!mode) throw new ApiError(422, "bad_mode", "A mode is review, auto, or deny.");
    if (source !== ANY && !/^(worker|plugin|key):[A-Za-z0-9_.:-]{1,80}$/.test(source)) throw new ApiError(422, "bad_source", "Unknown source.");
    if (op !== ANY && !POLICY_OPS.includes(op)) throw new ApiError(422, "bad_op", "Unknown proposal.");
    if (entityType !== ANY && !(ENTITY_TYPES as readonly string[]).includes(entityType)) throw new ApiError(422, "bad_type", "Unknown type.");
    if (tier !== ANY && !isTier(tier)) throw new ApiError(422, "bad_tier", "Unknown tier.");
    if (mode === "auto") {
      if (!sourceCanAuto(source)) throw new ApiError(422, "auto_source", "Only one named worker or plugin can be auto-accepted.");
      if (op === "delete") throw new ApiError(422, "auto_delete", "A delete always waits for the owner.");
      if (tier === "sealed") throw new ApiError(422, "auto_sealed", "Sealed data always waits for the owner.");
    }
    const now = this.now().toISOString();
    const existing = this.store.db
      .query("SELECT id FROM approval_policies WHERE source = ? AND op = ? AND entity_type = ? AND tier = ?")
      .get(source, op, entityType, tier) as { id: string } | null;
    const id = existing?.id ?? randomId("policy");
    if (existing) {
      this.store.db.query("UPDATE approval_policies SET mode = ?, updated_at = ? WHERE id = ?").run(mode, now, id);
    } else {
      this.store.db
        .query("INSERT INTO approval_policies (id, source, op, entity_type, tier, mode, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, source, op, entityType, tier, mode, now);
    }
    this.appendAudit({ actor: access.principal.id, action: `policy_${mode}`, tier: null, entity_type: "policy", entity_id: id, surface: access.surface });
    this.store.persist();
    return this.store.db.query("SELECT * FROM approval_policies WHERE id = ?").get(id) as PolicyRule;
  }

  policyRemove(access: Access, id: string) {
    assertScope(access, "write");
    const existing = this.store.db.query("SELECT id FROM approval_policies WHERE id = ?").get(id) as { id: string } | null;
    if (!existing) throw new ApiError(404, "not_found", "Not found.");
    this.store.db.query("DELETE FROM approval_policies WHERE id = ?").run(id);
    this.appendAudit({ actor: access.principal.id, action: "policy_remove", tier: null, entity_type: "policy", entity_id: id, surface: access.surface });
    this.store.persist();
    return { id, removed: true };
  }

  /** The state of one proposal, for the caller that filed it or for any caller whose ceiling covers it. */
  proposalStatus(access: Access, id: string) {
    const row = this.proposal(id);
    const view = this.viewProposal(row, access);
    if (!view) {
      // The caller filed it, and it is above the caller's ceiling. The state is the caller's to know. The content is not.
      if (row.key_id !== access.principal.id) throw new ApiError(404, "not_found", "Not found.");
      return { id: row.id, status: row.status, op: row.op, tier: row.tier, source: sourceOf(row), created_at: row.created_at, decided_at: row.decided_at, decided_by: row.decided_by, entity_id: null, expires_on: null };
    }
    return {
      id: view.id,
      status: view.status,
      op: view.op,
      tier: view.tier,
      source: view.source ?? null,
      created_at: view.created_at,
      decided_at: view.decided_at,
      decided_by: view.decided_by ?? null,
      // The id of the entity that an approval wrote. An agent can read it with get_entity if its ceiling allows.
      entity_id: view.status === "approved" ? view.entity_id : null,
      expires_on: view.expires_on ?? null,
    };
  }

  /** What one agent key read, newest first. A title is shown only when the viewer's ceiling covers the entity now. */
  clientReads(access: Access, principalId: string, limit = 50) {
    assertScope(access, "write");
    const rows = this.store.db
      .query("SELECT at, action, entity_type, entity_id, tier, detail FROM client_reads WHERE principal_id = ? ORDER BY seq DESC LIMIT ?")
      .all(principalId, Math.max(1, Math.min(500, limit))) as Array<{ at: string; action: string; entity_type: string | null; entity_id: string | null; tier: string | null; detail: string | null }>;
    const views = new Map(this.visible(access).map((view) => [view.id, view]));
    return rows.map((row) => {
      const view = row.entity_id ? views.get(row.entity_id) : null;
      return {
        at: row.at,
        action: row.action,
        type: row.entity_type,
        id: row.entity_id,
        tier: row.tier,
        title: view ? view.title : row.detail,
      };
    });
  }

  /** Every earlier proposal from one principal that has a source key, with its status. It is not limited by a ceiling, and it returns no content. */
  proposalDecisions(principalId: string): Array<{ source_key: string; status: string }> {
    return this.store.db
      .query("SELECT source_key, status FROM proposals WHERE key_id = ? AND source_key IS NOT NULL")
      .all(principalId) as Array<{ source_key: string; status: string }>;
  }

  /** A pending proposal whose last day has passed leaves the queue. The graph does not change. */
  expireProposals(): number {
    const today = zoned(this.now(), this.timeZone).dateKey;
    const rows = this.store.db
      .query("SELECT id, tier FROM proposals WHERE status = 'pending' AND expires_on IS NOT NULL AND expires_on < ?")
      .all(today) as Array<{ id: string; tier: Tier }>;
    if (rows.length === 0) return 0;
    const at = this.now().toISOString();
    for (const row of rows) {
      this.store.db.query("UPDATE proposals SET status = 'expired', decided_at = ?, decided_by = 'system' WHERE id = ? AND status = 'pending'").run(at, row.id);
      this.shrinkDecided(row.id);
      this.appendAudit({ actor: "system", action: "expire", tier: row.tier, entity_type: "proposal", entity_id: row.id, surface: "api" });
    }
    this.store.persist();
    return rows.length;
  }

  lockPayload(access: Access) {
    const locked = makeAccess(access.principal, "lock", false);
    const today = this.screen(locked, "today");
    return {
      ceiling: "public" as const,
      due_count: today.due_count,
      next: today.next,
      subtitle: today.next?.subtitle ?? "Nothing coming.",
    };
  }

  /**
   * A check-in for today. The server writes who and when, so a client cannot claim another name. A child checks
   * in only on a routine that is for the child. There is no streak and no count. docs/ONTOLOGY.md, section 2.5.
   */
  checkIn(access: Access, id: string) {
    this.assertMayCheckIn(access);
    const existing = this.mustRaw("habit", id);
    assertCanSeeTier(access, ownTier(existing, this.areaMap()).tier);
    this.assertMayTick(access, existing);
    const plain = this.plain(existing);
    const properties = { ...plain.properties };
    for (const key of ["streak", "streak_count", "completions", "count"]) delete properties[key];
    const today = zoned(this.now(), this.timeZone).dateKey;
    if (properties.last_check_in !== today) {
      if (typeof properties.last_check_in === "string") properties.previous_check_in = properties.last_check_in;
      properties.last_check_in = today;
      properties.checked_at = this.now().toISOString();
      properties.checked_by = this.tickName(access);
      this.writeEntity(this.tickWriter(access), id, "habit", { properties, title: plain.title, body: plain.body, status: existing.status ?? "active" }, existing);
      this.store.persist();
    }
    return this.get(access, "habit", id);
  }

  /** Take back today's check-in, for a tick by mistake. An earlier day is not changed. */
  uncheck(access: Access, id: string) {
    this.assertMayCheckIn(access);
    const existing = this.mustRaw("habit", id);
    assertCanSeeTier(access, ownTier(existing, this.areaMap()).tier);
    this.assertMayTick(access, existing);
    const plain = this.plain(existing);
    const properties = { ...plain.properties };
    if (properties.last_check_in === zoned(this.now(), this.timeZone).dateKey) {
      if (typeof properties.previous_check_in === "string") properties.last_check_in = properties.previous_check_in;
      else delete properties.last_check_in;
      for (const key of ["previous_check_in", "checked_at", "checked_by"]) delete properties[key];
      this.writeEntity(this.tickWriter(access), id, "habit", { properties, title: plain.title, body: plain.body, status: existing.status ?? "active" }, existing);
      this.store.persist();
    }
    return this.get(access, "habit", id);
  }

  /**
   * The owner's keys check in. A member key is an agent key for every other write, which waits in proposals, but a
   * tick on a routine is applied at once, by the rules of the role. Its undo is the take-back below.
   */
  private assertMayCheckIn(access: Access) {
    if (access.principal.member && !access.principal.external) return;
    assertScope(access, "write");
  }

  /**
   * The write of a tick keeps the habit's tier and area, so the agent rule on a new tier does not apply. The
   * member's ceiling and area limits still do, and the audit names the member's key.
   */
  private tickWriter(access: Access): Access {
    if (!access.principal.member) return access;
    return { ...access, principal: { ...access.principal, scope: "write" } };
  }

  /** A child ticks only a routine that is for the child. A partner ticks any routine the partner can see. */
  private assertMayTick(access: Access, habit: EntityRow) {
    const member = access.principal.member;
    if (!member || member.role === PARTNER_ROLE) return;
    if (!this.isFor(habit.id, member.personId)) throw new ApiError(403, "not_yours", "This routine is for someone else.");
  }

  private tickName(access: Access): string {
    if (access.principal.member) return access.principal.name;
    return access.principal.scope === "write" && !access.principal.external ? "owner" : access.principal.name;
  }

  /**
   * The routines: habits with a `for` link to a person. Each has its days (none means every day), whether it is
   * due today, and today's check-in. The views are the caller's own, through the policy layer.
   */
  routines(access: Access) {
    const views = this.visible(access);
    const byId = new Map(views.map((view) => [view.id, view]));
    const links = this.store.db.query("SELECT * FROM links WHERE deleted_at IS NULL AND rel = 'for'").all() as LinkRow[];
    const zone = zoned(this.now(), this.timeZone);
    const out: Array<{ habit: EntityView; for: Array<{ id: string; title: string }>; days: string[]; due_today: boolean; done_today: boolean }> = [];
    for (const habit of views) {
      if (habit.type !== "habit") continue;
      const people = links
        .filter((link) => link.from_id === habit.id)
        .map((link) => byId.get(link.to_id))
        .filter((peer): peer is EntityView => Boolean(peer && peer.type === "person"))
        .map((peer) => ({ id: peer.id, title: peer.title }));
      if (!people.length) continue;
      const days = routineDays(habit.properties.days);
      out.push({ habit, for: people, days, due_today: habit.status !== "paused" && dueOn(days, zone.weekday), done_today: habit.properties.last_check_in === zone.dateKey });
    }
    out.sort((a, b) => a.for[0]!.title.localeCompare(b.for[0]!.title) || a.habit.title.localeCompare(b.habit.title));
    for (const entry of out) this.noteRead(access, entry.habit);
    return out;
  }

  /** The owner makes a routine: a habit at Household, for one person, on some days of the week. */
  createRoutine(access: Access, input: Record<string, unknown>) {
    assertScope(access, "write");
    if (access.principal.member || access.principal.external) throw new ApiError(403, "forbidden", "Only the owner makes a routine.");
    const title = requiredString(input.title).trim().slice(0, 120);
    if (!title) throw new ApiError(422, "title", "A title is required.");
    const person = this.get(access, "person", requiredString(input.person_id));
    const days = input.days === undefined ? [] : routineDays(input.days, true);
    // A link takes the stricter tier of its two ends. A person above Household would hide the routine from the household.
    if (!covers("household", person.tier)) throw new ApiError(422, "person_tier", "This person is not at Household, so the household would not see the routine.");
    const id = randomId("habit");
    this.writeEntity(access, id, "habit", { title, status: "active", tier: "household", properties: { days, cadence: cadenceLabel(days) } }, null);
    this.store.db
      .query(
        `INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, origin, origin_ref, tier, created_at, deleted_at)
         VALUES (?, 'habit', ?, 'person', ?, 'for', 'owner', 'owner', NULL, ?, NULL)`,
      )
      .run(randomId("link"), id, person.id, this.now().toISOString());
    this.store.persist();
    return this.routines(access).find((entry) => entry.habit.id === id)!;
  }

  captureInbox(access: Access, input: Record<string, unknown>) {
    if (access.principal.scope === "read") throw new ApiError(403, "forbidden", "This credential cannot capture.");
    const raw = typeof input.text === "string" ? input.text : typeof input.body === "string" ? input.body : "";
    const transcript = typeof input.transcript === "string" ? input.transcript : "";
    let text = [raw, transcript].filter(Boolean).join("\n");
    if (typeof input.tag === "string" && input.tag.trim()) {
      const tag = input.tag.trim().replace(/^#/, "").toLowerCase();
      if (tag && !text.toLowerCase().includes(`#${tag}`)) text = `${text} #${tag}`.trim();
    }
    if (typeof input.json === "string" && input.json.trim()) text = text ? `${text}\n${input.json}` : input.json;
    else if (input.json && typeof input.json === "object") {
      const encoded = JSON.stringify(input.json);
      text = text ? `${text}\n${encoded}` : encoded;
    }
    text = text.slice(0, access.principal.guest ? GUEST_TEXT_MAX : 32_000);
    if (!text && !input.url) throw new ApiError(422, "empty", "Nothing to capture.");
    this.assertInboxBudget(access);
    const source = ["app", "share", "siri", "widget", "mcp", "email", "webhook", "shortcut"].includes(String(input.source))
      ? String(input.source)
      : access.principal.scope === "agent"
        ? "mcp"
        : "app";
    const guest = access.principal.guest === true;
    // A guest is the agent of another person. It leaves a short text: it does not choose a tier, attach files, add a
    // link, or name a source. A name of the owner's in its text still raises the tier.
    if (guest) {
      input = { text, source: "mcp" };
    }
    const parsed = parseCapture(text || String(input.url ?? ""), !guest && typeof input.tier === "string" ? input.tier : null);
    let tier = this.tierForTags(guest ? [] : parsed.tags, guest ? "personal" : clampTier(parsed.tier, access.principal.scope), parsed.body);
    if (source === "shortcut") tier = stricterTier(tier, "personal");
    const attachments = this.inboxAttachments(input.attachments);
    const packed = this.packInbox(parsed.body || String(input.url ?? ""), parsed.tags, attachments, typeof input.url === "string" ? input.url.slice(0, 2000) : null, tier);
    const id = randomId("inbox");
    const now = this.now().toISOString();
    this.store.db
      .query(
        `INSERT INTO inbox_items (
          id, body, url, tags, tier, source, status, content_sealed, attachments, suggestion,
          result_type, result_id, origin, origin_ref, captured_at, updated_at, deleted_at, credential_id
        ) VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        id,
        packed.body,
        packed.url,
        packed.tags,
        tier,
        source,
        packed.content_sealed,
        packed.attachments,
        access.principal.scope === "agent" ? "agent" : "owner",
        source,
        now,
        now,
        access.principal.id,
      );
    if (tier === "private" || tier === "sealed") {
      this.appendAudit({ actor: access.principal.id, action: "write", tier, entity_type: "inbox", entity_id: id, surface: access.surface });
    }
    this.store.persist();
    // A key that is not the owner's gets one answer for every item. The tier that the server chose, or a view that
    // only some items give, would tell the key which names in its text belong to a Private or Sealed row.
    if (access.principal.scope !== "write") return { id, received: true };
    const view = this.projectInboxRow(this.inboxRow(id)!, access);
    if (!view) return { id, tier, redacted: true };
    return view;
  }

  listInbox(access: Access, status = "new") {
    const rows = this.store.db.query("SELECT * FROM inbox_items WHERE deleted_at IS NULL AND status = ? ORDER BY captured_at DESC").all(status) as InboxRow[];
    return rows.map((row) => this.projectInboxRow(row, access)).filter((row): row is InboxView => row !== null).slice(0, 200);
  }

  inboxTags(access: Access, query: string) {
    const needle = query.trim().toLowerCase().replace(/^#/, "");
    const tags = new Set<string>(["todo", "person", "idea", "read"]);
    for (const item of this.listInbox(access, "new")) for (const tag of item.tags) tags.add(tag);
    for (const item of this.listInbox(access, "processed")) for (const tag of item.tags) tags.add(tag);
    const areas = this.visible(access).filter((entity) => entity.type === "area" || entity.type === "project" || entity.type === "person");
    for (const entity of areas) tags.add(slug(entity.title));
    return [...tags].filter((tag) => !needle || tag.includes(needle)).slice(0, 40).sort();
  }

  processInbox(access: Access, id: string, input: Record<string, unknown>) {
    assertScope(access, "write");
    const row = this.inboxRow(id);
    if (!row || row.deleted_at) throw new ApiError(404, "not_found", "Not found.");
    const open = this.openInbox(row);
    if (!covers(access.ceiling, open.tier)) throw new ApiError(404, "not_found", "Not found.");
    const action = String(input.action ?? "");
    const now = this.now().toISOString();
    if (action === "archive") {
      this.store.db.query("UPDATE inbox_items SET status = 'archived', updated_at = ? WHERE id = ?").run(now, id);
    } else if (action === "delete") {
      this.store.db.query("UPDATE inbox_items SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    } else if (action === "retag") {
      const parsed = parseCapture(typeof input.text === "string" ? input.text : `${open.body} ${open.tags.map((tag) => `#${tag}`).join(" ")}`, typeof input.tier === "string" ? input.tier : open.tier);
      const tier = this.tierForTags(parsed.tags, clampTier(parsed.tier, "write"), parsed.body);
      assertCanSeeTier(access, tier);
      const packed = this.packInbox(parsed.body, parsed.tags, open.attachments, open.url, tier);
      this.store.db
        .query("UPDATE inbox_items SET body = ?, url = ?, tags = ?, attachments = ?, tier = ?, content_sealed = ?, updated_at = ? WHERE id = ?")
        .run(packed.body, packed.url, packed.tags, packed.attachments, tier, packed.content_sealed, now, id);
    } else if (action === "file") {
      // Filing keeps the text: it becomes a note about the chosen record, so it shows there. A note that was only
      // marked as filed would leave every screen.
      const target = this.mustLive(String(input.entity_id ?? ""));
      const targetTier = ownTier(target, this.areaMap()).tier;
      assertCanSeeTier(access, targetTier);
      const noteId = randomId("note");
      const tier = stricterTier(open.tier, targetTier);
      this.writeEntity(access, noteId, "note", { title: titleFromBody(open.body), body: open.body, status: "open", kind: "capture", tier, properties: { from_inbox: id } }, null, "owner", `inbox:${id}`);
      this.store.db
        .query(
          `INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, origin, origin_ref, tier, created_at, deleted_at)
           VALUES (?, 'note', ?, ?, ?, 'about', 'owner', ?, NULL, ?, NULL)`,
        )
        .run(randomId("link"), noteId, target.type, target.id, `inbox:${id}`, now);
      this.store.db
        .query("UPDATE inbox_items SET status = 'processed', result_type = 'note', result_id = ?, updated_at = ? WHERE id = ?")
        .run(noteId, now, id);
    } else if (action === "accept") {
      // The owner can say what it becomes in one tap: a task, a note, or a person. With no choice, the tags decide.
      const chosen = typeof input.route === "string" ? input.route : null;
      if (chosen !== null && !["task", "note", "person"].includes(chosen)) throw new ApiError(422, "bad_route", "It becomes a task, a note, or a person.");
      const suggestion: InboxSuggestion | null = chosen ? { route: chosen as InboxSuggestion["route"], label: chosen } : this.suggestionFor(open.tags, access, open.body);
      if (!suggestion) throw new ApiError(422, "no_route", "Choose what it becomes: a task, a note, or a person.");
      const created = this.materialiseInbox(access, open, suggestion);
      this.store.db
        .query("UPDATE inbox_items SET status = 'processed', result_type = ?, result_id = ?, updated_at = ? WHERE id = ?")
        .run(created.type, created.id, now, id);
    } else {
      throw new ApiError(422, "bad_action", "Unknown inbox action.");
    }
    if (open.tier === "private" || open.tier === "sealed") {
      this.appendAudit({ actor: access.principal.id, action: "write", tier: open.tier, entity_type: "inbox", entity_id: id, surface: access.surface });
    }
    this.store.persist();
    const updated = this.inboxRow(id);
    if (!updated || updated.deleted_at) return { id, deleted: true };
    return this.projectInboxRow(updated, access);
  }

  async submitHealth(access: Access, body: Record<string, unknown>) {
    requireVaultFor(access, "sealed");
    const includeSamples = body.include_samples === true;
    const summaries = Array.isArray(body.summaries) ? body.summaries.map((item) => asObject(item)) : [];
    const drafts = await runPlugin("health", { summaries, include_samples: includeSamples }, this.now().toISOString());
    const created = [];
    for (const draft of drafts) {
      // The summary goes to the owner's area with the role `health`. It is Sealed with or without that area.
      this.placeByRole(draft.entity);
      draft.entity.tier = "sealed";
      const proposal = this.createProposal(
        access,
        { op: "create", payload: { op: "create", entity: draft.entity }, reason: draft.reason },
        "health",
        { source: "plugin:health" },
      );
      created.push({ id: "id" in proposal ? proposal.id : null, op: draft.op });
    }
    return { proposals: created, include_samples: includeSamples };
  }

  today(access: Access): TodayScreen {
    return this.screen(access, "today");
  }

  screen(access: Access, id: string): TodayScreen {
    const input = this.screenInput(access);
    let screen: TodayScreen;
    if (id === "today") screen = buildToday(input);
    else if (id === "upcoming") screen = buildUpcoming(input);
    else if (id === "commitments") screen = buildCommitments(input);
    else if (id === "quiet") screen = buildQuiet(input);
    else if (id === "week") screen = buildWeek(input);
    else if (id === "inbox") screen = buildInboxQueue(input, this.listInbox(access));
    else if (id === "agents") screen = buildAgents(input, this.listProposals(access, "pending"));
    else if (id === "home") screen = buildHome(input, this.homeOwner(access, input.views));
    else throw new ApiError(404, "not_found", "Not found.");
    // Each row that is an entity names its type, so that a tap can open it.
    screen = {
      ...screen,
      sections: screen.sections.map((section) => ({
        ...section,
        items: section.items.map((item) => {
          const type = input.views.get(item.id)?.type;
          return type ? { ...item, type } : item;
        }),
      })),
    };
    for (const entityId of screen.entity_ids) {
      const view = input.views.get(entityId);
      if (view) this.noteRead(access, view);
    }
    return screen;
  }

  /** The "Expiring soon" rows for an agent: from the recent past to `days` ahead. The ceiling already cut the rows. */
  expiring(access: Access, days: number) {
    const input = this.screenInput(access);
    const list = renewalsIn(input, RENEWAL_PAST_DAYS, days);
    for (const renewal of list) this.noteRead(access, renewal.entity);
    return list.map((renewal) => ({ entity: renewal.entity, label: renewal.label, key: renewal.key, days: renewal.days }));
  }

  /** One screen of the fridge. The views are those of the display's own key, through the policy layer. */
  fridgeScreen(access: Access, id: FridgeScreenId, origin: string | null = null): FridgeScreen {
    const input = this.screenInput(access);
    const screen = buildFridge(input, id);
    // A member pairing code that the owner asked for takes the whole panel. A hidden fridge never shows it.
    const pairing = access.principal.forcedCeiling ? null : this.liveFridgePairing();
    if (pairing) {
      const until = zoned(new Date(pairing.expiresAt), this.timeZone);
      // The address is the one the fridge uses: a phone in the kitchen is on the same network as the fridge.
      const payload = pairingLink(pairing.code, pairing.fingerprint, origin ?? pairing.origin);
      return { ...screen, pairing: { payload, name: pairing.name, until: until.hm }, entity_ids: [] };
    }
    for (const entityId of screen.entity_ids) {
      const view = input.views.get(entityId);
      if (view) this.noteRead(access, view);
    }
    return screen;
  }

  fridgeWindowNow(): FridgeScreenId {
    return fridgeWindow(zoned(this.now(), this.timeZone).hour);
  }

  fridgeSecondsToNextWindow(): number {
    // While a code is on the fridge, ask every minute, so that a used code leaves soon.
    if (this.liveFridgePairing()) return 60;
    return secondsToNextWindow(this.now(), this.timeZone);
  }

  browse(access: Access, type: EntityType) {
    const entities = this.list(access, type);
    return { type, entities, items: browseItems(entities) };
  }

  displayScreen(access: Access, force: string | null): TodayScreen {
    if (force) return this.screen(access, force);
    const row = this.store.db.query("SELECT screen_index, shown_at FROM display_state WHERE id = 'device'").get() as { screen_index: number; shown_at: string } | null;
    const current = row?.screen_index ?? 0;
    const shownAt = row?.shown_at ? Date.parse(row.shown_at) : 0;
    const advance = this.now().getTime() - shownAt >= 3_600_000;
    const index = nextDeckIndex(current, DECK.map((screen) => screen.ready), advance);
    if (!row || advance) {
      this.store.db.query("UPDATE display_state SET screen_index = ?, shown_at = ? WHERE id = 'device'").run(index, this.now().toISOString());
      this.store.persist();
    }
    return this.screen(access, DECK[index]!.id);
  }

  /**
   * A one-time import of records from another system. Each record becomes a proposal with its foreign id as
   * `external_id`. A second run with the same records does not make a second copy.
   * A record that points at an area or an item that is not approved yet waits for a later run. Its tier
   * depends on that target, so it is not proposed before the target exists.
   */
  importRecords(access: Access, body: Record<string, unknown>) {
    assertScope(access, "write");
    const slug = typeof body.source === "string" ? body.source : "";
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(slug)) throw new ApiError(422, "bad_source", "An import names its source in lower-case letters.");
    const records = Array.isArray(body.records) ? body.records.map((item) => asObject(item)) : [];
    if (records.length === 0 || records.length > IMPORT_MAX) throw new ApiError(422, "bad_import", `An import has 1 to ${IMPORT_MAX} records.`);
    const dryRun = body.dry_run === true;
    const source = `import:${slug}`;

    const live = this.store.db.query("SELECT * FROM entities WHERE deleted_at IS NULL").all() as EntityRow[];
    let sourceRow = live.find((row) => row.type === "source" && !row.content_sealed && asObject(JSON.parse(row.properties || "{}")).import === slug) ?? null;
    if (!sourceRow && !dryRun) {
      const id = randomId("source");
      const kind = slug === "notion" ? "notion" : "manual";
      this.writeEntity(access, id, "source", { title: typeof body.title === "string" && body.title ? body.title : `Import from ${slug}`, kind, properties: { import: slug } }, null);
      sourceRow = this.raw(id);
    }
    const sourceId = sourceRow?.id ?? null;
    const imported = new Map(live.filter((row) => sourceId && row.source_id === sourceId && row.external_id).map((row) => [row.external_id!, row]));
    const liveIds = new Map(live.map((row) => [row.id, row]));
    const areas = live.filter((row) => row.type === "area");
    const areaByTitle = new Map(areas.filter((row) => !row.content_sealed).map((row) => [(row.title ?? "").toLowerCase(), row]));
    const earlier = new Map(
      (this.store.db.query("SELECT source_key, status, decided_at FROM proposals WHERE source = ? AND source_key IS NOT NULL ORDER BY created_at ASC").all(source) as Array<{ source_key: string; status: string; decided_at: string | null }>).map((row) => [row.source_key, row]),
    );
    const cutoff = this.now().getTime() - IMPORT_KEEP_DAYS * 86_400_000;
    const recent = (at: string | null) => Boolean(at && Date.parse(at) >= cutoff);
    const inRequest = new Map<string, Record<string, unknown>>();
    for (const record of records) if (typeof record.external_id === "string") inRequest.set(record.external_id, record);
    const requestAreas = new Set(records.filter((record) => record.type === "area" && typeof record.title === "string").map((record) => String(record.title).toLowerCase()));

    const order = (type: unknown) => {
      const index = IMPORT_ORDER.indexOf(String(type));
      return index === -1 ? IMPORT_ORDER.length : index;
    };
    const sorted = records.map((record, index) => ({ record, index })).sort((a, b) => order(a.record.type) - order(b.record.type) || a.index - b.index);
    const seen = new Set<string>();
    const results: Array<{ external_id: string | null; type: string | null; status: string; error?: string; proposal_id?: string }> = [];
    for (const { record } of sorted) {
      const externalId = typeof record.external_id === "string" && record.external_id.length > 0 && record.external_id.length <= 200 ? record.external_id : null;
      const type = typeof record.type === "string" ? record.type : null;
      const done = (status: string, error?: string, proposalId?: string) => results.push({ external_id: externalId, type, status, ...(error ? { error } : {}), ...(proposalId ? { proposal_id: proposalId } : {}) });
      if (!externalId) { done("invalid", "external_id"); continue; }
      if (seen.has(externalId)) { done("invalid", "duplicate"); continue; }
      seen.add(externalId);
      if (!type || type === "source" || !(ENTITY_TYPES as readonly string[]).includes(type)) { done("invalid", "type"); continue; }
      const title = typeof record.title === "string" ? record.title.trim().slice(0, 200) : "";
      if (!title) { done("invalid", "title"); continue; }
      if (imported.has(externalId)) { done("exists"); continue; }
      const prior = earlier.get(`${slug}:${externalId}`);
      if (prior?.status === "pending") { done("pending"); continue; }
      // A decision is kept for 90 days. In that time a declined or removed record does not come back.
      if (prior && prior.status !== "approved" && recent(prior.decided_at)) { done("declined"); continue; }
      if (prior?.status === "approved" && recent(prior.decided_at)) { done("removed"); continue; }

      let areaId: string | null = null;
      if (typeof record.area === "string" && record.area) {
        const named = record.area;
        const found = (liveIds.get(named)?.type === "area" ? liveIds.get(named) : null) ?? (imported.get(named)?.type === "area" ? imported.get(named) : null) ?? areaByTitle.get(named.toLowerCase()) ?? null;
        if (found) areaId = found.id;
        else if (inRequest.get(named)?.type === "area" || requestAreas.has(named.toLowerCase())) { done("waiting", "area"); continue; }
        else { done("invalid", "unknown_area"); continue; }
      }
      const links: Array<{ rel: string; to_type: string; to_id: string }> = [];
      let waiting = false;
      let unknown = false;
      for (const item of Array.isArray(record.links) ? record.links : []) {
        const link = asObject(item);
        const to = typeof link.to === "string" ? link.to : "";
        const rel = typeof link.rel === "string" && /^[a-z_]{1,40}$/.test(link.rel) ? link.rel : "about";
        const target = imported.get(to) ?? liveIds.get(to) ?? null;
        if (target) links.push({ rel, to_type: target.type, to_id: target.id });
        else if (inRequest.has(to)) waiting = true;
        else unknown = true;
      }
      if (unknown) { done("invalid", "unknown_link"); continue; }
      if (waiting) { done("waiting", "links"); continue; }

      const status = typeof record.status === "string" && record.status ? record.status : IMPORT_STATUS[type] ?? null;
      const kind = typeof record.kind === "string" && record.kind ? record.kind : type === "area" ? "other" : type === "task" ? "task" : null;
      const registry = this.kinds();
      const dueAt = typeof record.due_at === "string" && record.due_at ? record.due_at : null;
      if (dueAt && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.test(dueAt)) { done("invalid", "due_at"); continue; }
      if (record.tier !== undefined && record.tier !== null && !isTier(record.tier)) { done("invalid", "tier"); continue; }
      try {
        assertShape(type, status, kind, registry.allowed(type));
      } catch {
        done("invalid", "status_or_kind");
        continue;
      }
      if (dryRun) { done("would_propose"); continue; }
      const entity = {
        type,
        title,
        body: typeof record.body === "string" ? record.body.slice(0, 32_000) : null,
        status,
        kind,
        due_at: dueAt,
        area_id: areaId,
        tier: isTier(record.tier) ? record.tier : null,
        source_id: sourceId,
        external_id: externalId,
        properties: { ...asObject(record.properties), import: slug },
      };
      try {
        const proposal = this.createProposal(access, { op: "create", payload: { op: "create", entity, links }, reason: `Imported from ${slug}.` }, slug, { source, sourceKey: `${slug}:${externalId}` });
        done("proposed", undefined, proposal.id);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        done(error.code === "policy_deny" ? "denied" : "invalid", error.code);
      }
    }
    if (!dryRun) this.store.persist();
    const counts: Record<string, number> = {};
    for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
    return {
      source,
      source_id: sourceId,
      dry_run: dryRun,
      counts,
      // A record waits when its area or a linked item is in this import and is not approved yet.
      next: counts.waiting ? "Approve the proposals from this import, then run the same import again." : null,
      results,
    };
  }

  pluginStatus() {
    const sources = this.store.db.query("SELECT kind FROM entities WHERE type = 'source' AND deleted_at IS NULL").all() as Array<{ kind: string | null }>;
    const installed = (kind: string) => sources.some((source) => source.kind === kind);
    return {
      plugins: [
        { id: "calendar", installed: installed("calendar"), token_configured: secretConfigured("hmn.caldav.password", "HMN_CALDAV_PASSWORD") },
        { id: "sport", installed: installed("sport"), token_configured: false },
        { id: "google", installed: installed("google"), token_configured: this.googleConfigured() },
        { id: "health", installed: installed("health"), token_configured: false },
      ],
    };
  }

  async tickPlugin(access: Access, id: string, body: Record<string, unknown>, ip: string | null) {
    assertScope(access, "write");
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
      throw new ApiError(403, "localhost", "Plugins tick on the mini itself.");
    }
    const rows = this.store.db.query("SELECT id, external_id, title, source_id, type, kind FROM entities WHERE deleted_at IS NULL").all() as Array<{ id: string; external_id: string | null; title: string; source_id: string | null; type: string; kind: string | null }>;
    const wanted = typeof body.source_id === "string" ? body.source_id : null;
    const source = rows.find((entity) => entity.type === "source" && entity.kind === id && (!wanted || entity.id === wanted)) ?? null;
    if (wanted && !source) throw new ApiError(404, "not_found", "Not found.");
    const imported = rows.filter((entity) => entity.external_id).map((entity) => ({ id: entity.id, external_id: entity.external_id, title: entity.title, source_id: entity.source_id }));
    const areas = rows.filter((entity) => entity.type === "area").map((entity) => ({ id: entity.id, title: entity.title }));
    const people = rows.filter((entity) => entity.type === "person").map((entity) => ({ id: entity.id, title: entity.title, kind: entity.kind }));
    let pluginInput: Record<string, unknown> | null = null;
    let calendar: CalendarSettings | null = null;
    // True when the text came from the address of a subscribed calendar. Whoever writes that feed writes the names in it.
    let fromFeed = false;
    if (id === "calendar") {
      calendar = source ? this.calendarSettings(source.id) : null;
      const events = Array.isArray(body.events) ? body.events : null;
      let ics = typeof body.ics === "string" ? body.ics : "";
      if (!events && !ics) {
        if (calendar?.url) {
          ics = await fetchIcs(calendar.url, null, null);
          fromFeed = true;
        } else if (process.env.HMN_CALDAV_URL) {
          const password = readPluginSecret("hmn.caldav.password", "HMN_CALDAV_PASSWORD");
          ics = await fetchIcs(process.env.HMN_CALDAV_URL, process.env.HMN_CALDAV_USERNAME ?? null, password, fetch, { allowLocal: true });
        }
        // An error page is not a calendar. Stop here, so that no mirrored event is marked as removed.
        if (!isCalendar(ics)) throw new ApiError(502, "calendar", "The calendar did not send a calendar document.");
      }
      pluginInput = {
        ...(events ? { events } : { ics }),
        people,
        // With a source, the plugin sees the mirror of that calendar only, and it sees the fields it compares.
        existing: source ? this.mirroredEvents(source.id) : imported,
        source: { id: source?.id ?? null, areaId: calendar?.areaId ?? null, tier: null },
        timeZone: this.timeZone,
        today: zoned(this.now(), this.timeZone).dateKey,
        mirror: Boolean(source),
        familyKinds: [...this.kinds().withRole("person", "family")],
      };
    } else if (id === "google") {
      const events = Array.isArray(body.events) ? body.events : await this.googleEvents();
      pluginInput = { events: events ?? [], people, existing: imported, sourceId: source?.id ?? null };
    } else if (id === "sport") {
      pluginInput = { fixtures: Array.isArray(body.fixtures) ? body.fixtures : [], existing: imported, sourceId: source?.id ?? null };
    } else if (id === "health") {
      pluginInput = { summaries: Array.isArray(body.summaries) ? body.summaries : [], include_samples: body.include_samples === true };
    } else {
      throw new ApiError(404, "not_found", "Not found.");
    }
    // A hostile feed can expand into many events. One tick files at most this many.
    const drafts = (await runPlugin(id, pluginInput, this.now().toISOString())).slice(0, PLUGIN_DRAFTS_MAX);
    const areaTiers = this.areaMap();
    const created = [];
    for (const draft of drafts) {
      // A draft names a role for its area. The owner's area with that role goes in here.
      const needed = draft.op !== "update" ? this.placeByRole(draft.entity) : null;
      if (id === "calendar" && draft.op !== "update") {
        // The tier is the calendar's own tier, and it is never below the tier of the area. A family date stays Private.
        let areaId = typeof draft.entity.area_id === "string" && areaTiers.has(draft.entity.area_id) ? draft.entity.area_id : null;
        if (!areaId && calendar?.areaId && areaTiers.has(calendar.areaId)) areaId = calendar.areaId;
        draft.entity.area_id = areaId;
        const floor = ownTier({ type: "event", tier: null, area_id: areaId }, areaTiers).tier;
        const tier = calendar?.tier ? stricterTier(calendar.tier, floor) : null;
        draft.entity.tier = needed ? stricterTier(needed, tier ?? floor) : tier;
      } else if (needed) {
        const own = isTier(draft.entity.tier) ? draft.entity.tier : "personal";
        draft.entity.tier = stricterTier(needed, own);
      }
      let proposal;
      try {
        proposal = this.createProposal(
          access,
          draft.op === "update"
            ? { op: "update", payload: { op: "update", id: draft.id, patch: draft.patch }, reason: draft.reason }
            : { op: "create", payload: { op: "create", entity: draft.entity, links: draft.links ?? [] }, reason: draft.reason },
          id,
          // From a subscribed feed, a family date or an event with a link to a person puts the feed's text in the
          // Family area at Private. It waits for the owner, also on a calendar set to auto.
          {
            source: `plugin:${id}`,
            forceReview: calendar?.approval === "review" || (fromFeed && (draft.entity.kind === "family" || (Array.isArray(draft.links) && draft.links.length > 0))),
          },
        );
      } catch (error) {
        // A deny rule drops this draft. The other drafts of the tick continue.
        if (error instanceof ApiError && error.code === "policy_deny") continue;
        throw error;
      }
      created.push({
        id: proposal && "id" in proposal ? proposal.id : null,
        op: draft.op,
        external_id: draft.entity.external_id ?? null,
        status: proposal && "status" in proposal ? String(proposal.status) : "pending",
      });
    }
    return { proposals: created };
  }

  /** The settings of one calendar source. The address is a secret, so it is stored sealed and it is never in a response. */
  private calendarSettings(sourceId: string): CalendarSettings | null {
    const row = this.raw(sourceId);
    if (!row || row.deleted_at || row.type !== "source" || row.kind !== "calendar") return null;
    const properties = this.plain(row).properties;
    const stored = properties.url;
    let url: string | null = null;
    if (typeof stored === "string" && stored) {
      url = isSealed(stored) ? (JSON.parse(openString(this.store.sealedKey, stored)) as string) : stored;
    }
    return {
      id: row.id,
      title: this.plain(row).title,
      areaId: row.area_id,
      tier: isTier(properties.event_tier) ? properties.event_tier : null,
      approval: properties.approval === "review" ? "review" : "auto",
      freeBusy: properties.free_busy === true,
      url,
    };
  }

  /** The live events that one calendar wrote, with the fields that the mirror compares. */
  private mirroredEvents(sourceId: string) {
    const rows = this.store.db
      .query("SELECT * FROM entities WHERE deleted_at IS NULL AND type = 'event' AND source_id = ? AND external_id IS NOT NULL")
      .all(sourceId) as EntityRow[];
    return rows.map((row) => {
      const plain = this.plain(row);
      return { id: row.id, external_id: row.external_id, title: plain.title, due_at: row.due_at, body: plain.body, status: row.status, properties: plain.properties };
    });
  }

  /** True for an event that a live calendar source mirrors. The calendar owns it, so HMN does not edit it. */
  private isMirrored(row: EntityRow): boolean {
    if (row.type !== "event" || !row.source_id || !row.external_id || row.content_sealed) return false;
    if (asObject(JSON.parse(row.properties || "{}")).mirror !== true) return false;
    const source = this.raw(row.source_id);
    return Boolean(source && !source.deleted_at && source.type === "source" && source.kind === "calendar");
  }

  calendars(access: Access) {
    assertScope(access, "write");
    const rows = this.store.db.query("SELECT id FROM entities WHERE deleted_at IS NULL AND type = 'source' AND kind = 'calendar' ORDER BY created_at ASC").all() as Array<{ id: string }>;
    const out = [];
    for (const row of rows) {
      const settings = this.calendarSettings(row.id);
      if (!settings) continue;
      const events = this.store.db
        .query("SELECT COUNT(*) AS n FROM entities WHERE deleted_at IS NULL AND type = 'event' AND source_id = ? AND status != 'cancelled'")
        .get(row.id) as { n: number };
      out.push({
        id: settings.id,
        title: settings.title,
        area_id: settings.areaId,
        event_tier: settings.tier,
        approval: settings.approval,
        // True when the busy times of this calendar go to a key that the owner allows.
        free_busy: settings.freeBusy,
        has_url: Boolean(settings.url),
        events: events.n,
        last_sync: this.calendarSync.get(row.id) ?? null,
      });
    }
    return { calendars: out, interval_minutes: CALENDAR_INTERVAL_MINUTES };
  }

  /** Add a calendar, or change one. `url` is the calendar's ICS address. */
  calendarSave(access: Access, id: string | null, body: Record<string, unknown>) {
    assertScope(access, "write");
    const existing = id ? this.raw(id) : null;
    if (id && (!existing || existing.deleted_at || existing.type !== "source" || existing.kind !== "calendar")) throw new ApiError(404, "not_found", "Not found.");
    const properties = existing ? { ...this.plain(existing).properties } : {};
    if ("url" in body) {
      const url = typeof body.url === "string" ? body.url.trim() : "";
      if (url && (!/^(https|webcal):\/\/[^\s]+$/i.test(url) || !calendarUrlAllowed(url))) {
        throw new ApiError(422, "bad_url", "A calendar address starts with https:// or webcal://, and it is on the internet.");
      }
      if (url) {
        properties.url = url;
        properties._privacy = { ...asObject(properties._privacy), url: "sealed" };
      } else {
        delete properties.url;
      }
    } else if (typeof properties.url === "string" && isSealed(properties.url)) {
      // Keep the stored address. It is opened here and sealed again by the write.
      properties.url = JSON.parse(openString(this.store.sealedKey, properties.url));
    }
    if ("event_tier" in body) {
      if (body.event_tier === null || body.event_tier === "") delete properties.event_tier;
      else if (isTier(body.event_tier)) properties.event_tier = body.event_tier;
      else throw new ApiError(422, "bad_tier", "Unknown tier.");
    }
    if ("approval" in body) {
      if (body.approval !== "auto" && body.approval !== "review") throw new ApiError(422, "bad_mode", "A calendar is auto or review.");
      properties.approval = body.approval;
    }
    if ("free_busy" in body) {
      if (typeof body.free_busy !== "boolean") throw new ApiError(422, "bad_value", "free_busy is true or false.");
      properties.free_busy = body.free_busy;
    }
    const input: Record<string, unknown> = { properties };
    if (typeof body.title === "string") input.title = body.title;
    if ("area_id" in body) {
      if (body.area_id !== null && !(typeof body.area_id === "string" && this.areaMap().has(body.area_id))) throw new ApiError(422, "bad_area", "Unknown area.");
      input.area_id = body.area_id;
    }
    const sourceId = existing?.id ?? randomId("source");
    if (!existing) {
      input.kind = "calendar";
      if (!input.title) input.title = "Calendar";
    }
    this.writeEntity(access, sourceId, "source", input, existing);
    this.store.persist();
    return this.calendars(access).calendars.find((item) => item.id === sourceId)!;
  }

  /** Called once a minute by the loop. It reads each calendar that has an address, at most once in an interval. A failure is recorded and does not stop the others. */
  async mirrorCalendars(force = false): Promise<Array<{ id: string; ok: boolean }>> {
    const rows = this.store.db.query("SELECT id FROM entities WHERE deleted_at IS NULL AND type = 'source' AND kind = 'calendar'").all() as Array<{ id: string }>;
    const now = this.now();
    const results: Array<{ id: string; ok: boolean }> = [];
    for (const row of rows) {
      const settings = this.calendarSettings(row.id);
      if (!settings?.url) continue;
      const last = this.calendarSync.get(row.id);
      if (!force && last && now.getTime() - Date.parse(last.at) < CALENDAR_INTERVAL_MINUTES * 60_000) continue;
      try {
        const done = await this.tickPlugin(this.mirrorAccess(), "calendar", { source_id: row.id }, "127.0.0.1");
        this.calendarSync.set(row.id, { at: now.toISOString(), ok: true, changes: done.proposals.length, error: null });
        results.push({ id: row.id, ok: true });
      } catch (error) {
        // The message of an ApiError is ours. Any other message can hold the address, so it is not kept.
        const message = error instanceof ApiError ? error.message : "The calendar did not answer.";
        this.calendarSync.set(row.id, { at: now.toISOString(), ok: false, changes: 0, error: message });
        results.push({ id: row.id, ok: false });
      }
    }
    return results;
  }

  /** The mirror writes as this principal. It can write up to Private, and it cannot open the vault. */
  private mirrorAccess(): Access {
    const principal: Principal = {
      id: "plugin:calendar",
      name: "Calendar",
      kind: "key",
      scope: "write",
      maxTier: "private",
      vault: false,
      denyAreas: [],
      allowAreas: null,
      allowTypes: null,
      forcedCeiling: "private",
    };
    return { principal, surface: "api", grant: false, ceiling: "private" };
  }

  private googleWrapPath() {
    return join(this.store.dataDir, "keys", "google.refresh.wrap");
  }

  private googleConfigured() {
    return existsSync(this.googleWrapPath());
  }

  private async googleEvents() {
    if (!this.googleConfigured()) return [];
    const clientId = readPluginSecret("hmn.google.client_id", "HMN_GOOGLE_CLIENT_ID");
    const clientSecret = readPluginSecret("hmn.google.client_secret", "HMN_GOOGLE_CLIENT_SECRET");
    if (!clientId || !clientSecret) return [];
    const refresh = aesDecrypt(this.store.sealedKey, readFileSync(this.googleWrapPath())).toString("utf8");
    const access = await refreshGoogleAccess({ refreshToken: refresh, clientId, clientSecret });
    return listGoogleEvents(access);
  }

  googleStart(ip: string | null, redirect: string) {
    if (!isLoopback(ip)) throw new ApiError(403, "localhost", "Google sign-in starts on the mini.");
    const clientId = readPluginSecret("hmn.google.client_id", "HMN_GOOGLE_CLIENT_ID");
    if (!clientId) throw new ApiError(404, "not_configured", "Set the Google client id on the mini.");
    return { url: googleAuthURL(clientId, redirect, randomId("state")), scope: GOOGLE_SCOPE };
  }

  async googleCallback(ip: string | null, code: string, redirect: string) {
    if (!isLoopback(ip)) throw new ApiError(403, "localhost", "Google sign-in finishes on the mini.");
    const clientId = readPluginSecret("hmn.google.client_id", "HMN_GOOGLE_CLIENT_ID");
    const clientSecret = readPluginSecret("hmn.google.client_secret", "HMN_GOOGLE_CLIENT_SECRET");
    if (!clientId || !clientSecret) throw new ApiError(404, "not_configured", "Set the Google client on the mini.");
    const tokens = await exchangeGoogleCode({ code, clientId, clientSecret, redirect });
    if (!tokens.refresh_token) throw new ApiError(422, "no_refresh", "Google did not return an offline token.");
    writeFileSync(this.googleWrapPath(), aesEncrypt(this.store.sealedKey, Buffer.from(tokens.refresh_token, "utf8")), { mode: 0o600 });
    return { configured: true };
  }

  auditTip() {
    const row = this.store.db.query("SELECT seq, hash, at FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string; at: string } | null;
    return { seq: row?.seq ?? 0, hash: row?.hash ?? "0".repeat(64), at: row?.at ?? null };
  }

  auditExtends(previous: string) {
    const tip = this.auditTip();
    if (!previous) return { ok: true, rewritten: false, tip: tip.hash };
    const found = this.store.db.query("SELECT seq FROM audit_log WHERE hash = ?").get(previous) as { seq: number } | null;
    return { ok: Boolean(found), rewritten: !found, tip: tip.hash };
  }

  me(access: Access) {
    const selfKinds = this.kinds().withRole("person", "self");
    const self = this.visible(access).find((view) => view.type === "person" && view.kind !== null && selfKinds.has(view.kind));
    return {
      credential: {
        id: access.principal.id,
        name: access.principal.name,
        kind: access.principal.kind,
        scope: access.principal.scope,
        max_tier: access.principal.maxTier,
        vault: access.principal.vault,
        deny_areas: access.principal.denyAreas,
        forced_ceiling: access.principal.forcedCeiling,
        expires_at: this.expiresOf(access.principal.id),
      },
      surface: access.surface,
      ceiling: access.ceiling,
      owner_name: access.principal.member ? null : self?.title ?? null,
      // A member's phone shows the member mode of the app: Home, Lists, and Family.
      member: access.principal.member ? { role: access.principal.member.role, person_id: access.principal.member.personId, name: access.principal.name } : null,
    };
  }

  /** Who Home greets: the member, or the owner's own person. */
  private homeOwner(access: Access, views: Map<string, EntityView>): { personId: string | null; name: string; role: string } {
    if (access.principal.member) return { personId: access.principal.member.personId, name: access.principal.name, role: access.principal.member.role };
    const selfKinds = this.kinds().withRole("person", "self");
    const self = [...views.values()].find((view) => view.type === "person" && view.kind !== null && selfKinds.has(view.kind));
    // The owner sees the household's Home as a partner does: every child's routines.
    return { personId: self?.id ?? null, name: self?.title ?? "you", role: PARTNER_ROLE };
  }

  /**
   * The yearly review of one calendar year, and the owner's note for it. A year with no record still answers,
   * with an empty card. `years` lists each year from the first row to now, the newest first.
   */
  yearReview(access: Access, year: number | null) {
    const zone = zoned(this.now(), this.timeZone);
    const current = Number(zone.dateKey.slice(0, 4));
    const wanted = year ?? current;
    if (!Number.isInteger(wanted) || wanted < 1970 || wanted > current) throw new ApiError(422, "year", "Pick a year up to this one.");
    const input = this.screenInput(access);
    const selfKinds = this.kinds().withRole("person", "self");
    const selfIds = new Set([...input.views.values()].filter((view) => view.type === "person" && view.kind !== null && selfKinds.has(view.kind)).map((view) => view.id));
    const review = buildYear(input, wanted, selfIds);
    for (const id of review.entity_ids) {
      const view = input.views.get(id);
      if (view) this.noteRead(access, view);
    }
    const note = this.yearNote(input.views, wanted);
    if (note) this.noteRead(access, note);
    const first = [...input.views.values()].reduce((min, view) => Math.min(min, yearOf(view.created_at, this.timeZone)), current);
    const years: number[] = [];
    for (let y = current; y >= first; y--) years.push(y);
    return { ...review, note, years };
  }

  /** The owner writes the note of a year. It is a Private note, and the review shows it above the record. */
  saveYearNote(access: Access, year: number, input: Record<string, unknown>) {
    assertScope(access, "write");
    if (access.principal.member || access.principal.external) throw new ApiError(403, "forbidden", "Only the owner writes the note of a year.");
    const current = Number(zoned(this.now(), this.timeZone).dateKey.slice(0, 4));
    if (!Number.isInteger(year) || year < 1970 || year > current) throw new ApiError(422, "year", "Pick a year up to this one.");
    const body = typeof input.body === "string" ? input.body : "";
    const existing = this.yearNote(new Map(this.visible(access).map((view) => [view.id, view])), year);
    if (existing) {
      const view = this.update(access, "note", existing.id, { body });
      return view;
    }
    return this.create(access, "note", { title: `The year ${year}`, body, status: "open", kind: "review", tier: "private", properties: { year_review: year } });
  }

  private yearNote(views: Map<string, EntityView>, year: number): EntityView | null {
    return [...views.values()].find((view) => view.type === "note" && view.properties.year_review === year && view.status !== "archived") ?? null;
  }

  /** The person page: the next dates, the open tasks, the notes, and the things linked to a person. */
  personPage(access: Access, id: string): PersonPage & { routines: ReturnType<Hmn["routines"]> } {
    const person = this.get(access, "person", id);
    const views = new Map(this.visible(access).map((view) => [view.id, view]));
    const rows = this.store.db.query("SELECT * FROM links WHERE deleted_at IS NULL AND (from_id = ? OR to_id = ?)").all(id, id) as LinkRow[];
    const page = buildPersonPage({ person, links: projectLinks(id, rows, views), views, now: this.now(), timeZone: this.timeZone, ...this.personKind(person) });
    for (const section of [page.next, page.tasks, page.done, page.notes, page.things, page.people, page.other]) for (const row of section) this.noteRead(access, row.entity);
    const routines = this.routines(access).filter((entry) => entry.for.some((peer) => peer.id === id));
    return { ...page, routines };
  }

  /** Every person, with one line: the relation, and the next date with them. Organisations come last. */
  people(access: Access) {
    const views = this.visible(access);
    const byId = new Map(views.map((view) => [view.id, view]));
    const all = this.store.db.query("SELECT * FROM links WHERE deleted_at IS NULL").all() as LinkRow[];
    const out = views
      .filter((view) => view.type === "person" && view.status !== "archived")
      .map((person) => {
        const rows = all.filter((link) => link.from_id === person.id || link.to_id === person.id);
        const page = buildPersonPage({ person, links: projectLinks(person.id, rows, byId), views: byId, now: this.now(), timeZone: this.timeZone, ...this.personKind(person) });
        return { person, line: page.line, organisation: page.organisation };
      });
    out.sort((a, b) => Number(a.organisation) - Number(b.organisation) || a.person.title.localeCompare(b.person.title));
    for (const entry of out) this.noteRead(access, entry.person);
    return out;
  }

  private personKind(person: EntityView): { kindTitle: string | null; organisation: boolean } {
    const kinds = this.kinds();
    const row = kinds.list().find((kind) => kind.type === "person" && kind.kind === person.kind);
    return { kindTitle: row?.title ?? null, organisation: person.kind !== null && kinds.withRole("person", "organisation").has(person.kind) };
  }

  /**
   * The family tasks: each task that is for one person or more, with those people and its steps. Open tasks come
   * first, by date. Then the tasks done in the last 14 days, the newest first. docs/ONTOLOGY.md, section 2.5.
   */
  familyTasks(access: Access) {
    const views = this.visible(access);
    const byId = new Map(views.map((view) => [view.id, view]));
    const links = this.store.db.query("SELECT * FROM links WHERE deleted_at IS NULL AND rel = 'for'").all() as LinkRow[];
    const now = this.now().getTime();
    const out: Array<{ task: EntityView; for: Array<{ id: string; title: string }>; steps: { open: number; done: number } }> = [];
    for (const task of views) {
      if (task.type !== "task" || task.kind === "item") continue;
      const people = links
        .filter((link) => link.from_id === task.id)
        .map((link) => byId.get(link.to_id))
        .filter((peer): peer is EntityView => Boolean(peer && peer.type === "person"))
        .map((peer) => ({ id: peer.id, title: peer.title }));
      if (!people.length) continue;
      if (task.status === "done") {
        const at = Date.parse(String(task.properties.done_at ?? task.updated_at));
        if (now - at > 14 * 86_400_000) continue;
      }
      const steps = this.itemsUnder(byId, task.id);
      out.push({ task, for: people, steps: { open: steps.filter((step) => step.status !== "done").length, done: steps.filter((step) => step.status === "done").length } });
    }
    const due = (entry: { task: EntityView }) => String(entry.task.due_at ?? "9999");
    const done = (entry: { task: EntityView }) => String(entry.task.properties.done_at ?? entry.task.updated_at);
    const open = out.filter((entry) => entry.task.status !== "done").sort((a, b) => due(a).localeCompare(due(b)));
    const closed = out.filter((entry) => entry.task.status === "done").sort((a, b) => done(b).localeCompare(done(a)));
    const tasks = [...open, ...closed];
    for (const entry of tasks) this.noteRead(access, entry.task);
    return tasks;
  }

  /**
   * A pairing code makes a device that reads Private and opens the vault. So the caller is on the mini, and it
   * holds the owner key. A process on the mini with no key gets nothing.
   */
  private expiresOf(id: string): string | null {
    return (this.store.db.query("SELECT expires_at FROM credentials WHERE id = ?").get(id) as { expires_at: string | null } | null)?.expires_at ?? null;
  }

  /**
   * For the restore tool: revoke each owner key of the restored graph and make a new one. The person who
   * restores has the paper passphrase, and may have lost the old owner key with the old Mac.
   */
  recoverOwner(): string {
    const now = this.now().toISOString();
    const old = this.store.db.query("SELECT id FROM credentials WHERE kind = 'key' AND scope = 'write' AND (external IS NULL OR external = 0) AND revoked_at IS NULL").all() as Array<{ id: string }>;
    for (const row of old) {
      this.store.db.query("UPDATE credentials SET revoked_at = ? WHERE id = ?").run(now, row.id);
      this.appendAudit({ actor: "restore", action: "revoke", tier: null, entity_type: "credential", entity_id: row.id, surface: "api" });
    }
    const secret = randomSecret();
    const id = randomId("key");
    const expires = new Date(this.now().getTime() + KEY_DAYS_DEFAULT * 86_400_000).toISOString();
    this.store.db
      .query(
        `INSERT INTO credentials (
          id, name, kind, key_hash, scope, max_tier, vault, allow_types, allow_areas, deny_areas,
          forced_ceiling, expires_at, created_at, revoked_at, rotated_from
        ) VALUES (?, 'owner', 'key', ?, 'write', 'private', 0, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
      )
      .run(id, sha256hex(secret), expires, now);
    this.appendAudit({ actor: "restore", action: "owner_recovered", tier: null, entity_type: "credential", entity_id: id, surface: "api" });
    this.store.persist(true);
    return secret;
  }

  /** A new secret and a new end date for the owner key, on the mini. The old secret stops at once. */
  renewOwner(access: Access, ip: string | null) {
    if (!isLoopback(ip)) throw new ApiError(403, "localhost", "The owner key is renewed on the mini itself.");
    if (access.principal.kind !== "key" || access.principal.scope !== "write" || access.principal.external) {
      throw new ApiError(403, "forbidden", "Only the owner key renews itself here. A phone pairs again.");
    }
    return this.rotate(access, ip, access.principal.id);
  }

  createPairing(access: Access, ip: string | null, fingerprint: string) {
    if (!isLoopback(ip)) throw new ApiError(403, "localhost", "Pairing codes are created on the mini itself.");
    assertScope(access, "write");
    assertNotHidden(access);
    const code = randomCode();
    const expires = new Date(this.now().getTime() + 10 * 60_000).toISOString();
    this.store.db
      .query("INSERT INTO pairing_codes (id, code_hash, expires_at, used_at, created_at, created_by) VALUES (?, ?, ?, NULL, ?, ?)")
      .run(randomId("pair"), sha256hex(code), expires, this.now().toISOString(), access.principal.id);
    this.appendAudit({ actor: access.principal.id, action: "pair", tier: null, entity_type: null, entity_id: null, surface: "api" });
    this.store.persist();
    return {
      code,
      expires_at: expires,
      payload: pairingLink(code, fingerprint, null),
    };
  }

  redeemPair(typed: string, deviceName: string, ip: string | null) {
    const subject = lockSubject("main", ip);
    this.assertUnlocked(subject);
    // A person types the code on a phone keyboard: small letters, a space, or a hyphen. The code has capitals and
    // digits only, so this changes nothing that matters, and the same code is accepted.
    const code = typed.toUpperCase().replace(/[\s-]/g, "");
    const row = this.store.db
      .query("SELECT * FROM pairing_codes WHERE code_hash = ?")
      .get(sha256hex(code)) as { id: string; expires_at: string; used_at: string | null; created_by?: string | null; member_role?: string | null; person_id?: string | null } | null;
    const now = this.now().toISOString();
    if (!row || row.used_at || row.expires_at <= now) {
      this.recordFailure(subject);
      throw new ApiError(401, "unauthorized", "That code did not work. Make a new one on your HMN. A code works once, for ten minutes.");
    }
    this.store.db.query("UPDATE pairing_codes SET used_at = ? WHERE id = ?").run(now, row.id);
    // A used code leaves the fridge at its next picture.
    if (this.fridgePairing?.codeHash === sha256hex(code)) this.fridgePairing = null;
    if (row.member_role && row.person_id) return this.redeemMember(row as { member_role: string; person_id: string; created_by?: string | null }, ip);
    const secret = randomSecret();
    const id = randomId("device");
    const expires = new Date(this.now().getTime() + 90 * 86_400_000).toISOString();
    this.store.db
      .query(
        `INSERT INTO credentials (
          id, name, kind, key_hash, scope, max_tier, vault, allow_types, allow_areas, deny_areas,
          forced_ceiling, expires_at, created_at, revoked_at, rotated_from, created_by
        ) VALUES (?, ?, 'device', ?, 'write', 'private', 1, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, ?)`,
      )
      .run(id, deviceName.slice(0, 80) || "iPhone", sha256hex(secret), expires, now, row.created_by ?? null);
    this.appendAudit({ actor: id, action: "pair", tier: null, entity_type: "device", entity_id: id, surface: "api" });
    this.store.persist();
    return { secret, credential: { id, name: deviceName || "iPhone", scope: "write", max_tier: "private", vault: true } };
  }

  /**
   * Revoke one credential. The keys that it made are revoked with it: a key of an agent, a view key, and the key
   * of an outside client. A phone that it paired stays, because the owner revokes a phone by name.
   */
  revoke(access: Access, id: string) {
    assertScope(access, "write");
    const also: Array<{ id: string; name: string }> = [];
    const done = new Set<string>();
    const queue = [id];
    while (queue.length) {
      const next = queue.shift()!;
      if (done.has(next)) continue;
      done.add(next);
      const made = this.store.db
        .query("SELECT id, name FROM credentials WHERE created_by = ? AND (kind = 'key' OR member_role IS NOT NULL) AND revoked_at IS NULL")
        .all(next) as Array<{ id: string; name: string }>;
      const was = this.revokeOne(next);
      if (next !== id && was) also.push({ id: next, name: was.replace(/^external:/, "") });
      for (const row of made) queue.push(row.id);
      this.appendAudit({ actor: access.principal.id, action: "revoke", tier: null, entity_type: "credential", entity_id: next, surface: access.surface });
    }
    this.store.persist();
    return { id, revoked: true, also_revoked: also };
  }

  /** The name of the credential when this call revoked it. Null when it was not live. */
  private revokeOne(id: string): string | null {
    const target = this.store.db.query("SELECT name, scope, external FROM credentials WHERE id = ? AND revoked_at IS NULL").get(id) as { name: string; scope: string; external: number | null } | null;
    if (!target) return null;
    // The key of a view that the owner made has an id that starts with `view_`. The display key of the first boot does not.
    if (target.scope === "read" && id.startsWith("view_") && /^[a-z][a-z0-9-]{0,39}$/.test(target.name)) forgetViewKey(target.name);
    this.store.db.query("UPDATE credentials SET revoked_at = ?, private_until = NULL WHERE id = ? AND revoked_at IS NULL").run(this.now().toISOString(), id);
    this.store.db.query("UPDATE trmnl_devices SET status = 'revoked', key_pending = NULL, setup_ip = NULL, conflict = 0 WHERE credential_id = ?").run(id);
    // The key of a local agent is also in the Keychain of the mini. It goes with the key.
    if (target.scope === "agent" && target.external !== 1 && /^[a-z][a-z0-9-]{0,39}$/.test(target.name)) forgetAgentKey(target.name);
    return target.name;
  }

  /**
   * A new secret for one credential. The old secret stops at once. A credential renews its own secret. For
   * another credential, the caller is on the mini with the owner key: a phone cannot take the secret of a key.
   * The new credential keeps each limit of the old one, also Hide and the marks of an outside client.
   */
  rotate(access: Access, ip: string | null, id: string) {
    const row = this.store.db.query("SELECT * FROM credentials WHERE id = ?").get(id) as CredentialRow | null;
    const self = access.principal.id === id;
    if (!self) {
      assertScope(access, "write");
      if (!isLoopback(ip)) throw new ApiError(403, "localhost", "A key gets a new secret on the mini itself.");
      assertNotHidden(access);
    }
    if (!row || row.revoked_at) throw new ApiError(404, "not_found", "Not found.");
    const secret = randomSecret();
    const now = this.now().toISOString();
    const newId = randomId(row.kind);
    // The owner key that renews itself gets a new end date. Each other credential keeps its end date.
    const owner = self && row.kind === "key" && row.scope === "write" && row.external !== 1;
    const expires = owner ? new Date(this.now().getTime() + KEY_DAYS_DEFAULT * 86_400_000).toISOString() : row.expires_at;
    this.store.db.query("UPDATE credentials SET revoked_at = ?, private_until = NULL WHERE id = ?").run(now, id);
    this.store.db
      .query(
        `INSERT INTO credentials (
          id, name, kind, key_hash, scope, max_tier, vault, allow_types, allow_areas, deny_areas,
          forced_ceiling, expires_at, created_at, revoked_at, rotated_from, external, guest, free_busy, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId,
        row.name,
        row.kind,
        sha256hex(secret),
        row.scope,
        row.max_tier,
        row.vault,
        row.allow_types,
        row.allow_areas,
        row.deny_areas,
        row.forced_ceiling,
        expires,
        now,
        id,
        row.external ?? 0,
        row.guest ?? 0,
        row.free_busy ?? 0,
        row.created_by ?? null,
      );
    // What the old credential made now belongs to the new one, so a later revoke still finds it.
    this.store.db.query("UPDATE credentials SET created_by = ? WHERE created_by = ?").run(newId, id);
    this.store.db.query("UPDATE pairing_codes SET created_by = ? WHERE created_by = ?").run(newId, id);
    this.appendAudit({ actor: access.principal.id, action: "rotate", tier: null, entity_type: "credential", entity_id: newId, surface: access.surface });
    this.store.persist();
    return { id: newId, secret, name: row.name, scope: row.scope, max_tier: row.max_tier, expires_at: expires };
  }

  mintGrant(access: Access) {
    if (access.principal.external) throw new ApiError(403, "external", "An outside client cannot open the vault.");
    if (!access.principal.vault) throw new ApiError(403, "forbidden", "This credential cannot open the vault.");
    const secret = randomSecret();
    const expires = new Date(this.now().getTime() + 5 * 60_000).toISOString();
    this.store.db
      .query("INSERT INTO vault_grants (id, grant_hash, credential_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomId("grant"), sha256hex(secret), access.principal.id, expires, this.now().toISOString());
    this.appendAudit({
      actor: access.principal.id,
      action: "grant",
      tier: "sealed",
      entity_type: null,
      entity_id: null,
      surface: access.surface,
    });
    this.store.persist();
    return { grant: secret, expires_at: expires };
  }

  /**
   * Hide is for a paired phone. The owner key is not a device: if it could hide itself, no key could show the
   * data again.
   */
  panic(access: Access) {
    if (access.principal.kind !== "device") throw new ApiError(409, "not_a_device", "Hide is for a paired phone. The owner key stays as it is.");
    this.store.db.query("UPDATE credentials SET forced_ceiling = 'public' WHERE id = ?").run(access.principal.id);
    // Hide on the phone that put a code on the fridge takes the code off too.
    if (this.fridgePairing?.createdBy === access.principal.id) this.endFridgePairing();
    this.appendAudit({ actor: access.principal.id, action: "panic", tier: "public", entity_type: "credential", entity_id: access.principal.id, surface: access.surface });
    this.store.persist();
    return { forced_ceiling: "public" };
  }

  /**
   * Show one hidden credential again. A hidden credential cannot do this for itself: the person who holds a hidden
   * phone must not be able to undo Hide. The caller is on the mini, with a write key that is not hidden.
   */
  clearPanic(access: Access, ip: string | null, id: string) {
    if (!isLoopback(ip)) throw new ApiError(403, "localhost", "Hide ends on your HMN, from its menu bar.");
    assertScope(access, "write");
    assertNotHidden(access);
    const row = this.store.db.query("SELECT id FROM credentials WHERE id = ? AND kind = 'device' AND revoked_at IS NULL AND forced_ceiling IS NOT NULL").get(id) as { id: string } | null;
    if (!row) throw new ApiError(404, "not_found", "Not found.");
    this.store.db.query("UPDATE credentials SET forced_ceiling = NULL WHERE id = ?").run(id);
    this.appendAudit({ actor: access.principal.id, action: "panic_clear", tier: null, entity_type: "credential", entity_id: id, surface: access.surface });
    this.store.persist();
    return { id, forced_ceiling: null };
  }

  auditList(access: Access) {
    assertCanSeeTier(access, "private");
    if (access.surface === "display" || access.surface === "widget" || access.surface === "lock") {
      throw new ApiError(404, "not_found", "Not found.");
    }
    return this.store.db
      .query(
        "SELECT seq, at, actor, action, tier, entity_type, entity_id, surface FROM audit_log ORDER BY seq DESC LIMIT 200",
      )
      .all();
  }

  verifyAudit() {
    const rows = this.store.db.query("SELECT * FROM audit_log ORDER BY seq ASC").all() as Array<Record<string, unknown>>;
    let prev = AUDIT_GENESIS;
    for (const row of rows) {
      if (row.prev_hash !== prev) return { ok: false, tip: prev };
      const hash = hashAudit(row);
      if (hash !== row.hash) return { ok: false, tip: prev };
      prev = String(row.hash);
    }
    const versions = this.store.db.query("SELECT * FROM entity_versions").all() as VersionRow[];
    for (const version of versions) {
      if (versionHash(version) !== version.hash) return { ok: false, tip: prev };
      const linked = this.store.db.query("SELECT prev_hash FROM audit_log WHERE subject_hash = ?").get(version.hash) as { prev_hash: string } | null;
      if (!linked || linked.prev_hash !== version.prev_hash) return { ok: false, tip: prev };
    }
    // Each head row must be its newest version. An edit of the head row with no new version is a tamper that the
    // hash chain alone does not see.
    const heads = this.store.db.query("SELECT * FROM entities").all() as EntityRow[];
    for (const head of heads) {
      const tipId = this.headVersionId(head.id);
      const tip = tipId ? (this.store.db.query("SELECT * FROM entity_versions WHERE id = ?").get(tipId) as VersionRow | null) : null;
      if (!tip) return { ok: false, tip: prev, entity: head.id };
      const same =
        tip.title === head.title && tip.body === head.body && tip.status === head.status && tip.kind === head.kind &&
        tip.due_at === head.due_at && tip.area_id === head.area_id && tip.properties === head.properties &&
        (tip.tier ?? null) === (head.tier ?? null) && Number(tip.content_sealed) === Number(head.content_sealed) &&
        Boolean(tip.tombstone) === Boolean(head.deleted_at);
      if (!same) return { ok: false, tip: prev, entity: head.id };
    }
    return { ok: true, tip: prev, rows: rows.length };
  }

  backup(access: Access, ip: string | null) {
    if (!isLoopback(ip)) throw new ApiError(403, "localhost", "Backups are taken on the mini itself.");
    assertScope(access, "write");
    return { name: this.writeBackup() };
  }

  /**
   * The daily backup, from the worker loop. It writes one backup when the newest is a day old, keeps the newest
   * BACKUPS_KEPT, and copies each new backup to `HMN_BACKUP_COPY_DIR` when the owner set it: a second disk, so that
   * the backups do not die with the disk of the mini.
   */
  backupIfDue(): string | null {
    const names = this.backupNames().sort();
    const newest = names.at(-1);
    const dayAgo = this.now().getTime() - 86_400_000;
    if (newest && statSync(join(this.store.dataDir, "backups", newest)).mtimeMs > dayAgo && backupTime(newest) > dayAgo) return null;
    const name = this.writeBackup();
    const all = this.backupNames().sort();
    for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) rmSync(join(this.store.dataDir, "backups", old), { force: true });
    const copyDir = process.env.HMN_BACKUP_COPY_DIR;
    if (copyDir) {
      try {
        mkdirSync(copyDir, { recursive: true, mode: 0o700 });
        copyFileSync(join(this.store.dataDir, "backups", name), join(copyDir, name));
        const copies = readdirSync(copyDir).filter((item) => BACKUP_NAME.test(item)).sort();
        for (const old of copies.slice(0, Math.max(0, copies.length - BACKUPS_KEPT))) rmSync(join(copyDir, old), { force: true });
      } catch {
        console.error("hmn could not copy the backup to HMN_BACKUP_COPY_DIR");
      }
    }
    return name;
  }

  private writeBackup(): string {
    this.store.persist();
    const plain = this.store.plainBytes();
    const body = Buffer.concat([
      Buffer.from("HMN1"),
      uint32(this.store.sealedKey.length),
      this.store.sealedKey,
      uint32(plain.length),
      plain,
    ]);
    const blob = encryptBackup(this.store.backupPassphrase, body);
    const dir = join(this.store.dataDir, "backups");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `backup-${this.now().toISOString().replace(/[:.]/g, "")}.hmn`;
    writeFileSync(join(dir, name), blob, { mode: 0o600 });
    return name;
  }

  private inboxAttachments(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 8).map((item) => {
      const row = asObject(item);
      const kind = typeof row.kind === "string" ? row.kind.slice(0, 40) : "file";
      const name = typeof row.name === "string" ? row.name.slice(0, 200) : kind;
      const contentType = typeof row.content_type === "string" ? row.content_type.slice(0, 80) : "application/octet-stream";
      const data = typeof row.data_base64 === "string" ? row.data_base64.slice(0, 200_000) : undefined;
      return { kind, name, content_type: contentType, ...(data ? { data_base64: data } : {}) };
    });
  }

  private packInbox(body: string, tags: string[], attachments: unknown, url: string | null, tier: Tier) {
    if (tier !== "sealed") {
      return { body, tags: JSON.stringify(tags), attachments: JSON.stringify(attachments), url, content_sealed: 0 };
    }
    const key = this.store.sealedKey;
    return {
      body: sealString(key, body),
      tags: sealString(key, JSON.stringify(tags)),
      attachments: sealString(key, JSON.stringify(attachments)),
      url: url ? sealString(key, url) : null,
      content_sealed: 1,
    };
  }

  private tierForTags(tags: string[], tier: Tier, body = ""): Tier {
    const areas = this.areaMap();
    const rows = this.store.db
      .query("SELECT type, title, kind, area_id, tier, properties FROM entities WHERE deleted_at IS NULL AND type IN ('area', 'person', 'project')")
      .all() as Array<{ type: string; title: string; kind: string | null; area_id: string | null; tier: Tier | null; properties: string }>;
    for (const row of rows) {
      const names = new Set<string>([slug(row.title)]);
      if (row.kind) names.add(row.kind);
      const tagged = tags.some((tag) => names.has(tag) || (tag.startsWith("area/") && names.has(tag.slice("area/".length))));
      if (tagged || mentionsTitle(body, row.title)) {
        const next = row.type === "area" ? childTierOf(asObject(JSON.parse(row.properties || "{}"))) : ownTier(row, areas).tier;
        tier = stricterTier(tier, next);
      }
    }
    return tier;
  }

  private inboxRow(id: string): InboxRow | null {
    return (this.store.db.query("SELECT * FROM inbox_items WHERE id = ?").get(id) as InboxRow | null) ?? null;
  }

  private openInbox(row: InboxRow) {
    const key = this.store.sealedKey;
    const body = row.content_sealed ? openString(key, row.body ?? "") : row.body ?? "";
    const attachments = JSON.parse(row.content_sealed ? openString(key, row.attachments) : row.attachments || "[]");
    const tags = JSON.parse(row.content_sealed ? openString(key, row.tags) : row.tags || "[]") as string[];
    const url = row.url && row.content_sealed ? openString(key, row.url) : row.url;
    return { ...row, body, attachments, tags, url, tier: row.tier as Tier };
  }

  private suggestionFor(tags: string[], access: Access, body = ""): InboxSuggestion | null {
    const visible = this.visible(access);
    const areas = visible.filter((entity) => entity.type === "area").map((entity) => ({ id: entity.id, title: entity.title, kind: entity.kind }));
    const projects = visible.filter((entity) => entity.type === "project").map((entity) => ({ id: entity.id, title: entity.title }));
    const people = visible.filter((entity) => entity.type === "person").map((entity) => ({ id: entity.id, title: entity.title }));
    return suggestRoute(tags, areas, projects, people, body);
  }

  private projectInboxRow(row: InboxRow, access: Access): InboxView | null {
    if (row.deleted_at) return null;
    // An inbox item has no type and no area. A key that the owner limited to some types or some areas does not read it.
    if (access.principal.allowTypes || access.principal.allowAreas) return null;
    const tier = row.tier as Tier;
    if (!covers(access.ceiling, tier)) return null;
    const open = this.openInbox(row);
    return {
      id: row.id,
      body: open.body,
      url: open.url,
      tags: open.tags,
      tier,
      source: row.source,
      status: row.status,
      attachments: open.attachments,
      suggestion: row.status === "new" ? this.suggestionFor(open.tags, access, open.body) : null,
      result_type: row.result_type,
      result_id: row.result_id,
      origin: row.origin,
      origin_ref: row.origin_ref,
      captured_at: row.captured_at,
    };
  }

  private materialiseInbox(access: Access, item: { id: string; body: string; tier: Tier; tags: string[] }, suggestion: InboxSuggestion) {
    const title = titleFromBody(item.body);
    const originRef = `inbox:${item.id}`;
    if (suggestion.route === "person") {
      const id = randomId("person");
      this.writeEntity(access, id, "person", { title, kind: "other", tier: item.tier }, null, "owner", originRef);
      return { type: "person", id };
    }
    if (suggestion.route === "note") {
      const id = randomId("note");
      this.writeEntity(access, id, "note", { title, body: item.body, status: "open", kind: "note", tier: item.tier }, null, "owner", originRef);
      return { type: "note", id };
    }
    if (suggestion.route === "reading") {
      const id = randomId("note");
      this.writeEntity(access, id, "note", { title, body: item.body, status: "open", kind: "reading", tier: item.tier, properties: { reading: true } }, null, "owner", originRef);
      return { type: "note", id };
    }
    if (suggestion.route === "file" && suggestion.entity_id) {
      return { type: suggestion.entity_type ?? "area", id: suggestion.entity_id };
    }
    const id = randomId("task");
    const areaId = suggestion.entity_type === "area" ? suggestion.entity_id : null;
    const area = areaId ? this.areaMap().get(areaId) : undefined;
    const tier = area ? stricterTier(item.tier, area.childTier) : item.tier;
    this.writeEntity(access, id, "task", { title, body: item.body, status: "open", kind: "task", area_id: areaId, tier }, null, "owner", originRef);
    if (suggestion.entity_type === "project" && suggestion.entity_id) {
      const project = this.mustLive(suggestion.entity_id);
      this.store.db
        .query(
          `INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, origin, origin_ref, tier, created_at, deleted_at)
           VALUES (?, 'task', ?, ?, ?, 'part_of', 'owner', ?, NULL, ?, NULL)`,
        )
        .run(randomId("link"), id, project.type, project.id, originRef, this.now().toISOString());
    }
    return { type: "task", id };
  }

  adminStatus(access: Access, ip: string | null, fingerprint: string) {
    this.requireLocalWrite(access, ip);
    const counts = this.store.db
      .query(
        `SELECT
           COALESCE(SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END), 0) AS paired,
           COALESCE(SUM(CASE WHEN revoked_at IS NULL AND forced_ceiling = 'public' THEN 1 ELSE 0 END), 0) AS hidden
         FROM credentials WHERE kind = 'device'`,
      )
      .get() as { paired: number; hidden: number };
    const backups = this.backupNames().length;
    return {
      ok: true,
      service: "hmn",
      version: VERSION,
      time: this.now().toISOString(),
      fingerprint,
      devices: { paired: Number(counts.paired) || 0, hidden: Number(counts.hidden) || 0 },
      backups,
    };
  }

  adminDevices(access: Access, ip: string | null) {
    this.requireLocalWrite(access, ip);
    const devices = this.store.db
      .query(
        `SELECT id, name, scope, max_tier, forced_ceiling, expires_at, created_at, revoked_at
         FROM credentials WHERE kind = 'device' ORDER BY created_at DESC LIMIT 50`,
      )
      .all();
    return { devices };
  }

  adminPanic(access: Access, ip: string | null) {
    this.requireLocalWrite(access, ip);
    const rows = this.store.db
      .query("SELECT id FROM credentials WHERE kind = 'device' AND revoked_at IS NULL")
      .all() as Array<{ id: string }>;
    this.store.db
      .query("UPDATE credentials SET forced_ceiling = 'public' WHERE kind = 'device' AND revoked_at IS NULL")
      .run();
    for (const row of rows) {
      this.appendAudit({
        actor: access.principal.id,
        action: "panic",
        tier: "public",
        entity_type: "credential",
        entity_id: row.id,
        surface: access.surface,
      });
    }
    this.store.persist();
    return { hidden: rows.length };
  }

  adminClearPanic(access: Access, ip: string | null) {
    this.requireLocalWrite(access, ip);
    assertNotHidden(access);
    const rows = this.store.db
      .query("SELECT id FROM credentials WHERE kind = 'device' AND forced_ceiling IS NOT NULL")
      .all() as Array<{ id: string }>;
    this.store.db.query("UPDATE credentials SET forced_ceiling = NULL WHERE kind = 'device' AND forced_ceiling IS NOT NULL").run();
    for (const row of rows) {
      this.appendAudit({
        actor: access.principal.id,
        action: "panic_clear",
        tier: null,
        entity_type: "credential",
        entity_id: row.id,
        surface: access.surface,
      });
    }
    this.store.persist();
    return { hidden: 0, cleared: rows.length };
  }

  adminBackups(access: Access, ip: string | null) {
    this.requireLocalWrite(access, ip);
    const backups = this.backupNames().map((name) => {
      const info = statSync(join(this.store.dataDir, "backups", name));
      return { name, bytes: info.size, modified_at: info.mtime.toISOString() };
    });
    backups.sort((a, b) => (a.modified_at < b.modified_at ? 1 : -1));
    return { backups };
  }

  adminRestore(access: Access, ip: string | null, body: Record<string, unknown>) {
    this.requireLocalWrite(access, ip);
    const name = typeof body.name === "string" ? body.name : "";
    if (!BACKUP_NAME.test(name)) throw new ApiError(422, "invalid", "Name a backup from this mini.");
    const path = join(this.store.dataDir, "backups", name);
    if (!existsSync(path)) throw new ApiError(404, "not_found", "Not found.");
    const blob = readFileSync(path);
    if (blob.length > 256_000_000) throw new ApiError(422, "too_large", "That backup is too large.");
    let plain: Buffer;
    try {
      plain = decryptBackup(this.store.backupPassphrase, blob);
    } catch {
      throw new ApiError(422, "invalid", "That backup could not be opened.");
    }
    const parsed = parseBackupBody(plain);
    // A backup is older than the live graph. A credential that was revoked or hidden since then stays so, and the
    // head of the live audit chain is kept in the restored chain.
    const revoked = this.store.db.query("SELECT id, key_hash, revoked_at FROM credentials WHERE revoked_at IS NOT NULL").all() as Array<{ id: string; key_hash: string; revoked_at: string }>;
    const hidden = this.store.db.query("SELECT id, forced_ceiling FROM credentials WHERE forced_ceiling IS NOT NULL AND revoked_at IS NULL").all() as Array<{ id: string; forced_ceiling: string }>;
    const liveTip = this.auditTip().hash;
    this.store.replaceDatabase(parsed.sqlite, parsed.sealedKey);
    // A backup can be from before a table or a column existed.
    ensureKindTables(this.store.db);
    ensureRequestTables(this.store.db);
    ensureDeviceTables(this.store.db);
    ensureExternalTables(this.store.db);
    ensureApprovalTables(this.store.db);
    this.appendAudit({
      actor: access.principal.id,
      action: "restore",
      tier: null,
      entity_type: "backup",
      entity_id: name,
      surface: access.surface,
    });
    this.appendAudit({ actor: access.principal.id, action: "restore_prior_tip", tier: null, entity_type: "audit", entity_id: liveTip, surface: access.surface });
    for (const row of revoked) {
      const changed = this.store.db
        .query("UPDATE credentials SET revoked_at = ?, private_until = NULL WHERE (id = ? OR key_hash = ?) AND revoked_at IS NULL")
        .run(row.revoked_at, row.id, row.key_hash);
      if (changed.changes > 0) this.appendAudit({ actor: access.principal.id, action: "revoke", tier: null, entity_type: "credential", entity_id: row.id, surface: access.surface });
    }
    for (const row of hidden) this.store.db.query("UPDATE credentials SET forced_ceiling = ? WHERE id = ?").run(row.forced_ceiling, row.id);
    this.store.persist();
    return { name, restored: true };
  }

  /**
   * A new database key, on the mini. The KEK in the Keychain and the Sealed key stay. The Sealed key is not changed:
   * Sealed values are part of the hashed history, and new ciphertext would rewrite it. Older backups still open
   * with the paper passphrase.
   */
  adminRotateKeys(access: Access, ip: string | null) {
    this.requireLocalWrite(access, ip);
    assertNotHidden(access);
    const result = this.store.rotateKeys();
    this.appendAudit({ actor: access.principal.id, action: "rotate_keys", tier: null, entity_type: null, entity_id: null, surface: access.surface });
    this.store.persist(true);
    return { rotated: result.rotated };
  }

  private requireLocalWrite(access: Access, ip: string | null) {
    if (!isLoopback(ip)) throw new ApiError(403, "localhost", "This is only on the mini itself.");
    assertScope(access, "write");
  }

  private backupNames(): string[] {
    const dir = join(this.store.dataDir, "backups");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => BACKUP_NAME.test(name));
  }

  private screenInput(access: Access) {
    // A date from before the check on writes, that HMN cannot read, is no date on a screen. The row still shows.
    const views = new Map(this.visible(access).map((view) => [view.id, view.due_at && !readableDue(view.due_at) ? { ...view, due_at: null } : view]));
    const linkRows = this.store.db.query("SELECT * FROM links WHERE deleted_at IS NULL").all() as LinkRow[];
    const links: SourcedLink[] = [];
    for (const link of linkRows) {
      for (const item of projectLinks(link.from_id, [link], views)) links.push({ ...item, source_id: link.from_id });
    }
    const kinds = this.kinds();
    const workKinds = kinds.withRole("area", "work");
    const workAreas = new Set([...views.values()].filter((view) => view.type === "area" && view.kind !== null && workKinds.has(view.kind)).map((view) => view.id));
    // An expiry can be a passport. The lock screen, the widget, the display, and a member never get the section.
    const closed = access.surface === "display" || access.surface === "widget" || access.surface === "lock" || !!access.principal.member;
    return { views, links, now: this.now(), timeZone: this.timeZone, surface: access.surface, ceiling: access.ceiling, roles: roleSets(kinds), workAreas, ...(closed ? {} : { expiryFields: this.expiryFieldsOf() }) };
  }

  /** The expiry fields of each type and kind, read once for one screen. */
  private expiryFieldsOf(): (type: string, kind: string | null) => Array<{ key: string; label: string }> {
    const expiry = (specs: FieldSpec[]) => specs.filter((spec) => spec.type === "expiry").map((spec) => ({ key: spec.key, label: spec.label }));
    const byKind = new Map(kindFieldList(this.store.db).map((item) => [`${item.type}:${item.kind}`, expiry(item.fields)]));
    return (type, kind) => {
      const base = expiry(BASE_FIELDS[type] ?? []);
      const extra = kind ? byKind.get(`${type}:${kind}`) ?? [] : [];
      return extra.length ? base.concat(extra) : base;
    };
  }

  private visible(access: Access): EntityView[] {
    const areas = this.areaMap();
    const rows = this.store.db.query("SELECT * FROM entities WHERE deleted_at IS NULL").all() as EntityRow[];
    const out: EntityView[] = [];
    for (const row of rows) {
      const view = projectEntity(row, areas, access, this.store.sealedKey);
      if (view) out.push(view);
    }
    return out;
  }

  /**
   * A writer changes only a row that it can read. Without this, a credential could lower the tier of a row above
   * its ceiling: a hidden phone could make a Private row Public. The answer is the answer for a missing row.
   * For an area, the writer can also read the tier that the area gives its items, so a writer cannot open an area
   * above its own ceiling.
   */
  private assertCanChange(access: Access, existing: EntityRow, input: Record<string, unknown>, areas: Map<string, AreaInfo>) {
    const now = ownTier(existing, areas).tier;
    if (!covers(access.ceiling, now) || areaDenied(existing, access, areas)) throw new ApiError(404, "not_found", "Not found.");
    if (existing.type === "area" && "properties" in input) {
      const before = childTierOf(asObject(JSON.parse(existing.properties || "{}")));
      if (!covers(access.ceiling, before)) throw new ApiError(404, "not_found", "Not found.");
    }
  }

  private writeEntity(
    access: Access,
    id: string,
    type: EntityType,
    input: Record<string, unknown>,
    existing: EntityRow | null,
    origin = "owner",
    originRef = "owner",
  ) {
    input = cleanFields(input);
    // The typed fields of the row's type and kind are checked. A key with no field is kept as it is.
    if (input.properties !== undefined && input.properties !== null) {
      const kind = "kind" in input ? ((input.kind as string | null) ?? null) : existing?.kind ?? null;
      const before = existing ? asObject(this.plain(existing).properties) : {};
      input = { ...input, properties: cleanValues(fieldsFor(this.store.db, type, kind), asObject(input.properties), before, (ref) => this.fieldTarget(access, ref)) };
    }
    const areas = this.areaMap();
    if (existing) this.assertCanChange(access, existing, input, areas);
    const areaId = "area_id" in input ? (input.area_id as string | null) : existing?.area_id ?? null;
    if ("area_id" in input && areaId !== null && !areas.has(areaId)) throw new ApiError(422, "bad_area", "That area is not in your HMN.");
    const declared = "tier" in input ? (input.tier as Tier | null) : existing?.tier ?? null;
    if (declared && !isTier(declared) && declared !== null) throw new ApiError(422, "bad_tier", "Unknown tier.");
    const floor = ownTier({ type, tier: null, area_id: areaId }, areas).tier;
    let tier = declared;
    if (access.principal.scope === "agent") tier = agentTierFloor(declared, floor);
    const effective = tier ?? floor;
    assertCanSeeTier(access, effective);
    if (existing) {
      const previous = ownTier(existing, areas).tier;
      if (previous !== effective) {
        this.appendAudit({
          actor: access.principal.id,
          action: "tier_change",
          tier: effective,
          entity_type: type,
          entity_id: id,
          surface: access.surface,
        });
      }
    }
    const status = ("status" in input ? input.status : existing?.status) as string | null;
    const kind = ("kind" in input ? input.kind : existing?.kind) as string | null;
    const kinds = this.kinds();
    assertShape(type, status ?? null, kind ?? null, kinds.allowed(type));
    const title = ("title" in input ? String(input.title ?? "") : existing ? this.plain(existing).title : "").slice(0, 200);
    if (!title) throw new ApiError(422, "title", "A title is required.");
    const bodyValue = "body" in input ? input.body : existing ? this.plain(existing).body : null;
    const body = typeof bodyValue === "string" ? bodyValue.slice(0, 32_000) : null;
    const properties = asObject("properties" in input ? input.properties : existing ? this.plain(existing).properties : {});
    if (type === "task") this.markCompletion(access, properties, status ?? null, existing);
    assertNoSpoilers(type, kind ?? null, properties, kinds.withRole("event", "fixture"));
    // A new area with no tier for its items gets the tier of its role. A health area is not Personal by an omission.
    if (type === "area" && !existing && !isTier(properties.child_tier)) {
      properties.child_tier = AREA_TIER_BY_ROLE[kinds.roleOf("area", kind ?? null) ?? ""] ?? "personal";
    }
    const sealed = effective === "sealed";
    const now = this.now().toISOString();
    const storedTitle = sealed ? sealString(this.store.sealedKey, title) : title;
    const storedBody = body ? (sealed ? sealString(this.store.sealedKey, body) : body) : null;
    const storedProps = sealed
      ? sealString(this.store.sealedKey, JSON.stringify(properties))
      : JSON.stringify(sealMarkedProperties(properties, this.store.sealedKey));
    if (!existing) {
      this.store.db
        .query(
          `INSERT INTO entities (
            id, type, title, body, status, kind, due_at, area_id, properties, tier, content_sealed,
            origin, origin_ref, source_id, external_id, confirmed_at, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          id,
          type,
          storedTitle,
          storedBody,
          status ?? null,
          kind ?? null,
          ("due_at" in input ? input.due_at : null) as string | null,
          areaId,
          storedProps,
          tier,
          sealed ? 1 : 0,
          origin,
          originRef,
          (input.source_id as string) ?? null,
          (input.external_id as string) ?? null,
          origin === "agent" ? now : null,
          now,
          now,
        );
    } else {
      this.store.db
        .query(
          `UPDATE entities SET title = ?, body = ?, status = ?, kind = ?, due_at = ?, area_id = ?, properties = ?, tier = ?,
           content_sealed = ?, updated_at = ?, confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ?`,
        )
        .run(
          storedTitle,
          storedBody,
          status ?? null,
          kind ?? null,
          ("due_at" in input ? input.due_at : existing.due_at) as string | null,
          areaId,
          storedProps,
          tier,
          sealed ? 1 : 0,
          now,
          origin === "agent" ? now : null,
          id,
        );
    }
    this.appendEntityVersion({
      entityId: id,
      supersedes: this.headVersionId(id),
      tombstone: 0,
      type,
      title: storedTitle,
      body: storedBody,
      status: status ?? null,
      kind: kind ?? null,
      dueAt: ("due_at" in input ? input.due_at : existing?.due_at ?? null) as string | null,
      areaId,
      properties: storedProps,
      tier,
      contentSealed: sealed ? 1 : 0,
      origin,
      originRef,
      sourceId: (input.source_id as string) ?? existing?.source_id ?? null,
      externalId: (input.external_id as string) ?? existing?.external_id ?? null,
      validFrom: now,
      actor: access.principal.id,
      surface: access.surface,
    });
    this.noteWrite(access, "write", effective, type, id);
  }

  /** The tier of a row before a patch and after it. An explicit tier wins, then the area, as for each row. */
  private patchedTier(target: EntityRow, patch: Record<string, unknown>, areas: Map<string, AreaInfo>): { from: Tier; to: Tier } {
    const from = ownTier(target, areas).tier;
    const current = target.tier && isTier(target.tier) ? target.tier : null;
    const declared = "tier" in patch ? (isTier(patch.tier) ? patch.tier : null) : current;
    const areaId = "area_id" in patch ? (typeof patch.area_id === "string" ? patch.area_id : null) : target.area_id;
    return { from, to: ownTier({ type: target.type, tier: declared, area_id: areaId }, areas).tier };
  }

  /** True when a key that is not the owner's filed the proposal. A key that was removed counts as one. */
  private fromLimitedKey(row: ProposalRow): boolean {
    if (!sourceOf(row).startsWith("key:") && !isMemberSource(sourceOf(row))) return false;
    const key = this.store.db.query("SELECT scope FROM credentials WHERE id = ?").get(row.key_id ?? "") as { scope: string } | null;
    return key?.scope !== "write";
  }

  /**
   * What a key that is not the owner's cannot put in a proposal, also when the owner would approve it.
   * A key cannot make a row more visible, cannot change or remove an area, and cannot mark a row as a calendar copy.
   */
  /** Each row that a proposal from a key names is a row that the key can read, or the answer is "Not found". */
  private assertKeyTargets(access: Access, payload: Record<string, unknown>) {
    const areas = this.areaMap();
    const ids = collectIds(payload);
    for (const part of [asObject(payload.entity), asObject(payload.patch)]) {
      if (typeof part.area_id === "string") ids.push(part.area_id);
    }
    for (const id of ids) {
      const row = this.raw(id);
      const readable = Boolean(row && !row.deleted_at && covers(rowCeiling(access, row, areas), ownTier(row, areas).tier) && !areaDenied(row, access, areas));
      if (!readable) throw new ApiError(404, "not_found", "Not found.");
    }
  }

  private assertKeyPayload(access: Access, op: string, payload: Record<string, unknown>) {
    const areas = this.areaMap();
    const patch = asObject(payload.patch);
    for (const part of [asObject(payload.entity), patch]) {
      if ("mirror" in asObject(part.properties)) throw new ApiError(422, "field", "A proposal cannot mark a row as a copy of a calendar.");
      // The link to a source belongs to the mirror and the plugins. With it, a row could pass as a copy of a calendar,
      // and the owner's own edits would answer "this comes from a calendar". `external_id` stays: agents use it.
      if ("source_id" in part) throw new ApiError(422, "field", "A proposal cannot set source_id.");
    }
    // A key cannot name the address that the mini reads a calendar from.
    const entity = asObject(payload.entity);
    if ((entity.type === "source" && "url" in asObject(entity.properties)) || "url" in asObject(patch.properties)) {
      throw new ApiError(422, "field", "A proposal cannot set the address of a calendar. The owner sets it in Calendars.");
    }
    if ((op !== "update" && op !== "delete") || typeof payload.id !== "string") return;
    const target = this.raw(payload.id);
    if (!target) return;
    if (target.type === "area") throw new ApiError(403, "area", "A key cannot change or remove an area. An area sets the tier of its items.");
    if (op !== "update") return;
    if ("tier" in patch && patch.tier !== null && !isTier(patch.tier)) throw new ApiError(422, "bad_tier", "Unknown tier.");
    if (typeof patch.area_id === "string") {
      const area = this.raw(patch.area_id);
      if (!area || area.deleted_at || area.type !== "area" || areaDenied(area, access, areas)) throw new ApiError(404, "not_found", "Not found.");
    }
    const change = this.patchedTier(target, patch, areas);
    if (!covers(change.to, change.from)) throw new ApiError(422, "tier_floor", "A proposal cannot make a row more visible.");
  }

  /**
   * One proposal as a caller can see it, or null. A key that is not the owner's sees the proposals that it filed.
   * The limits of the key on areas and types apply to each row that the proposal names.
   */
  private viewProposal(row: ProposalRow, access: Access): ProposalView | null {
    const principal = access.principal;
    if (principal.scope !== "write" && row.key_id !== principal.id) return null;
    const view = projectProposal(row, access, this.store.sealedKey);
    if (!view || view.redacted) return view;
    const payload = asObject(view.payload);
    if (principal.denyAreas.length > 0 || principal.allowAreas || principal.allowTypes) {
      const areas = this.areaMap();
      const ids = new Set(collectIds(payload));
      if (row.entity_id) ids.add(row.entity_id);
      for (const id of ids) {
        const target = this.raw(id);
        if (target && areaDenied(target, access, areas)) return null;
      }
      const entity = asObject(payload.entity);
      const areaId = typeof entity.area_id === "string" ? entity.area_id : typeof asObject(payload.patch).area_id === "string" ? (asObject(payload.patch).area_id as string) : null;
      const type = typeof entity.type === "string" ? entity.type : row.entity_type;
      if (type && areaDenied({ id: "", type, area_id: areaId }, access, areas)) return null;
    }
    // Each link carries the title of the row it points to, when the caller can see that row. No title is a row that
    // the caller cannot see, and the app does not say more.
    let shown: unknown = view.payload;
    if (Array.isArray(payload.links)) {
      const areas = this.areaMap();
      const links = payload.links.map((item) => {
        const link = asObject(item);
        const target = typeof link.to_id === "string" && link.to_id ? this.raw(link.to_id) : null;
        const seen = target ? projectEntity(target, areas, access, this.store.sealedKey) : null;
        return seen ? { ...link, title: seen.title } : link;
      });
      shown = { ...payload, links };
    }
    return { ...view, payload: shown, summary: this.proposalSummary(row, access, payload) };
  }

  /**
   * What an approval of this proposal writes, in words that the server made. The card on the phone shows it.
   * The reason and the name of a proposal come from its source. This part does not.
   */
  private proposalSummary(row: ProposalRow, access: Access, payload: Record<string, unknown>): ProposalSummary {
    const areas = this.areaMap();
    const seen = (id: unknown): EntityView | null => {
      const target = typeof id === "string" && id ? this.raw(id) : null;
      return target ? projectEntity(target, areas, access, this.store.sealedKey) : null;
    };
    const name = (id: unknown): string => {
      const target = typeof id === "string" && id ? this.raw(id) : null;
      if (!target || target.deleted_at) return "An item that is not there";
      return seen(id)?.title ?? "A hidden item";
    };
    const lines: ProposalSummary["lines"] = [];
    const text = (value: unknown): string => (value === null || value === undefined || value === "" ? "none" : String(value).slice(0, 120));
    const pending = row.status === "pending";
    let warning: string | null = null;
    if (row.op === "create") {
      const entity = asObject(payload.entity);
      if (entity.due_at) lines.push({ label: "Due", text: text(entity.due_at) });
      if (typeof entity.area_id === "string") lines.push({ label: "Area", text: name(entity.area_id) });
      lines.push({ label: "Tier", text: row.tier });
      const links = Array.isArray(payload.links) ? payload.links.map((item) => name(asObject(item).to_id)) : [];
      if (links.length) lines.push({ label: "Links", text: links.join(", ") });
      return { title: text(entity.title), lines, warning };
    }
    if (row.op === "update" || row.op === "delete") {
      const target = typeof payload.id === "string" ? this.raw(payload.id) : null;
      const before = seen(payload.id);
      if (!target || target.deleted_at) warning = pending ? "The item is not there. An approval cannot write this." : null;
      if (row.op === "delete") {
        lines.push({ label: "Removes", text: before ? `${before.type}, ${before.tier}` : row.entity_type ?? "item" });
        if (target?.type === "area") warning = "This removes an area. An area sets the tier of its items.";
        return { title: name(payload.id), lines, warning };
      }
      const patch = asObject(payload.patch);
      for (const field of ["title", "status", "kind", "due_at"] as const) {
        if (!(field in patch)) continue;
        const label = field === "due_at" ? "Due" : field[0]!.toUpperCase() + field.slice(1);
        lines.push(pending && before ? { label, text: text(patch[field]), was: text(before[field]) } : { label, text: text(patch[field]) });
      }
      if ("body" in patch) lines.push({ label: "Text", text: `changed, ${typeof patch.body === "string" ? patch.body.length : 0} characters` });
      if ("properties" in patch) {
        const fields = Object.keys(asObject(patch.properties)).filter((key) => key !== "_privacy");
        lines.push({ label: "Fields", text: fields.length ? fields.slice(0, 8).join(", ") : "all removed" });
      }
      if ("area_id" in patch) {
        const to = typeof patch.area_id === "string" ? name(patch.area_id) : "none";
        lines.push(pending && before ? { label: "Area", text: to, was: before.area_id ? name(before.area_id) : "none" } : { label: "Area", text: to });
      }
      if (target && pending && ("tier" in patch || "area_id" in patch)) {
        const change = this.patchedTier(target, patch, areas);
        if (change.from !== change.to) lines.push({ label: "Tier", text: change.to, was: change.from });
        if (!covers(change.to, change.from)) warning = `This makes the item more visible: ${change.from} to ${change.to}.`;
      } else if ("tier" in patch) {
        lines.push({ label: "Tier", text: text(patch.tier) });
      }
      if (target?.type === "area") warning = warning ?? "This changes an area. An area sets the tier of its items.";
      if (!lines.length) lines.push({ label: "Change", text: "no field" });
      return { title: name(payload.id), lines, warning };
    }
    let link = asObject(payload.link);
    if (row.op === "unlink") {
      const found = this.store.db.query("SELECT from_id, to_id, rel FROM links WHERE id = ?").get(typeof payload.id === "string" ? payload.id : "") as { from_id: string; to_id: string; rel: string } | null;
      link = found ?? {};
      if (!found) warning = pending ? "The link is not there." : null;
    }
    lines.push({ label: row.op === "unlink" ? "Removes" : "Link", text: text(link.rel) });
    return { title: `${name(link.from_id)} and ${name(link.to_id)}`, lines, warning };
  }

  private proposalTier(access: Access, op: string, payload: Record<string, unknown>): Tier {
    const areas = this.areaMap();
    // A member's write starts at Household, the member's own tier. Each row it names can make it stricter.
    let floor: Tier = access.principal.member ? "household" : "personal";
    const entity = asObject(payload.entity);
    if (op === "create" && entity.type) {
      const areaId = typeof entity.area_id === "string" ? entity.area_id : null;
      if (access.principal.member) {
        // A member writes a new row at Household or stricter. The row holds what the member wrote, and nothing of yours.
        floor = isTier(entity.tier) ? stricterTier(entity.tier, "household") : areaId ? ownTier({ type: String(entity.type), tier: null, area_id: areaId }, areas).tier : "household";
      } else {
        floor = ownTier({ type: String(entity.type), tier: null, area_id: areaId }, areas).tier;
        if (isTier(entity.tier)) floor = agentTierFloor(entity.tier, floor);
      }
      assertNoSpoilers(String(entity.type), (entity.kind as string) ?? null, asObject(entity.properties), this.kinds().withRole("event", "fixture"));
    }
    const ids = collectIds(payload);
    for (const id of ids) {
      const row = this.raw(id);
      if (!row) continue;
      if (areaDenied(row, access, areas)) throw new ApiError(404, "not_found", "Not found.");
      floor = stricterTier(floor, ownTier(row, areas).tier);
    }
    if (op === "update" && typeof payload.id === "string") {
      const target = this.raw(payload.id);
      if (target) floor = stricterTier(floor, this.patchedTier(target, asObject(payload.patch), areas).to);
    }
    if (access.principal.scope === "agent" && isTier(payload.tier)) {
      floor = agentTierFloor(payload.tier, floor);
    }
    return floor;
  }

  /**
   * A key that is not the owner's has a budget, so that one key cannot fill the review queue or make each save slow.
   * The size of one proposal, the proposals that wait for the owner, and the proposals in the last hour.
   */
  private assertProposalBudget(source: string, payload: unknown, readSet: unknown) {
    if (JSON.stringify(payload).length > PROPOSAL_MAX_CHARS || (readSet != null && JSON.stringify(readSet).length > READ_SET_MAX_CHARS)) {
      throw new ApiError(413, "too_large", "That proposal is too large. Propose a shorter text, or split it.");
    }
    const waiting = this.store.db.query("SELECT COUNT(*) AS n FROM proposals WHERE source = ? AND status = 'pending'").get(source) as { n: number };
    if (waiting.n >= PROPOSALS_WAITING_MAX) {
      throw new ApiError(429, "queue_full", `This key has ${PROPOSALS_WAITING_MAX} proposals that wait for the owner. Wait for decisions, then propose again.`);
    }
    const since = new Date(this.now().getTime() - 3_600_000).toISOString();
    const recent = this.store.db.query("SELECT COUNT(*) AS n FROM proposals WHERE source = ? AND created_at > ?").get(source, since) as { n: number };
    if (recent.n >= PROPOSALS_PER_HOUR) {
      throw new ApiError(429, "rate", `This key filed ${PROPOSALS_PER_HOUR} proposals in the last hour. Try again later.`);
    }
  }

  /** The same idea for the inbox: the open items and the items in the last hour of one key that is not the owner's. */
  private assertInboxBudget(access: Access) {
    if (access.principal.scope === "write") return;
    const open = this.store.db.query("SELECT COUNT(*) AS n FROM inbox_items WHERE credential_id = ? AND status = 'new' AND deleted_at IS NULL").get(access.principal.id) as { n: number };
    if (open.n >= INBOX_OPEN_MAX) {
      throw new ApiError(429, "queue_full", `This key has ${INBOX_OPEN_MAX} items in the inbox. Wait for the owner, then send again.`);
    }
    const since = new Date(this.now().getTime() - 3_600_000).toISOString();
    const recent = this.store.db.query("SELECT COUNT(*) AS n FROM inbox_items WHERE credential_id = ? AND captured_at > ?").get(access.principal.id, since) as { n: number };
    if (recent.n >= INBOX_PER_HOUR) throw new ApiError(429, "rate", `This key sent ${INBOX_PER_HOUR} items in the last hour. Try again later.`);
  }

  /**
   * A declined or expired proposal keeps what the owner's list shows: the ids, the type, and a short title. The
   * rest of the text goes, so a flood that the owner declines does not stay in the graph.
   */
  private shrinkDecided(id: string) {
    const row = this.proposal(id);
    const full = asObject(this.unpack(row.payload));
    const short = (value: unknown) => (typeof value === "string" ? value.slice(0, 200) : undefined);
    const kept: Record<string, unknown> = {};
    for (const key of ["id", "type", "rel", "from_type", "from_id", "to_type", "to_id"]) {
      if (typeof full[key] === "string") kept[key] = short(full[key]);
    }
    const entity = asObject(full.entity);
    if (Object.keys(entity).length) kept.entity = { type: short(entity.type), title: short(entity.title) };
    const patch = asObject(full.patch);
    if (typeof patch.title === "string") kept.patch = { title: short(patch.title) };
    const link = asObject(full.link);
    if (Object.keys(link).length) kept.link = { from_id: short(link.from_id), to_id: short(link.to_id), rel: short(link.rel) };
    const reason = this.unpackText(row.reason);
    const stored = this.packSecret(row.tier, kept, reason ? reason.slice(0, 200) : null, null);
    this.store.db.query("UPDATE proposals SET payload = ?, reason = ?, read_set = NULL WHERE id = ?").run(stored.payload, stored.reason, id);
  }

  private packSecret(tier: Tier, payload: unknown, reason: string | null, readSet: unknown) {
    const payloadText = JSON.stringify(payload);
    const readText = readSet == null ? null : JSON.stringify(readSet);
    if (tier !== "sealed") return { payload: payloadText, reason, read_set: readText };
    return {
      payload: sealString(this.store.sealedKey, payloadText),
      reason: reason ? sealString(this.store.sealedKey, reason) : null,
      read_set: readText ? sealString(this.store.sealedKey, readText) : null,
    };
  }

  private unpack(value: string | null): unknown {
    if (!value) return null;
    const text = isSealed(value) ? requireOpen(this.store.sealedKey, value) : value;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private unpackText(value: string | null): string | null {
    if (!value) return null;
    return isSealed(value) ? requireOpen(this.store.sealedKey, value) : value;
  }

  private plain(row: EntityRow): { title: string; body: string | null; properties: Record<string, unknown> } {
    if (!row.content_sealed) {
      return { title: row.title ?? "", body: row.body, properties: asObject(JSON.parse(row.properties || "{}")) };
    }
    return {
      title: requireOpen(this.store.sealedKey, row.title ?? ""),
      body: row.body ? requireOpen(this.store.sealedKey, row.body) : null,
      properties: asObject(JSON.parse(requireOpen(this.store.sealedKey, row.properties))),
    };
  }

  private areaMap(): Map<string, AreaInfo> {
    const rows = this.store.db
      .query("SELECT id, kind, properties FROM entities WHERE type = 'area' AND deleted_at IS NULL")
      .all() as { id: string; kind: string | null; properties: string }[];
    const kinds = this.kinds();
    const map = new Map<string, AreaInfo>();
    for (const row of rows) {
      map.set(row.id, { id: row.id, childTier: childTierOf(asObject(JSON.parse(row.properties || "{}"))), role: kinds.roleOf("area", row.kind) });
    }
    return map;
  }

  /** The kinds, read from their table. A kind is data, so each request reads them. */
  kinds(): Kinds {
    return new Kinds(this.store.db);
  }

  /** The first live area whose kind has the role, or null. A plugin names a role, and this finds the owner's area. */
  areaForRole(role: string): string | null {
    const kinds = [...this.kinds().withRole("area", role)];
    if (kinds.length === 0) return null;
    const row = this.store.db
      .query(`SELECT id FROM entities WHERE type = 'area' AND deleted_at IS NULL AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY created_at ASC, id ASC LIMIT 1`)
      .get(...kinds) as { id: string } | null;
    return row?.id ?? null;
  }

  /**
   * A plugin draft names a role for its area, because the plugin does not know the owner's areas.
   * This puts the area in, and it returns the tier that the role needs when the owner has no such area.
   */
  private placeByRole(entity: Record<string, unknown>): Tier | null {
    const role = typeof entity.area_role === "string" ? entity.area_role : null;
    delete entity.area_role;
    if (!role) return null;
    const areaId = this.areaForRole(role);
    if (areaId) {
      entity.area_id = areaId;
      return null;
    }
    // With no area for the role, the area cannot give the tier. A family date is Private and a health row is Sealed.
    return role === "health" || role === "money" ? "sealed" : role === "family" ? "private" : null;
  }

  private visibleIds(access: Access) {
    return new Set(this.visible(access).map((view) => view.id));
  }

  private raw(id: string): EntityRow | null {
    return (this.store.db.query("SELECT * FROM entities WHERE id = ?").get(id) as EntityRow | null) ?? null;
  }

  private mustLive(id: string): EntityRow {
    const row = this.raw(id);
    if (!row || row.deleted_at) throw new ApiError(404, "not_found", "Not found.");
    return row;
  }

  private mustRaw(type: string, id: string): EntityRow {
    const row = this.mustLive(id);
    if (row.type !== type) throw new ApiError(404, "not_found", "Not found.");
    return row;
  }

  private proposal(id: string): ProposalRow {
    const row = this.store.db.query("SELECT * FROM proposals WHERE id = ?").get(id) as ProposalRow | null;
    if (!row) throw new ApiError(404, "not_found", "Not found.");
    return row;
  }

  private grantValid(credentialId: string, token: string): boolean {
    const row = this.store.db
      .query("SELECT * FROM vault_grants WHERE grant_hash = ?")
      .get(sha256hex(token)) as { credential_id: string; expires_at: string } | null;
    if (!row || row.credential_id !== credentialId) return false;
    return row.expires_at > this.now().toISOString();
  }

  private assertUnlocked(subject: string) {
    const row = this.store.db.query("SELECT locked_until FROM auth_lock WHERE subject = ?").get(subject) as { locked_until: string | null } | null;
    if (row?.locked_until && row.locked_until > this.now().toISOString()) {
      throw new ApiError(429, "locked", "Too many attempts.");
    }
  }

  private recordFailure(subject: string) {
    const now = this.now();
    const row = this.store.db.query("SELECT * FROM auth_lock WHERE subject = ?").get(subject) as {
      failures: number;
      window_start: string;
      locked_until: string | null;
    } | null;
    const windowMs = 10 * 60_000;
    if (!row || now.getTime() - Date.parse(row.window_start) > windowMs) {
      this.store.db
        .query(
          "INSERT INTO auth_lock (subject, failures, window_start, locked_until) VALUES (?, 1, ?, NULL) ON CONFLICT(subject) DO UPDATE SET failures = 1, window_start = excluded.window_start, locked_until = NULL",
        )
        .run(subject, now.toISOString());
    } else {
      const failures = row.failures + 1;
      const locked = failures >= 8 ? new Date(now.getTime() + 15 * 60_000).toISOString() : null;
      this.store.db.query("UPDATE auth_lock SET failures = ?, locked_until = ? WHERE subject = ?").run(failures, locked, subject);
    }
  }

  private tombstoneEntity(access: Access, existing: EntityRow) {
    const tier = ownTier(existing, this.areaMap()).tier;
    assertCanSeeTier(access, tier);
    // An area gives its items their tier, and an agent's denial names it. Its removal would make a Sealed health note
    // Personal, and readable by an agent. So an area with items stays until its items are moved or removed.
    if (existing.type === "area") {
      const used = (this.store.db.query("SELECT COUNT(*) AS n FROM entities WHERE deleted_at IS NULL AND area_id = ? AND id != ?").get(existing.id, existing.id) as { n: number }).n;
      if (used > 0) throw new ApiError(409, "area_in_use", `Move or remove the ${used === 1 ? "item" : `${used} items`} in this area first.`);
    }
    const now = this.now().toISOString();
    this.appendEntityVersion({
      entityId: existing.id,
      supersedes: this.headVersionId(existing.id),
      tombstone: 1,
      type: existing.type,
      title: existing.title,
      body: existing.body,
      status: existing.status,
      kind: existing.kind,
      dueAt: existing.due_at,
      areaId: existing.area_id,
      properties: existing.properties,
      tier: existing.tier,
      contentSealed: existing.content_sealed,
      origin: "owner",
      originRef: "tombstone",
      sourceId: existing.source_id,
      externalId: existing.external_id,
      validFrom: now,
      actor: access.principal.id,
      surface: access.surface,
    });
    this.store.db.query("UPDATE entities SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, existing.id);
    this.noteWrite(access, "write", tier, existing.type, existing.id);
  }

  private headVersionId(entityId: string): string | null {
    const row = this.store.db
      .query(
        `SELECT id FROM entity_versions v
         WHERE v.entity_id = ?
           AND NOT EXISTS (SELECT 1 FROM entity_versions n WHERE n.supersedes_id = v.id)
         ORDER BY v.valid_from DESC, v.id DESC LIMIT 1`,
      )
      .get(entityId) as { id: string } | null;
    return row?.id ?? null;
  }

  private appendEntityVersion(input: {
    entityId: string;
    supersedes: string | null;
    tombstone: number;
    type: string;
    title: string | null;
    body: string | null;
    status: string | null;
    kind: string | null;
    dueAt: string | null;
    areaId: string | null;
    properties: string;
    tier: string | null;
    contentSealed: number;
    origin: string;
    originRef: string | null;
    sourceId: string | null;
    externalId: string | null;
    validFrom: string;
    actor: string;
    surface: string;
  }) {
    const last = this.store.db.query("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { hash: string } | null;
    const prev = last?.hash ?? AUDIT_GENESIS;
    const id = randomId("ver");
    const row = {
      id,
      entity_id: input.entityId,
      supersedes_id: input.supersedes,
      valid_from: input.validFrom,
      tombstone: input.tombstone,
      type: input.type,
      title: input.title,
      body: input.body,
      status: input.status,
      kind: input.kind,
      due_at: input.dueAt,
      area_id: input.areaId,
      properties: input.properties,
      tier: input.tier,
      content_sealed: input.contentSealed,
      origin: input.origin,
      origin_ref: input.originRef,
      source_id: input.sourceId,
      external_id: input.externalId,
      prev_hash: prev,
    };
    const hash = versionHash(row);
    this.store.db
      .query(
        `INSERT INTO entity_versions (
          id, entity_id, supersedes_id, valid_from, tombstone, type, title, body, status, kind, due_at, area_id,
          properties, tier, content_sealed, origin, origin_ref, source_id, external_id, prev_hash, hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.entity_id,
        row.supersedes_id,
        row.valid_from,
        row.tombstone,
        row.type,
        row.title,
        row.body,
        row.status,
        row.kind,
        row.due_at,
        row.area_id,
        row.properties,
        row.tier,
        row.content_sealed,
        row.origin,
        row.origin_ref,
        row.source_id,
        row.external_id,
        prev,
        hash,
      );
    const areas = this.areaMap();
    const declared = input.tier && isTier(input.tier) ? input.tier : null;
    const tier = input.contentSealed ? "sealed" : ownTier({ type: input.type, tier: declared, area_id: input.areaId }, areas).tier;
    this.appendAudit({
      actor: input.actor,
      action: input.tombstone ? "tombstone" : "version",
      tier,
      entity_type: input.type,
      entity_id: input.entityId,
      surface: input.surface,
      subjectHash: hash,
    });
  }

  noteExternal(access: Access, tool: string) {
    this.appendAudit({
      actor: access.principal.id,
      action: "external",
      tier: access.ceiling,
      entity_type: "tool",
      entity_id: tool.slice(0, 40),
      surface: "external",
    });
  }

  /**
   * True for an agent key, for an outside client, and for a view key. A worker has a journal, so it is not
   * logged here. A TRMNL display has a device key at Public, and it is not logged.
   */
  private logsReads(access: Access): boolean {
    const principal = access.principal;
    if (principal.id.startsWith("worker:")) return false;
    return principal.scope === "agent" || (principal.scope === "read" && principal.kind === "key");
  }

  /** One row in the read log of an agent: a search with its words, or a walk of the links. */
  private noteQuery(access: Access, action: string, detail: string) {
    if (!this.logsReads(access)) return;
    this.store.db
      .query("INSERT INTO client_reads (at, principal_id, action, entity_type, entity_id, tier, detail) VALUES (?, ?, ?, NULL, NULL, ?, ?)")
      .run(this.now().toISOString(), access.principal.id, action, access.ceiling, detail.slice(0, 200));
  }

  private noteRead(access: Access, view: { tier: Tier; type: string; id: string }) {
    if (this.logsReads(access)) {
      const done = this.store.db
        .query("INSERT INTO client_reads (at, principal_id, action, entity_type, entity_id, tier, detail) VALUES (?, ?, 'read', ?, ?, ?, NULL)")
        .run(this.now().toISOString(), access.principal.id, view.type, view.id, view.tier);
      // Keep the newest rows of each agent. The log is for the owner to read, not an archive.
      if (Number(done.lastInsertRowid) % 500 === 0) {
        this.store.db
          .query("DELETE FROM client_reads WHERE principal_id = ? AND seq NOT IN (SELECT seq FROM client_reads WHERE principal_id = ? ORDER BY seq DESC LIMIT ?)")
          .run(access.principal.id, access.principal.id, CLIENT_READS_KEEP);
      }
    }
    if (view.tier !== "private" && view.tier !== "sealed") return;
    this.appendAudit({
      actor: access.principal.id,
      action: "read",
      tier: view.tier,
      entity_type: view.type,
      entity_id: view.id,
      surface: access.surface,
    });
  }

  private noteWrite(access: Access, action: string, tier: Tier, type: string, id: string) {
    if (tier !== "private" && tier !== "sealed" && action !== "tier_change") return;
    this.appendAudit({
      actor: access.principal.id,
      action,
      tier,
      entity_type: type,
      entity_id: id,
      surface: access.surface,
    });
  }

  private appendAudit(entry: {
    actor: string;
    action: string;
    tier: string | null;
    entity_type: string | null;
    entity_id: string | null;
    surface: string;
    subjectHash?: string | null;
  }) {
    const last = this.store.db.query("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | null;
    const seq = (last?.seq ?? 0) + 1;
    const prev = last?.hash ?? AUDIT_GENESIS;
    const row = {
      seq,
      at: this.now().toISOString(),
      actor: entry.actor,
      action: entry.action,
      tier: entry.tier,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      surface: entry.surface,
      prev_hash: prev,
      subject_hash: entry.subjectHash ?? null,
    };
    const hash = hashAudit(row);
    this.store.db
      .query(
        `INSERT INTO audit_log (seq, at, actor, action, tier, entity_type, entity_id, surface, prev_hash, hash, subject_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(seq, row.at, row.actor, row.action, row.tier, row.entity_type, row.entity_id, row.surface, prev, hash, row.subject_hash);
    // The Keychain copy is written when the database is saved. One Keychain call for each row made a batch slow on a Mac.
    this.pendingTip = hash;
  }

  private knownType(type: string): asserts type is EntityType {
    if (!(ENTITY_TYPES as readonly string[]).includes(type)) throw new ApiError(404, "not_found", "Not found.");
  }
}

function hashAudit(row: Record<string, unknown>): string {
  const body: Record<string, unknown> = {
    action: row.action ?? null,
    actor: row.actor,
    at: row.at,
    entity_id: row.entity_id ?? null,
    entity_type: row.entity_type ?? null,
    prev_hash: row.prev_hash,
    seq: row.seq,
    surface: row.surface ?? null,
    tier: row.tier ?? null,
  };
  if (typeof row.subject_hash === "string" && row.subject_hash) body.subject_hash = row.subject_hash;
  return sha256hex(JSON.stringify(body));
}

function stricterTier(a: Tier, b: Tier): Tier {
  return stricter(a, b);
}

/**
 * The pairing link in a QR code. `url` is the address the code was made through, so a new phone needs no typing.
 * A phone camera opens it in the app. The fingerprint pins the server's certificate.
 */
export function pairingLink(code: string, fingerprint: string, origin: string | null): string {
  const url = origin && /^https:\/\//.test(origin) ? `url=${encodeURIComponent(origin)}&` : "";
  return `hmn://pair?${url}code=${code}&fp=${fingerprint}`;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiError(422, "invalid", "Missing field.");
  return value.trim();
}

/**
 * Text from a source, made safe for a card. It removes control characters, the characters that turn the
 * direction of text, and characters with no width. A line break stays only in a text with many lines.
 */
export function tidyText(value: string, multiline: boolean): string {
  const base = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, "");
  return (multiline ? base.replace(/\r/g, "") : base.replace(/[\r\n\t]+/g, " ")).trim();
}

/** The titles and the texts of a proposal, through `tidyText`. All other fields stay as they are. */
function tidyPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...payload };
  for (const part of ["entity", "patch"] as const) {
    if (!copy[part] || typeof copy[part] !== "object" || Array.isArray(copy[part])) continue;
    const fields = { ...(copy[part] as Record<string, unknown>) };
    if (typeof fields.title === "string") fields.title = tidyText(fields.title, false);
    if (typeof fields.body === "string") fields.body = tidyText(fields.body, true);
    copy[part] = fields;
  }
  return copy;
}

function collectIds(payload: Record<string, unknown>): string[] {
  const ids: string[] = [];
  if (typeof payload.id === "string") ids.push(payload.id);
  const link = asObject(payload.link);
  if (typeof link.from_id === "string") ids.push(link.from_id);
  if (typeof link.to_id === "string") ids.push(link.to_id);
  if (Array.isArray(payload.links)) {
    for (const item of payload.links) {
      const linkItem = asObject(item);
      if (typeof linkItem.to_id === "string") ids.push(linkItem.to_id);
    }
  }
  return ids;
}

function sealMarkedProperties(properties: Record<string, unknown>, key: Buffer): Record<string, unknown> {
  const privacy = asObject(properties._privacy);
  const copy: Record<string, unknown> = { ...properties };
  for (const [name, tier] of Object.entries(privacy)) {
    if (tier === "sealed" && name in copy) {
      copy[name] = sealString(key, JSON.stringify(copy[name]));
    }
  }
  return copy;
}

function requireOpen(key: Buffer, value: string): string {
  return openString(key, value);
}

/** The lockout counts failures for one address on one listener. */
function lockSubject(listener: Listener, ip: string | null): string {
  return `${listener}:ip:${ip ?? "unknown"}`;
}

/** A save after a request waits at most this long after the last save. */
const SAVE_GAP_MS = 1000;
/** The time of last use of a credential changes in steps of ten minutes. */
const LAST_USED_STEP_MS = 10 * 60_000;

/** The budget of one key that is not the owner's. */
const PROPOSAL_MAX_CHARS = 32_000;
const READ_SET_MAX_CHARS = 8_000;
const PROPOSALS_WAITING_MAX = 100;
const PROPOSALS_PER_HOUR = 60;
const INBOX_OPEN_MAX = 50;
const INBOX_PER_HOUR = 60;

/** The daily backup keeps this many files. */
const BACKUPS_KEPT = 14;

/** The time in the name of a backup, as milliseconds. */
function backupTime(name: string): number {
  const match = /^backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z\.hmn$/.exec(name);
  if (!match) return 0;
  const [, y, mo, d, h, mi, s, ms] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms));
}

/** The owner key can renew itself on the mini up to this long after its end date. */
const OWNER_GRACE_MS = 30 * 86_400_000;

/** One plugin tick files at most this many proposals. */
const PLUGIN_DRAFTS_MAX = 500;

const BACKUP_NAME = /^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]+Z\.hmn$/;

function uint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return buf;
}

export function parseBackupBody(body: Buffer): { sealedKey: Buffer; sqlite: Buffer } {
  const magic = Buffer.from("HMN1");
  if (body.length < 12 || !body.subarray(0, 4).equals(magic)) {
    throw new ApiError(422, "invalid", "That backup could not be opened.");
  }
  const keyLen = body.readUInt32BE(4);
  if (keyLen !== 32 || body.length < 12 + keyLen) {
    throw new ApiError(422, "invalid", "That backup could not be opened.");
  }
  const sealedKey = Buffer.from(body.subarray(8, 8 + keyLen));
  const sqlLen = body.readUInt32BE(8 + keyLen);
  const start = 12 + keyLen;
  if (sqlLen < 16 || start + sqlLen > body.length) {
    throw new ApiError(422, "invalid", "That backup could not be opened.");
  }
  const sqlite = Buffer.from(body.subarray(start, start + sqlLen));
  if (sqlite.subarray(0, 15).toString("utf8") !== "SQLite format 3") {
    throw new ApiError(422, "invalid", "That backup could not be opened.");
  }
  return { sealedKey, sqlite };
}

type CalendarSettings = { id: string; title: string; areaId: string | null; tier: Tier | null; approval: "auto" | "review"; freeBusy: boolean; url: string | null };

const CALENDAR_INTERVAL_MINUTES = 15;
/** A Private grant for an agent key ends after at most this many days. The owner renews it. */
/** The tier of the items of a new area, when the caller gives none. */
const AREA_TIER_BY_ROLE: Record<string, Tier> = { health: "sealed", money: "sealed", family: "private" };
const PRIVATE_DAYS_MAX = 90;
/** One request for busy times covers at most this many days. */
const FREE_BUSY_DAYS_MAX = 60;
/** The text that a guest can put in the inbox or in an event. */
const GUEST_TEXT_MAX = 2000;
const KEY_DAYS_DEFAULT = 90;
const KEY_DAYS_MAX = 365;
const NEIGHBOUR_MAX = 100;
const CLIENT_READS_KEEP = 2000;
/** Words that carry no subject in a question. They are dropped when a caller asks for any word. */
const SEARCH_SMALL_WORDS = new Set([
  "a", "an", "and", "any", "are", "about", "at", "be", "by", "can", "did", "do", "does", "for", "from", "have", "has", "how", "i", "in", "is", "it",
  "me", "my", "need", "of", "on", "or", "our", "should", "that", "the", "there", "this", "to", "was", "we", "what", "when", "where", "which", "who", "why", "will", "with", "you", "your",
]);

/**
 * A guest proposes one thing: a new event. This keeps the title, the time, the end, and a short text, and it
 * drops each other field: no area, no tier, no link, and no kind of the guest's choice.
 */
function guestEvent(op: string, payload: Record<string, unknown>): Record<string, unknown> {
  const entity = asObject(payload.entity);
  if (op !== "create" || entity.type !== "event") {
    throw new ApiError(403, "guest", "A guest can propose an event. It cannot propose a change, a removal, a link, or another type.");
  }
  const title = typeof entity.title === "string" ? entity.title.trim().slice(0, 200) : "";
  const dueAt = typeof entity.due_at === "string" ? entity.due_at : "";
  if (!title || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.test(dueAt)) {
    throw new ApiError(422, "guest", "An event from a guest needs a title and a start, for example 2026-11-17T06:00:00Z.");
  }
  const endAt = asObject(entity.properties).end_at;
  return {
    op: "create",
    entity: {
      type: "event",
      title,
      body: typeof entity.body === "string" ? entity.body.slice(0, GUEST_TEXT_MAX) : null,
      status: "upcoming",
      kind: "appointment",
      due_at: dueAt,
      properties: typeof endAt === "string" && /^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(endAt) ? { end_at: endAt } : {},
    },
    links: [],
  };
}

type Applied = {
  entity_id: string | null;
  version_id: string | null;
  prev_version_id: string | null;
  link_ids: string[];
  unlinked_id: string | null;
};

const CLEARABLE = ["rejected", "expired", "undone"];

function pluginOrigin(agentName: string): "plugin" | "agent" {
  return agentName === "calendar" || agentName === "sport" ? "plugin" : "agent";
}

/** Parents first, so that a later record can name an earlier one. */
const IMPORT_ORDER = ["area", "person", "place", "asset", "goal", "project", "habit", "event", "task", "note"];
const IMPORT_STATUS: Record<string, string> = { task: "open", note: "open", goal: "active", project: "active", event: "upcoming", habit: "active" };
const IMPORT_MAX = 2000;
/** A decision on an imported record is kept this long, so that a second import does not bring the record back. */
const IMPORT_KEEP_DAYS = 90;

function isLoopback(ip: string | null): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

const quietFetch: ModelFetch = (url, init) => fetch(url, init);

/** A list, or a task that is not itself an item, can hold items. */
function isItemParent(view: EntityView): boolean {
  return (view.type === "project" && view.kind === "list") || (view.type === "task" && view.kind !== "item");
}

/** The types that a partner adds and changes with no review. An area, a goal, a habit, and a source wait for the owner. */
const PARTNER_TYPES = new Set(["task", "event", "note", "person", "place", "asset", "project"]);

/** The looser of two tiers: the one that reads more. */
function looserOf(a: Tier, b: Tier): Tier {
  return covers(a, b) ? a : b;
}

/**
 * A write from a client: an empty string is no value, and a date must be one that HMN can read. A free text date
 * such as "next friday" is refused here, so it never reaches a screen.
 */
function cleanFields(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  for (const key of ["due_at", "status", "kind", "area_id"]) {
    if (out[key] === "") out[key] = null;
  }
  if (out.due_at !== undefined && out.due_at !== null && !readableDue(out.due_at)) {
    throw new ApiError(422, "bad_date", "Use a date like 2026-12-01, or a date and a time.");
  }
  return out;
}

/** The relations of the graph, with the words for each direction. docs/ONTOLOGY.md, section 2.3. */
export const RELATIONS: Array<{ rel: string; out: string; in: string }> = [
  { rel: "part_of", out: "Part of", in: "Has" },
  { rel: "for", out: "For", in: "For this" },
  { rel: "with", out: "With", in: "With this" },
  { rel: "about", out: "About", in: "About this" },
  { rel: "at", out: "At", in: "Here" },
  { rel: "in", out: "In", in: "Holds" },
  { rel: "from", out: "From", in: "Gave" },
  { rel: "cares_for", out: "Cares for", in: "Cared for by" },
  { rel: "serves", out: "Serves", in: "Served by" },
  { rel: "related", out: "Related to", in: "Related to" },
];

/**
 * The typed fields that a person sees and edits for each type, kept in `properties` under the same key. A client
 * shows a form from this list, so no one edits JSON. A key that is not here is kept as it is.
 */
export const FIELDS = BASE_FIELDS;

/** A sort key for `due_at`: a time on a day comes before "some time that day", and no date comes last. */
function dueSortKey(due: string | null): string {
  if (!due) return "9999";
  return due.length === 10 ? `${due}T99` : due;
}
