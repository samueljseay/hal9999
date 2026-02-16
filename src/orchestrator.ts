import type { Database } from "bun:sqlite";
import type { PoolConfig } from "./pool/types.ts";
import type { TaskRow } from "./db/types.ts";
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
  startTask(repoUrl: string, context: string): string {
    const task = this.tasks.createTask({ repoUrl, context });
    // Fire and forget — errors are captured in the DB
    this.executeTask(task.id, repoUrl, context);
    return task.id;
  }

  /**
   * Run a task and wait for it to complete. Returns the final TaskRow.
   */
  async runTask(repoUrl: string, context: string): Promise<TaskRow> {
    const task = this.tasks.createTask({ repoUrl, context });
    await this.executeTask(task.id, repoUrl, context);
    return this.tasks.getTask(task.id)!;
  }

  private async executeTask(taskId: string, repoUrl: string, context: string): Promise<void> {
    const log = createLogWriter(taskId);
    const events = createEventWriter(taskId);
    const agent = this.config.agent;

    log.writeHeader(`task ${taskId}`);
    log.append(`Repo: ${repoUrl}\nContext: ${context}\nAgent: ${agent.name}\n`);
    events.emit({ type: "task_start", repoUrl, context, agent: agent.name });

    let vm;
    try {
      // Acquire a VM
      log.writeHeader("acquiring VM");
      events.emit({ type: "phase", name: "vm_acquire" });
      vm = await this.pool.acquireVm(taskId);
      this.tasks.assignTask(taskId, vm.id);
      log.append(`VM ${vm.id} assigned (${vm.ip})\n`);
      events.emit({ type: "vm_acquired", vmId: vm.id, provider: vm.provider, ip: vm.ip ?? "" });

      // Wait for SSH
      const sshPort = vm.ssh_port ?? undefined;
      log.writeHeader("waiting for SSH");
      events.emit({ type: "phase", name: "ssh_wait" });
      await waitForSsh(vm.ip!, "agent", 180_000, sshPort);
      log.append(`SSH ready\n`);

      // Clean workspace (VM may be reused from warm pool)
      await sshExec({
        host: vm.ip!,
        port: sshPort,
        command: "rm -rf /workspace/*",
        timeoutMs: 30_000,
      });

      // Clone the repo
      const repoName = extractRepoName(repoUrl);
      const workdir = `/workspace/${repoName}`;
      log.writeHeader("cloning repo");
      events.emit({ type: "phase", name: "clone" });
      const cloneResult = await sshExecStreaming({
        host: vm.ip!,
        port: sshPort,
        command: `git clone ${repoUrl} ${workdir}`,
        timeoutMs: 120_000,
        onChunk: (text) => {
          log.append(text);
          events.emit({ type: "output", stream: "stdout", text });
        },
      });
      if (cloneResult.exitCode !== 0) {
        throw new Error(`git clone failed: ${cloneResult.stderr}`);
      }

      // Run the agent
      this.tasks.markRunning(taskId);
      const agentCommand = expandAgentCommand(agent.command, { context, workdir });
      log.writeHeader(`running ${agent.name} agent`);
      events.emit({ type: "phase", name: "agent_run" });
      const agentEnv = {
        // Ensure tools installed to user-local paths are available.
        // Use absolute path — $HOME won't expand inside single-quoted SSH env.
        PATH: "/home/agent/.local/bin:/home/agent/.bun/bin:/usr/local/bin:/usr/bin:/bin",
        ...agent.env,
      };
      const agentResult = await sshExecStreaming({
        host: vm.ip!,
        port: sshPort,
        command: `cd ${workdir} && ${agentCommand}`,
        env: agentEnv,
        timeoutMs: agent.timeoutMs ?? 600_000,
        onChunk: (text) => {
          log.append(text);
          events.emit({ type: "output", stream: "stdout", text });
        },
      });

      if (agentResult.exitCode === 0) {
        this.tasks.completeTask(taskId, agentResult.stdout, 0);
        log.append(`\nTask completed successfully\n`);
        events.emit({ type: "task_end", status: "completed", exitCode: 0 });
      } else {
        this.tasks.failTask(taskId, agentResult.stderr || agentResult.stdout, agentResult.exitCode);
        log.append(`\nTask failed (exit ${agentResult.exitCode})\n`);
        events.emit({ type: "task_end", status: "failed", exitCode: agentResult.exitCode, error: agentResult.stderr || agentResult.stdout });
      }
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

  async recover(): Promise<void> {
    console.log("Running pool reconciliation...");
    const result = await this.pool.reconcile();
    if (result.updated || result.destroyed) {
      console.log(`Reconciled: ${result.updated} updated, ${result.destroyed} destroyed`);
    } else {
      console.log("Pool is in sync");
    }
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
