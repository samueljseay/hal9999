import { parseArgs } from "node:util";
import { createProvider } from "./providers/index.ts";
import type { DigitalOceanProvider } from "./providers/digitalocean.ts";
import { getDb } from "./db/index.ts";
import { Orchestrator } from "./orchestrator.ts";
import { tailLog } from "./logs.ts";

const HELP = `
hal9999 cli — manage VMs for agent workers

Usage:
  bun run src/cli.ts <command> [options]

Infrastructure Commands:
  create       Create a new instance from a base OS
  launch       Launch a new instance from a snapshot
  snapshot     Create a snapshot of an instance
  list         List all instances (from provider API)
  snapshots    List all snapshots
  get          Get instance details
  destroy         Destroy an instance
  delete-snapshot Delete a snapshot
  images          List available OS images (use --query to filter)
  ssh-keys        List registered SSH keys

Task Commands:
  task create  Create a task on a new VM (streams output)
  task watch   Attach to a running (or finished) task's output
  task list    List all tasks
  task get     Get task details

Pool Commands:
  pool status     Show pool stats
  pool list       List tracked VMs
  pool reconcile  Sync DB with provider state

General:
  help         Show this help

Options:
  --region <region>       Region code (default: nyc1)
  --plan <plan>           Plan/size slug (default: s-1vcpu-1gb)
  --os <id>               OS/image ID or slug (run 'images --query debian' to find)
  --snapshot <id>         Snapshot ID (for launch)
  --label <label>         Instance label
  --description <desc>    Snapshot description
  --query <text>          Filter for images (e.g. "debian", "ubuntu")
  --wait                  Wait for instance/snapshot to be ready
  --provider <name>       Provider name (default: digitalocean)
  --ssh-key <id>          SSH key ID to inject
  --repo <url>            Repository URL (for task create)
  --context <text>        Task context/instructions (for task create)
  --status <status>       Filter by status (for task list, pool list)
`.trim();

function parseCliArgs() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      region: { type: "string", default: "nyc1" },
      plan: { type: "string", default: "s-1vcpu-1gb" },
      os: { type: "string" },
      query: { type: "string" },
      snapshot: { type: "string" },
      label: { type: "string" },
      description: { type: "string" },
      wait: { type: "boolean", default: false },
      provider: { type: "string", default: "digitalocean" },
      repo: { type: "string" },
      context: { type: "string" },
      status: { type: "string" },
      "ssh-key": { type: "string" },
    },
  });

  return {
    command: positionals[0],
    subcommand: positionals[1],
    id: positionals[1], // also used as ID for single-arg commands
    ...values,
  };
}

function getOrchestrator(args: ReturnType<typeof parseCliArgs>): Orchestrator {
  const provider = createProvider(args.provider as "digitalocean");
  const db = getDb();

  const snapshotId = process.env.HAL_SNAPSHOT_ID;
  if (!snapshotId) {
    console.error("Error: HAL_SNAPSHOT_ID is required in .env");
    process.exit(1);
  }

  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!oauthToken && !apiKey) {
    console.error("Error: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is required in .env");
    process.exit(1);
  }

  return new Orchestrator(db, provider, {
    pool: {
      snapshotId,
      region: process.env.HAL_REGION ?? args.region!,
      plan: process.env.HAL_PLAN ?? args.plan!,
      maxPoolSize: parseInt(process.env.HAL_MAX_POOL_SIZE ?? "5", 10),
      sshKeyIds: process.env.HAL_SSH_KEY_ID ? [process.env.HAL_SSH_KEY_ID] : undefined,
      idleTimeoutMs: parseInt(process.env.HAL_IDLE_TIMEOUT_S ?? "0", 10) * 1000,
    },
    claudeAuth: oauthToken
      ? { type: "oauth", token: oauthToken }
      : { type: "api-key", key: apiKey! },
  });
}

