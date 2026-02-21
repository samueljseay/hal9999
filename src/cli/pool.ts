import { parseArgs } from "node:util";
import type { VmStatus } from "../db/types.ts";
import { db, poolManager, orchestrator, normalizeProvider, defaultProvider } from "./context.ts";
import { shortId } from "./resolve.ts";

export async function poolCommand(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      status: { type: "string", short: "s" },
      provider: { type: "string", short: "p" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(`hal pool — manage the VM pool

Usage:
  hal pool                        Show pool status summary
  hal pool ls [-s <status>]       List tracked VMs
  hal pool sync [-p <provider>]   Reconcile DB with provider state
  hal pool warm [-p <provider>]   Reap idle VMs, top up warm pool

Options:
  -s, --status <status>   Filter VMs: provisioning, ready, assigned, destroying, destroyed, error
  -p, --provider <name>   Provider for sync/warm: lima, do/digitalocean (default: lima)
  -h, --help              Show this help`);
    return;
  }

  const sub = positionals[0];

  // No subcommand or "status" → pool stats (read-only)
  if (!sub || sub === "status") {
    const stats = poolManager().getPoolStats();
    console.log("Pool Status:");
    console.log(`  Provisioning: ${stats.provisioning}`);
    console.log(`  Ready:        ${stats.ready}`);
    console.log(`  Assigned:     ${stats.assigned}`);
    console.log(`  Total active: ${stats.total}`);
    if (Object.keys(stats.byProvider).length > 0) {
      console.log("  By provider:");
      for (const [name, count] of Object.entries(stats.byProvider)) {
        console.log(`    ${name}: ${count}`);
      }
    }
    return;
  }

  if (sub === "ls" || sub === "list") {
    const vms = poolManager().listVms(values.status as VmStatus | undefined);
    if (vms.length === 0) {
      console.log("No VMs found.");
      return;
    }
    console.log(
      `${"ID".padEnd(10)} ${"STATUS".padEnd(14)} ${"PROVIDER".padEnd(14)} ${"IP".padEnd(16)} ${"TASK".padEnd(10)} CREATED`
    );
    for (const vm of vms) {
      console.log(
        `${shortId(vm.id).padEnd(10)} ${vm.status.padEnd(14)} ${vm.provider.padEnd(14)} ${(vm.ip ?? "-").padEnd(16)} ${(vm.task_id ? shortId(vm.task_id) : "-").padEnd(10)} ${vm.created_at}`
      );
    }
    return;
  }

  if (sub === "sync" || sub === "reconcile") {
    const providerStr = values.provider ? normalizeProvider(values.provider) : defaultProvider();
    const orch = orchestrator({ provider: providerStr });
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
      console.log(`Reaped ${reaped} idle VM(s)`);
    } else {
      console.log("No idle VMs to reap");
    }

    pool.ensureWarm();

    const stats = pool.getPoolStats();
    console.log(`Pool: ${stats.ready} ready, ${stats.provisioning} provisioning, ${stats.assigned} assigned`);
    for (const slot of slots) {
      if (slot.minReady > 0) {
        console.log(`  ${slot.name}: minReady=${slot.minReady}, idleTimeout=${slot.idleTimeoutMs / 1000}s`);
      }
    }
    return;
  }

  console.error(`Unknown pool command: ${sub}`);
  console.log("Available: hal pool, hal pool ls, hal pool sync, hal pool warm");
  process.exit(1);
}
