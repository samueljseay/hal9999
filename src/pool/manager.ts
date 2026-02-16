import type { Database } from "bun:sqlite";
import type { PoolConfig, ProviderSlot } from "./types.ts";
import type { VmRow, VmStatus } from "../db/types.ts";

export class VMPoolManager {
  private db: Database;
  private config: PoolConfig;
  private slotsByName: Map<string, ProviderSlot>;

  constructor(db: Database, config: PoolConfig) {
    this.db = db;
    this.config = config;
    this.slotsByName = new Map(config.slots.map((s) => [s.name, s]));
  }

  /** Get the provider slot for a VM by looking up its provider column */
  private getSlotForVm(vm: VmRow): ProviderSlot {
    const slot = this.slotsByName.get(vm.provider);
    if (!slot) {
      throw new Error(`No provider slot found for "${vm.provider}" (VM ${vm.id})`);
    }
    return slot;
  }

  /** Pick the best slot that has capacity, ordered by priority */
  private pickSlot(): ProviderSlot | null {
    const sorted = [...this.config.slots].sort((a, b) => a.priority - b.priority);
    for (const slot of sorted) {
      const count = this.db
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) as count FROM vms
           WHERE provider = ? AND status IN ('provisioning', 'ready', 'assigned')`
        )
        .get(slot.name)?.count ?? 0;

      if (count < slot.maxPoolSize) return slot;
    }
    return null;
  }

  async provisionVm(): Promise<VmRow> {
    const slot = this.pickSlot();
    if (!slot) {
      const total = this.config.slots.reduce((n, s) => n + s.maxPoolSize, 0);
      throw new Error(`All provider slots are at capacity (total max: ${total})`);
    }

    const label = `${this.config.labelPrefix ?? "hal9999"}-${Date.now()}`;
    const instance = await slot.provider.createInstance({
      region: slot.region,
      plan: slot.plan,
      snapshotId: slot.snapshotId,
      label,
      sshKeyIds: slot.sshKeyIds,
    });

    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO vms (id, label, provider, ip, ssh_port, status, snapshot_id, region, plan, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?)`,
      [instance.id, label, slot.name, instance.ip, instance.sshPort ?? null, slot.snapshotId, slot.region, slot.plan, now, now]
    );

    return this.getVm(instance.id)!;
  }

  async waitForVm(vmId: string, timeoutMs?: number): Promise<VmRow> {
    const vm = this.getVm(vmId);
    if (!vm) throw new Error(`VM ${vmId} not found in DB`);
    const slot = this.getSlotForVm(vm);

    const instance = await slot.provider.waitForReady(vmId, timeoutMs);
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE vms SET status = 'ready', ip = ?, ssh_port = ?, updated_at = ? WHERE id = ?`,
      [instance.ip, instance.sshPort ?? null, now, vmId]
    );
    return this.getVm(vmId)!;
  }

  async acquireVm(taskId: string): Promise<VmRow> {
    // Try to find an existing ready VM (any provider)
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
    const vm = this.getVm(vmId);
    if (!vm) return;

    const now = new Date().toISOString();
    this.db.run(
      `UPDATE vms SET status = 'destroying', task_id = NULL, updated_at = ? WHERE id = ?`,
      [now, vmId]
    );

    try {
      const slot = this.getSlotForVm(vm);
      await slot.provider.destroyInstance(vmId);
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

  getPoolStats(): { provisioning: number; ready: number; assigned: number; total: number; byProvider: Record<string, number> } {
    const rows = this.db
      .query<{ status: VmStatus; provider: string; count: number }, []>(
        `SELECT status, provider, COUNT(*) as count FROM vms
         WHERE status IN ('provisioning', 'ready', 'assigned')
         GROUP BY status, provider`
      )
      .all();

    const statusCounts: Record<string, number> = { provisioning: 0, ready: 0, assigned: 0 };
    const byProvider: Record<string, number> = {};
    for (const row of rows) {
      if (row.status in statusCounts) {
        statusCounts[row.status]! += row.count;
      }
      byProvider[row.provider] = (byProvider[row.provider] ?? 0) + row.count;
    }
    const counts = {
      provisioning: statusCounts.provisioning!,
      ready: statusCounts.ready!,
      assigned: statusCounts.assigned!,
      total: statusCounts.provisioning! + statusCounts.ready! + statusCounts.assigned!,
      byProvider,
    };
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
      const slot = this.slotsByName.get(vm.provider);
      if (!slot) {
        // Provider no longer configured — mark as destroyed
        this.db.run(
          `UPDATE vms SET status = 'destroyed', updated_at = ? WHERE id = ?`,
          [new Date().toISOString(), vm.id]
        );
        destroyed++;
        continue;
      }

      try {
        const instance = await slot.provider.getInstance(vm.id);
        const now = new Date().toISOString();

        if (instance.status === "active" && vm.status === "provisioning") {
          this.db.run(
            `UPDATE vms SET status = 'ready', ip = ?, ssh_port = ?, updated_at = ? WHERE id = ?`,
            [instance.ip, instance.sshPort ?? null, now, vm.id]
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
