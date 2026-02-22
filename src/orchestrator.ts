import type { Database } from "bun:sqlite";
import type { PoolConfig } from "./pool/types.ts";
import type { TaskRow, VmRow } from "./db/types.ts";
import type { AgentConfig } from "./agents/types.ts";
import { VMPoolManager } from "./pool/manager.ts";
import { TaskManager } from "./tasks/manager.ts";
import { sshExec, sshExecStreaming, waitForSsh, buildSshArgs } from "./ssh.ts";
import { createLogWriter } from "./logs.ts";
import { createEventWriter } from "./events/index.ts";

export interface OrchestratorConfig {
  pool: PoolConfig;
  agent: AgentConfig;
}

export interface TaskOpts {
  branch?: string;
  base?: string;
  noPr?: boolean;
  planFirst?: boolean;
}

const HAL_DIR = "/workspace/.hal";
const OUTPUT_LOG = `${HAL_DIR}/output.log`;
const DONE_SENTINEL = `${HAL_DIR}/done`;
const RUN_SCRIPT = `${HAL_DIR}/run.sh`;
const RESULT_DIR = `${HAL_DIR}/result`;

const POLL_INTERVAL_MS = 5_000;

export class Orchestrator {
  readonly pool: VMPoolManager;
  readonly tasks: TaskManager;
  private config: OrchestratorConfig;

  constructor(db: Database, config: OrchestratorConfig) {
    this.pool = new VMPoolManager(db, config.pool);
    this.tasks = new TaskManager(db);
    this.config = config;
  }

  /**
   * Start a task in the background. Returns the task ID immediately.
   * The task runs asynchronously — use `tailLog` to watch output.
   */
  startTask(repoUrl: string, context: string, opts: TaskOpts = {}): string {
    const task = this.tasks.createTask({ repoUrl, context });
    // Fire and forget — errors are captured in the DB
    this.executeTask(task.id, repoUrl, context, opts);
    return task.id;
  }

  /**
   * Run a task and wait for it to complete. Returns the final TaskRow.
   */
  async runTask(repoUrl: string, context: string, opts: TaskOpts = {}): Promise<TaskRow> {
    const task = this.tasks.createTask({ repoUrl, context });
    await this.executeTask(task.id, repoUrl, context, opts);
    return this.tasks.getTask(task.id)!;
  }

