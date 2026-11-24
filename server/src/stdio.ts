/**
 * The stdio transport for a local MCP client. It is a pipe to the running HMN server, and it holds no data.
 * It does not open the data directory: two processes that open one encrypted store overwrite each other.
 *
 * MCP on stdio is one JSON message on each line. A notification gets no answer.
 *
 * The agent key comes from the first of these that is set:
 *   HMN_API_KEY                      the key itself
 *   --key-file <path>, HMN_API_KEY_FILE   a file that holds the key
 *   --key-name <name>                the macOS Keychain item `hmn.agent.<name>`, for a key that the owner made for one agent
 *   --view-name <name>               the macOS Keychain item `hmn.view.<name>`, for a key that the owner made for one view
 *   the macOS Keychain item `hmn.agent`, which the first boot of the server wrote
 *
 *   --url <url>, HMN_URL    the server, default https://127.0.0.1:8787
 *   --ca <path>, HMN_CA     the server's CA certificate, default ./data/tls/ca.crt
 */
import { existsSync, readFileSync } from "node:fs";

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1]! : null;
}

function readKey(): string | null {
  if (process.env.HMN_API_KEY) return process.env.HMN_API_KEY;
  const file = option("key-file") ?? process.env.HMN_API_KEY_FILE ?? null;
  if (file) return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  if (process.platform === "darwin" && process.env.HMN_NO_KEYCHAIN !== "1") {
    const view = option("view-name");
    const name = view ?? option("key-name");
    if (name && !/^[a-z][a-z0-9-]{0,39}$/.test(name)) return null;
    const item = view ? `hmn.view.${view}` : name ? `hmn.agent.${name}` : "hmn.agent";
    const found = Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-s", item, "-a", "hmn", "-w"], { stdout: "pipe", stderr: "pipe" });
    if (found.exitCode === 0) return found.stdout.toString("utf8").trim();
  }
  return null;
}

const token = readKey();
if (!token) {
  console.error("No agent key. Set HMN_API_KEY, or give --key-file with a file that holds the key.");
  process.exit(1);
}
const base = (option("url") ?? process.env.HMN_URL ?? "https://127.0.0.1:8787").replace(/\/+$/, "");
const caPath = option("ca") ?? process.env.HMN_CA ?? "./data/tls/ca.crt";
if (!existsSync(caPath)) {
  console.error(`The CA certificate is not at ${caPath}. Give --ca with the path of data/tls/ca.crt.`);
  process.exit(1);
}
const ca = readFileSync(caPath, "utf8");

export async function forward(message: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const isRequest = "id" in message && message.id !== null && message.id !== undefined;
  try {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-hmn-surface": "mcp" },
      body: JSON.stringify(message),
      tls: { ca },
    } as RequestInit);
    if (!isRequest) return null;
    if (!response.ok) {
      const text = response.status === 401 ? "The key was refused." : "The HMN server did not accept the request.";
      return { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } };
    }
    return (await response.json()) as Record<string, unknown>;
  } catch {
    if (!isRequest) return null;
    return { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "The HMN server did not answer. Check that it runs." } };
  }
}

function write(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
let chain: Promise<void> = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end === -1) return;
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    // One message at a time, so the answers keep the order of the requests.
    chain = chain.then(async () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
        return;
      }
      const answer = await forward(parsed);
      if (answer) write(answer);
    });
  }
});
process.stdin.on("end", () => {
  void chain.then(() => process.exit(0));
});
