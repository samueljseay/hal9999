import { parseArgs } from "node:util";
import { db, taskManager } from "./context.ts";
import { resolveTaskId, shortId } from "./resolve.ts";
import { tailLog } from "../logs.ts";

export async function logsCommand(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(`hal logs — stream task output

Usage:
  hal logs <id>

Arguments:
  <id>                    Task ID or unique prefix

Options:
  -h, --help              Show this help

Streams the raw log output. For running tasks, tails live. Ctrl+C to detach.`);
    if (positionals.length === 0 && !values.help) process.exit(1);
    return;
  }

  const taskId = resolveTaskId(db(), positionals[0]!);
  const task = taskManager().getTask(taskId);
  if (!task) {
    console.error(`Task ${positionals[0]} not found`);
    process.exit(1);
  }

  const ac = new AbortController();
  process.on("SIGINT", () => {
    ac.abort();
    console.log("\nDetached.");
    process.exit(0);
  });

  await tailLog(taskId, () => {
    const t = taskManager().getTask(taskId);
    return t?.status === "completed" || t?.status === "failed";
  }, ac.signal);

  const final = taskManager().getTask(taskId);
  if (final?.status === "completed" || final?.status === "failed") {
    console.log(`\nTask ${final.status} (exit ${final.exit_code ?? "?"})`);
  }
}
