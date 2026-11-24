import { afterAll, beforeAll, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { call, testApp } from "./helpers";
import type { App } from "../src/app";
import { encodeBmp1 } from "../src/devices/image";
import { publicDisplayAccess, renderPublic } from "../src/devices/trmnl";

let app: App;
beforeAll(() => {
  app = testApp();
});
afterAll(() => app.close());

const hidden = ["Yves", "Luca", "Sam", "Alex", "passport", "clinic", "weekly notes", "SRS", "dentist"];

async function request(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown) {
  const response = await app.fetch(
    new Request(`https://hmn.local${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    headers["x-test-ip"] ?? "127.0.0.1",
  );
  const buffer = Buffer.from(await response.arrayBuffer());
  let json: unknown = null;
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    try {
      json = JSON.parse(buffer.toString("utf8"));
    } catch {
      json = null;
    }
  }
  return { status: response.status, buffer, json, headers: response.headers };
}

test("1-bit BMP and greyscale PNG are 800 by 480", () => {
  const white = encodeBmp1(() => true);
  expect(white.length).toBe(48062);
  expect(white.subarray(0, 2).toString("ascii")).toBe("BM");
  expect(white.readInt32LE(18)).toBe(800);
  expect(white.readInt32LE(22)).toBe(480);
  expect(white.readUInt16LE(28)).toBe(1);
  expect(white[62]).toBe(0xff);
  const marked = encodeBmp1((x, y) => !(x === 0 && y === 0));
  expect(marked[62 + 479 * 100]).toBe(0x7f);

  const access = publicDisplayAccess(app.hmn, app.secrets!.display, "127.0.0.1");
  const png = renderPublic(app.hmn, access, "today", "png", "1");
  expect(png.readUInt32BE(16)).toBe(800);
  expect(png.readUInt32BE(20)).toBe(480);
  expect(png[24]).toBe(1);
  const grey = renderPublic(app.hmn, access, "today", "png", "4");
  expect(grey[24]).toBe(2);
  const idat = pngChunk(png, "IDAT");
  const raw = inflateSync(idat);
  expect(raw.length).toBe(480 * 101);
});

test("a display pairs with its own key, pulls a public screen, and can be revoked", async () => {
  const mac = "41:B4:10:39:A1:24";
  const setup = await request("/api/setup", { ID: mac, Model: "og", "FW-Version": "1.8.16" });
  expect(setup.status).toBe(200);
  const first = setup.json as { status: number; api_key: string | null; friendly_id: string; message: string };
  expect(first.status).toBe(404);
  expect(first.api_key).toBeNull();
  expect(first.friendly_id).toMatch(/^[A-Z0-9]{6}$/);
  expect(first.message).toContain(first.friendly_id);

  const away = await request(`/api/v1/trmnl/devices/${first.friendly_id}/claim`, { authorization: `Bearer ${app.secrets!.owner}`, "x-test-ip": "10.9.9.9", "content-type": "application/json" }, "POST", { name: "Kitchen" });
  expect(away.status).toBe(403);

  const claim = await request(`/api/v1/trmnl/devices/${first.friendly_id}/claim`, { authorization: `Bearer ${app.secrets!.owner}`, "content-type": "application/json" }, "POST", { name: "Kitchen" });
  expect(claim.status).toBe(200);
  const claimed = claim.json as { api_key: string; credential_id: string };
  expect(claimed.api_key.startsWith("hmn_")).toBe(true);

  const paired = await request("/api/setup", { ID: mac });
  const key = (paired.json as { status: number; api_key: string | null }).api_key;
  expect((paired.json as { status: number }).status).toBe(200);
  expect(key).toBe(claimed.api_key);
  const again = await request("/api/setup", { ID: mac });
  expect((again.json as { api_key: string | null }).api_key).toBeNull();

  const display = await request("/api/display", { ID: mac, "Access-Token": key!, Model: "og", Width: "800", Height: "480" });
  expect(display.status).toBe(200);
  const body = display.json as { status: number; filename: string; refresh_rate: number; image_url: string; reset_firmware: boolean; update_firmware: boolean; firmware_url: string | null; special_function: string };
  expect(body.status).toBe(0);
  expect(body.refresh_rate).toBe(3600);
  expect(typeof body.refresh_rate).toBe("number");
  expect(body.filename.length).toBeLessThanOrEqual(31);
  expect(body.filename.startsWith("today-")).toBe(true);
  expect(body.reset_firmware).toBe(false);
  expect(body.update_firmware).toBe(false);
  expect(body.firmware_url).toBeNull();
  expect(body.special_function).toBe("none");
  expect(body.image_url).toContain("/api/trmnl/image.bmp");
  for (const word of hidden) expect(JSON.stringify(display.json).includes(word), word).toBe(false);

  const imagePath = new URL(body.image_url).pathname + new URL(body.image_url).search;
  const image = await request(imagePath);
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toContain("image/bmp");
  expect(image.buffer.length).toBe(48062);
  expect(image.buffer.readUInt16LE(28)).toBe(1);
  const access = publicDisplayAccess(app.hmn, app.secrets!.display, "127.0.0.1");
  const expected = renderPublic(app.hmn, access, "today", "bmp", "1");
  expect(image.buffer.equals(expected)).toBe(true);

  const ownerImage = await request("/api/display", { ID: mac, authorization: `Bearer ${app.secrets!.owner}` });
  const ownerUrl = (ownerImage.json as { image_url: string }).image_url;
  const ownerPath = new URL(ownerUrl).pathname + new URL(ownerUrl).search;
  const ownerBytes = await request(ownerPath);
  expect(ownerBytes.buffer.equals(expected)).toBe(true);

  const grey = await request(`/api/trmnl/image.png?access_token=${encodeURIComponent(key!)}&screen=today&depth=4`);
  expect(grey.headers.get("content-type")).toContain("image/png");
  expect(grey.buffer[24]).toBe(2);
  expect(grey.buffer.length).toBeLessThan(90_000);

  const logged = await request("/api/log", { "Access-Token": key!, "content-type": "application/json" }, "POST", {
    logs: [{ message: `battery low token hmn_${"a".repeat(20)}` }],
  });
  expect(logged.status).toBe(204);
  const stored = app.hmn.store.db.query("SELECT message FROM trmnl_logs ORDER BY id DESC LIMIT 1").get() as { message: string };
  expect(stored.message).toContain("[secret]");
  expect(stored.message).not.toContain("hmn_a");
  expect(stored.message).not.toContain("weekly notes");

  const listed = await request("/api/v1/trmnl/devices", { authorization: `Bearer ${app.secrets!.owner}` });
  expect(JSON.stringify(listed.json)).not.toContain(claimed.api_key);

  const second = await request("/api/v1/trmnl/devices", { authorization: `Bearer ${app.secrets!.owner}`, "content-type": "application/json" }, "POST", {
    name: "Desk",
    mac: "AA:BB:CC:DD:EE:02",
  });
  const other = (second.json as { api_key: string }).api_key;
  expect(other).not.toBe(key);

  const stable = await request("/api/display", { ID: mac, "Access-Token": key! });
  expect((stable.json as { filename: string }).filename).toBe(body.filename);

  const revoked = await request(`/api/v1/trmnl/devices/${claimed.credential_id}/revoke`, { authorization: `Bearer ${app.secrets!.owner}` }, "POST");
  expect(revoked.status).toBe(200);
  const denied = await request("/api/display", { ID: mac, "Access-Token": key! });
  expect(denied.status).toBe(401);
  const still = await request("/api/display", { "Access-Token": other, ID: "AA:BB:CC:DD:EE:02" });
  expect(still.status).toBe(200);
});

test("a TRMNL X gets a 1872 by 1404 sixteen-grey public image", async () => {
  const mac = "41:B4:10:39:A1:99";
  const setup = await request("/api/setup", { ID: mac, Model: "x" });
  const friendly = (setup.json as { friendly_id: string }).friendly_id;
  const claim = await request(`/api/v1/trmnl/devices/${friendly}/claim`, { authorization: `Bearer ${app.secrets!.owner}`, "content-type": "application/json" }, "POST", { name: "Desk" });
  const key = (claim.json as { api_key: string }).api_key;
  await request("/api/setup", { ID: mac, Model: "x" });
  const display = await request("/api/display", { ID: mac, "Access-Token": key, Model: "x", Width: "1872", Height: "1404" });
  const body = display.json as { image_url: string; filename: string };
  expect(body.image_url).toContain("model=x");
  expect(body.image_url).toContain(".png");
  expect(body.filename.length).toBeLessThanOrEqual(31);
  for (const word of hidden) expect(JSON.stringify(display.json).includes(word), word).toBe(false);
  const imagePath = new URL(body.image_url).pathname + new URL(body.image_url).search;
  const image = await request(imagePath, { Model: "x", Width: "1872", Height: "1404" });
  expect(image.headers.get("content-type")).toContain("image/png");
  expect(image.buffer.readUInt32BE(16)).toBe(1872);
  expect(image.buffer.readUInt32BE(20)).toBe(1404);
  expect(image.buffer[24]).toBe(4);
  expect(image.buffer.length).toBeLessThan(750_000);
  const access = publicDisplayAccess(app.hmn, app.secrets!.display, "127.0.0.1");
  const expected = renderPublic(app.hmn, access, "today", "png", "16", { width: 1872, height: 1404 });
  expect(image.buffer.equals(expected)).toBe(true);
});

test("the existing display route stays on today.png when the caller is not a TRMNL", async () => {
  const display = await call(app, "/api/display", { key: app.secrets!.display });
  const payload = display.json as { image_url: string; refresh_rate: number };
  expect(payload.refresh_rate).toBe(3600);
  expect(payload.image_url).toContain("/api/display/today.png");
});

function pngChunk(png: Buffer, type: string): Buffer {
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const name = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (name === type) return data;
    offset += 12 + length;
  }
  throw new Error("missing chunk");
}