async function main() {
  const args = parseCliArgs();

  if (!args.command || args.command === "help" || args.help) {
    console.log(HELP);
    return;
  }

  // --- Task commands ---
  if (args.command === "task") {
    const orch = getOrchestrator(args);

    switch (args.subcommand) {
      case "create": {
        if (!args.repo || !args.context) {
          console.error("Error: --repo <url> and --context <text> are required");
          process.exit(1);
        }
        const taskId = orch.startTask(args.repo, args.context);
        console.log(`Task ${taskId} started. Streaming output...\n`);

        const ac = new AbortController();
        process.on("SIGINT", () => {
          ac.abort();
          console.log(`\nDetached. Task is still running.`);
          console.log(`Reconnect: bun run src/cli.ts task watch ${taskId}`);
          process.exit(0);
        });

        await tailLog(taskId, () => {
          const t = orch.tasks.getTask(taskId);
          return t?.status === "completed" || t?.status === "failed";
        }, ac.signal);

        const finalTask = orch.tasks.getTask(taskId);
        console.log("\nResult:");
        console.log(JSON.stringify(finalTask, null, 2));
        break;
      }

      case "watch": {
        const watchId = args.id;
        if (!watchId) {
          console.error("Error: task ID is required. Usage: task watch <task-id>");
          process.exit(1);
        }
        const existing = orch.tasks.getTask(watchId);
        if (!existing) {
          console.error(`Task ${watchId} not found`);
          process.exit(1);
        }

        const ac = new AbortController();
        process.on("SIGINT", () => {
          ac.abort();
          console.log(`\nDetached.`);
          process.exit(0);
        });

        await tailLog(watchId, () => {
          const t = orch.tasks.getTask(watchId);
          return t?.status === "completed" || t?.status === "failed";
        }, ac.signal);

        const final = orch.tasks.getTask(watchId);
        if (final?.status === "completed" || final?.status === "failed") {
          console.log(`\nTask ${final.status} (exit ${final.exit_code ?? "?"})`);
        }
        break;
      }

      case "list": {
        const tasks = orch.tasks.listTasks(args.status as any);
        if (tasks.length === 0) {
          console.log("No tasks found.");
          return;
        }
        console.log(
          `${"ID".padEnd(38)} ${"STATUS".padEnd(12)} ${"REPO".padEnd(40)} CREATED`
        );
        for (const t of tasks) {
          const repo = t.repo_url.length > 38 ? t.repo_url.slice(-38) : t.repo_url;
          console.log(
            `${t.id.padEnd(38)} ${t.status.padEnd(12)} ${repo.padEnd(40)} ${t.created_at}`
          );
        }
        break;
      }

      case "get": {
        const taskId = args.id;
        if (!taskId) {
          console.error("Error: task ID is required. Usage: task get <task-id>");
          process.exit(1);
        }
        const task = orch.tasks.getTask(taskId);
        if (!task) {
          console.error(`Task ${taskId} not found`);
          process.exit(1);
        }
        console.log(JSON.stringify(task, null, 2));
        break;
      }

      default:
        console.error(`Unknown task command: ${args.subcommand}`);
        console.log('Available: task create, task watch, task list, task get');
        process.exit(1);
    }
    return;
  }

  // --- Pool commands ---
  if (args.command === "pool") {
    const orch = getOrchestrator(args);

    switch (args.subcommand) {
      case "status": {
        const stats = orch.pool.getPoolStats();
        console.log("Pool Status:");
        console.log(`  Provisioning: ${stats.provisioning}`);
        console.log(`  Ready:        ${stats.ready}`);
        console.log(`  Assigned:     ${stats.assigned}`);
        console.log(`  Total active: ${stats.total}`);
        break;
      }

      case "list": {
        const vms = orch.pool.listVms(args.status as any);
        if (vms.length === 0) {
          console.log("No VMs found.");
          return;
        }
        console.log(
          `${"ID".padEnd(40)} ${"STATUS".padEnd(14)} ${"IP".padEnd(16)} ${"TASK".padEnd(38)} CREATED`
        );
        for (const vm of vms) {
          console.log(
            `${vm.id.padEnd(40)} ${vm.status.padEnd(14)} ${(vm.ip ?? "-").padEnd(16)} ${(vm.task_id ?? "-").padEnd(38)} ${vm.created_at}`
          );
        }
        break;
      }

      case "reconcile": {
        await orch.recover();
        break;
      }

      default:
        console.error(`Unknown pool command: ${args.subcommand}`);
        console.log('Available: pool status, pool list, pool reconcile');
        process.exit(1);
    }
    return;
  }

  // --- Infrastructure commands (existing) ---
  const provider = createProvider(args.provider as "digitalocean");

  switch (args.command) {
    case "create": {
      if (!args.os) {
        console.error("Error: --os <id> is required. Run 'images --query debian' to find IDs.");
        process.exit(1);
      }
      const sshKeyIds = args["ssh-key"] ? [args["ssh-key"]] : (process.env.HAL_SSH_KEY_ID ? [process.env.HAL_SSH_KEY_ID] : undefined);
      // Support both numeric IDs and string slugs (e.g. "debian-12-x64")
      const osId = /^\d+$/.test(args.os) ? parseInt(args.os, 10) : args.os;
      console.log(`Creating instance (os=${args.os}, region=${args.region}, plan=${args.plan})...`);
      const instance = await provider.createInstance({
        region: args.region!,
        plan: args.plan!,
        osId,
        label: args.label ?? "hal9999",
        sshKeyIds,
      });
      console.log(`Instance created: ${instance.id}`);
      console.log(`  Status: ${instance.status}`);
      console.log(`  IP:     ${instance.ip}`);

      if (args.wait) {
        console.log("Waiting for instance to be ready...");
        const ready = await provider.waitForReady(instance.id);
        console.log(`Instance ready: ${ready.ip}`);
      }
      break;
    }

    case "launch": {
      if (!args.snapshot) {
        console.error("Error: --snapshot <id> is required for launch");
        process.exit(1);
      }
      console.log(`Launching instance from snapshot ${args.snapshot}...`);
      const instance = await provider.createInstance({
        region: args.region!,
        plan: args.plan!,
        snapshotId: args.snapshot,
        label: args.label ?? "hal9999",
      });
      console.log(`Instance created: ${instance.id}`);
      console.log(`  Status: ${instance.status}`);
      console.log(`  IP:     ${instance.ip}`);

      if (args.wait) {
        console.log("Waiting for instance to be ready...");
        const ready = await provider.waitForReady(instance.id);
        console.log(`Instance ready: ${ready.ip}`);
      }
      break;
    }

    case "snapshot": {
      if (!args.id) {
        console.error("Error: instance ID is required. Usage: snapshot <instance-id>");
        process.exit(1);
      }
      const desc = args.description ?? `hal9999-${new Date().toISOString().split("T")[0]}`;
      console.log(`Creating snapshot of ${args.id} (${desc})...`);
      const snap = await provider.createSnapshot(args.id, desc);
      console.log(`Snapshot created: ${snap.id}`);
      console.log(`  Status: ${snap.status}`);

      if (args.wait) {
        console.log("Waiting for snapshot to complete (this can take up to 30 min)...");
        const ready = await provider.waitForSnapshot(snap.id);
        console.log(`Snapshot complete: ${ready.id} (${ready.size} bytes)`);
      }
      break;
    }

    case "list": {
      const instances = await provider.listInstances(args.label);
      if (instances.length === 0) {
        console.log("No instances found.");
        return;
      }
      console.log(`${"ID".padEnd(40)} ${"LABEL".padEnd(20)} ${"STATUS".padEnd(10)} ${"IP".padEnd(16)} REGION`);
      for (const i of instances) {
        console.log(
          `${i.id.padEnd(40)} ${i.label.padEnd(20)} ${i.status.padEnd(10)} ${i.ip.padEnd(16)} ${i.region}`
        );
      }
      break;
    }

    case "snapshots": {
      const snapshots = await provider.listSnapshots();
      if (snapshots.length === 0) {
        console.log("No snapshots found.");
        return;
      }
      console.log(`${"ID".padEnd(40)} ${"DESCRIPTION".padEnd(30)} ${"STATUS".padEnd(10)} SIZE`);
      for (const s of snapshots) {
        const sizeMb = (s.size / 1_000_000).toFixed(1);
        console.log(
          `${s.id.padEnd(40)} ${s.description.padEnd(30)} ${s.status.padEnd(10)} ${sizeMb}MB`
        );
      }
      break;
    }

    case "get": {
      if (!args.id) {
        console.error("Error: instance ID is required. Usage: get <instance-id>");
        process.exit(1);
      }
      const instance = await provider.getInstance(args.id);
      console.log(JSON.stringify(instance, null, 2));
      break;
    }

    case "destroy": {
      if (!args.id) {
        console.error("Error: instance ID is required. Usage: destroy <instance-id>");
        process.exit(1);
      }
      console.log(`Destroying instance ${args.id}...`);
      await provider.destroyInstance(args.id);
      console.log("Done.");
      break;
    }

    case "stop": {
      if (!args.id) {
        console.error("Error: instance ID is required. Usage: stop <instance-id>");
        process.exit(1);
      }
      console.log(`Stopping instance ${args.id}...`);
      await provider.stopInstance(args.id);
      console.log("Done.");
      break;
    }

    case "delete-snapshot": {
      if (!args.id) {
        console.error("Error: snapshot ID is required. Usage: delete-snapshot <snapshot-id>");
        process.exit(1);
      }
      console.log(`Deleting snapshot ${args.id}...`);
      await provider.deleteSnapshot(args.id);
      console.log("Done.");
      break;
    }

    case "ssh-keys": {
      const doProvider = provider as DigitalOceanProvider;
      const keys = await doProvider.listSshKeys();
      if (keys.length === 0) {
        console.log("No SSH keys registered.");
        return;
      }
      for (const k of keys) {
        console.log(`${k.id}  ${k.name}  ${k.fingerprint}`);
      }
      break;
    }

    case "images": {
      const doProvider = provider as DigitalOceanProvider;
      const images = await doProvider.listImages(args.query);
      if (images.length === 0) {
        console.log(`No images found${args.query ? ` matching "${args.query}"` : ""}.`);
        return;
      }
      console.log(`${"ID".padEnd(12)} ${"SLUG".padEnd(24)} ${"NAME".padEnd(40)} DISTRO`);
      for (const img of images) {
        console.log(
          `${String(img.id).padEnd(12)} ${(img.slug ?? "-").padEnd(24)} ${img.name.padEnd(40)} ${img.distribution}`
        );
      }
      break;
    }

    default:
      console.error(`Unknown command: ${args.command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
