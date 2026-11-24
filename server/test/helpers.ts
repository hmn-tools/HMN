import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp, type App } from "../src/app";

// A test never uses a real Keychain. The server refuses a named keychain file that does not exist.
process.env.HMN_KEYCHAIN ??= join(tmpdir(), "hmn-tests-no-such.keychain-db");

export const NOW = new Date("2026-11-11T04:39:00.000Z");

export function testApp(): App {
  const dataDir = mkdtempSync(join(tmpdir(), "hmn-"));
  return createApp({
    dataDir,
    kek: randomBytes(32),
    now: () => NOW,
    timeZone: "Australia/Perth",
  });
}

export async function call(
  app: App,
  path: string,
  options: {
    method?: string;
    key?: string;
    surface?: string;
    grant?: string;
    body?: unknown;
    ip?: string;
    agent?: string;
  } = {},
) {
  const headers = new Headers();
  if (options.key) headers.set("authorization", `Bearer ${options.key}`);
  if (options.surface) headers.set("x-hmn-surface", options.surface);
  if (options.grant) headers.set("x-hmn-grant", options.grant);
  if (options.agent) headers.set("x-hmn-agent", options.agent);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await app.fetch(
    new Request(`https://hmn.local${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    }),
    options.ip ?? "127.0.0.1",
  );
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json, headers: response.headers };
}
