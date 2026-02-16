# HAL9999

Hardware-independent agentic coding system. Spawns VMs with coding agents that work on issues autonomously.

## Stack

- **Runtime**: Bun (use bun instead of node/npm everywhere)
- **Language**: TypeScript (strict mode)
- **Database**: SQLite via `bun:sqlite` (stored in `data/hal9999.db`)
- **VM Provider**: DigitalOcean (cloud), Lima (local macOS VMs) — provider-agnostic interface supports multiple backends

## Project Structure

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
- `src/agents/types.ts` — AgentConfig type (name, command template, env, timeout)
- `src/agents/presets.ts` — Built-in agent presets (claude, opencode, goose, custom) and resolver
- `src/orchestrator.ts` — Wires pool + tasks + SSH into startTask/runTask flow (agent-agnostic)
- `src/image/setup.sh` — Golden image bootstrap script for DO (Debian 13)
- `src/image/hal9999.yaml` — Lima VM template (Debian 13, local dev)
- `src/cli.ts` — CLI entry point

## Conventions

- Bun auto-loads `.env` — no dotenv
- Use `bun:test` for tests
- Provider implementations must satisfy the `Provider` interface in `types.ts`
- Agent-agnostic: orchestrator takes an `AgentConfig` with a command template + env vars. Built-in presets for claude, opencode, goose. Custom commands via `--agent "my-cmd {{context}}"`.
- Auth on VMs: pass API keys via SSH env forwarding, never bake into image
- SSH env forwarding uses `bash -c 'export KEY=val; command'` (not `env` — shell builtins like `cd` need bash)
- Warm pool: VMs are returned to pool after task completion, reaped after `HAL_IDLE_TIMEOUT_S`
- Streaming output: tasks write to `data/logs/<task-id>.log`, CLI tails with 250ms polling
- JSONL events: structured event stream per task in `data/events/<task-id>.jsonl`. Orchestrator emits typed events (task_start, vm_acquired, phase, output, task_end). `task events` CLI command for pretty-printed or raw JSONL output.
- Lima provider: `--provider lima` flag, uses `limactl` CLI, SSH via localhost:<dynamic-port>, template path as snapshotId
- Lima VMs use `agent` user to match DO golden image conventions
- Mixed pools: `--provider lima,digitalocean` — comma-separated, first has highest priority. Each VM tracks its provider in DB. Pool fills local first, overflows to cloud.
- Per-provider env: `HAL_LIMA_MAX_POOL_SIZE`, `HAL_DO_SNAPSHOT_ID`, etc. Fall back to global `HAL_*` vars.
