import type { CredentialKey, CredentialStore } from "./types.ts";

const APP = "hal9999";

export class SecretServiceStore implements CredentialStore {
  name = "Linux Secret Service";

  get(key: CredentialKey): string | null {
    const result = Bun.spawnSync(
      ["secret-tool", "lookup", "application", APP, "key", key],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (result.exitCode !== 0) return null;
    const value = new TextDecoder().decode(result.stdout).trim();
    return value || null;
  }

  set(key: CredentialKey, value: string): void {
    // Pipe value via stdin — never as a CLI argument
    const result = Bun.spawnSync(
      ["secret-tool", "store", "--label", `hal9999 ${key}`, "application", APP, "key", key],
      { stdin: Buffer.from(value), stdout: "pipe", stderr: "pipe" }
    );
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to store credential in Secret Service: ${stderr}`);
    }
  }

  delete(key: CredentialKey): void {
    Bun.spawnSync(
      ["secret-tool", "clear", "application", APP, "key", key],
      { stdout: "pipe", stderr: "pipe" }
    );
  }

  isAvailable(): boolean {
    // Need both secret-tool on PATH and a D-Bus session bus
    const which = Bun.spawnSync(
      ["which", "secret-tool"],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (which.exitCode !== 0) return false;

    return !!process.env.DBUS_SESSION_BUS_ADDRESS;
  }
}
