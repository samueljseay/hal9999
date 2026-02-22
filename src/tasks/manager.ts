import type { Database } from "bun:sqlite";
import type { TaskRow, TaskStatus } from "../db/types.ts";
import type { CreateTaskOptions } from "./types.ts";

export class TaskManager {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  createTask(opts: CreateTaskOptions): TaskRow {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO tasks (id, repo_url, context, status, branch, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      [id, opts.repoUrl, opts.context, opts.branch ?? null, now, now]
    );
    return this.getTask(id)!;
  }

  setBranch(taskId: string, branch: string): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE tasks SET branch = ?, updated_at = ? WHERE id = ?`,
      [branch, now, taskId]
    );
  }

  setPrUrl(taskId: string, prUrl: string): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE tasks SET pr_url = ?, updated_at = ? WHERE id = ?`,
      [prUrl, now, taskId]
    );
  }

  assignTask(taskId: string, vmId: string): TaskRow {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE tasks SET status = 'assigned', vm_id = ?, updated_at = ? WHERE id = ?`,
      [vmId, now, taskId]
    );
    return this.getTask(taskId)!;
  }

  markRunning(taskId: string): TaskRow {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, taskId]
    );
    return this.getTask(taskId)!;
  }

  completeTask(taskId: string, result: string, exitCode: number): TaskRow {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE tasks SET status = 'completed', result = ?, exit_code = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      [result, exitCode, now, now, taskId]
    );
    return this.getTask(taskId)!;
  }

  failTask(taskId: string, error: string, exitCode?: number): TaskRow {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE tasks SET status = 'failed', result = ?, exit_code = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      [error, exitCode ?? null, now, now, taskId]
    );
    return this.getTask(taskId)!;
  }

  getTask(taskId: string): TaskRow | null {
    return this.db
      .query<TaskRow, [string]>(`SELECT * FROM tasks WHERE id = ?`)
      .get(taskId) ?? null;
  }

  listTasks(status?: TaskStatus): TaskRow[] {
    if (status) {
      return this.db
        .query<TaskRow, [string]>(`SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC`)
        .all(status);
    }
    return this.db
      .query<TaskRow, []>(`SELECT * FROM tasks ORDER BY created_at DESC`)
      .all();
  }

  nextPendingTask(): TaskRow | null {
    return this.db
      .query<TaskRow, []>(
        `SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
      )
      .get() ?? null;
  }

  getInFlightTasks(): TaskRow[] {
    return this.db
      .query<TaskRow, []>(
        `SELECT * FROM tasks WHERE status IN ('running', 'assigned') ORDER BY created_at ASC`
      )
      .all();
  }
}
