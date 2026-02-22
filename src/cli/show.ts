import { parseArgs } from "node:util";
import pc from "picocolors";
import { db, taskManager } from "./context.ts";
import { resolveTaskId, shortId } from "./resolve.ts";
import { statusColor } from "./ui.ts";

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

  console.log(`${pc.dim("ID:")}        ${task.id}`);
  console.log(`${pc.dim("Short ID:")}  ${shortId(task.id)}`);
  console.log(`${pc.dim("Status:")}    ${statusColor(task.status)}`);
  console.log(`${pc.dim("Repo:")}      ${task.repo_url}`);
  console.log(`${pc.dim("Context:")}   ${task.context}`);
  if (task.branch) console.log(`${pc.dim("Branch:")}    ${task.branch}`);
  if (task.pr_url) console.log(`${pc.dim("PR:")}        ${pc.cyan(task.pr_url)}`);
  if (task.vm_id) console.log(`${pc.dim("VM:")}        ${task.vm_id}`);
  if (task.exit_code !== null) {
    const code = task.exit_code === 0 ? pc.green(String(task.exit_code)) : pc.red(String(task.exit_code));
    console.log(`${pc.dim("Exit code:")} ${code}`);
  }
  console.log(`${pc.dim("Created:")}   ${task.created_at}`);
  if (task.started_at) console.log(`${pc.dim("Started:")}   ${task.started_at}`);
  if (task.completed_at) console.log(`${pc.dim("Completed:")} ${task.completed_at}`);
  if (task.result) {
    console.log(`\n${pc.dim("Result:")}\n${task.result}`);
  }
}
