import { parseArgs } from "node:util";
import pc from "picocolors";
import type { TaskStatus } from "../db/types.ts";
import { taskManager } from "./context.ts";
import { shortId } from "./resolve.ts";
import { statusPad } from "./ui.ts";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function stripGitHub(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//, "");
}

export async function psCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      status: { type: "string", short: "s" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(`hal ps — list tasks

Usage:
  hal ps [options]

Options:
  -s, --status <status>   Filter by status: pending, assigned, running, completed, failed
  -h, --help              Show this help`);
    return;
  }

  const tasks = taskManager().listTasks(values.status as TaskStatus | undefined);
  if (tasks.length === 0) {
    console.log("No tasks found.");
    return;
  }

  console.log(pc.dim(`${"ID".padEnd(10)} ${"STATUS".padEnd(12)} ${"REPO".padEnd(36)} CREATED`));
  for (const t of tasks) {
    const repo = stripGitHub(t.repo_url);
    const display = repo.length > 34 ? repo.slice(-34) : repo;
    console.log(
      `${shortId(t.id).padEnd(10)} ${statusPad(t.status, 12)} ${display.padEnd(36)} ${relativeTime(t.created_at)}`
    );
  }
}
