import { parseArgs } from "node:util";
import { db, taskManager } from "./context.ts";
import { resolveTaskId } from "./resolve.ts";
import { readEvents, tailEvents } from "../events/index.ts";
import type { EventEnvelope } from "../events/index.ts";

function printEvent(env: EventEnvelope): void {
  const ts = env.timestamp.split("T")[1]?.replace("Z", "") ?? env.timestamp;
  const e = env.event;
  switch (e.type) {
    case "task_start":
      console.log(`[${ts}] TASK START  repo=${e.repoUrl} agent=${e.agent}`);
      break;
    case "vm_acquired":
      console.log(`[${ts}] VM ACQUIRED vm=${e.vmId} provider=${e.provider} ip=${e.ip}`);
      break;
    case "phase":
      console.log(`[${ts}] PHASE       ${e.name}`);
      break;
    case "output":
      process.stdout.write(e.text);
      break;
    case "task_end":
      console.log(`\n[${ts}] TASK END    status=${e.status} exit=${e.exitCode ?? "?"}${e.error ? ` error=${e.error}` : ""}`);
      break;
  }
}

export async function eventsCommand(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      raw: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(`hal events — structured JSONL event stream

Usage:
  hal events <id> [options]

Arguments:
  <id>                    Task ID or unique prefix

Options:
  --raw                   Output raw JSONL (one JSON object per line)
  -h, --help              Show this help

Shows typed lifecycle events (task_start, vm_acquired, phase, output, task_end).
Without --raw, events are pretty-printed. For running tasks, tails live.`);
    if (positionals.length === 0 && !values.help) process.exit(1);
    return;
  }

  const taskId = resolveTaskId(db(), positionals[0]!);
  const task = taskManager().getTask(taskId);
  if (!task) {
    console.error(`Task ${positionals[0]} not found`);
    process.exit(1);
  }

  const isDone = () => {
    const t = taskManager().getTask(taskId);
    return t?.status === "completed" || t?.status === "failed";
  };

  const isFinished = task.status === "completed" || task.status === "failed";

  if (values.raw) {
    if (isFinished) {
      for (const env of readEvents(taskId)) {
        console.log(JSON.stringify(env));
      }
    } else {
      const ac = new AbortController();
      process.on("SIGINT", () => { ac.abort(); process.exit(0); });
      for await (const env of tailEvents(taskId, isDone, ac.signal)) {
        console.log(JSON.stringify(env));
      }
    }
  } else {
    if (isFinished) {
      for (const env of readEvents(taskId)) {
        printEvent(env);
      }
    } else {
      const ac = new AbortController();
      process.on("SIGINT", () => { ac.abort(); process.exit(0); });
      for await (const env of tailEvents(taskId, isDone, ac.signal)) {
        printEvent(env);
      }
    }
  }
}