  private async executeTask(taskId: string, repoUrl: string, context: string, opts: TaskOpts = {}): Promise<void> {
    const log = createLogWriter(taskId);
    const events = createEventWriter(taskId);
    const agent = this.config.agent;

    log.writeHeader(`task ${taskId}`);
    log.append(`Repo: ${repoUrl}\nContext: ${context}\nAgent: ${agent.name}\n`);
    events.emit({ type: "task_start", repoUrl, context, agent: agent.name });

    let vm: VmRow | undefined;
    try {
      vm = await this.setupTask(taskId, repoUrl, context, log, events, opts);
      await this.pollForCompletion(taskId, vm, log, events);
      await this.collectResults(taskId, vm, log, events);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.tasks.failTask(taskId, message);
      log.append(`\nTask failed: ${message}\n`);
      events.emit({ type: "task_end", status: "failed", exitCode: null, error: message });
    } finally {
      if (vm) {
        log.append(`Releasing VM ${vm.id}...\n`);
        try {
          await this.pool.releaseVm(vm.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.append(`Failed to release VM ${vm.id}: ${msg}\n`);
        }
      }
      const finalTask = this.tasks.getTask(taskId);
      log.finalize(finalTask?.exit_code ?? 1);
    }
  }

  /**
   * Setup phase: acquire VM, wait for SSH, clean workspace, clone repo,
   * install agent, upload wrapper script, and launch with nohup.
   */
  private async setupTask(
    taskId: string,
    repoUrl: string,
    context: string,
    log: ReturnType<typeof createLogWriter>,
    events: ReturnType<typeof createEventWriter>,
    opts: TaskOpts = {},
  ): Promise<VmRow> {
    const agent = this.config.agent;
    const githubToken = agent.env?.GITHUB_TOKEN;

    // Acquire a VM
    log.writeHeader("acquiring VM");
    events.emit({ type: "phase", name: "vm_acquire" });
    const vm = await this.pool.acquireVm(taskId, (msg) => log.append(`${msg}\n`));
    this.tasks.assignTask(taskId, vm.id);
    log.append(`VM ${vm.id} assigned (${vm.ip})\n`);
    events.emit({ type: "vm_acquired", vmId: vm.id, provider: vm.provider, ip: vm.ip ?? "" });

    const sshPort = vm.ssh_port ?? undefined;

    // Wait for SSH
    log.writeHeader("waiting for SSH");
    events.emit({ type: "phase", name: "ssh_wait" });
    await waitForSsh(vm.ip!, "agent", 180_000, sshPort, (msg) => log.append(`${msg}\n`));
    log.append(`SSH ready\n`);

    // Clean workspace (VM may be reused from warm pool)
    await sshExec({
      host: vm.ip!,
      port: sshPort,
      command: "rm -rf /workspace/*",
      timeoutMs: 30_000,
    });

    // Clone the repo — rewrite URL if GITHUB_TOKEN is available
    const repoName = extractRepoName(repoUrl);
    const workdir = `/workspace/${repoName}`;
    const cloneUrl = githubToken ? embedTokenInUrl(repoUrl, githubToken) : repoUrl;
    log.writeHeader("cloning repo");
    events.emit({ type: "phase", name: "clone" });
    const cloneResult = await sshExecStreaming({
      host: vm.ip!,
      port: sshPort,
      command: `git clone ${cloneUrl} ${workdir}`,
      timeoutMs: 120_000,
      onChunk: (text) => {
        log.append(text);
        events.emit({ type: "output", stream: "stdout", text });
      },
    });
    if (cloneResult.exitCode !== 0) {
      throw new Error(`git clone failed: ${cloneResult.stderr}`);
    }

    // Install agent (if install script provided)
    if (agent.install) {
      log.writeHeader(`installing ${agent.name} agent`);
      events.emit({ type: "phase", name: "agent_install" });
      const installEnv = {
        PATH: "/home/agent/.local/bin:/home/agent/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      };
      const installResult = await sshExecStreaming({
        host: vm.ip!,
        port: sshPort,
        command: agent.install,
        env: installEnv,
        timeoutMs: 300_000, // 5 minutes
        onChunk: (text) => {
          log.append(text);
          events.emit({ type: "output", stream: "stdout", text });
        },
      });
      if (installResult.exitCode !== 0) {
        throw new Error(`Agent install failed (exit ${installResult.exitCode}): ${installResult.stderr || installResult.stdout}`);
      }
    }

    // Set up feature branch and git identity
    const shortTaskId = taskId.slice(0, 8);
    const branch = opts.branch ?? `hal/${shortTaskId}`;
    log.writeHeader("setting up branch");
    events.emit({ type: "phase", name: "branch_setup" });

    // Detect default branch for PR base
    const defaultBranchResult = await sshExec({
      host: vm.ip!,
      port: sshPort,
      command: `cd ${workdir} && git rev-parse --abbrev-ref HEAD`,
      timeoutMs: 10_000,
    });
    const base = opts.base ?? (defaultBranchResult.stdout.trim() || "main");

    // Create feature branch and configure git identity
    const branchSetup = await sshExec({
      host: vm.ip!,
      port: sshPort,
      command: [
        `cd ${workdir}`,
        `git checkout -b ${branch}`,
        `git config user.name "hal9999"`,
        `git config user.email "hal9999@noreply"`,
      ].join(" && "),
      timeoutMs: 10_000,
    });
    if (branchSetup.exitCode !== 0) {
      throw new Error(`Branch setup failed: ${branchSetup.stderr}`);
    }
    this.tasks.setBranch(taskId, branch);
    log.append(`Branch: ${branch} (base: ${base})\n`);

    // Wrap user context with branch/push/PR instructions
    const prInstruction = opts.noPr
      ? ""
      : `3. Create a PR to ${base}: gh pr create --base ${base} --fill\n`;
    const wrappedContext = `You are working on branch "${branch}". When done:\n1. Commit your changes with a clear message\n2. Push the branch: git push origin ${branch}\n${prInstruction}\nTask:\n${context}`;

    // Generate and upload wrapper script, then launch with nohup
    const wrapperScript = generateWrapperScript(agent, wrappedContext, workdir, githubToken, branch, opts.noPr, opts.planFirst);
    const scriptBase64 = Buffer.from(wrapperScript).toString("base64");

    log.writeHeader(`launching ${agent.name} agent`);
    events.emit({ type: "phase", name: "agent_launch" });

    // Step 1: Upload script via stdin pipe (base64 needs exclusive stdin access)
    const uploadArgs = buildSshArgs(
      "agent", vm.ip!, sshPort,
      `mkdir -p ${HAL_DIR} ${RESULT_DIR} && base64 -d > ${RUN_SCRIPT} && chmod +x ${RUN_SCRIPT}`
    );
    const uploadProc = Bun.spawn(uploadArgs, {
      stdin: Buffer.from(scriptBase64),
      stdout: "pipe",
      stderr: "pipe",
    });

    let uploadTimedOut = false;
    const uploadTimer = setTimeout(() => {
      uploadTimedOut = true;
      uploadProc.kill();
    }, 30_000);

    const uploadStderr = await new Response(uploadProc.stderr).text();
    const uploadExit = await uploadProc.exited;
    clearTimeout(uploadTimer);

    if (uploadTimedOut) {
      throw new Error("Script upload timed out after 30s");
    }
    if (uploadExit !== 0) {
      throw new Error(`Failed to upload wrapper script: ${uploadStderr}`);
    }

    // Step 2: Launch with nohup (no stdin needed — use 'ignore' to prevent SSH hang)
    const launchArgs = buildSshArgs(
      "agent", vm.ip!, sshPort,
      `nohup ${RUN_SCRIPT} </dev/null >/dev/null 2>&1 & exit 0`
    );
    const launchProc = Bun.spawn(launchArgs, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    let launchTimedOut = false;
    const launchTimer = setTimeout(() => {
      launchTimedOut = true;
      launchProc.kill();
    }, 15_000);

    const launchStderr = await new Response(launchProc.stderr).text();
    const launchExit = await launchProc.exited;
    clearTimeout(launchTimer);

    if (launchTimedOut) {
      throw new Error("Script launch timed out after 15s");
    }
    if (launchExit !== 0) {
      throw new Error(`Failed to launch wrapper script: ${launchStderr}`);
    }

    // Agent is now running independently on the VM
    this.tasks.markRunning(taskId);
    log.append(`Agent launched independently on VM\n`);

    return vm;
  }

  /**
   * Poll the VM for task completion by checking the sentinel file
   * and pulling incremental output.
   */
  private async pollForCompletion(
    taskId: string,
    vm: VmRow,
    log: ReturnType<typeof createLogWriter>,
    events: ReturnType<typeof createEventWriter>,
  ): Promise<void> {
    const agent = this.config.agent;
    const timeoutMs = agent.timeoutMs ?? 600_000;
    const sshPort = vm.ssh_port ?? undefined;
    const startTime = Date.now();
    let remoteOffset = 0;

    log.writeHeader(`polling for completion`);
    events.emit({ type: "phase", name: "agent_run" });

    while (true) {
      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        // Kill the agent on the VM
        try {
          await sshExec({
            host: vm.ip!,
            port: sshPort,
            command: `pkill -f run.sh; echo timeout > ${DONE_SENTINEL}`,
            timeoutMs: 10_000,
          });
        } catch { /* best effort */ }
        throw new Error(`Agent timed out after ${timeoutMs / 1000}s`);
      }

      // Combined probe: check sentinel + get remote log size
      const probeResult = await sshExec({
        host: vm.ip!,
        port: sshPort,
        command: `test -f ${DONE_SENTINEL} && echo "HAL:DONE" || echo "HAL:WAITING"; stat -c%s ${OUTPUT_LOG} 2>/dev/null || echo 0`,
        timeoutMs: 15_000,
      });

      const lines = probeResult.stdout.trim().split("\n");
      const isDone = lines[0] === "HAL:DONE";
      const remoteSize = parseInt(lines[1] ?? "0", 10) || 0;

      // Pull incremental output if new bytes exist
      if (remoteSize > remoteOffset) {
        const deltaResult = await sshExec({
          host: vm.ip!,
          port: sshPort,
          command: `tail -c +${remoteOffset + 1} ${OUTPUT_LOG} | head -c ${remoteSize - remoteOffset}`,
          timeoutMs: 30_000,
        });
        if (deltaResult.stdout.length > 0) {
          log.append(deltaResult.stdout);
          events.emit({ type: "output", stream: "stdout", text: deltaResult.stdout });
        }
        remoteOffset = remoteSize;
      }

      // Heartbeat: bump updated_at so stale-task detection knows we're alive
      this.tasks.touchTask(taskId);

      if (isDone) break;

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  /**
   * Collect final results: exit code, remaining output, diff-stat.
   * Update task status in DB.
   */
  private async collectResults(
    taskId: string,
    vm: VmRow,
    log: ReturnType<typeof createLogWriter>,
    events: ReturnType<typeof createEventWriter>,
  ): Promise<void> {
    const sshPort = vm.ssh_port ?? undefined;

    // Read exit code from sentinel
    const exitCodeResult = await sshExec({
      host: vm.ip!,
      port: sshPort,
      command: `cat ${DONE_SENTINEL}`,
      timeoutMs: 10_000,
    });
    const exitCode = parseInt(exitCodeResult.stdout.trim(), 10);
    const exitCodeValid = !isNaN(exitCode) ? exitCode : 1;

    // Fetch plan.md if it exists (plan-first mode artifact)
    const planResult = await sshExec({
      host: vm.ip!,
      port: sshPort,
      command: `cat ${HAL_DIR}/plan.md 2>/dev/null || true`,
      timeoutMs: 10_000,
    });
    const plan = planResult.stdout.trim();
    if (plan) {
      // Save plan locally as an artifact
      const planPath = `data/plans/${taskId}.md`;
      await Bun.write(planPath, plan);
      log.append(`\nPlan saved to ${planPath}\n`);
    }

    // Fetch diff-stat if it exists
    let diffStat = "";
    const diffResult = await sshExec({
      host: vm.ip!,
      port: sshPort,
      command: `cat ${RESULT_DIR}/diff-stat.txt 2>/dev/null || true`,
      timeoutMs: 10_000,
    });
    diffStat = diffResult.stdout.trim();

    // Fetch PR URL if captured
    const prUrlResult = await sshExec({
      host: vm.ip!,
      port: sshPort,
      command: `cat ${RESULT_DIR}/pr-url.txt 2>/dev/null || true`,
      timeoutMs: 10_000,
    });
    const prUrl = prUrlResult.stdout.trim() || null;
    if (prUrl) {
      this.tasks.setPrUrl(taskId, prUrl);
    }

    const result = diffStat || `exit code ${exitCodeValid}`;

    if (exitCodeValid === 0) {
      this.tasks.completeTask(taskId, result, 0);
      log.append(`\nTask completed successfully\n`);
      if (diffStat) log.append(`\nDiff stat:\n${diffStat}\n`);
      if (prUrl) log.append(`PR: ${prUrl}\n`);
      events.emit({ type: "task_end", status: "completed", exitCode: 0, prUrl: prUrl ?? undefined });
    } else {
      this.tasks.failTask(taskId, result, exitCodeValid);
      log.append(`\nTask failed (exit ${exitCodeValid})\n`);
      if (prUrl) log.append(`PR: ${prUrl}\n`);
      events.emit({ type: "task_end", status: "failed", exitCode: exitCodeValid, error: result, prUrl: prUrl ?? undefined });
    }
  }

  /**
   * Recover in-flight tasks after a process restart.
   * - Reconcile pool state with providers
   * - Resume polling for 'running' tasks with live VMs
   * - Fail 'assigned' tasks (setup didn't complete)
   * - Fail 'running' tasks with dead VMs
   */
  async recover(): Promise<void> {
    console.log("Running pool reconciliation...");
    const result = await this.pool.reconcile();
    if (result.updated || result.destroyed) {
      console.log(`Reconciled: ${result.updated} updated, ${result.destroyed} destroyed`);
    } else {
      console.log("Pool is in sync");
    }

    const inFlight = this.tasks.getInFlightTasks();
    if (inFlight.length === 0) {
      console.log("No in-flight tasks to recover");
      return;
    }

    console.log(`Found ${inFlight.length} in-flight task(s)`);

    for (const task of inFlight) {
      if (task.status === "assigned") {
        // Setup didn't complete — fail the task
        console.log(`Task ${task.id.slice(0, 8)}: assigned (setup incomplete) — failing`);
        this.tasks.failTask(task.id, "Process restarted during setup");
        if (task.vm_id) {
          try {
            await this.pool.releaseVm(task.vm_id);
          } catch { /* best effort */ }
        }
        continue;
      }

      // status === 'running' — check if VM is still alive
      if (!task.vm_id) {
        console.log(`Task ${task.id.slice(0, 8)}: running but no VM — failing`);
        this.tasks.failTask(task.id, "No VM associated with running task");
        continue;
      }

      const vm = this.pool.getVm(task.vm_id);
      if (!vm || vm.status === "destroyed" || vm.status === "error") {
        console.log(`Task ${task.id.slice(0, 8)}: running but VM is dead — failing`);
        this.tasks.failTask(task.id, "VM no longer available after restart");
        continue;
      }

      // VM is alive — resume poll+collect in the background
      console.log(`Task ${task.id.slice(0, 8)}: running on VM ${vm.id.slice(0, 8)} — resuming poll`);
      this.resumeTask(task.id, vm);
    }
  }

  /**
   * Resume polling and collection for a running task after process restart.
   * Runs in the background (fire-and-forget).
   */
  private resumeTask(taskId: string, vm: VmRow): void {
    const log = createLogWriter(taskId);
    const events = createEventWriter(taskId);

    log.writeHeader("resuming after restart");

    const run = async () => {
      try {
        await this.pollForCompletion(taskId, vm, log, events);
        await this.collectResults(taskId, vm, log, events);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.tasks.failTask(taskId, message);
        log.append(`\nTask failed during recovery: ${message}\n`);
        events.emit({ type: "task_end", status: "failed", exitCode: null, error: message });
      } finally {
        log.append(`Releasing VM ${vm.id}...\n`);
        try {
          await this.pool.releaseVm(vm.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.append(`Failed to release VM ${vm.id}: ${msg}\n`);
        }
        const finalTask = this.tasks.getTask(taskId);
        log.finalize(finalTask?.exit_code ?? 1);
      }
    };

    // Fire and forget
    run();
  }
}

function extractRepoName(repoUrl: string): string {
  const parts = repoUrl.replace(/\.git$/, "").split("/");
  return parts[parts.length - 1] ?? "repo";
}

function shellEscapeArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Expand {{context}} and {{workdir}} in an agent command template */
function expandAgentCommand(
  template: string,
  vars: { context: string; workdir: string }
): string {
  return template
    .replace(/\{\{context\}\}/g, shellEscapeArg(vars.context))
    .replace(/\{\{workdir\}\}/g, vars.workdir);
}

/**
 * Rewrite a GitHub HTTPS URL to embed an access token for authenticated cloning.
 * https://github.com/owner/repo → https://x-access-token:TOKEN@github.com/owner/repo
 */
function embedTokenInUrl(repoUrl: string, token: string): string {
  return repoUrl.replace(
    /^https:\/\/github\.com\//,
    `https://x-access-token:${token}@github.com/`
  );
}

/**
 * Generate a bash wrapper script that runs the agent independently on the VM.
 * Handles: env exports, agent execution, output capture, git diff, and sentinel file.
 */
function generateWrapperScript(
  agent: AgentConfig,
  context: string,
  workdir: string,
  githubToken?: string,
  branch?: string,
  noPr?: boolean,
  planFirst?: boolean,
): string {
  const agentCommand = expandAgentCommand(agent.command, { context, workdir });

  // Separate credential env vars from non-sensitive ones
  const allEnvVars: Record<string, string> = {
    PATH: "/home/agent/.local/bin:/home/agent/.bun/bin:/usr/local/bin:/usr/bin:/bin",
    ...agent.env,
  };

  const sensitiveKeys = new Set([
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
    "GITHUB_TOKEN", "DO_API_TOKEN",
  ]);

  const safeExports: string[] = [];
  const credExports: string[] = [];

  for (const [k, v] of Object.entries(allEnvVars)) {
    const line = `export ${k}=${shellEscapeArg(v)}`;
    if (sensitiveKeys.has(k)) {
      credExports.push(line);
    } else {
      safeExports.push(line);
    }
  }

  // Git credential lines (also sensitive)
  const gitCredentialLines = githubToken
    ? [
        `git config --global credential.helper store`,
        `echo 'https://x-access-token:${githubToken}@github.com' > ~/.git-credentials`,
        `chmod 600 ~/.git-credentials`,
      ]
    : [];

  // All sensitive lines go into a temp file that's sourced then deleted
  const allSensitiveLines = [...credExports, ...gitCredentialLines];

  const credentialBlock = allSensitiveLines.length > 0
    ? `# Load credentials from temp file, then scrub
_HAL_CREDS=$(mktemp)
cat > "$_HAL_CREDS" <<'__HAL_CREDS_EOF__'
${allSensitiveLines.join("\n")}
__HAL_CREDS_EOF__
source "$_HAL_CREDS"
rm -f "$_HAL_CREDS"
# Scrub credential block from this script on disk
sed -i '/^cat > "\\$_HAL_CREDS"/,/^__HAL_CREDS_EOF__$/c\\# [credentials scrubbed]' "$0" 2>/dev/null || true`
    : "";

  // Two-phase plan-first execution
  const planContext = `You are an autonomous coding agent. Your ONLY job right now is to explore this repository and write an execution plan. Write the plan to ${HAL_DIR}/plan.md — that is your sole deliverable.

Explore the repository at ${workdir}. Read source files, understand the architecture and conventions, then write a detailed plan.

Task to plan for:
${context}

Write your plan to ${HAL_DIR}/plan.md with this structure:

# Execution Plan

## Analysis
What you found in the codebase — key files, patterns, conventions to follow.

## Steps
1. [Specific action: create/modify FILE_PATH — describe exactly what to add/change]
2. [Next action...]

## Verification
How to verify the changes work (test commands, expected behavior).

Your only output should be the plan file. Do not implement the changes yet — a separate execution phase will follow.`;

  const executeContext = `You are an autonomous coding agent. Execute the plan below precisely.

Read ${HAL_DIR}/plan.md for the full plan, then implement every step. The working tree is clean — all changes must come from you.

If a step is impossible, adapt and document why. Do not stop or ask questions.

Original task:
${context}`;

  const planCommand = expandAgentCommand(agent.command, { context: planContext, workdir });
  const executeCommand = expandAgentCommand(agent.command, { context: executeContext, workdir });

  const agentExecBlock = planFirst
    ? `# === Phase 1: Plan ===
echo "" >> ${OUTPUT_LOG}
echo "▓▓▓ HAL9999: PLANNING PHASE ▓▓▓" >> ${OUTPUT_LOG}
echo "" >> ${OUTPUT_LOG}
cd ${workdir}
${planCommand} >> ${OUTPUT_LOG} 2>&1
PLAN_EXIT=$?

if [ $PLAN_EXIT -ne 0 ]; then
  echo "Planning phase failed (exit $PLAN_EXIT)" >> ${OUTPUT_LOG}
  EXIT_CODE=$PLAN_EXIT
else
  # Verify plan was created
  if [ ! -f ${HAL_DIR}/plan.md ]; then
    echo "WARNING: Agent did not create ${HAL_DIR}/plan.md — falling back to direct execution" >> ${OUTPUT_LOG}
    cd ${workdir}
    ${agentCommand} >> ${OUTPUT_LOG} 2>&1
    EXIT_CODE=$?
  else
    # Reset working tree between phases — phase 1 may have made changes
    cd ${workdir}
    git checkout -- . 2>/dev/null || true
    git clean -fd 2>/dev/null || true

    echo "" >> ${OUTPUT_LOG}
    echo "▓▓▓ HAL9999: EXECUTION PHASE ▓▓▓" >> ${OUTPUT_LOG}
    echo "" >> ${OUTPUT_LOG}
    cd ${workdir}
    ${executeCommand} >> ${OUTPUT_LOG} 2>&1
    EXIT_CODE=$?
  fi
fi`
    : `# Run the agent, capturing all output
cd ${workdir}
${agentCommand} >> ${OUTPUT_LOG} 2>&1
EXIT_CODE=$?`;

  return `#!/usr/bin/env bash
set -uo pipefail

# === HAL9999 Wrapper Script ===
# This script runs independently on the VM after SSH disconnects.

# Non-sensitive environment
${safeExports.join("\n")}

${credentialBlock}

# Create output log
touch ${OUTPUT_LOG}

${agentExecBlock}

# Disable strict mode for cleanup — sentinel MUST be written
set +uo pipefail

# Fallback: commit and push if agent didn't already
cd ${workdir}
if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet HEAD 2>/dev/null; then
  git add -A
  git commit -m "hal9999: automated changes" || true
fi
${branch ? `git push origin ${branch} 2>/dev/null || true` : ""}
${branch && !noPr ? `
# Capture PR URL if one exists
PR_URL=$(gh pr view --json url -q '.url' 2>/dev/null || true)
echo "$PR_URL" > ${RESULT_DIR}/pr-url.txt
` : ""}

# Capture git diff artifacts
mkdir -p ${RESULT_DIR}
git diff --stat HEAD 2>/dev/null | head -20 > ${RESULT_DIR}/diff-stat.txt || true
git diff HEAD > ${RESULT_DIR}/diff.patch 2>/dev/null || true

# Write sentinel file with exit code
echo "$EXIT_CODE" > ${DONE_SENTINEL}

exit 0
`;
}
