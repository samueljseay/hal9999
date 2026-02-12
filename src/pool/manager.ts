import type { Database } from "bun:sqlite";
import type { Provider } from "../providers/types.ts";
import type { PoolConfig } from "./types.ts";
import type { VmRow, VmStatus } from "../db/types.ts";

export class VMPoolManager {
  private db: Database;
  private provider: Provider;
  private config: PoolConfig;

  constructor(db: Database, provider: Provider, config: PoolConfig) {
    this.db = db;
    this.provider = provider;
    this.config = config;
  }

  async provisionVm(): Promise<VmRow> {
    const stats = this.getPoolStats();
    if (stats.total >= this.config.maxPoolSize) {
      throw new Error(
        `Pool is at max capacity (${stats.total}/${this.config.maxPoolSize})`
      );
    }

    const label = `${this.config.labelPrefix ?? "hal9999"}-${Date.now()}`;
    const instance = await this.provider.createInstance({
      region: this.config.region,
      plan: this.config.plan,
      snapshotId: this.config.snapshotId,
      label,
      sshKeyIds: this.config.sshKeyIds,
    });

    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO vms (id, label, ip, status, snapshot_id, region, plan, created_at, updated_at)
       VALUES (?, ?, ?, 'provisioning', ?, ?, ?, ?, ?)`,
      [instance.id, label, instance.ip, this.config.snapshotId, this.config.region, this.config.plan, now, now]
    );

    return this.getVm(instance.id)!;
  }

  async waitForVm(vmId: string, timeoutMs?: number): Promise<VmRow> {
    const instance = await this.provider.waitForReady(vmId, timeoutMs);
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE vms SET status = 'ready', ip = ?, updated_at = ? WHERE id = ?`,
      [instance.ip, now, vmId]
    );
    return this.getVm(vmId)!;
  }

  async acquireVm(taskId: string): Promise<VmRow> {
    // Try to find an existing ready VM
    const free = this.db
      .query<VmRow, []>(
        `SELECT * FROM vms WHERE status = 'ready' AND task_id IS NULL LIMIT 1`
      )
      .get();

    let vm: VmRow;
    if (free) {
      vm = free;
    } else {
      const provisioned = await this.provisionVm();
      try {
        vm = await this.waitForVm(provisioned.id);
      } catch (err) {
        // Clean up the failed VM so it doesn't block the pool
        console.log(`VM ${provisioned.id} failed to become ready, destroying...`);
        try {
          await this.destroyVm(provisioned.id);
        } catch {
          // Mark as error if we can't even destroy it
          this.db.run(
            `UPDATE vms SET status = 'error', error = 'failed during provisioning', updated_at = ? WHERE id = ?`,
            [new Date().toISOString(), provisioned.id]
          );
        }
        throw err;
      }
    }

    // Assign VM to task in a transaction
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE vms SET status = 'assigned', task_id = ?, updated_at = ? WHERE id = ?`,
        [taskId, now, vm.id]
      );
      this.db.run(
        `UPDATE tasks SET vm_id = ?, updated_at = ? WHERE id = ?`,
        [vm.id, now, taskId]
      );
    })();

    return this.getVm(vm.id)!;
  }

  async releaseVm(vmId: string): Promise<void> {
    const idleTimeout = this.config.idleTimeoutMs ?? 0;
    if (idleTimeout <= 0) {
      await this.destroyVm(vmId);
      return;
    }

    // Return VM to pool as ready (warm)
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE vms SET status = 'ready', task_id = NULL, updated_at = ? WHERE id = ?`,
      [now, vmId]
    );
    console.log(`VM ${vmId} returned to pool (idle timeout: ${idleTimeout / 1000}s)`);

    // Schedule destruction after idle timeout
    this.scheduleIdleReap(vmId, idleTimeout);
  }

  private scheduleIdleReap(vmId: string, delayMs: number): void {
    setTimeout(async () => {
      const vm = this.getVm(vmId);
      if (!vm || vm.status !== "ready") return; // already reassigned or destroyed
      console.log(`VM ${vmId} idle timeout reached, destroying...`);
      try {
        await this.destroyVm(vmId);
      } catch (err) {
        console.error(`Failed to reap idle VM ${vmId}:`, err);
      }
    }, delayMs);
  }

  async destroyVm(vmId: string): Promise<void> {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE vms SET status = 'destroying', task_id = NULL, updated_at = ? WHERE id = ?`,
      [now, vmId]
    );

    try {
      await this.provider.destroyInstance(vmId);
      this.db.run(
        `UPDATE vms SET status = 'destroyed', updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), vmId]
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.db.run(
        `UPDATE vms SET status = 'error', error = ?, updated_at = ? WHERE id = ?`,
        [message, new Date().toISOString(), vmId]
      );
      throw err;
    }
  }

  getPoolStats(): { provisioning: number; ready: number; assigned: number; total: number } {
    const rows = this.db
      .query<{ status: VmStatus; count: number }, []>(
        `SELECT status, COUNT(*) as count FROM vms
         WHERE status IN ('provisioning', 'ready', 'assigned')
         GROUP BY status`
      )
      .all();

    const counts = { provisioning: 0, ready: 0, assigned: 0, total: 0 };
    for (const row of rows) {
      if (row.status in counts) {
        counts[row.status as keyof typeof counts] = row.count;
      }
    }
    counts.total = counts.provisioning + counts.ready + counts.assigned;
    return counts;
  }

  getVm(vmId: string): VmRow | null {
    return this.db
      .query<VmRow, [string]>(`SELECT * FROM vms WHERE id = ?`)
      .get(vmId) ?? null;
  }

  listVms(status?: VmStatus): VmRow[] {
    if (status) {
      return this.db
        .query<VmRow, [string]>(`SELECT * FROM vms WHERE status = ? ORDER BY created_at DESC`)
        .all(status);
    }
    return this.db
      .query<VmRow, []>(`SELECT * FROM vms ORDER BY created_at DESC`)
      .all();
  }

  async reconcile(): Promise<{ updated: number; destroyed: number }> {
    const activeVms = this.db
      .query<VmRow, []>(
        `SELECT * FROM vms WHERE status IN ('provisioning', 'ready', 'assigned')`
      )
      .all();

    let updated = 0;
    let destroyed = 0;

    for (const vm of activeVms) {
      try {
        const instance = await this.provider.getInstance(vm.id);
        const now = new Date().toISOString();

        if (instance.status === "active" && vm.status === "provisioning") {
          this.db.run(
            `UPDATE vms SET status = 'ready', ip = ?, updated_at = ? WHERE id = ?`,
            [instance.ip, now, vm.id]
          );
          updated++;
        }
      } catch {
        // Instance no longer exists on provider
        const now = new Date().toISOString();
        this.db.run(
          `UPDATE vms SET status = 'destroyed', updated_at = ? WHERE id = ?`,
          [now, vm.id]
        );
        destroyed++;
      }
    }

    return { updated, destroyed };
  }
}
