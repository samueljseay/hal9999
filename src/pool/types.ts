import type { Provider } from "../providers/types.ts";

export interface ProviderSlot {
  name: string;
  provider: Provider;
  snapshotId: string;
  region: string;
  plan: string;
  maxPoolSize: number;
  priority: number;
  sshKeyIds?: string[];
}

export interface PoolConfig {
  slots: ProviderSlot[];
  labelPrefix?: string;
  /** How long (ms) a released VM stays warm before being destroyed. 0 = destroy immediately. */
  idleTimeoutMs?: number;
}
