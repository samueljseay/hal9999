# HAL9999

Hardware-independent agentic coding system. Spawns VMs with coding agents that work on issues autonomously.

## Stack

- **Runtime**: Bun (use bun instead of node/npm everywhere)
- **Language**: TypeScript (strict mode)
- **Database**: SQLite via `bun:sqlite` (stored in `data/hal9999.db`)
- **VM Provider**: DigitalOcean (cloud), Lima (local macOS VMs) — provider-agnostic interface supports multiple backends

## Project Structure

### CLI (`hal` binary)
- `bin/hal` — Shebang entry point (`#!/usr/bin/env bun`)
- `src/cli.ts` — Re-export of `src/cli/index.ts` (backward compat entry)
- `src/cli/index.ts` — Command router + backward-compat aliases (`task create` → `run`, etc.)
- `src/cli/run.ts` — `hal run <repo> -m "msg"` — flagship command
- `src/cli/ps.ts` — `hal ps` — list tasks with short IDs
- `src/cli/logs.ts` — `hal logs <id>` — stream task output
- `src/cli/events.ts` — `hal events <id>` — structured JSONL events
- `src/cli/show.ts` — `hal show <id>` — full task details
- `src/cli/pool.ts` — `hal pool [ls|sync|warm]` — pool management
- `src/cli/vm.ts` — `hal vm <cmd>` — infrastructure commands
- `src/cli/image.ts` — `hal image [build|ls|rm]` — golden image management
- `src/cli/auth.ts` — `hal auth [login|logout|status|set|get]` — credential management
- `src/cli/context.ts` — Lazy db/taskManager/poolManager/orchestrator factories
- `src/cli/resolve.ts` — Short ID prefix → full UUID resolution
- `src/cli/help.ts` — Help text
- `src/cli/ui.ts` — Shared UI: HAL spinner, `getProvider()`, `statusColor()`/`statusPad()`

### Core
- `src/providers/types.ts` — Provider interface and shared types
- `src/providers/digitalocean.ts` — DigitalOcean API implementation
- `src/providers/lima.ts` — Lima (local macOS VM) implementation
- `src/providers/index.ts` — Provider factory
- `src/db/types.ts` — SQLite row types (VmRow, TaskRow)
- `src/db/index.ts` — Database singleton and schema init
- `src/pool/types.ts` — Pool config types (ProviderSlot for mixed-provider pools)
- `src/pool/manager.ts` — VM pool manager (multi-provider, priority-based provisioning, warm pool)
- `src/tasks/types.ts` — Task option types
- `src/tasks/manager.ts` — Task lifecycle manager
- `src/ssh.ts` — SSH command execution (blocking + streaming) with env forwarding
- `src/logs.ts` — File-based log writer + tail reader for streaming output
- `src/events/types.ts` — JSONL event protocol types (TaskEvent union, EventEnvelope)
- `src/events/writer.ts` — Per-task JSONL event writer (`data/events/<task-id>.jsonl`)
- `src/events/reader.ts` — Event reader (readEvents) and async generator tailer (tailEvents)
- `src/events/index.ts` — Barrel export for events module
- `src/agents/types.ts` — AgentConfig type (name, command template, install script, env, timeout)
- `src/agents/presets.ts` — Built-in agent presets (claude, opencode, goose, custom) and resolver
- `src/auth/types.ts` — CredentialStore interface, CredentialKey type
- `src/auth/keychain.ts` — macOS Keychain backend (`security` CLI)
- `src/auth/secret-service.ts` — Linux Secret Service backend (`secret-tool` CLI)
- `src/auth/encrypted-file.ts` — Encrypted file fallback (AES-256-GCM, machine-bound)
- `src/auth/store.ts` — Platform detection factory, `getCredential()`, `getCredentialEnv()`
- `src/auth/index.ts` — Barrel export
- `src/orchestrator.ts` — Fire-and-forget orchestrator: setup → nohup launch → poll → collect (agent-agnostic)
- `src/image/setup.sh` — Golden image bootstrap script for DO (Debian 13)
- `src/image/hal9999.yaml` — Lima VM template (Debian 13, local dev)

## Conventions

