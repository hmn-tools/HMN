import { randomCode, randomId, randomSecret, sha256hex } from "../crypto";
import type { Hmn } from "../hmn";
import { makeAccess } from "../policy";
import { DECK } from "../screens";
import { ApiError, type Access } from "../types";
import { renderLines, renderScreen, type Depth } from "./render";
import { isBwryModel, OG, panelFor, TRMNL_X } from "./image";
import { renderFridge } from "../fridge";
import { ensureDeviceTables } from "./tables";

export type DeviceRow = {
  id: string;
  mac: string;
  friendly_id: string;
  name: string;
  model: string | null;
  firmware: string | null;
  status: string;
  credential_id: string | null;
  key_pending: string | null;
  claimed_at: string | null;
  delivered_at: string | null;
  last_seen_at: string | null;
  battery: string | null;
  rssi: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
  setup_ip?: string | null;
  conflict?: number;
  /** `public`, or `household` for a display that the household shares, such as the fridge. */
  ceiling?: string;
  /** `bwry` for a four-colour panel. Null when the display sends its model. */
  palette?: string | null;
};

/** The choices that the owner gives a display when it is claimed. */
export type DisplayChoice = { ceiling: "public" | "household"; palette: "bw" | "bwry" | null };

export function displayChoice(body: Record<string, unknown>): DisplayChoice {
  const ceiling = body.ceiling === undefined || body.ceiling === "public" ? "public" : body.ceiling === "household" ? "household" : null;
  if (!ceiling) throw new ApiError(422, "bad_tier", "A display reads Public or Household.");
  const palette = body.palette === undefined || body.palette === null ? null : body.palette === "bw" || body.palette === "bwry" ? body.palette : undefined;
  if (palette === undefined) throw new ApiError(422, "bad_palette", "A palette is bw or bwry.");
  return { ceiling, palette };
}

const DECK_IDS = new Set<string>(DECK.map((screen) => screen.id));

export function normalizeMac(value: string | null): string | null {
  if (!value) return null;
  const mac = value.trim().toUpperCase().replace(/-/g, ":");
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) ? mac : null;
}

/**
 * The setup call of a display has no key, and a MAC address is easy to read. So the key goes only to the address
 * that asked first as this display, and a second address that asks as the same display blocks the pairing.
 */
export function setupDevice(hmn: Hmn, macRaw: string | null, modelRaw: string | null, firmwareRaw: string | null, origin: string, ip: string | null = null) {
  ensureDeviceTables(hmn.store.db);
  const model = modelRaw ? modelRaw.slice(0, 40) : null;
  const firmware = firmwareRaw ? firmwareRaw.slice(0, 40) : null;
  // A display that was never claimed goes after an hour, so that made-up displays do not fill the slots.
  const hourAgo = new Date(Date.parse(hmnNow(hmn)) - 3_600_000).toISOString();
  hmn.store.db.query("DELETE FROM trmnl_devices WHERE status = 'pending' AND created_at < ?").run(hourAgo);
  const mac = normalizeMac(macRaw);
  if (!mac) {
    return {
      status: 404,
      api_key: null,
      friendly_id: null,
      image_url: `${origin}/api/trmnl/setup.bmp`,
      message: "The display did not send a MAC address.",
    };
  }
  let row = deviceByMac(hmn, mac);
  if (!row) {
    const pending = hmn.store.db.query("SELECT COUNT(*) AS n FROM trmnl_devices WHERE status = 'pending'").get() as { n: number };
    if (pending.n >= 8) {
      return {
        status: 404,
        api_key: null,
        friendly_id: null,
        image_url: `${origin}/api/trmnl/setup.bmp`,
        message: "Too many unpaired displays.",
      };
    }
    const now = hmnNow(hmn);
    row = insertDevice(hmn, {
      mac,
      friendly: friendlyId(hmn),
      name: "Display",
      model,
      firmware,
      status: "pending",
      now,
    });
    hmn.store.db.query("UPDATE trmnl_devices SET setup_ip = ? WHERE id = ?").run(ip, row.id);
    row = deviceByMac(hmn, mac)!;
  } else {
    hmn.store.db.query("UPDATE trmnl_devices SET model = COALESCE(?, model), firmware = COALESCE(?, firmware), last_seen_at = ? WHERE id = ?").run(
      model,
      firmware,
      hmnNow(hmn),
      row.id,
    );
    row = deviceByMac(hmn, mac)!;
    const waiting = row.status === "pending" || row.status === "revoked" || (row.status === "claimed" && Boolean(row.key_pending));
    if (waiting && ip) {
      if (!row.setup_ip) hmn.store.db.query("UPDATE trmnl_devices SET setup_ip = ? WHERE id = ?").run(ip, row.id);
      else if (row.setup_ip !== ip) hmn.store.db.query("UPDATE trmnl_devices SET conflict = 1 WHERE id = ?").run(row.id);
      row = deviceByMac(hmn, mac)!;
    }
  }
  const image = `${origin}/api/trmnl/setup.bmp?friendly_id=${encodeURIComponent(row.friendly_id)}`;
  if (row.conflict) {
    hmn.store.persist();
    return {
      status: 404,
      api_key: null,
      friendly_id: row.friendly_id,
      image_url: image,
      message: "Two machines asked as this display. On the mini, revoke it and pair it again.",
    };
  }
  if (row.status === "claimed" && row.key_pending && (!row.setup_ip || row.setup_ip === ip)) {
    const secret = row.key_pending;
    hmn.store.db.query("UPDATE trmnl_devices SET key_pending = NULL, delivered_at = ? WHERE id = ?").run(hmnNow(hmn), row.id);
    hmn.store.persist();
    return {
      status: 200,
      api_key: secret,
      friendly_id: row.friendly_id,
      image_url: image,
      message: "Paired. The key stays on the display.",
    };
  }
  hmn.store.persist();
  if (row.status === "claimed" && row.delivered_at) {
    return {
      status: 200,
      api_key: null,
      friendly_id: row.friendly_id,
      image_url: image,
      message: "This display is already paired. Revoke it on the mini to pair again.",
    };
  }
  return {
    status: 404,
    api_key: null,
    friendly_id: row.friendly_id,
    image_url: image,
    message: `On the mini, claim display ${row.friendly_id}.`,
  };
}

