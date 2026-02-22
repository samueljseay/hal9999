export type CredentialKey =
  | "GITHUB_TOKEN"
  | "CLAUDE_CODE_OAUTH_TOKEN"
  | "ANTHROPIC_API_KEY"
  | "DO_API_TOKEN"
  | "OPENAI_API_KEY";

export const CREDENTIAL_KEYS: CredentialKey[] = [
  "GITHUB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "DO_API_TOKEN",
  "OPENAI_API_KEY",
];

export interface CredentialStore {
  /** Human-readable backend name (e.g. "macOS Keychain") */
  name: string;

  get(key: CredentialKey): string | null;
  set(key: CredentialKey, value: string): void;
  delete(key: CredentialKey): void;

  /** Returns true if this backend is available on the current system */
  isAvailable(): boolean;
}