- Bun auto-loads `.env` — no dotenv
- Use `bun:test` for tests
- **CLI binary**: `hal` (via `bun link`). Entry: `bin/hal` → `src/cli/index.ts`. Old `bun run src/cli.ts` still works.
- **Default provider: `lima`** — local-first, zero-cost. Override with `-p do` or `HAL_DEFAULT_PROVIDER=digitalocean`.
- **Repo shorthand**: `owner/repo` → `https://github.com/owner/repo`. Full URLs still work.
- **Short IDs**: first 8 chars of UUID for display, prefix matching for lookups (`hal show a1b2`).
- **Provider alias**: `do` accepted as shorthand for `digitalocean`.
- **Lazy init**: read-only commands (`ps`, `logs`, `show`, `events`, `pool`, `pool ls`) only open SQLite. Only `run`, `pool sync`, and `pool warm` build providers.
- **Backward compat**: `task create/list/watch/get/events` still work but print deprecation hints.
- Provider implementations must satisfy the `Provider` interface in `types.ts`
- Agent-agnostic: orchestrator takes an `AgentConfig` with a command template + env vars. Built-in presets for claude, opencode, goose. Custom commands via `-a "my-cmd {{context}}"`.
- Runtime agent install: `AgentConfig.install` is an idempotent shell script run before the agent command. Uses `command -v` guard to skip if already installed. Only PATH is forwarded (no API keys). VMs accumulate agents across warm-pool reuse.
- **Fire-and-forget execution**: orchestrator runs setup over SSH (clone, install agent), then uploads a wrapper script to `/workspace/.hal/run.sh` and launches it with `nohup`. SSH session ends, agent keeps running on the VM.
- **`/workspace/.hal/` convention**: `run.sh` (wrapper), `output.log` (stdout/stderr), `done` (exit code sentinel), `result/` (diff-stat, patch).
- **Poll-based output**: orchestrator polls VM every 5s — checks sentinel file + pulls incremental output via `tail -c +<offset>`. Writes to local `data/logs/<taskId>.log`. `hal logs` tails the local file unchanged.
- **Recovery**: `recover()` finds `running` tasks and resumes poll+collect. `assigned` tasks (setup incomplete) are failed. Dead VMs → task failed.
- **Credential store**: `hal auth login` stores API keys in OS-native credential managers (macOS Keychain, Linux Secret Service, or encrypted file fallback). Precedence: `process.env` (.env / exported vars) > credential store. `getCredential(key)` and `getCredentialEnv()` in `src/auth/store.ts` handle lookup. `.env` still works for CI/power users.
- **GITHUB_TOKEN**: set via `hal auth login`, `.env`, or env var. Forwarded to agent env. Clone URL rewritten to `https://x-access-token:TOKEN@github.com/...`. Wrapper script configures `git credential.helper store` so agents can `git push`.
- **Wrapper script credential scrubbing**: credentials are written to a temp file, sourced into env, then the temp file and the credential block in the script are deleted. Credentials exist on disk only momentarily.
- Auth on VMs: API keys loaded via temp file in the wrapper script on the VM (not forwarded over persistent SSH). Never bake into image.
- **Per-provider idle defaults**: Lima=1800s (30min), DO=300s (5min). Override with `HAL_LIMA_IDLE_TIMEOUT_S`, `HAL_DO_IDLE_TIMEOUT_S`, or global `HAL_IDLE_TIMEOUT_S`. `idleTimeoutMs` is per-slot on `ProviderSlot`, not on `PoolConfig`.
- **Persistent reap**: `idle_since` column in DB tracks when a VM became idle. `reapIdleVms()` compares elapsed time against slot timeout — works across process restarts. `hal pool sync` and `hal pool warm` both trigger reap.
- **Pre-warm pool**: `ProviderSlot.minReady` (env: `HAL_LIMA_MIN_READY`, `HAL_DO_MIN_READY`, or `HAL_MIN_READY`). `ensureWarm()` fires after release, acquire, reap, and reconcile. `hal pool warm` triggers reap + warm manually.
- Warm pool: VMs are returned to pool after task completion, reaped after per-provider idle timeout
- Streaming output: orchestrator pulls from VM to `data/logs/<task-id>.log`, CLI tails with 250ms polling
- JSONL events: structured event stream per task in `data/events/<task-id>.jsonl`. Orchestrator emits typed events (task_start, vm_acquired, phase, output, task_end). `hal events <id>` for pretty-printed or `--raw` JSONL output.
- Lima provider: `-p lima` flag, uses `limactl` CLI, SSH via localhost:<dynamic-port>, template path as snapshotId
- Lima VMs use `agent` user to match DO golden image conventions
- Mixed pools: `-p lima,digitalocean` — comma-separated, first has highest priority. Each VM tracks its provider in DB. Pool fills local first, overflows to cloud.
- Per-provider env: `HAL_LIMA_MAX_POOL_SIZE`, `HAL_DO_SNAPSHOT_ID`, etc. Fall back to global `HAL_*` vars.
- **Golden images**: `hal image build` creates `hal9999-golden` (Lima) or a DO snapshot for fast VM boot. Auto-detection: if `hal9999-golden` Lima instance exists, `hal run` uses `clone:` path automatically (skips cloud-init). `HAL_LIMA_TEMPLATE` env var overrides auto-detection. `clone:` prefix in snapshotId triggers `limactl clone` instead of template provisioning.
- **Branch/Push/PR**: every task creates a feature branch (`hal/<shortId>` by default, override with `--branch`). Orchestrator sets up the branch and git identity (`hal9999`) on the VM before the agent runs. Agent context is wrapped with instructions to commit, push, and create a PR. Wrapper script has fallback: commits uncommitted changes + pushes if the agent didn't. PR URL is captured from `gh pr view` and stored in `tasks.pr_url`. `--base` sets PR target (default: repo's default branch). `--no-pr` skips PR creation.
