export interface AgentConfig {
  /** Human-readable name for logging (e.g. "claude", "opencode") */
  name: string;

  /**
   * Shell command to run inside the VM.
   * Template variables (expanded by the orchestrator):
   *   {{context}} — task instructions (shell-escaped)
   *   {{workdir}} — absolute path to the cloned repo
   */
  command: string;

  /** Environment variables forwarded to the VM via SSH */
  env?: Record<string, string>;

  /**
   * Idempotent install script that runs on the VM before the agent command.
   * Should use `command -v <binary>` guard to skip if already installed.
   * Only PATH is forwarded during install (no API keys).
   */
  install?: string;

  /** Agent command timeout in ms (default: 600_000 = 10 min) */
  timeoutMs?: number;
}
