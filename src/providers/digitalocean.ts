import type {
  Provider,
  Instance,
  Snapshot,
  CreateInstanceOptions,
} from "./types.ts";

const API_BASE = "https://api.digitalocean.com/v2";

interface DOConfig {
  apiKey: string;
}

export class DigitalOceanProvider implements Provider {
  private apiKey: string;

  constructor(config: DOConfig) {
    if (!config.apiKey) {
      throw new Error("DigitalOcean API token is required");
    }
    this.apiKey = config.apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DO API ${method} ${path} failed (${res.status}): ${text}`);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private mapDroplet(raw: DODroplet): Instance {
    const publicNet = raw.networks.v4.find((n) => n.type === "public");
    return {
      id: String(raw.id),
      label: raw.name,
      ip: publicNet?.ip_address ?? "0.0.0.0",
      status: mapDropletStatus(raw.status),
      region: raw.region.slug,
      plan: raw.size_slug,
      createdAt: raw.created_at,
    };
  }

  private mapSnapshot(raw: DOSnapshot): Snapshot {
    return {
      id: String(raw.id),
      description: raw.name,
      // DO snapshots don't have a status field — if it exists, it's complete
      status: "complete",
      size: raw.size_gigabytes * 1_000_000_000,
      createdAt: raw.created_at,
    };
  }

  async createInstance(opts: CreateInstanceOptions): Promise<Instance> {
    const body: Record<string, unknown> = {
      name: opts.label ?? `hal9999-${Date.now()}`,
      region: opts.region,
      size: opts.plan,
    };

    if (opts.snapshotId) {
      body.image = parseInt(opts.snapshotId, 10) || opts.snapshotId;
    } else if (opts.osId) {
      body.image = opts.osId;
    } else {
      throw new Error("Either snapshotId or osId must be provided");
    }

    if (opts.sshKeyIds?.length) body.ssh_keys = opts.sshKeyIds;
    if (opts.userData) body.user_data = opts.userData;

    const data = await this.request<{ droplet: DODroplet }>(
      "POST",
      "/droplets",
      body
    );
    return this.mapDroplet(data.droplet);
  }

  async startInstance(id: string): Promise<void> {
    await this.request<{ action: DOAction }>(
      "POST",
      `/droplets/${id}/actions`,
      { type: "power_on" }
    );
  }

  async stopInstance(id: string): Promise<void> {
    await this.request<{ action: DOAction }>(
      "POST",
      `/droplets/${id}/actions`,
      { type: "shutdown" }
    );
  }

  async destroyInstance(id: string): Promise<void> {
    await this.request<void>("DELETE", `/droplets/${id}`);
  }

  async getInstance(id: string): Promise<Instance> {
    const data = await this.request<{ droplet: DODroplet }>(
      "GET",
      `/droplets/${id}`
    );
    return this.mapDroplet(data.droplet);
  }

  async listInstances(label?: string): Promise<Instance[]> {
    const params = label ? `?name=${encodeURIComponent(label)}` : "";
    const data = await this.request<{ droplets: DODroplet[] }>(
      "GET",
      `/droplets${params}`
    );
    return data.droplets.map((d) => this.mapDroplet(d));
  }

  async waitForReady(id: string, timeoutMs = 300_000): Promise<Instance> {
    const start = Date.now();
    let lastStatus = "";
    while (Date.now() - start < timeoutMs) {
      const instance = await this.getInstance(id);
      if (instance.status === "active" && instance.ip !== "0.0.0.0") {
        return instance;
      }
      if (instance.status !== lastStatus) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(`Droplet ${id}: ${instance.status} (${elapsed}s elapsed)`);
        lastStatus = instance.status;
      }
      if (instance.status === "error") {
        throw new Error(`Droplet ${id} entered error state`);
      }
      await sleep(5_000);
    }
    throw new Error(`Droplet ${id} did not become ready within ${timeoutMs / 1000}s`);
  }

  async createSnapshot(
    instanceId: string,
    description: string
  ): Promise<Snapshot> {
    // DO creates snapshots via droplet actions
    const data = await this.request<{ action: DOAction }>(
      "POST",
      `/droplets/${instanceId}/actions`,
      { type: "snapshot", name: description }
    );

    // The action doesn't return the snapshot directly — we need to poll
    // for the action to complete, then find the snapshot by name
    const actionId = data.action.id;
    await this.waitForAction(instanceId, actionId);

    // Find the snapshot we just created
    const snapshots = await this.listSnapshots();
    const snap = snapshots.find((s) => s.description === description);
    if (!snap) {
      throw new Error(`Snapshot "${description}" not found after creation`);
    }
    return snap;
  }

  async listSnapshots(): Promise<Snapshot[]> {
    const data = await this.request<{ snapshots: DOSnapshot[] }>(
      "GET",
      "/snapshots?resource_type=droplet"
    );
    return data.snapshots.map((s) => this.mapSnapshot(s));
  }

  async getSnapshot(id: string): Promise<Snapshot> {
    const data = await this.request<{ snapshot: DOSnapshot }>(
      "GET",
      `/snapshots/${id}`
    );
    return this.mapSnapshot(data.snapshot);
  }

  async deleteSnapshot(id: string): Promise<void> {
    await this.request<void>("DELETE", `/snapshots/${id}`);
  }

  async waitForSnapshot(id: string, timeoutMs = 1_800_000): Promise<Snapshot> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const snapshot = await this.getSnapshot(id);
      if (snapshot.status === "complete") {
        return snapshot;
      }
      await sleep(10_000);
    }
    throw new Error(`Snapshot ${id} did not complete within ${timeoutMs}ms`);
  }

  async listSshKeys(): Promise<DOSshKey[]> {
    const data = await this.request<{ ssh_keys: DOSshKey[] }>(
      "GET",
      "/account/keys"
    );
    return data.ssh_keys;
  }

  async createSshKey(name: string, publicKey: string): Promise<DOSshKey> {
    const data = await this.request<{ ssh_key: DOSshKey }>(
      "POST",
      "/account/keys",
      { name, public_key: publicKey }
    );
    return data.ssh_key;
  }

  async listImages(query?: string): Promise<DOImage[]> {
    const data = await this.request<{ images: DOImage[] }>(
      "GET",
      "/images?type=distribution"
    );
    if (!query) return data.images;
    const q = query.toLowerCase();
    return data.images.filter(
      (img) =>
        img.name.toLowerCase().includes(q) ||
        img.distribution.toLowerCase().includes(q) ||
        img.slug?.toLowerCase().includes(q)
    );
  }

  private async waitForAction(
    dropletId: string,
    actionId: number,
    timeoutMs = 1_800_000
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const data = await this.request<{ action: DOAction }>(
        "GET",
        `/droplets/${dropletId}/actions/${actionId}`
      );
      if (data.action.status === "completed") return;
      if (data.action.status === "errored") {
        throw new Error(`Action ${actionId} errored`);
      }
      await sleep(10_000);
    }
    throw new Error(`Action ${actionId} timed out after ${timeoutMs}ms`);
  }
}

// --- DO API response shapes ---

interface DODroplet {
  id: number;
  name: string;
  status: string;
  created_at: string;
  region: { slug: string };
  size_slug: string;
  networks: {
    v4: Array<{ ip_address: string; type: string }>;
  };
}

interface DOSnapshot {
  id: number;
  name: string;
  status: string;
  size_gigabytes: number;
  created_at: string;
  regions: string[];
}

export interface DOSshKey {
  id: number;
  name: string;
  public_key: string;
  fingerprint: string;
}

export interface DOImage {
  id: number;
  name: string;
  distribution: string;
  slug: string | null;
  public: boolean;
  regions: string[];
  created_at: string;
}

interface DOAction {
  id: number;
  status: string;
  type: string;
}

function mapDropletStatus(status: string): Instance["status"] {
  if (status === "active") return "active";
  if (status === "new") return "pending";
  if (status === "off") return "stopped";
  return "error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
