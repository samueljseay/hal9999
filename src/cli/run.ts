import { parseArgs } from "node:util";
import { orchestrator, normalizeProvider, defaultProvider } from "./context.ts";
import { shortId } from "./resolve.ts";
import { tailLog } from "../logs.ts";

function normalizeRepo(input: string): string {
  // Already a full URL
  if (input.startsWith("http://") || input.startsWith("https://") || input.startsWith("git@")) {
    return input;
  }
  // owner/repo shorthand
  if (/^[\w.-]+\/[\w.-]+$/.test(input)) {
    return `https://github.com/${input}`;
  }
  return input;
}

export async function runCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      message: { type: "string", short: "m" },
      agent: { type: "string", short: "a", default: "claude" },
      provider: { type: "string", short: "p" },
      region: { type: "string" },
      plan: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(`hal run — run an agent on a repo

Usage:
  hal run <repo> -m "instructions" [options]

Arguments:
  <repo>                  Repository: owner/repo or full URL

Options:
  -m, --message <text>    Task instructions (required)
  -a, --agent <name>      Agent: claude, opencode, goose, or custom cmd (default: claude)
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  --region <region>       Region for cloud provider (default: nyc1)
  --plan <plan>           Instance size/plan (default: s-1vcpu-1gb)
  -h, --help              Show this help

Examples:
  hal run owner/repo -m "fix the bug"
  hal run owner/repo -m "add tests" -a goose
  hal run https://github.com/org/repo -m "refactor" -p do`);
    return;
  }

  const repo = positionals[0];
  const message = values.message;

  if (!repo || !message) {
    console.error('Usage: hal run <repo> -m "instructions"');
    console.error("  repo: owner/repo or full URL");
    console.error('  -m:   task instructions (required)');
    process.exit(1);
  }

  const repoUrl = normalizeRepo(repo);
  const providerStr = values.provider ? normalizeProvider(values.provider) : defaultProvider();

  const orch = orchestrator({
    provider: providerStr,
    agent: values.agent,
    region: values.region,
    plan: values.plan,
  });

  const taskId = orch.startTask(repoUrl, message);
  const short = shortId(taskId);
  console.log(`Task ${short} started. Streaming output...\n`);

  const ac = new AbortController();
  process.on("SIGINT", () => {
    ac.abort();
    console.log(`\nDetached. Task is still running.`);
    console.log(`Reconnect: hal logs ${short}`);
    process.exit(0);
  });

  await tailLog(taskId, () => {
    const t = orch.tasks.getTask(taskId);
    return t?.status === "completed" || t?.status === "failed";
  }, ac.signal);

  const finalTask = orch.tasks.getTask(taskId);
  if (finalTask) {
    console.log(`\nTask ${finalTask.status} (exit ${finalTask.exit_code ?? "?"})`);
  }
}
