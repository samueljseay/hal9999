import { parseArgs } from "node:util";
import pc from "picocolors";
import { orchestrator, normalizeProvider, defaultProvider } from "./context.ts";
import { shortId } from "./resolve.ts";
import { tailLog } from "../logs.ts";
import { hal } from "./ui.ts";

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
      branch: { type: "string", short: "b" },
      base: { type: "string" },
      "no-pr": { type: "boolean", default: false },
      "plan-first": { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
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
  -p, --provider <name>   Provider: local (auto), lima, incus, do/digitalocean
  -b, --branch <name>     Feature branch name (default: hal/<shortId>)
  --base <branch>         PR target branch (default: repo's default branch)
  --no-pr                 Push branch but skip PR creation
  --plan-first            Two-phase execution: plan then execute
  --region <region>       Region for cloud provider (default: nyc1)
  --plan <plan>           Instance size/plan (default: s-1vcpu-1gb)
  -v, --verbose           Show detailed VM provisioning output
  -h, --help              Show this help

Examples:
  hal run owner/repo -m "fix the bug"
  hal run owner/repo -m "add tests" -a goose
  hal run owner/repo -m "fix" --branch fix/bug --base main
  hal run owner/repo -m "explore" --no-pr
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
  if (values.verbose) process.env.HAL_VERBOSE = "1";
  const providerStr = values.provider ? normalizeProvider(values.provider) : defaultProvider();

  const taskOpts = {
    branch: values.branch,
    base: values.base,
    noPr: values["no-pr"],
    planFirst: values["plan-first"],
  };

  const orch = await orchestrator({
    provider: providerStr,
    agent: values.agent,
    region: values.region,
    plan: values.plan,
  });

  const taskId = orch.startTask(repoUrl, message, taskOpts);
  const short = shortId(taskId);

  const spinner = hal(`Task ${short} provisioning...`);

  const ac = new AbortController();
  process.on("SIGINT", () => {
    spinner.stop();
    ac.abort();
    const t = orch.tasks.getTask(taskId);
    const status = t?.status ?? "unknown";

    if (status === "running") {
      console.log(pc.yellow(`\nAgent still running on VM. Output collection stopped.`));
      console.log(`Resume: hal run is needed to poll for results.`);
      console.log(`Check status: hal show ${short}`);
    } else if (status === "completed" || status === "failed") {
      console.log(`\nTask already ${status}.`);
      console.log(`Details: hal show ${short}`);
    } else {
      // pending, assigned — still setting up
      console.log(pc.yellow(`\nVM still provisioning. Agent not yet launched.`));
      console.log(`Check status: hal show ${short}`);
    }
    process.exit(0);
  });

  await tailLog(taskId, () => {
    const t = orch.tasks.getTask(taskId);
    // Stop spinner once we have any output (task is running)
    if (t?.status === "running") {
      spinner.stop(`Task ${short} started. Streaming output...\n`);
    }
    return t?.status === "completed" || t?.status === "failed";
  }, ac.signal);

  spinner.stop(); // no-op if already stopped

  const finalTask = orch.tasks.getTask(taskId);
  if (finalTask) {
    if (finalTask.status === "completed") {
      console.log(pc.green(`\nTask completed (exit ${finalTask.exit_code ?? 0})`));
    } else if (finalTask.status === "failed") {
      console.log(pc.red(`\nTask failed (exit ${finalTask.exit_code ?? "?"})`));
      if (finalTask.result) console.log(`Error: ${finalTask.result}`);
    }
    if (finalTask.pr_url) {
      console.log(pc.cyan(`PR: ${finalTask.pr_url}`));
    } else if (finalTask.branch) {
      console.log(pc.dim(`Branch: ${finalTask.branch}`));
    }
  }
}
