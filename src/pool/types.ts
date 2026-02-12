export interface PoolConfig {
  snapshotId: string;
  region: string;
  plan: string;
  maxPoolSize: number;
  sshKeyIds?: string[];
  labelPrefix?: string;
  /** How long (ms) a released VM stays warm before being destroyed. 0 = destroy immediately. */
  idleTimeoutMs?: number;
}
