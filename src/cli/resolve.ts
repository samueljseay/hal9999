import type { Database } from "bun:sqlite";
import type { TaskRow } from "../db/types.ts";

/**
 * Resolve a short ID prefix to a full UUID from the given table.
 * - Full UUIDs pass through with an exact match.
 * - Short prefixes use LIKE matching.
 * - 0 matches → error. 2+ matches → error listing ambiguous IDs.
 */
function resolveId(db: Database, table: "tasks" | "vms", short: string): string {
  // Full UUID — exact match
  if (short.length === 36 && short.includes("-")) {
    const row = db.query<{ id: string }, [string]>(`SELECT id FROM ${table} WHERE id = ?`).get(short);
    if (!row) {
      throw new Error(`${table === "tasks" ? "Task" : "VM"} ${short} not found`);
    }
    return row.id;
  }

  // Prefix match
  const rows = db
    .query<{ id: string }, [string]>(`SELECT id FROM ${table} WHERE id LIKE ?`)
    .all(`${short}%`);

  if (rows.length === 0) {
    throw new Error(`${table === "tasks" ? "Task" : "VM"} not found: ${short}`);
  }
  if (rows.length > 1) {
    const ids = rows.map((r) => r.id.slice(0, 12)).join(", ");
    throw new Error(`Ambiguous ID "${short}" — matches: ${ids}`);
  }
  return rows[0]!.id;
}

/**
 * Resolve a task by slug or UUID prefix.
 * Tries slug first (exact match), then falls back to UUID prefix matching.
 */
export function resolveTaskId(db: Database, input: string): string {
  // Try slug first (exact match)
  const bySlug = db
    .query<{ id: string }, [string]>(`SELECT id FROM tasks WHERE slug = ?`)
    .get(input);
  if (bySlug) return bySlug.id;

  // Fall back to UUID resolution
  return resolveId(db, "tasks", input);
}

export function resolveVmId(db: Database, short: string): string {
  return resolveId(db, "vms", short);
}

/** Return the task's slug for display, falling back to first 8 chars of UUID */
export function shortId(id: string, slug?: string | null): string {
  return slug || id.slice(0, 8);
}
