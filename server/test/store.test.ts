import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { call, testApp } from "./helpers";
import type { App } from "../src/app";
import { processIsAlive, removeStaleRuntimeFiles, runtimeBase } from "../src/store";

let app: App;
beforeAll(() => {
  app = testApp();
});
afterAll(() => app.close());

/** The id of a process that has ended. */
function deadPid(): number {
  const proc = Bun.spawnSync(["true"]);
  expect(proc.exitCode).toBe(0);
  return proc.pid;
}

test("a start removes the working copy of a server that was killed, and no other file", () => {
  const base = runtimeBase();
  const dead = deadPid();
  if (processIsAlive(dead)) {
    // A sandboxed shell can refuse the check of another process. HMN then keeps each copy, which is the
    // safe side, and this test has nothing to show. CI and a normal shell run the test.
    console.warn("This shell cannot tell that a process has ended. The stale-copy test did not run.");
    return;
  }
  const stale = join(base, `hmn-${dead}-0123abcd.sqlite`);
  const staleJournal = join(base, `hmn-${dead}-0123abcd.sqlite-journal`);
  const running = join(base, `hmn-${process.ppid}-0123abcd.sqlite`);
  const other = join(base, `hmn-${dead}-notes.txt`);
  for (const path of [stale, staleJournal, running, other]) writeFileSync(path, "plain text of a graph", { mode: 0o600 });
  try {
    const second = testApp();
    try {
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(staleJournal)).toBe(false);
      // The parent process is alive, so its copy can be in use.
      expect(existsSync(running)).toBe(true);
      // A file that does not have the name of a working copy is not HMN's to remove.
      expect(existsSync(other)).toBe(true);

    } finally {
      second.close();
    }
  } finally {
    for (const path of [stale, staleJournal, running, other]) {
      if (existsSync(path)) Bun.spawnSync(["rm", "-f", path]);
    }
  }
});

test("the working copy is in memory: no plaintext file of this process is in the temporary folder", () => {
  const mine = readdirSync(runtimeBase()).filter((name) => name.startsWith(`hmn-${process.pid}-`));
  expect(mine).toEqual([]);
  expect(app.store.plainBytes().subarray(0, 15).toString("latin1")).toBe("SQLite format 3");
});

test("a folder that is not there is not an error", () => {
  expect(removeStaleRuntimeFiles("/no/such/folder/for/hmn")).toBe(0);
});

test("a save replaces the encrypted graph in one step and leaves no part file", async () => {
  const before = readFileSync(app.store.encPath);
  // A pairing code is a small write that the server saves at once.
  const paired = await call(app, "/api/v1/pairing", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
  expect(paired.status).toBe(200);
  app.store.persist();
  const after = readFileSync(app.store.encPath);
  expect(after.equals(before)).toBe(false);
  expect(existsSync(`${app.store.encPath}.tmp`)).toBe(false);
  expect(after.length).toBeGreaterThan(0);
  // The saved file is the encrypted form, not the SQLite file.
  expect(after.subarray(0, 15).toString("latin1")).not.toBe("SQLite format 3");
});
