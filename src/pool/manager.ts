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

  /** Provision a VM using the best available slot */
  async provisionVm(): Promise<VmRow> {
    const slot = this.pickSlot();
    if (!slot) {
      const total = this.config.slots.reduce((n, s) => n + s.maxPoolSize, 0);
      throw new Error(`All provider slots are at capacity (total max: ${total})`);
    }
    return this.provisionVmForSlot(slot);
  }

  /** Provision a VM for a specific slot (used by ensureWarm) */
  private async provisionVmForSlot(slot: ProviderSlot): Promise<VmRow> {
    const label = `${this.config.labelPrefix ?? "hal9999"}-${Date.now()}`;

    // Insert DB row first so the VM is visible during provisioning
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO vms (id, label, provider, ip, ssh_port, status, snapshot_id, region, plan, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, 'provisioning', ?, ?, ?, ?, ?)`,
      [label, label, slot.name, slot.snapshotId, slot.region, slot.plan, now, now]
    );

    try {
      const instance = await slot.provider.createInstance({
        region: slot.region,
        plan: slot.plan,
        snapshotId: slot.snapshotId,
        label,
        sshKeyIds: slot.sshKeyIds,
      });

      // Update with real ID and IP from provider
      this.db.run(
        `UPDATE vms SET id = ?, ip = ?, ssh_port = ?, updated_at = ? WHERE id = ?`,
        [instance.id, instance.ip, instance.sshPort ?? null, new Date().toISOString(), label]
      );

      return this.getVm(instance.id)!;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.db.run(
        `UPDATE vms SET status = 'error', error = ?, updated_at = ? WHERE id = ?`,
        [message, new Date().toISOString(), label]
      );
      throw err;
    }
  }

  /** Provision a VM with one retry on failure (handles transient Lima issues) */
  private async provisionWithRetry(progress: (msg: string) => void, maxAttempts = 2): Promise<VmRow> {
    let lastErr: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        progress(`Retrying provisioning (attempt ${attempt}/${maxAttempts})...`);
      } else {
        progress("No warm VM available, provisioning new one...");
      }

      const provisioned = await this.provisionVm();
      progress(`VM ${provisioned.id.slice(0, 8)} provisioning (${provisioned.provider})...`);

      try {
        const vm = await this.waitForVm(provisioned.id);
        progress(`VM ${vm.id.slice(0, 8)} ready (ip: ${vm.ip})`);
        return vm;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        progress(`VM ${provisioned.id.slice(0, 8)} failed: ${lastErr.message}`);

        // Clean up the failed VM
        try {
          await this.destroyVm(provisioned.id);
        } catch {
          this.db.run(
            `UPDATE vms SET status = 'error', error = 'failed during provisioning', updated_at = ? WHERE id = ?`,
            [new Date().toISOString(), provisioned.id]
          );
        }
      }
    }

    throw lastErr ?? new Error("Provisioning failed after retries");
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

  async acquireVm(taskId: string, onProgress?: (message: string) => void): Promise<VmRow> {
    const progress = onProgress ?? (() => {});

    // Clean up all orphan/stale/error states before looking for a VM
    await this.releaseOrphans();
    await this.reapStaleProvisioning();
    await this.reapIdleVms();

    // Try to find an existing ready VM (any provider)
    progress("Checking warm pool for ready VM...");
    const free = this.db
      .query<VmRow, []>(
        `SELECT * FROM vms WHERE status = 'ready' AND task_id IS NULL LIMIT 1`
      )
      .get();

    let vm: VmRow;
    if (free) {
      progress(`Reusing warm VM ${free.id.slice(0, 8)} (${free.provider})`);
      vm = free;
    } else {
      vm = await this.provisionWithRetry(progress);
    }

    // Assign VM to task in a transaction (clear idle_since)
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE vms SET status = 'assigned', task_id = ?, idle_since = NULL, updated_at = ? WHERE id = ?`,
        [taskId, now, vm.id]
      );
      this.db.run(
        `UPDATE tasks SET vm_id = ?, updated_at = ? WHERE id = ?`,
        [vm.id, now, taskId]
      );
    })();

    // Top up the warm pool after consuming a VM
    this.ensureWarm();

    return this.getVm(vm.id)!;
  }

  async releaseVm(vmId: string): Promise<void> {
    const vm = this.getVm(vmId);
    if (!vm) return;

    const slot = this.slotsByName.get(vm.provider);
    const idleTimeout = slot?.idleTimeoutMs ?? 0;

    if (idleTimeout <= 0) {
      await this.destroyVm(vmId);
      return;
    }

    // Return VM to pool as ready (warm) with idle_since timestamp
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE vms SET status = 'ready', task_id = NULL, idle_since = ?, updated_at = ? WHERE id = ?`,
      [now, now, vmId]
    );
    console.log(`VM ${vmId} returned to pool (idle timeout: ${idleTimeout / 1000}s)`);

    // Belt-and-suspenders: in-process timer in case we stay alive
    this.scheduleIdleReap(vmId, idleTimeout);

    // Top up the warm pool after release
    this.ensureWarm();
  }

  private scheduleIdleReap(vmId: string, delayMs: number): void {
    setTimeout(async () => {
      const vm = this.getVm(vmId);
      if (!vm || vm.status !== "ready") return; // already reassigned or destroyed
      console.log(`VM ${vmId} idle timeout reached, destroying...`);
      try {
        await this.destroyVm(vmId);
        this.ensureWarm();
      } catch (err) {
        console.error(`Failed to reap idle VM ${vmId}:`, err);
      }
    }, delayMs).unref(); // Don't keep the process alive for idle reap
  }

  /** Reap idle VMs whose idle_since has exceeded their slot's timeout (persistent reap) */
  async reapIdleVms(): Promise<number> {
    const idleVms = this.db
      .query<VmRow, []>(
        `SELECT * FROM vms WHERE status = 'ready' AND task_id IS NULL AND idle_since IS NOT NULL`
      )
      .all();

    let reaped = 0;
    for (const vm of idleVms) {
      const slot = this.slotsByName.get(vm.provider);
      const idleTimeout = slot?.idleTimeoutMs ?? 0;
      if (idleTimeout <= 0) {
        // Slot config changed to 0 since release — destroy now
        console.log(`Reaping VM ${vm.id.slice(0, 8)} (idle timeout is 0)`);
        try {
          await this.destroyVm(vm.id);
          reaped++;
        } catch (err) {
          console.error(`Failed to reap VM ${vm.id.slice(0, 8)}:`, err);
        }
        continue;
      }

      const idleSinceMs = new Date(vm.idle_since!).getTime();
      const elapsedMs = Date.now() - idleSinceMs;
      if (elapsedMs >= idleTimeout) {
        console.log(`Reaping VM ${vm.id.slice(0, 8)} (idle ${Math.round(elapsedMs / 1000)}s, limit ${idleTimeout / 1000}s)`);
        try {
          await this.destroyVm(vm.id);
          reaped++;
        } catch (err) {
          console.error(`Failed to reap VM ${vm.id.slice(0, 8)}:`, err);
        }
      }
    }
    return reaped;
  }

  /** Clean up VMs stuck in 'provisioning' for too long (process died mid-provision) */
  async reapStaleProvisioning(maxAgeMs = 600_000): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const stale = this.db
      .query<VmRow, [string]>(
        `SELECT * FROM vms WHERE status = 'provisioning' AND created_at < ?`
      )
      .all(cutoff);

    let reaped = 0;
    for (const vm of stale) {
      console.log(`Reaping stale provisioning VM ${vm.id.slice(0, 8)} (provider: ${vm.provider})`);
      try {
        await this.destroyVm(vm.id);
        reaped++;
      } catch {
        // Provider may not know about it — just mark destroyed
        this.db.run(
          `UPDATE vms SET status = 'destroyed', updated_at = ? WHERE id = ?`,
          [new Date().toISOString(), vm.id]
        );
        reaped++;
      }
    }
    return reaped;
  }

  /** Retry destroying VMs stuck in 'error' state */
  async reapErrorVms(): Promise<number> {
    const errorVms = this.db
      .query<VmRow, []>(
        `SELECT * FROM vms WHERE status = 'error'`
      )
      .all();

    let reaped = 0;
    for (const vm of errorVms) {
      const slot = this.slotsByName.get(vm.provider);
      if (!slot) {
        // Provider no longer configured — just mark destroyed
        this.db.run(
          `UPDATE vms SET status = 'destroyed', updated_at = ? WHERE id = ?`,
          [new Date().toISOString(), vm.id]
        );
        reaped++;
        continue;
      }

      console.log(`Retrying destroy for error VM ${vm.id.slice(0, 8)} (${vm.provider})`);
      try {
        await slot.provider.destroyInstance(vm.id);
        this.db.run(
          `UPDATE vms SET status = 'destroyed', updated_at = ? WHERE id = ?`,
          [new Date().toISOString(), vm.id]
        );
        reaped++;
      } catch {
        // Still can't destroy — provider may not know about it, mark destroyed
        this.db.run(
          `UPDATE vms SET status = 'destroyed', updated_at = ? WHERE id = ?`,
          [new Date().toISOString(), vm.id]
        );
        reaped++;
      }
    }
    return reaped;
  }

  /** Top up warm pool to meet each slot's minReady target */
  ensureWarm(): void {
    for (const slot of this.config.slots) {
      if (slot.minReady <= 0) continue;

      const warmCount = this.db
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) as count FROM vms
           WHERE provider = ? AND status IN ('ready', 'provisioning') AND task_id IS NULL`
        )
        .get(slot.name)?.count ?? 0;

      const deficit = slot.minReady - warmCount;
      if (deficit <= 0) continue;

      console.log(`Pre-warm: ${slot.name} needs ${deficit} more VM(s) (have ${warmCount}, want ${slot.minReady})`);
      for (let i = 0; i < deficit; i++) {
        // Fire-and-forget provisioning
        this.provisionVmForSlot(slot).catch((err) => {
          console.error(`Pre-warm provision failed for ${slot.name}:`, err);
        });
      }
    }
  }

  /**
   * Release VMs orphaned by finished tasks (completed/failed but VM still assigned).
   * Lightweight cleanup that runs at the start of each `hal run`.
   */
  async releaseOrphans(): Promise<number> {
    const orphans = this.db
      .query<VmRow, []>(
        `SELECT v.* FROM vms v
         JOIN tasks t ON v.task_id = t.id
         WHERE v.status = 'assigned'
           AND t.status IN ('completed', 'failed')`
      )
      .all();

    // Also find assigned VMs with no matching task at all
    const noTask = this.db
      .query<VmRow, []>(
        `SELECT v.* FROM vms v
         WHERE v.status = 'assigned'
           AND v.task_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = v.task_id)`
      )
      .all();

    // Tasks stuck in running/assigned with stale updated_at (process died mid-poll)
    const staleCutoff = new Date(Date.now() - 600_000).toISOString(); // 10 min
    const staleRunning = this.db
      .query<VmRow, [string]>(
        `SELECT v.* FROM vms v
         JOIN tasks t ON v.task_id = t.id
         WHERE v.status = 'assigned'
           AND t.status IN ('running', 'assigned')
           AND t.updated_at < ?`
      )
      .all(staleCutoff);

    // Fail the stale tasks so they don't get picked up again
    for (const vm of staleRunning) {
      if (vm.task_id) {
        this.db.run(
          `UPDATE tasks SET status = 'failed', result = 'Stale task (process died)', completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('running', 'assigned')`,
          [new Date().toISOString(), new Date().toISOString(), vm.task_id]
        );
      }
    }

    const allOrphans = [...orphans, ...noTask, ...staleRunning];
    if (allOrphans.length === 0) return 0;

    let released = 0;
    for (const vm of allOrphans) {
      const slot = this.slotsByName.get(vm.provider);
      const idleTimeout = slot?.idleTimeoutMs ?? 0;

      if (idleTimeout <= 0) {
        // No warm pool for this provider — destroy immediately
        try {
          await this.destroyVm(vm.id);
        } catch (err) {
          console.error(`Failed to destroy orphan VM ${vm.id.slice(0, 8)}:`, err);
        }
      } else {
        // Return to warm pool
        const now = new Date().toISOString();
        this.db.run(
          `UPDATE vms SET status = 'ready', task_id = NULL, idle_since = ?, updated_at = ? WHERE id = ?`,
          [now, now, vm.id]
        );
        this.scheduleIdleReap(vm.id, idleTimeout);
      }
      released++;
    }

    if (released > 0) {
      console.log(`Released ${released} orphaned VM(s) back to pool`);
    }
    return released;
  }

  async destroyVm(vmId: string): Promise<void> {
    const vm = this.getVm(vmId);
    if (!vm) return;

    const now = new Date().toISOString();
    this.db.run(
      `UPDATE vms SET status = 'destroying', task_id = NULL, idle_since = NULL, updated_at = ? WHERE id = ?`,
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

  listActiveVms(): VmRow[] {
    return this.db
      .query<VmRow, []>(
        `SELECT * FROM vms WHERE status IN ('provisioning', 'ready', 'assigned') ORDER BY created_at DESC`
      )
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

    // Clean up error-state VMs
    const errorReaped = await this.reapErrorVms();
    destroyed += errorReaped;

    // Clean up stale provisioning VMs
    const staleReaped = await this.reapStaleProvisioning();
    destroyed += staleReaped;

    // Persistent reap: clean up expired idle VMs
    const reaped = await this.reapIdleVms();
    destroyed += reaped;

    // Release orphaned VMs
    const orphansReleased = await this.releaseOrphans();

    // Provider→DB scan: destroy VMs the provider knows about but DB doesn't track
    for (const slot of this.config.slots) {
      try {
        const instances = await slot.provider.listInstances();
        for (const inst of instances) {
          const dbVm = this.getVm(inst.id);
          if (!dbVm || dbVm.status === "destroyed") {
            console.log(`Unknown provider instance ${inst.id.slice(0, 12)} (${slot.name}) — destroying`);
            try {
              await slot.provider.destroyInstance(inst.id);
              destroyed++;
            } catch (err) {
              console.error(`Failed to destroy unknown instance ${inst.id.slice(0, 12)}:`, err);
            }
          }
        }
      } catch (err) {
        console.error(`Failed to list instances for ${slot.name}:`, err);
      }
    }

    // Top up warm pool
    this.ensureWarm();

    return { updated, destroyed };
  }
}
