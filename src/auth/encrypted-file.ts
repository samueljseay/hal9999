import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join, dirname } from "node:path";
import type { CredentialKey, CredentialStore } from "./types.ts";

const CREDENTIALS_PATH = join(homedir(), ".config", "hal9999", "credentials.enc");
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

interface EncryptedEnvelope {
  salt: string;     // base64
  iv: string;       // base64
  ciphertext: string; // base64
  tag: string;      // base64 (GCM auth tag)
}

function getMachineSecret(): string {
  const user = userInfo().username;
  const host = hostname();

  // Try /etc/machine-id (Linux standard)
  let machineId = "";
  try {
    machineId = readFileSync("/etc/machine-id", "utf-8").trim();
  } catch {
    // Not available — use hostname as fallback
  }

  return `hal9999:${host}:${user}:${machineId}`;
}

function deriveKey(salt: Buffer): Buffer {
  const secret = getMachineSecret();
  return scryptSync(secret, salt, KEY_LENGTH);
}

function encrypt(data: string): EncryptedEnvelope {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(data, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decrypt(envelope: EncryptedEnvelope): string {
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const key = deriveKey(salt);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf-8");
}

export class EncryptedFileStore implements CredentialStore {
  name = "Encrypted File";

  private load(): Record<string, string> {
    if (!existsSync(CREDENTIALS_PATH)) return {};
    try {
      const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
      const envelope: EncryptedEnvelope = JSON.parse(raw);
      const decrypted = decrypt(envelope);
      return JSON.parse(decrypted);
    } catch {
      // Corrupt or wrong machine — start fresh
      return {};
    }
  }

  private save(data: Record<string, string>): void {
    const dir = dirname(CREDENTIALS_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const envelope = encrypt(JSON.stringify(data));
    writeFileSync(CREDENTIALS_PATH, JSON.stringify(envelope, null, 2), { mode: 0o600 });
  }

  get(key: CredentialKey): string | null {
    const data = this.load();
    return data[key] ?? null;
  }

  set(key: CredentialKey, value: string): void {
    const data = this.load();
    data[key] = value;
    this.save(data);
  }

  delete(key: CredentialKey): void {
    const data = this.load();
    delete data[key];
    this.save(data);
  }

  isAvailable(): boolean {
    return true; // Always available as fallback
  }
}
