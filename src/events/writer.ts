import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskEvent, EventEnvelope } from "./types.ts";

const EVENTS_DIR = join(import.meta.dir, "..", "..", "data", "events");

export function ensureEventsDir(): void {
  mkdirSync(EVENTS_DIR, { recursive: true });
}

export function eventPath(taskId: string): string {
  return join(EVENTS_DIR, `${taskId}.jsonl`);
}

export function createEventWriter(taskId: string) {
  ensureEventsDir();
  const path = eventPath(taskId);
  let seq = 0;

  function emit(event: TaskEvent): void {
    const envelope: EventEnvelope = {
      taskId,
      timestamp: new Date().toISOString(),
      seq: seq++,
      event,
    };
    appendFileSync(path, JSON.stringify(envelope) + "\n");
  }

  return { emit, path };
}
