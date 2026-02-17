import { parseArgs } from "node:util";
import { db, taskManager } from "./context.ts";
import { resolveTaskId, shortId } from "./resolve.ts";

export async function showCommand(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(`hal show — display full task details

Usage:
  hal show <id>

Arguments:
  <id>                    Task ID or unique prefix

Options:
  -h, --help              Show this help

Displays ID, status, repo, context, VM assignment, timestamps, and result.`);
    if (positionals.length === 0 && !values.help) process.exit(1);
    return;
  }

  const taskId = resolveTaskId(db(), positionals[0]!);
  const task = taskManager().getTask(taskId);
  if (!task) {
    console.error(`Task ${positionals[0]} not found`);
    process.exit(1);
  }

  console.log(`ID:        ${task.id}`);
  console.log(`Short ID:  ${shortId(task.id)}`);
  console.log(`Status:    ${task.status}`);
  console.log(`Repo:      ${task.repo_url}`);
  console.log(`Context:   ${task.context}`);
  if (task.vm_id) console.log(`VM:        ${task.vm_id}`);
  if (task.exit_code !== null) console.log(`Exit code: ${task.exit_code}`);
  console.log(`Created:   ${task.created_at}`);
  if (task.started_at) console.log(`Started:   ${task.started_at}`);
  if (task.completed_at) console.log(`Completed: ${task.completed_at}`);
  if (task.result) {
    console.log(`\nResult:\n${task.result}`);
  }
}
