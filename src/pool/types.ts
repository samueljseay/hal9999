import type { Provider } from "../providers/types.ts";

export interface ProviderSlot {
  name: string;
  provider: Provider;
  snapshotId: string;
  region: string;
  plan: string;
  maxPoolSize: number;
  priority: number;
  /** How long (ms) a released VM stays warm before being destroyed. 0 = destroy immediately. */
  idleTimeoutMs: number;
  /** Minimum number of ready VMs to maintain for this provider (pre-warm). 0 = disabled. */
  minReady: number;
  sshKeyIds?: string[];
}

export interface PoolConfig {
  slots: ProviderSlot[];
  labelPrefix?: string;
}
