import type {
  Provider,
  Instance,
  Snapshot,
  CreateInstanceOptions,
} from "./types.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface IncusConfig {
  cpus?: number; // default 2
  memory?: string; // default "4GiB"
  remote?: string; // default "local"
  sshPubKeyPath?: string; // auto-detect ~/.ssh/id_ed25519.pub
}

interface IncusInstance {
  name: string;
  type: string; // "virtual-machine" or "container"
  status: string; // Running, Stopped, Starting, etc.
  created_at: string;
  config: Record<string, string>;
  state?: {
    network?: Record<
      string,
      {
        addresses: Array<{
          family: string;
          address: string;
          scope: string;
        }>;
      }
    >;
  };
}

interface IncusImage {
  fingerprint: string;
  aliases: Array<{ name: string }>;
  size: number;
  created_at: string;
  properties?: Record<string, string>;
}

export class IncusProvider implements Provider {
  private cpus: number;
  private memory: string;
  private remote: string;
  private sshPubKey: string;

  constructor(config: IncusConfig = {}) {
    this.cpus = config.cpus ?? 2;
    this.memory = config.memory ?? "4GiB";
    this.remote = config.remote ?? "local";
    this.sshPubKey = this.readSshPubKey(config.sshPubKeyPath);
  }

  private readSshPubKey(overridePath?: string): string {
    const paths = overridePath
      ? [overridePath]
      : [
          join(homedir(), ".ssh", "id_ed25519.pub"),
          join(homedir(), ".ssh", "id_rsa.pub"),
        ];

    for (const p of paths) {
      try {
        return readFileSync(p, "utf-8").trim();
      } catch {
        continue;
      }
    }
    throw new Error(
      `No SSH public key found. Tried: ${paths.join(", ")}. Set HAL_INCUS_SSH_PUB_KEY to override.`
    );
  }

  // ── Exec helpers (mirrors Lima pattern) ──────────────────────────

