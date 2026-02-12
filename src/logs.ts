import { mkdirSync, existsSync, statSync, appendFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(import.meta.dir, "..", "data", "logs");
const SENTINEL_PREFIX = "---HAL9999-DONE exit=";

export function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true });
}

export function logPath(taskId: string): string {
  return join(LOG_DIR, `${taskId}.log`);
}

export function createLogWriter(taskId: string) {
  ensureLogDir();
  const path = logPath(taskId);

  function append(text: string): void {
    appendFileSync(path, text);
  }

  function writeHeader(label: string): void {
    append(`\n--- ${label} ---\n`);
  }

  function finalize(exitCode: number): void {
    append(`\n${SENTINEL_PREFIX}${exitCode}---\n`);
  }

  return { append, writeHeader, finalize, path };
}

export async function tailLog(
  taskId: string,
  isTaskDone: () => boolean,
  signal?: AbortSignal
): Promise<void> {
  const path = logPath(taskId);

  // Wait for file to exist (task may still be starting)
  let waited = 0;
  while (!existsSync(path) && waited < 60_000) {
    if (signal?.aborted) return;
    if (isTaskDone()) {
      console.log("Task completed but no log file found.");
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
    waited += 500;
  }
  if (!existsSync(path)) {
    console.log("Log file not found after 60s.");
    return;
  }

  let offset = 0;

  while (true) {
    if (signal?.aborted) break;

    const stat = statSync(path);
    if (stat.size > offset) {
      const readSize = stat.size - offset;
      const buf = Buffer.alloc(readSize);
      const fd = openSync(path, "r");
      readSync(fd, buf, 0, readSize, offset);
      closeSync(fd);
      const text = buf.toString("utf-8");
      process.stdout.write(text);
      offset = stat.size;

      if (text.includes(SENTINEL_PREFIX)) {
        break;
      }
    }

    if (isTaskDone()) {
      // Drain any remaining bytes
      const finalStat = statSync(path);
      if (finalStat.size > offset) {
        const remaining = Buffer.alloc(finalStat.size - offset);
        const fd = openSync(path, "r");
        readSync(fd, remaining, 0, finalStat.size - offset, offset);
        closeSync(fd);
        process.stdout.write(remaining.toString("utf-8"));
      }
      break;
    }

    await new Promise((r) => setTimeout(r, 250));
  }
}