export function registerDevice(hmn: Hmn, access: Access, name: string, macRaw: string, ip: string | null, choice: DisplayChoice = { ceiling: "public", palette: null }) {
  assertMint(access, ip);
  const mac = normalizeMac(macRaw);
  if (!mac) throw new ApiError(422, "bad_mac", "A display needs a MAC address.");
  ensureDeviceTables(hmn.store.db);
  const existing = deviceByMac(hmn, mac);
  if (existing?.status === "claimed" && existing.credential_id) {
    throw new ApiError(409, "paired", "That display is already paired. Revoke it before pairing again.");
  }
  const friendly = existing?.friendly_id ?? friendlyId(hmn);
  const id = existing?.id ?? randomId("trmnl");
  const minted = mintKey(hmn, name || "Display", choice.ceiling);
  const now = hmnNow(hmn);
  if (existing) {
    hmn.store.db
      .query(
        `UPDATE trmnl_devices SET name = ?, status = 'claimed', credential_id = ?, key_pending = ?, claimed_at = ?, delivered_at = NULL WHERE id = ?`,
      )
      .run(name.slice(0, 40) || "Display", minted.id, minted.secret, now, id);
  } else {
    insertDevice(hmn, { id, mac, friendly, name: name || "Display", model: null, firmware: null, status: "claimed", now });
    hmn.store.db
      .query("UPDATE trmnl_devices SET credential_id = ?, key_pending = ?, claimed_at = ? WHERE id = ?")
      .run(minted.id, minted.secret, now, id);
  }
  hmn.store.db.query("UPDATE trmnl_devices SET ceiling = ?, palette = ? WHERE id = ?").run(choice.ceiling, choice.palette, id);
  hmn.store.persist();
  return {
    id,
    friendly_id: friendly,
    mac,
    ceiling: choice.ceiling,
    api_key: minted.secret,
    credential_id: minted.id,
    message: "The key is shown once here, and once more when the display calls setup.",
  };
}

