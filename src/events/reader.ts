import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { eventPath } from "./writer.ts";
import type { EventEnvelope } from "./types.ts";

function parseLine(line: string): EventEnvelope | null {
  try {
    return JSON.parse(line) as EventEnvelope;
  } catch {
    return null;
  }
}

/**
 * Read all events from a completed task's JSONL file.
 */
export function readEvents(taskId: string): EventEnvelope[] {
  const path = eventPath(taskId);
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8");
  const events: EventEnvelope[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const envelope = parseLine(line);
    if (envelope) events.push(envelope);
  }
  return events;
}

/**
 * Tail events from a task's JSONL file as an async generator.
 * Yields EventEnvelope objects as they appear. Stops when a task_end event
 * is seen or the task is marked done in the DB.
 */
export async function* tailEvents(
  taskId: string,
  isTaskDone: () => boolean,
  signal?: AbortSignal,
): AsyncGenerator<EventEnvelope> {
  const path = eventPath(taskId);

  // Wait for file to exist
  let waited = 0;
  while (!existsSync(path) && waited < 60_000) {
    if (signal?.aborted) return;
    if (isTaskDone()) return;
    await new Promise((r) => setTimeout(r, 500));
    waited += 500;
  }
  if (!existsSync(path)) return;

  let offset = 0;
  let partial = "";

  while (true) {
    if (signal?.aborted) break;

    const stat = statSync(path);
    if (stat.size > offset) {
      const readSize = stat.size - offset;
      const buf = Buffer.alloc(readSize);
      const fd = openSync(path, "r");
      readSync(fd, buf, 0, readSize, offset);
      closeSync(fd);
      offset = stat.size;

      const text = partial + buf.toString("utf-8");
      const lines = text.split("\n");
      // Last element might be incomplete — save it
      partial = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const envelope = parseLine(line);
        if (!envelope) continue;
        yield envelope;

        if (envelope.event.type === "task_end") return;
      }
    }

    if (isTaskDone()) {
      // Drain remaining partial
      if (partial.trim()) {
        const envelope = parseLine(partial);
        if (envelope) yield envelope;
      }
      break;
    }

    await new Promise((r) => setTimeout(r, 250));
  }
}
