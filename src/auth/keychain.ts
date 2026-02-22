import type { CredentialKey, CredentialStore } from "./types.ts";

const SERVICE = "hal9999";

export class KeychainStore implements CredentialStore {
  name = "macOS Keychain";

  get(key: CredentialKey): string | null {
    const result = Bun.spawnSync(
      ["security", "find-generic-password", "-s", SERVICE, "-a", key, "-w"],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (result.exitCode !== 0) return null;
    return new TextDecoder().decode(result.stdout).trim();
  }

  set(key: CredentialKey, value: string): void {
    const result = Bun.spawnSync(
      ["security", "add-generic-password", "-s", SERVICE, "-a", key, "-w", value, "-U"],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to store credential in Keychain: ${stderr}`);
    }
  }

  delete(key: CredentialKey): void {
    Bun.spawnSync(
      ["security", "delete-generic-password", "-s", SERVICE, "-a", key],
      { stdout: "pipe", stderr: "pipe" }
    );
    // Ignore errors — key may not exist
  }

  isAvailable(): boolean {
    const result = Bun.spawnSync(
      ["security", "help"],
      { stdout: "pipe", stderr: "pipe" }
    );
    return result.exitCode === 0;
  }
}