export function claimDevice(hmn: Hmn, access: Access, friendly: string, name: string, ip: string | null, choice: DisplayChoice = { ceiling: "public", palette: null }) {
  assertMint(access, ip);
  ensureDeviceTables(hmn.store.db);
  const row = hmn.store.db.query("SELECT * FROM trmnl_devices WHERE friendly_id = ? OR id = ?").get(friendly, friendly) as DeviceRow | null;
  if (!row) throw new ApiError(404, "not_found", "Not found.");
  if (row.status === "claimed") throw new ApiError(409, "paired", "That display is already paired. Revoke it before pairing again.");
  if (row.conflict) throw new ApiError(409, "conflict", "Two machines asked as this display. Revoke it, then restart the display.");
  const minted = mintKey(hmn, name || row.name, choice.ceiling);
  const now = hmnNow(hmn);
  hmn.store.db
    .query(
      `UPDATE trmnl_devices SET name = ?, status = 'claimed', credential_id = ?, key_pending = ?, claimed_at = ?, delivered_at = NULL WHERE id = ?`,
    )
    .run((name || row.name).slice(0, 40), minted.id, minted.secret, now, row.id);
  hmn.store.db.query("UPDATE trmnl_devices SET ceiling = ?, palette = ? WHERE id = ?").run(choice.ceiling, choice.palette, row.id);
  hmn.store.persist();
  return { id: row.id, friendly_id: row.friendly_id, mac: row.mac, ceiling: choice.ceiling, api_key: minted.secret, credential_id: minted.id };
}

