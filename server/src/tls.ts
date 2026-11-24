import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { unwrap, wrap } from "./store";

export type Certs = { cert: string; key: string; ca: string; fingerprint: string };

/** TLS 1.2 with forward secrecy and an AEAD cipher only. TLS 1.3 suites are not changed by this list. */
export const TLS_CIPHERS = "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305";

/** The system tool by absolute path when it is there, so that a folder early in PATH cannot replace it. */
const OPENSSL = existsSync("/usr/bin/openssl") ? "/usr/bin/openssl" : "openssl";

/**
 * The certificate of the server, and its key. The key is wrapped under the KEK, like the database key, and it is
 * opened in memory only. A plain `server.key` from an older version is wrapped and removed at the next start. The
 * CA key is removed after the certificate is made: nothing else is signed with it.
 */
export function ensureCerts(dataDir: string, kek: Buffer): Certs {
  const dir = join(dataDir, "tls");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const certPath = join(dir, "server.crt");
  const caPath = join(dir, "ca.crt");
  const plainKey = join(dir, "server.key");
  const wrappedKey = join(dir, "server.key.wrap");
  if (!existsSync(certPath) || !existsSync(caPath) || (!existsSync(wrappedKey) && !existsSync(plainKey))) issue(dir);
  if (existsSync(plainKey)) {
    writeFileSync(wrappedKey, wrap(kek, readFileSync(plainKey)), { mode: 0o600 });
    unlinkSync(plainKey);
  }
  for (const name of ["ca.key", "server.csr", "ca.srl", "openssl.cnf"]) {
    if (existsSync(join(dir, name))) unlinkSync(join(dir, name));
  }
  let key: string;
  try {
    key = unwrap(kek, readFileSync(wrappedKey)).toString("utf8");
  } catch {
    throw new Error("The TLS key does not open with this KEK. Run deploy/hmn renew-cert, then put the new fingerprint on each phone.");
  }
  const cert = readFileSync(certPath, "utf8");
  const ca = readFileSync(caPath, "utf8");
  const fingerprint = createHash("sha256").update(derFromPem(cert)).digest("hex");
  return { cert, key, ca, fingerprint };
}

/** A new CA and a new certificate. The fingerprint changes, so each phone needs the new one. Stop the server first. */
export function renewCerts(dataDir: string, kek: Buffer): Certs {
  const dir = join(dataDir, "tls");
  for (const name of ["server.crt", "ca.crt", "server.key", "server.key.wrap"]) {
    if (existsSync(join(dir, name))) unlinkSync(join(dir, name));
  }
  return ensureCerts(dataDir, kek);
}

function issue(dir: string) {
  const certPath = join(dir, "server.crt");
  const keyPath = join(dir, "server.key");
  const caPath = join(dir, "ca.crt");
  const caKey = join(dir, "ca.key");
  const config = join(dir, "openssl.cnf");
  writeFileSync(
    config,
    `[req]\ndistinguished_name=req_distinguished_name\nx509_extensions=v3_req\nprompt=no\n[req_distinguished_name]\nCN=hmn\n[v3_req]\nsubjectAltName=DNS:hmn.local,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
  );
  const run = (args: string[]) => {
    const proc = Bun.spawnSync([OPENSSL, ...args], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`openssl failed: ${proc.stderr.toString()}`);
  };
  // A named curve: LibreSSL, the openssl of macOS, writes explicit curve parameters by default, and Bun refuses them.
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-pkeyopt", "ec_param_enc:named_curve"];
  run(["req", "-x509", ...ec, "-keyout", caKey, "-out", caPath, "-days", "825", "-nodes", "-subj", "/CN=HMN Local CA"]);
  run(["req", ...ec, "-keyout", keyPath, "-out", join(dir, "server.csr"), "-nodes", "-subj", "/CN=hmn"]);
  run(["x509", "-req", "-in", join(dir, "server.csr"), "-CA", caPath, "-CAkey", caKey, "-CAcreateserial", "-out", certPath, "-days", "825", "-extfile", config, "-extensions", "v3_req"]);
}

function derFromPem(pem: string): Buffer {
  const body = pem.replace(/-----BEGIN CERTIFICATE-----/, "").replace(/-----END CERTIFICATE-----/, "").replace(/\s+/g, "");
  return Buffer.from(body, "base64");
}
