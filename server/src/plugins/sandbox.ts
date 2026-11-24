import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = dirname(fileURLToPath(import.meta.url));
const srcDir = dirname(pluginDir);

export type SandboxDraft = {
  op: "create" | "update";
  entity: Record<string, unknown>;
  reason: string;
  links?: unknown;
  id?: string;
  patch?: Record<string, unknown>;
};

/** Spawn the fixed plugin child process. It does not inherit secrets. Under bubblewrap or sandbox-exec it has no network, and it cannot read the data directory or the owner's home. */
export async function runPlugin(plugin: string, input: unknown, now: string): Promise<SandboxDraft[]> {
  if (!/^[a-z]+$/.test(plugin)) throw new Error("unknown plugin");
  const stdout = await spawnChild(sandboxCommand(), JSON.stringify({ plugin, now, input }));
  const parsed = JSON.parse(stdout) as { proposals?: unknown };
  if (!Array.isArray(parsed.proposals)) throw new Error("plugin output was not proposals");
  return parsed.proposals.map(asDraft);
}

/** Used by tests to prove the sandbox cannot read an arbitrary path. */
export async function probeIsolatedRead(path: string): Promise<string> {
  const command = sandboxCommand();
  const script = `const fs=require("fs"); try { process.stdout.write(fs.readFileSync(${JSON.stringify(path)}, "utf8")); } catch { process.stdout.write("UNREADABLE"); }`;
  command.pop();
  command.push("-e", script);
  return spawnChild(command, "");
}

function sandboxCommand(): string[] {
  const bun = process.execPath;
  const bwrap = ["/usr/bin/bwrap", "/bin/bwrap"].find((path) => existsSync(path));
  if (bwrap && process.platform === "linux") {
    const args = [
      bwrap,
      "--unshare-all",
      "--die-with-parent",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/lib", "/lib",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--ro-bind", dirname(bun), "/opt/bun",
      "--ro-bind", srcDir, "/src",
      "--chdir", "/",
    ];
    if (existsSync("/lib64")) args.push("--ro-bind", "/lib64", "/lib64");
    if (existsSync("/bin")) args.push("--ro-bind", "/bin", "/bin");
    args.push("/opt/bun/bun", "/src/plugins/child.ts");
    return args;
  }
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    // Bun aborts at startup unless it can read the root directory entry and its working directory.
    // The literal rule allows "/" itself and nothing below it. spawnChild sets the working directory to "/".
    const profile = `(version 1)
(deny default)
(allow process*)
(allow signal (target self))
(allow sysctl-read)
(allow mach*)
(allow ipc-posix*)
(allow file-read* (literal "/"))
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/Library"))
(allow file-read* (subpath "/bin"))
(allow file-read* (subpath "/opt"))
(allow file-read* (subpath ${JSON.stringify(dirname(bun))}))
(allow file-read* (subpath ${JSON.stringify(srcDir)}))
(deny network*)
`;
    return ["/usr/bin/sandbox-exec", "-p", profile, bun, `${pluginDir}/child.ts`];
  }
  return [bun, `${pluginDir}/child.ts`];
}

const PLUGIN_TIMEOUT_MS = 20_000;
const PLUGIN_OUTPUT_MAX = 8_000_000;

async function spawnChild(command: string[], stdin: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: command,
    env: { PATH: "/usr/bin:/bin" },
    cwd: "/",
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  // A feed with many repeating events can keep the child busy for hours. It ends after a time limit.
  const limit = setTimeout(() => proc.kill(9), PLUGIN_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(limit);
  if (code !== 0) throw new Error(err.trim() || "plugin process failed");
  if (out.length > PLUGIN_OUTPUT_MAX) throw new Error("plugin output too large");
  return out;
}

function asDraft(value: unknown): SandboxDraft {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const op = row.op === "update" ? "update" : "create";
  const entity = row.entity && typeof row.entity === "object" ? (row.entity as Record<string, unknown>) : {};
  return {
    op,
    entity,
    reason: typeof row.reason === "string" ? row.reason.slice(0, 500) : "",
    links: row.links,
    id: typeof row.id === "string" ? row.id : undefined,
    patch: row.patch && typeof row.patch === "object" ? (row.patch as Record<string, unknown>) : undefined,
  };
}

export function sandboxIsIsolated(): boolean {
  if (process.platform === "linux") return ["/usr/bin/bwrap", "/bin/bwrap"].some((path) => existsSync(path));
  return process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
}