  private async exec(
    args: string[],
    timeoutMs = 60_000
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["incus", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (timedOut) {
      throw new Error(`incus ${args[0]} timed out after ${timeoutMs}ms`);
    }

    return { exitCode, stdout, stderr };
  }

  private async execOrThrow(
    args: string[],
    timeoutMs?: number
  ): Promise<string> {
    const result = await this.exec(args, timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(
        `incus ${args[0]} failed (exit ${result.exitCode}): ${result.stderr}`
      );
    }
    return result.stdout;
  }

  /** Run incus with inherited stdio (output goes straight to terminal) */
  private async execInherit(
    args: string[],
    timeoutMs = 60_000
  ): Promise<void> {
    const proc = Bun.spawn(["incus", ...args], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    const exitCode = await proc.exited;
    clearTimeout(timer);

    if (timedOut) {
      throw new Error(`incus ${args[0]} timed out after ${timeoutMs}ms`);
    }
    if (exitCode !== 0) {
      throw new Error(`incus ${args[0]} failed (exit ${exitCode})`);
    }
  }

  // ── Instance helpers ─────────────────────────────────────────────

  private extractIp(raw: IncusInstance): string {
    if (!raw.state?.network) return "";
    for (const [iface, net] of Object.entries(raw.state.network)) {
      if (iface === "lo") continue;
      for (const addr of net.addresses) {
        if (
          addr.family === "inet" &&
          addr.scope === "global" &&
          !addr.address.startsWith("127.")
        ) {
          return addr.address;
        }
      }
    }
    return "";
  }

  private mapInstance(raw: IncusInstance): Instance {
    const cpus = raw.config["limits.cpu"] ?? String(this.cpus);
    const mem = raw.config["limits.memory"] ?? this.memory;
    return {
      id: raw.name,
      label: raw.name,
      ip: this.extractIp(raw),
      status: mapIncusStatus(raw.status),
      region: this.remote,
      plan: `${cpus}cpu-${mem}`,
      createdAt: raw.created_at,
      // No sshPort — Incus VMs get real bridge IPs, SSH on port 22
    };
  }

  // ── Provider interface ───────────────────────────────────────────

  async createInstance(opts: CreateInstanceOptions): Promise<Instance> {
    const name = opts.label ?? `hal9999-${Date.now()}`;
    const image = opts.snapshotId || "images:debian/13";
    const verbose = process.env.HAL_VERBOSE === "1";
    const run = verbose
      ? (args: string[], timeout: number) => this.execInherit(args, timeout)
      : (args: string[], timeout: number) =>
          this.execOrThrow(args, timeout).then(() => {});

    await run(
      [
        "launch",
        image,
        name,
        "--vm",
        `--config=limits.cpu=${this.cpus}`,
        `--config=limits.memory=${this.memory}`,
      ],
      300_000 // 5 min for image download + boot
    );

    // Wait for incus agent to be ready before injecting SSH key
    await this.waitForAgent(name);

    // Inject SSH public key for the agent user
    await this.execOrThrow(
      [
        "exec",
        name,
        "--",
        "bash",
        "-c",
        `mkdir -p /home/agent/.ssh && echo '${this.sshPubKey}' >> /home/agent/.ssh/authorized_keys && chown -R agent:agent /home/agent/.ssh && chmod 700 /home/agent/.ssh && chmod 600 /home/agent/.ssh/authorized_keys`,
      ],
      30_000
    );

    return this.getInstance(name);
  }

  /** Wait for the incus agent inside the VM to respond */
  private async waitForAgent(
    name: string,
    timeoutMs = 120_000
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await this.exec(
        ["exec", name, "--", "echo", "ready"],
        10_000
      );
      if (result.exitCode === 0 && result.stdout.trim() === "ready") return;
      await sleep(3_000);
    }
    throw new Error(
      `Incus agent in ${name} not ready after ${timeoutMs / 1000}s`
    );
  }

  async startInstance(id: string): Promise<void> {
    await this.execOrThrow(["start", id], 120_000);
  }

  async stopInstance(id: string): Promise<void> {
    await this.execOrThrow(["stop", id], 60_000);
  }

  async destroyInstance(id: string): Promise<void> {
    // Check if instance exists
    const result = await this.exec([
      "list",
      "--format=json",
      `--project=${this.remote}`,
    ]);
    if (result.exitCode !== 0) return;
    try {
      const instances = JSON.parse(result.stdout) as IncusInstance[];
      if (!instances.some((i) => i.name === id)) return; // already gone
    } catch {
      return;
    }

    // Stop first (ignore errors — may already be stopped)
    await this.exec(["stop", id, "--force"]);
    await this.execOrThrow(["delete", id, "--force"]);
  }

  async getInstance(id: string): Promise<Instance> {
    // Use --format=json with list to get state info (including network)
    const stdout = await this.execOrThrow([
      "list",
      id,
      "--format=json",
    ]);
    const instances = JSON.parse(stdout) as IncusInstance[];
    const raw = instances.find((i) => i.name === id);
    if (!raw) throw new Error(`Incus instance ${id} not found`);
    return this.mapInstance(raw);
  }

  async listInstances(label?: string): Promise<Instance[]> {
    const result = await this.exec(["list", "--format=json"]);
    if (result.exitCode !== 0) return [];

    let instances: IncusInstance[];
    try {
      instances = JSON.parse(result.stdout) as IncusInstance[];
    } catch {
      return [];
    }

    return instances
      .filter((raw) => {
        // Only VMs, not containers
        if (raw.type !== "virtual-machine") return false;
        if (label) return raw.name.includes(label);
        return raw.name.startsWith("hal9999-");
      })
      .map((raw) => this.mapInstance(raw));
  }

  async waitForReady(id: string, timeoutMs = 300_000): Promise<Instance> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const instance = await this.getInstance(id);
      // Must have both active status AND a valid IP (DHCP lease may lag)
      if (instance.status === "active" && instance.ip) {
        return instance;
      }
      if (instance.status === "error") {
        throw new Error(`Incus instance ${id} entered error state`);
      }
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(
        `Incus ${id}: ${instance.status}${instance.ip ? "" : " (waiting for IP)"} (${elapsed}s elapsed)`
      );
      await sleep(3_000);
    }
    throw new Error(
      `Incus instance ${id} did not become ready within ${timeoutMs / 1000}s`
    );
  }

  // ── Snapshot methods — published images ──────────────────────────

  async createSnapshot(
    instanceId: string,
    description: string
  ): Promise<Snapshot> {
    const alias = description.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();

    // Instance must be stopped to publish
    await this.exec(["stop", instanceId, "--force"]);
    await this.execOrThrow(
      ["publish", instanceId, "--alias", alias],
      300_000 // publishing can take a while
    );

    return {
      id: alias,
      description,
      status: "complete",
      size: 0,
      createdAt: new Date().toISOString(),
    };
  }

  async listSnapshots(): Promise<Snapshot[]> {
    const stdout = await this.execOrThrow(["image", "list", "--format=json"]);
    let images: IncusImage[];
    try {
      images = JSON.parse(stdout) as IncusImage[];
    } catch {
      return [];
    }

    return images
      .filter((img) => img.aliases.some((a) => a.name.startsWith("hal9999-")))
      .map((img) => ({
        id: img.aliases[0]?.name ?? img.fingerprint,
        description:
          img.aliases[0]?.name ??
          img.properties?.description ??
          img.fingerprint,
        status: "complete" as const,
        size: img.size,
        createdAt: img.created_at,
      }));
  }

  async getSnapshot(id: string): Promise<Snapshot> {
    const stdout = await this.execOrThrow([
      "image",
      "list",
      id,
      "--format=json",
    ]);
    const images = JSON.parse(stdout) as IncusImage[];
    const img = images[0];
    if (!img) throw new Error(`Incus image ${id} not found`);

    return {
      id: img.aliases[0]?.name ?? img.fingerprint,
      description:
        img.aliases[0]?.name ??
        img.properties?.description ??
        img.fingerprint,
      status: "complete",
      size: img.size,
      createdAt: img.created_at,
    };
  }

  async deleteSnapshot(id: string): Promise<void> {
    await this.execOrThrow(["image", "delete", id]);
  }

  async waitForSnapshot(
    _id: string,
    _timeoutMs?: number
  ): Promise<Snapshot> {
    // incus publish blocks until complete — no-op
    return this.getSnapshot(_id);
  }
}

function mapIncusStatus(status: string): Instance["status"] {
  switch (status) {
    case "Running":
      return "active";
    case "Stopped":
      return "stopped";
    case "Starting":
      return "pending";
    default:
      return "error";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
