import type {
  Provider,
  Instance,
  Snapshot,
  CreateInstanceOptions,
} from "./types.ts";

interface LimaConfig {
  templatePath: string;
}

interface LimaInstance {
  name: string;
  status: string;
  dir: string;
  arch: string;
  cpus: number;
  memory: number;
  disk: number;
  sshConfigFile: string;
  sshAddress: string;
  config: {
    user?: { name?: string };
    ssh?: { localPort?: number };
  };
}

export class LimaProvider implements Provider {
  private templatePath: string;

  constructor(config: LimaConfig) {
    this.templatePath = config.templatePath;
  }

  private async exec(
    args: string[],
    timeoutMs = 60_000
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["limactl", ...args], {
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
      throw new Error(`limactl ${args[0]} timed out after ${timeoutMs}ms`);
    }

    return { exitCode, stdout, stderr };
  }

  private async execOrThrow(args: string[], timeoutMs?: number): Promise<string> {
    const result = await this.exec(args, timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(`limactl ${args[0]} failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    return result.stdout;
  }

  /** Run limactl with inherited stdio (output goes straight to terminal) */
  private async execInherit(args: string[], timeoutMs = 60_000): Promise<void> {
    const proc = Bun.spawn(["limactl", ...args], {
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
      throw new Error(`limactl ${args[0]} timed out after ${timeoutMs}ms`);
    }
    if (exitCode !== 0) {
      throw new Error(`limactl ${args[0]} failed (exit ${exitCode})`);
    }
  }

  private async getLimaInstance(name: string): Promise<LimaInstance | null> {
    const result = await this.exec(["list", name, "--json"]);
    if (result.exitCode !== 0) return null;

    // limactl list --json outputs one JSON object per line (JSONL)
    for (const line of result.stdout.trim().split("\n")) {
      if (!line) continue;
      try {
        const inst = JSON.parse(line) as LimaInstance;
        if (inst.name === name) return inst;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async parseSshPort(sshConfigFile: string): Promise<number> {
    try {
      const content = await Bun.file(sshConfigFile).text();
      const match = content.match(/^\s*Port\s+(\d+)/m);
      if (match?.[1]) return parseInt(match[1], 10);
    } catch {
      // Config doesn't exist yet (VM still starting)
    }
    return 22;
  }

  private async mapInstance(raw: LimaInstance): Promise<Instance> {
    const sshPort = await this.parseSshPort(raw.sshConfigFile);
    return {
      id: raw.name,
      label: raw.name,
      ip: raw.sshAddress || "127.0.0.1",
      status: mapLimaStatus(raw.status),
      region: "local",
      plan: `${raw.cpus}cpu-${Math.round(raw.memory / (1024 * 1024 * 1024))}gb`,
      createdAt: new Date().toISOString(),
      sshPort,
    };
  }

  async createInstance(opts: CreateInstanceOptions): Promise<Instance> {
    const name = opts.label ?? `hal9999-${Date.now()}`;
    const template = opts.snapshotId || this.templatePath;
    const verbose = process.env.HAL_VERBOSE === "1";
    const run = verbose
      ? (args: string[], timeout: number) => this.execInherit(args, timeout)
      : (args: string[], timeout: number) => this.execOrThrow(args, timeout);

    if (template.startsWith("clone:")) {
      // Clone-based creation: deep-copy a golden image's disk+config
      const goldenName = template.slice("clone:".length);
      await run(["clone", "--tty=false", goldenName, name], 120_000);
      await run(["start", name, "--tty=false"], 120_000);
    } else {
      // Template-based creation: full cloud-init provisioning
      // First run can take 10+ min (image download + provisioning)
      await run(
        ["start", "--name", name, template, "--tty=false"],
        600_000 // 10 min
      );
    }

    const raw = await this.getLimaInstance(name);
    if (!raw) throw new Error(`Lima instance ${name} created but not found in list`);

    return this.mapInstance(raw);
  }

  async startInstance(id: string): Promise<void> {
    await this.execOrThrow(["start", id, "--tty=false"], 120_000);
  }

  async stopInstance(id: string): Promise<void> {
    await this.execOrThrow(["stop", id, "--tty=false"], 60_000);
  }

  async destroyInstance(id: string): Promise<void> {
    // Check if instance exists before trying to destroy
    const inst = await this.getLimaInstance(id);
    if (!inst) return; // already gone — no-op

    // Stop first (ignore errors — may already be stopped)
    await this.exec(["stop", id, "--tty=false"]);
    await this.execOrThrow(["delete", "--force", id, "--tty=false"]);
  }

  async getInstance(id: string): Promise<Instance> {
    const raw = await this.getLimaInstance(id);
    if (!raw) throw new Error(`Lima instance ${id} not found`);
    return this.mapInstance(raw);
  }

  async listInstances(label?: string): Promise<Instance[]> {
    const result = await this.exec(["list", "--json"]);
    if (result.exitCode !== 0) return [];

    const instances: Instance[] = [];
    for (const line of result.stdout.trim().split("\n")) {
      if (!line) continue;
      try {
        const raw = JSON.parse(line) as LimaInstance;
        // Filter to HAL-managed instances
        if (label && !raw.name.includes(label)) continue;
        if (!label && !raw.name.startsWith("hal9999-")) continue;
        instances.push(await this.mapInstance(raw));
      } catch {
        continue;
      }
    }
    return instances;
  }

  async waitForReady(id: string, timeoutMs = 300_000): Promise<Instance> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const instance = await this.getInstance(id);
      if (instance.status === "active") {
        return instance;
      }
      if (instance.status === "error") {
        throw new Error(`Lima instance ${id} entered error state`);
      }
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`Lima ${id}: ${instance.status} (${elapsed}s elapsed)`);
      await sleep(3_000);
    }
    throw new Error(`Lima instance ${id} did not become ready within ${timeoutMs / 1000}s`);
  }

  // Snapshot support — Lima snapshots are per-instance (save/restore state)
  // We use a compound ID format: "instance:tag"

  async createSnapshot(instanceId: string, description: string): Promise<Snapshot> {
    const tag = description.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();

    // Instance must be stopped to snapshot
    await this.exec(["stop", instanceId, "--tty=false"]);
    await this.execOrThrow(["snapshot", "create", instanceId, "--tag", tag]);

    return {
      id: `${instanceId}:${tag}`,
      description,
      status: "complete",
      size: 0,
      createdAt: new Date().toISOString(),
    };
  }

  async listSnapshots(): Promise<Snapshot[]> {
    // List all HAL instances and their snapshots
    const instances = await this.listInstances();
    const snapshots: Snapshot[] = [];

    for (const inst of instances) {
      const result = await this.exec(["snapshot", "list", inst.id]);
      if (result.exitCode !== 0) continue;

      // Parse snapshot list output (format varies, try to extract tag names)
      for (const line of result.stdout.trim().split("\n")) {
        const tag = line.trim();
        if (!tag || tag.startsWith("NAME") || tag.startsWith("---")) continue;
        snapshots.push({
          id: `${inst.id}:${tag}`,
          description: tag,
          status: "complete",
          size: 0,
          createdAt: new Date().toISOString(),
        });
      }
    }

    return snapshots;
  }

  async getSnapshot(id: string): Promise<Snapshot> {
    const [instanceId, tag] = id.split(":");
    if (!instanceId || !tag) {
      throw new Error(`Invalid snapshot ID format: ${id} (expected "instance:tag")`);
    }

    return {
      id,
      description: tag,
      status: "complete",
      size: 0,
      createdAt: new Date().toISOString(),
    };
  }

  async deleteSnapshot(id: string): Promise<void> {
    const [instanceId, tag] = id.split(":");
    if (!instanceId || !tag) {
      throw new Error(`Invalid snapshot ID format: ${id} (expected "instance:tag")`);
    }
    await this.execOrThrow(["snapshot", "delete", instanceId, "--tag", tag]);
  }

  async waitForSnapshot(_id: string, _timeoutMs?: number): Promise<Snapshot> {
    // Lima snapshots are instant (local disk)
    return this.getSnapshot(_id);
  }
}

function mapLimaStatus(status: string): Instance["status"] {
  switch (status) {
    case "Running":
      return "active";
    case "Stopped":
      return "stopped";
    case "Starting":
    case "Creating":
      return "pending";
    default:
      return "error";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