export function revokeDevice(hmn: Hmn, access: Access, id: string) {
  if (access.principal.scope !== "write") throw new ApiError(403, "forbidden", "This credential cannot revoke a display.");
  ensureDeviceTables(hmn.store.db);
  const row = hmn.store.db.query("SELECT * FROM trmnl_devices WHERE id = ? OR friendly_id = ? OR credential_id = ?").get(id, id, id) as DeviceRow | null;
  if (!row) throw new ApiError(404, "not_found", "Not found.");
  const now = hmnNow(hmn);
  if (row.credential_id) {
    hmn.store.db.query("UPDATE credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, row.credential_id);
  }
  // A revoke also clears the record of setup addresses, so the display can pair again.
  hmn.store.db.query("UPDATE trmnl_devices SET status = 'revoked', key_pending = NULL, setup_ip = NULL, conflict = 0 WHERE id = ?").run(row.id);
  hmn.store.persist();
  return { id: row.id, revoked: true };
}

export function listDevices(hmn: Hmn) {
  ensureDeviceTables(hmn.store.db);
  const rows = hmn.store.db.query("SELECT * FROM trmnl_devices ORDER BY created_at").all() as DeviceRow[];
  return rows.map((row) => ({
    id: row.id,
    friendly_id: row.friendly_id,
    mac: row.mac,
    name: row.name,
    model: row.model,
    status: row.status,
    credential_id: row.credential_id,
    last_seen_at: row.last_seen_at,
    battery: row.battery,
    rssi: row.rssi,
  }));
}

/** True when a display is claimed at Household: a fridge that can show a pairing code. */
export function hasHouseholdDisplay(hmn: Hmn): boolean {
  ensureDeviceTables(hmn.store.db);
  return hmn.store.db.query("SELECT 1 FROM trmnl_devices WHERE status = 'claimed' AND ceiling = 'household' LIMIT 1").get() !== null;
}

export function publicDisplayAccess(hmn: Hmn, token: string, ip: string | null): Access {
  const authed = hmn.accessFor(token, ip, "display", null);
  return makeAccess({ ...authed.principal, maxTier: "public", vault: false, forcedCeiling: "public" }, "display", false);
}

/**
 * The access of a display. A display route is Public for every key, also for the owner key. The one exception is
 * the key of a display that the owner claimed at Household: it reads Household, and Hide from the mini still
 * pushes it down to Public.
 */
export function displayAccess(hmn: Hmn, token: string, ip: string | null): { access: Access; device: DeviceRow | null } {
  const authed = hmn.accessFor(token, ip, "display", null);
  const device = deviceByCredential(hmn, authed.principal.id);
  if (device?.ceiling === "household" && authed.principal.kind === "device" && authed.principal.maxTier === "household") {
    const hidden = authed.principal.forcedCeiling === "public";
    return {
      access: makeAccess({ ...authed.principal, vault: false, forcedCeiling: hidden ? "public" : null }, "api", false),
      device,
    };
  }
  return { access: makeAccess({ ...authed.principal, maxTier: "public", vault: false, forcedCeiling: "public" }, "display", false), device };
}

function deviceByCredential(hmn: Hmn, credentialId: string): DeviceRow | null {
  ensureDeviceTables(hmn.store.db);
  return (hmn.store.db.query("SELECT * FROM trmnl_devices WHERE credential_id = ? AND status = 'claimed'").get(credentialId) as DeviceRow | null) ?? null;
}

/** The inks of a display: what the owner chose, else what its `Model` header says. */
export function paletteOf(device: DeviceRow | null, modelHeader: string | null): "bw" | "bwry" {
  if (device?.palette === "bwry" || device?.palette === "bw") return device.palette;
  return isBwryModel(modelHeader ?? device?.model ?? null) ? "bwry" : "bw";
}

/** The BYOS answer for the fridge: the screen of the time window, an image name that changes only with the picture. */
export function fridgeBody(hmn: Hmn, access: Access, token: string, origin: string, palette: "bw" | "bwry") {
  const id = hmn.fridgeWindowNow();
  const screen = hmn.fridgeScreen(access, id, origin);
  const bytes = renderFridge(screen, palette);
  const format = palette === "bwry" ? "png" : "bmp";
  return {
    status: 0,
    image_url: `${origin}/api/trmnl/fridge.${format}?access_token=${encodeURIComponent(token)}&screen=${id}&palette=${palette}`,
    filename: `fr-${id}-${sha256hex(bytes).slice(0, 10)}`,
    // Ask again at the next window, and every ten minutes, so that a change shows. The same name is no redraw.
    refresh_rate: Math.min(600, hmn.fridgeSecondsToNextWindow()),
    reset_firmware: false,
    update_firmware: false,
    firmware_url: null,
    special_function: "none",
    maximum_compatibility: false,
    temperature_profile: "default",
    screen: id,
  };
}

export function renderPublic(hmn: Hmn, access: Access, screenId: string, format: "bmp" | "png", depth: Depth, panel = OG): Buffer {
  if (!DECK_IDS.has(screenId)) throw new ApiError(404, "not_found", "Not found.");
  return renderScreen(hmn.screen(access, screenId), format, depth, panel);
}

export function renderSetup(friendly: string | null, format: "bmp" | "png"): Buffer {
  const id = friendly && /^[A-Z0-9]{6}$/.test(friendly) ? friendly : "";
  const lines = ["HMN", "Claim this display", id || "Waiting", "On the mini."];
  return renderLines(lines, format, "1", "> setup");
}

export function byosBody(
  hmn: Hmn,
  access: Access,
  token: string,
  origin: string,
  format: "bmp" | "png",
  depth: Depth,
  panel = OG,
) {
  const screen = hmn.displayScreen(access, null);
  const bytes = renderScreen(screen, format, depth, panel);
  const filename = imageName(screen.id, bytes, new Date(screen.generated_at));
  const extra = panel.width === TRMNL_X.width ? "&model=x" : format === "png" && (depth === "4" || depth === "bwry") ? `&depth=${depth}` : "";
  return {
    status: 0,
    image_url: `${origin}/api/trmnl/image.${format}?access_token=${encodeURIComponent(token)}&screen=${screen.id}${extra}`,
    filename,
    refresh_rate: 3600,
    reset_firmware: false,
    update_firmware: false,
    firmware_url: null,
    special_function: "none",
    maximum_compatibility: false,
    temperature_profile: "default",
    screen: screen.id,
  };
}

export function currentBody(hmn: Hmn, access: Access, token: string, origin: string) {
  const body = byosBody(hmn, access, token, origin, "bmp", "1");
  return {
    status: 200,
    image_url: body.image_url,
    filename: body.filename,
    refresh_rate: body.refresh_rate,
    rendered_at: hmnNow(hmn),
  };
}

export function imageName(screenId: string, bytes: Buffer, now: Date): string {
  const hash = sha256hex(bytes).slice(0, 6);
  const stamp = Math.floor(now.getTime() / 3_600_000) * 3600;
  const prefix = screenId.slice(0, 12);
  const name = `${prefix}-${hash}-${stamp}`;
  return name.length <= 31 ? name : `${prefix.slice(0, 8)}-${hash}-${stamp}`;
}

export function noteTelemetry(hmn: Hmn, macRaw: string | null, headers: Headers) {
  const mac = normalizeMac(macRaw);
  if (!mac) return;
  ensureDeviceTables(hmn.store.db);
  const row = deviceByMac(hmn, mac);
  if (!row) return;
  const width = Number(headers.get("width") ?? "");
  const height = Number(headers.get("height") ?? "");
  hmn.store.db
    .query(
      `UPDATE trmnl_devices SET last_seen_at = ?, battery = ?, rssi = ?, firmware = COALESCE(?, firmware), model = COALESCE(?, model), width = ?, height = ? WHERE id = ?`,
    )
    .run(
      hmnNow(hmn),
      headers.get("battery-voltage")?.slice(0, 20) ?? null,
      headers.get("rssi")?.slice(0, 20) ?? null,
      headers.get("fw-version")?.slice(0, 40) ?? null,
      headers.get("model")?.slice(0, 40) ?? null,
      Number.isFinite(width) ? width : null,
      Number.isFinite(height) ? height : null,
      row.id,
    );
  hmn.store.persist();
}

export function writeLogs(hmn: Hmn, access: Access, logs: unknown[]) {
  ensureDeviceTables(hmn.store.db);
  const row = hmn.store.db.query("SELECT * FROM trmnl_devices WHERE credential_id = ?").get(access.principal.id) as DeviceRow | null;
  // Only a paired display writes its log. Another key gets the same answer, and nothing is stored.
  if (!row) return;
  const now = hmnNow(hmn);
  const messages = logs.slice(0, 40).map(sanitizeLog).filter((line) => line.length > 0);
  for (const message of messages) {
    hmn.store.db.query("INSERT INTO trmnl_logs (device_id, at, message) VALUES (?, ?, ?)").run(row?.id ?? access.principal.id, now, message);
  }
  if (row) {
    hmn.store.db
      .query(
        `DELETE FROM trmnl_logs WHERE device_id = ? AND id NOT IN (
          SELECT id FROM trmnl_logs WHERE device_id = ? ORDER BY id DESC LIMIT 200
        )`,
      )
      .run(row.id, row.id);
  }
  hmn.store.persist();
}

function sanitizeLog(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text
    .replace(/hmn_[A-Za-z0-9_-]+/g, "[secret]")
    .replace(/bearer\s+\S+/gi, "Bearer [secret]")
    .replace(/access_token=[^&\s]+/gi, "access_token=[secret]")
    .slice(0, 500);
}

/**
 * The key of one display. A Public display is held at Public. A household display (the fridge) is made at
 * Household, with no forced ceiling, so that Hide from the mini can still push it down to Public.
 */
function mintKey(hmn: Hmn, name: string, ceiling: "public" | "household" = "public"): { id: string; secret: string } {
  const secret = randomSecret();
  const id = randomId("device");
  const now = hmnNow(hmn);
  const expires = new Date(new Date(now).getTime() + 90 * 86_400_000).toISOString();
  hmn.store.db
    .query(
      `INSERT INTO credentials (
        id, name, kind, key_hash, scope, max_tier, vault, allow_types, allow_areas, deny_areas,
        forced_ceiling, expires_at, created_at, revoked_at, rotated_from
      ) VALUES (?, ?, 'device', ?, 'read', ?, 0, NULL, NULL, NULL, ?, ?, ?, NULL, NULL)`,
    )
    .run(id, `trmnl:${name}`.slice(0, 80), sha256hex(secret), ceiling, ceiling === "public" ? "public" : null, expires, now);
  return { id, secret };
}

function insertDevice(
  hmn: Hmn,
  input: { id?: string; mac: string; friendly: string; name: string; model: string | null; firmware: string | null; status: string; now: string },
): DeviceRow {
  const id = input.id ?? randomId("trmnl");
  hmn.store.db
    .query(
      `INSERT INTO trmnl_devices (
        id, mac, friendly_id, name, model, firmware, status, credential_id, key_pending, claimed_at, delivered_at, last_seen_at, battery, rssi, width, height, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?)`,
    )
    .run(id, input.mac, input.friendly, input.name.slice(0, 40), input.model, input.firmware, input.status, input.now, input.now);
  return deviceByMac(hmn, input.mac)!;
}

function deviceByMac(hmn: Hmn, mac: string): DeviceRow | null {
  ensureDeviceTables(hmn.store.db);
  return (hmn.store.db.query("SELECT * FROM trmnl_devices WHERE mac = ?").get(mac) as DeviceRow | null) ?? null;
}

function friendlyId(hmn: Hmn): string {
  for (let i = 0; i < 8; i++) {
    const code = randomCode().slice(0, 6);
    const taken = hmn.store.db.query("SELECT id FROM trmnl_devices WHERE friendly_id = ?").get(code) as { id: string } | null;
    if (!taken) return code;
  }
  return randomCode().slice(0, 6);
}

function assertMint(access: Access, ip: string | null) {
  if (access.principal.scope !== "write") throw new ApiError(403, "forbidden", "This credential cannot pair a display.");
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
    throw new ApiError(403, "localhost", "Display keys are created on the mini itself.");
  }
}

function hmnNow(hmn: Hmn): string {
  return new Date(hmn.screen(makeAccess({ id: "clock", name: "clock", kind: "key", scope: "read", maxTier: "public", vault: false, denyAreas: [], allowAreas: null, allowTypes: null, forcedCeiling: "public" }, "display", false), "today").generated_at).toISOString();
}
