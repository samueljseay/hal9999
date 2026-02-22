import type { CredentialKey, CredentialStore } from "./types.ts";
import { CREDENTIAL_KEYS } from "./types.ts";
import { KeychainStore } from "./keychain.ts";
import { SecretServiceStore } from "./secret-service.ts";
import { EncryptedFileStore } from "./encrypted-file.ts";

let _store: CredentialStore | null = null;

/** Detect the best available credential store for this platform */
export function getStore(): CredentialStore {
  if (_store) return _store;

  if (process.platform === "darwin") {
    const keychain = new KeychainStore();
    if (keychain.isAvailable()) {
      _store = keychain;
      return _store;
    }
  }

  if (process.platform === "linux") {
    const secretService = new SecretServiceStore();
    if (secretService.isAvailable()) {
      _store = secretService;
      return _store;
    }
  }

  _store = new EncryptedFileStore();
  return _store;
}

/**
 * Get a single credential. process.env takes precedence over the store.
 */
export function getCredential(key: CredentialKey): string | null {
  // Env always wins (supports .env and exported vars)
  const envValue = process.env[key];
  if (envValue) return envValue;

  return getStore().get(key);
}

/**
 * Returns a full env record for all known credential keys.
 * process.env values take precedence over stored credentials.
 */
export function getCredentialEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};

  for (const key of CREDENTIAL_KEYS) {
    env[key] = getCredential(key) ?? undefined;
  }

  return env;
}

export type CredentialSource = "env" | "store" | "not set";

export interface CredentialStatus {
  key: CredentialKey;
  source: CredentialSource;
}

/** Check the source of each credential for status display */
export function getCredentialStatuses(): CredentialStatus[] {
  const store = getStore();

  return CREDENTIAL_KEYS.map((key) => {
    if (process.env[key]) {
      return { key, source: "env" as const };
    }
    if (store.get(key)) {
      return { key, source: "store" as const };
    }
    return { key, source: "not set" as const };
  });
}
