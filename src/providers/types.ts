export interface Instance {
  id: string;
  label: string;
  ip: string;
  status: "pending" | "active" | "stopped" | "error";
  region: string;
  plan: string;
  snapshotId?: string;
  createdAt: string;
  sshPort?: number;
}

export interface Snapshot {
  id: string;
  description: string;
  status: "pending" | "complete";
  size: number;
  createdAt: string;
}

export interface CreateInstanceOptions {
  region: string;
  plan: string;
  snapshotId?: string;
  osId?: number | string;
  label?: string;
  sshKeyIds?: string[];
  userData?: string;
}

export interface Provider {
  createInstance(opts: CreateInstanceOptions): Promise<Instance>;
  startInstance(id: string): Promise<void>;
  stopInstance(id: string): Promise<void>;
  destroyInstance(id: string): Promise<void>;
  getInstance(id: string): Promise<Instance>;
  listInstances(label?: string): Promise<Instance[]>;
  waitForReady(id: string, timeoutMs?: number): Promise<Instance>;

  createSnapshot(instanceId: string, description: string): Promise<Snapshot>;
  listSnapshots(): Promise<Snapshot[]>;
  getSnapshot(id: string): Promise<Snapshot>;
  deleteSnapshot(id: string): Promise<void>;
  waitForSnapshot(id: string, timeoutMs?: number): Promise<Snapshot>;
}
