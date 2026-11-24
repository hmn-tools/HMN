/**
 * A new certificate for the server. Stop the server first.
 *
 *   bun src/renew-cert.ts [--data-dir <dir>]
 *
 * It prints the new fingerprint. Each phone pins the old one, so type the new fingerprint into Settings on each phone.
 */
import { loadKek } from "./store";
import { renewCerts } from "./tls";

const index = process.argv.indexOf("--data-dir");
const dataDir = index !== -1 && process.argv[index + 1] ? process.argv[index + 1]! : process.env.HMN_DATA_DIR ?? "./data";
try {
  const certs = renewCerts(dataDir, loadKek({ dataDir }));
  console.log(`certificate fingerprint ${certs.fingerprint}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "The certificate was not renewed.");
  process.exit(1);
}
