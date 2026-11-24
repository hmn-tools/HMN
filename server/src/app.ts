import { join } from "node:path";
import { ensureWorkers } from "./workers/config";
import { ensureApprovalTables } from "./approval";
import { ensureDeviceTables } from "./devices/tables";
import { ensureExternalTables } from "./external/tables";
import { openStore, type Store } from "./store";
import { Hmn } from "./hmn";
import { handleRequest } from "./http";
import type { Certs } from "./tls";

export type App = {
  hmn: Hmn;
  store: Store;
  secrets: { owner: string; agent: string; display: string } | null;
  certs: Certs;
  fetch: (req: Request, ip?: string | null) => Promise<Response>;
  close: () => void;
};

export function createApp(options: {
  dataDir: string;
  kek: Buffer;
  now?: () => Date;
  timeZone?: string;
  certs?: Certs;
  mirrorDir?: string;
  /** `empty` starts a new graph with no demonstration. It has an effect on the first boot only. */
  seed?: "demo" | "empty";
}): App {
  const store = openStore(options.dataDir, options.kek);
  const hmn = new Hmn(store, options.now ?? (() => new Date()), options.timeZone ?? "UTC");
  hmn.migrateSeed(options.seed ?? "demo");
  hmn.backfillVersions();
  ensureWorkers(store.db, (options.now ?? (() => new Date()))().toISOString());
  ensureDeviceTables(store.db);
  ensureExternalTables(store.db);
  ensureApprovalTables(store.db);
  hmn.attachMirror(options.mirrorDir ?? join(options.dataDir, "mirror"));
  ensureWorkers(store.db, (options.now ?? (() => new Date()))().toISOString());
  ensureDeviceTables(store.db);
  ensureExternalTables(store.db);
  ensureApprovalTables(store.db);
  hmn.checkpoint();
  const certs = options.certs ?? { cert: "", key: "", ca: "", fingerprint: "test" };
  return {
    hmn,
    store,
    secrets: hmn.secrets,
    certs,
    fetch: (req, ip = "127.0.0.1") => handleRequest(hmn, req, ip, certs.fingerprint),
    close: () => {
      hmn.cancelSave();
      store.close();
    },
  };
}
