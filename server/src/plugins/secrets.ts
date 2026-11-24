import { keychainAllowed, keychainArgs, SECURITY_TOOL } from "../store";

/**
 * A plugin token comes from the Keychain on a Mac, or from the named environment variable. It is never given a
 * default. A test server (HMN_INSECURE_DEV_KEK, or HMN_KEYCHAIN that names a missing file) does not read the Keychain.
 */
export function readPluginSecret(keychainService: string, envName: string): string | null {
  if (process.platform === "darwin" && keychainAllowed()) {
    const proc = Bun.spawnSync([SECURITY_TOOL, ...keychainArgs(["find-generic-password", "-s", keychainService, "-w"])], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      const value = new TextDecoder().decode(proc.stdout).trim();
      if (value) return value;
    }
  }
  const env = process.env[envName];
  if (env && env.trim()) return env.trim();
  return null;
}

export function secretConfigured(keychainService: string, envName: string): boolean {
  return readPluginSecret(keychainService, envName) !== null;
}
