import type { Database } from "bun:sqlite";
import type { PoolConfig } from "./pool/types.ts";
import type { TaskRow, VmRow } from "./db/types.ts";
import type { AgentConfig } from "./agents/types.ts";
import { VMPoolManager } from "./pool/manager.ts";
import { TaskManager } from "./tasks/manager.ts";
import { sshExec, sshExecStreaming, waitForSsh } from "./ssh.ts";
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
    const wrapperScript = generateWrapperScript(agent, wrappedContext, workdir, githubToken, branch, opts.noPr);
    const scriptBase64 = Buffer.from(wrapperScript).toString("base64");

    log.writeHeader(`launching ${agent.name} agent`);
    events.emit({ type: "phase", name: "agent_launch" });

    // Create .hal dir, decode script, make executable, launch with nohup
    const launchCmd = [
      `mkdir -p ${HAL_DIR} ${RESULT_DIR}`,
      `echo '${scriptBase64}' | base64 -d > ${RUN_SCRIPT}`,
      `chmod +x ${RUN_SCRIPT}`,
      `nohup ${RUN_SCRIPT} > /dev/null 2>&1 &`,
    ].join(" && ");

    const launchResult = await sshExec({
      host: vm.ip!,
      port: sshPort,
      command: launchCmd,
      timeoutMs: 30_000,
    });
    if (launchResult.exitCode !== 0) {
      throw new Error(`Failed to launch wrapper script: ${launchResult.stderr}`);
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

  return `#!/usr/bin/env bash
set -uo pipefail

# === HAL9999 Wrapper Script ===
# This script runs independently on the VM after SSH disconnects.

# Non-sensitive environment
${safeExports.join("\n")}

${credentialBlock}

# Create output log
touch ${OUTPUT_LOG}

# Run the agent, capturing all output
cd ${workdir}
${agentCommand} >> ${OUTPUT_LOG} 2>&1
EXIT_CODE=$?

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
