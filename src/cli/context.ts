import type { Database } from "bun:sqlite";
import type { ProviderSlot } from "../pool/types.ts";
import type { ProviderType } from "../providers/index.ts";
import { getDb } from "../db/index.ts";
import { createProvider } from "../providers/index.ts";
import { VMPoolManager } from "../pool/manager.ts";
import { TaskManager } from "../tasks/manager.ts";
import { Orchestrator } from "../orchestrator.ts";
import { resolveAgent } from "../agents/presets.ts";

// --- Lazy singletons ---

let _db: Database | null = null;
let _taskManager: TaskManager | null = null;
let _poolManager: VMPoolManager | null = null;

/** Tier 1 — open SQLite (cheap, cached) */
export function db(): Database {
  if (!_db) _db = getDb();
  return _db;
}

/** Tier 2 — TaskManager wrapping DB. No providers needed. */
export function taskManager(): TaskManager {
  if (!_taskManager) _taskManager = new TaskManager(db());
  return _taskManager;
}

/**
 * Tier 2 — VMPoolManager with empty slots (read-only).
 * listVms() and getPoolStats() are pure SQL — no provider needed.
 */
export function poolManager(): VMPoolManager {
  if (!_poolManager) _poolManager = new VMPoolManager(db(), { slots: [] });
  return _poolManager;
}

// --- Provider alias ---

export function normalizeProvider(input: string): ProviderType {
  if (input === "do") return "digitalocean";
  return input as ProviderType;
}

export const defaultProvider = (): ProviderType =>
  normalizeProvider(process.env.HAL_DEFAULT_PROVIDER ?? "lima");

// --- Full orchestrator (tier 3) ---

export interface OrchestratorOpts {
  provider?: string;
  agent?: string;
  region?: string;
  plan?: string;
  branch?: string;
  base?: string;
  noPr?: boolean;
}

/** Per-provider idle timeout defaults (seconds) */
const IDLE_TIMEOUT_DEFAULTS: Record<string, number> = {
  lima: 1800,        // 30 min — free, keep warm
  digitalocean: 300, // 5 min — costs money
};

/** Sync check for hal9999-golden Lima instance. Uses clone: prefix if found. */
function resolveLimaSnapshotId(): string {
  if (process.env.HAL_LIMA_TEMPLATE) return process.env.HAL_LIMA_TEMPLATE;
  const result = Bun.spawnSync(
    ["limactl", "list", "hal9999-golden", "--json"],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (result.exitCode === 0) {
    const stdout = new TextDecoder().decode(result.stdout);
    if (stdout.includes("hal9999-golden")) {
      return "clone:hal9999-golden";
    }
  }
  return "src/image/hal9999.yaml";
}

export function buildProviderSlots(opts: OrchestratorOpts): ProviderSlot[] {
  const providerStr = opts.provider ?? defaultProvider();
  const providerNames = providerStr.split(",").map((s) => normalizeProvider(s.trim()));

  return providerNames.map((name, i) => {
    const provider = createProvider(name);

    const prefix = name === "digitalocean" ? "DO" : name.toUpperCase();
    const snapshotId = name === "lima"
      ? resolveLimaSnapshotId()
      : (process.env[`HAL_${prefix}_SNAPSHOT_ID`] ?? process.env.HAL_SNAPSHOT_ID);

    if (!snapshotId) {
      console.error(`Error: HAL_SNAPSHOT_ID (or HAL_${prefix}_SNAPSHOT_ID) is required for ${name}`);
      process.exit(1);
    }

    const idleTimeoutS = parseInt(
      process.env[`HAL_${prefix}_IDLE_TIMEOUT_S`] ?? process.env.HAL_IDLE_TIMEOUT_S ?? String(IDLE_TIMEOUT_DEFAULTS[name] ?? 0),
      10
    );

    const minReady = parseInt(
      process.env[`HAL_${prefix}_MIN_READY`] ?? process.env.HAL_MIN_READY ?? "0",
      10
    );

    return {
      name,
      provider,
      snapshotId,
      region: process.env[`HAL_${prefix}_REGION`] ?? process.env.HAL_REGION ?? opts.region ?? "nyc1",
      plan: process.env[`HAL_${prefix}_PLAN`] ?? process.env.HAL_PLAN ?? opts.plan ?? "s-1vcpu-1gb",
      maxPoolSize: parseInt(process.env[`HAL_${prefix}_MAX_POOL_SIZE`] ?? process.env.HAL_MAX_POOL_SIZE ?? "5", 10),
      priority: i,
      idleTimeoutMs: idleTimeoutS * 1000,
      minReady,
      sshKeyIds: process.env.HAL_SSH_KEY_ID ? [process.env.HAL_SSH_KEY_ID] : undefined,
    };
  });
}

export async function orchestrator(opts: OrchestratorOpts): Promise<Orchestrator> {
  const slots = buildProviderSlots(opts);
  const agentName = opts.agent ?? process.env.HAL_AGENT ?? "claude";
  const agent = await resolveAgent(agentName);

  return new Orchestrator(db(), {
    pool: { slots },
    agent,
  });
}
