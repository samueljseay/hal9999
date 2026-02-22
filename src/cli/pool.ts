import { parseArgs } from "node:util";
import pc from "picocolors";
import type { VmRow, VmStatus } from "../db/types.ts";
import { db, poolManager, taskManager, orchestrator, normalizeProvider, defaultProvider } from "./context.ts";
import { shortId } from "./resolve.ts";
import { statusPad } from "./ui.ts";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Readable VM identifier — trim common "hal9999-" prefix for Lima names */
function vmDisplayId(vm: VmRow): string {
  // Lima IDs are like "hal9999-1740000000000" — show the timestamp part
  if (vm.id.startsWith("hal9999-")) {
    return vm.id.slice(8, 18);
  }
  return shortId(vm.id);
}

export async function poolCommand(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      status: { type: "string", short: "s" },
      all: { type: "boolean", short: "a", default: false },
      provider: { type: "string", short: "p" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(`hal pool — manage the VM pool

Usage:
  hal pool                        Show pool status summary
  hal pool ls [-s <status>] [-a]  List VMs (active only by default)
  hal pool sync [-p <provider>]   Reconcile DB with provider state
  hal pool warm [-p <provider>]   Reap idle VMs, top up warm pool
  hal pool gc [-p <provider>]     Full cleanup: stale, error, orphan, idle, unknown VMs

Options:
  -s, --status <status>   Filter VMs: provisioning, ready, assigned, destroying, destroyed, error
  -a, --all               Show all VMs including destroyed (default: active only)
  -p, --provider <name>   Provider for sync/warm/gc: lima, do/digitalocean (default: lima)
  -h, --help              Show this help`);
    return;
  }

  const sub = positionals[0];

  // No subcommand or "status" → pool stats (read-only)
  if (!sub || sub === "status") {
    const stats = poolManager().getPoolStats();
    console.log("Pool Status:");
    console.log(`  Provisioning: ${pc.yellow(String(stats.provisioning))}`);
    console.log(`  Ready:        ${pc.green(String(stats.ready))}`);
    console.log(`  Assigned:     ${pc.yellow(String(stats.assigned))}`);
    console.log(`  Total active: ${String(stats.total)}`);
    if (Object.keys(stats.byProvider).length > 0) {
      console.log("  By provider:");
      for (const [name, count] of Object.entries(stats.byProvider)) {
        console.log(`    ${name}: ${count}`);
      }
    }
    return;
  }

  if (sub === "ls" || sub === "list") {
    let vms: VmRow[];
    if (values.status) {
      vms = poolManager().listVms(values.status as VmStatus);
    } else if (values.all) {
      vms = poolManager().listVms();
    } else {
      // Default: active VMs only
      vms = poolManager().listActiveVms();
    }
    if (vms.length === 0) {
      console.log(values.all ? "No VMs found." : "No active VMs. Use -a to show all.");
      return;
    }
    // Build a map of task_id → slug for display
    const taskSlugs = new Map<string, string | null>();
    for (const vm of vms) {
      if (vm.task_id && !taskSlugs.has(vm.task_id)) {
        const task = taskManager().getTask(vm.task_id);
        taskSlugs.set(vm.task_id, task?.slug ?? null);
      }
    }

    console.log(
      pc.dim(`${"VM".padEnd(12)} ${"STATUS".padEnd(14)} ${"PROVIDER".padEnd(14)} ${"IP".padEnd(16)} ${"TASK".padEnd(18)} ${"AGE".padEnd(6)} IDLE`)
    );
    for (const vm of vms) {
      const age = relativeTime(vm.created_at);
      const idle = vm.idle_since ? relativeTime(vm.idle_since) : "-";
      const taskDisplay = vm.task_id ? shortId(vm.task_id, taskSlugs.get(vm.task_id)) : "-";
      console.log(
        `${vmDisplayId(vm).padEnd(12)} ${statusPad(vm.status, 14)} ${vm.provider.padEnd(14)} ${(vm.ip ?? "-").padEnd(16)} ${taskDisplay.padEnd(18)} ${age.padEnd(6)} ${idle}`
      );
    }
    return;
  }

  if (sub === "sync" || sub === "reconcile") {
    const providerStr = values.provider ? normalizeProvider(values.provider) : defaultProvider();
    const orch = await orchestrator({ provider: providerStr });
    await orch.recover();
    return;
  }

  if (sub === "warm") {
    const providerStr = values.provider ? normalizeProvider(values.provider) : defaultProvider();
    const { buildProviderSlots } = await import("./context.ts");
    const { VMPoolManager } = await import("../pool/manager.ts");
    const slots = buildProviderSlots({ provider: providerStr });
    const pool = new VMPoolManager(db(), { slots });

    const reaped = await pool.reapIdleVms();
    if (reaped > 0) {
      console.log(`Reaped ${pc.yellow(String(reaped))} idle VM(s)`);
    } else {
      console.log("No idle VMs to reap");
    }

    pool.ensureWarm();

    const stats = pool.getPoolStats();
    console.log(`Pool: ${pc.green(String(stats.ready))} ready, ${pc.yellow(String(stats.provisioning))} provisioning, ${pc.yellow(String(stats.assigned))} assigned`);
    for (const slot of slots) {
      if (slot.minReady > 0) {
        console.log(`  ${slot.name}: minReady=${slot.minReady}, idleTimeout=${slot.idleTimeoutMs / 1000}s`);
      }
    }
    return;
  }

  if (sub === "gc") {
    const providerStr = values.provider ? normalizeProvider(values.provider) : defaultProvider();
    const { buildProviderSlots } = await import("./context.ts");
    const { VMPoolManager } = await import("../pool/manager.ts");
    const slots = buildProviderSlots({ provider: providerStr });
    const pool = new VMPoolManager(db(), { slots });

    console.log("Running full pool cleanup...\n");

    const staleProvisioning = await pool.reapStaleProvisioning();
    if (staleProvisioning > 0) console.log(`  Stale provisioning: ${pc.yellow(String(staleProvisioning))} destroyed`);

    const errorVms = await pool.reapErrorVms();
    if (errorVms > 0) console.log(`  Error VMs:          ${pc.yellow(String(errorVms))} destroyed`);

    const orphans = await pool.releaseOrphans();
    if (orphans > 0) console.log(`  Orphaned VMs:       ${pc.yellow(String(orphans))} released`);

    const idle = await pool.reapIdleVms();
    if (idle > 0) console.log(`  Idle VMs:           ${pc.yellow(String(idle))} reaped`);

    const reconciled = await pool.reconcile();
    if (reconciled.updated > 0 || reconciled.destroyed > 0) {
      console.log(`  Reconcile:          ${reconciled.updated} updated, ${reconciled.destroyed} destroyed`);
    }

    pool.ensureWarm();

    const total = staleProvisioning + errorVms + orphans + idle + reconciled.destroyed;
    if (total === 0) {
      console.log(pc.green("Pool is clean — nothing to do."));
    } else {
      console.log(`\n${pc.green(`Cleaned up ${total} VM(s).`)}`);
    }

    const stats = pool.getPoolStats();
    console.log(`\nPool: ${pc.green(String(stats.ready))} ready, ${pc.yellow(String(stats.provisioning))} provisioning, ${pc.yellow(String(stats.assigned))} assigned`);
    return;
  }

  console.error(`Unknown pool command: ${sub}`);
  console.log("Available: hal pool, hal pool ls, hal pool sync, hal pool warm, hal pool gc");
  process.exit(1);
}
