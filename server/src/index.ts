import { createApp } from "./app";
import { startWorkerLoop } from "./workers/loop";
import { handleExternal } from "./external/http";
import { loadKek, rememberBootSecrets } from "./store";
import { ensureCerts, TLS_CIPHERS } from "./tls";

const dataDir = process.env.HMN_DATA_DIR ?? "./data";
const port = Number(process.env.HMN_PORT ?? "8787");
const hostname = process.env.HMN_HOST ?? "0.0.0.0";
// With no HMN_TZ, the zone of this machine. A day starts and ends in that zone.
const timeZone = process.env.HMN_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const now = () => (process.env.HMN_NOW ? new Date(process.env.HMN_NOW) : new Date());

const kek = loadKek({ dataDir });
const certs = ensureCerts(dataDir, kek);
const app = createApp({
  dataDir,
  kek,
  now,
  timeZone,
  certs,
  mirrorDir: process.env.HMN_MIRROR_DIR || undefined,
  seed: process.env.HMN_SEED === "empty" ? "empty" : "demo",
});

if (app.secrets) {
  console.log("HMN created a new graph. Write these down. They will not be shown again.");
  console.log(`owner   (write, up to private)  ${app.secrets.owner}`);
  console.log(`agent   (propose, up to personal) ${app.secrets.agent}`);
  console.log(`display (read, public only)     ${app.secrets.display}`);
  console.log(`recovery passphrase (write this on paper, it is not in the data directory in the clear):`);
  console.log(`  ${app.store.backupPassphrase}`);
  rememberBootSecrets({
    owner: app.secrets.owner,
    agent: app.secrets.agent,
    display: app.secrets.display,
    backup: app.store.backupPassphrase,
  });
} else {
  console.log("HMN opened an existing graph. Secrets stay wrapped.");
}
console.log(`certificate fingerprint ${app.certs.fingerprint}`);
console.log(`ca certificate ${dataDir}/tls/ca.crt`);

const server = Bun.serve({
  port,
  hostname,
  tls: { cert: app.certs.cert, key: app.certs.key, ciphers: TLS_CIPHERS },
  fetch(req, bunServer) {
    const ip = bunServer.requestIP(req)?.address ?? null;
    return app.fetch(req, ip);
  },
});

console.log(`HMN listening on https://${hostname}:${server.port}`);

let external: ReturnType<typeof Bun.serve> | null = null;
if (process.env.HMN_EXTERNAL_MCP === "1") {
  const externalPort = Number(process.env.HMN_EXTERNAL_PORT ?? "8788");
  external = Bun.serve({
    port: externalPort,
    hostname,
    tls: { cert: app.certs.cert, key: app.certs.key, ciphers: TLS_CIPHERS },
    fetch(req, bunServer) {
      const ip = bunServer.requestIP(req)?.address ?? null;
      return handleExternal(app.hmn, req, ip);
    },
  });
  console.log(`HMN external MCP on https://${hostname}:${external.port}. This port has no admin API. It stays closed until the owner enables it.`);
}

const stopWorkers = startWorkerLoop(app.hmn);

const shutdown = () => {
  stopWorkers();
  server.stop();
  external?.stop();
  app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
