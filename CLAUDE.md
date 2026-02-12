# HAL9999

Hardware-independent agentic coding system. Spawns VMs with coding agents that work on issues autonomously.

## Stack

- **Runtime**: Bun (use bun instead of node/npm everywhere)
- **Language**: TypeScript (strict mode)
- **Database**: SQLite via `bun:sqlite` (stored in `data/hal9999.db`)
- **VM Provider**: DigitalOcean (primary), provider-agnostic interface supports multiple backends

## Project Structure

- `src/providers/types.ts` — Provider interface and shared types
- `src/providers/digitalocean.ts` — DigitalOcean API implementation
- `src/providers/index.ts` — Provider factory
- `src/db/types.ts` — SQLite row types (VmRow, TaskRow)
- `src/db/index.ts` — Database singleton and schema init
- `src/pool/types.ts` — Pool config types
- `src/pool/manager.ts` — VM pool manager (provision, acquire, release, warm pool, reconcile)
- `src/tasks/types.ts` — Task option types
- `src/tasks/manager.ts` — Task lifecycle manager
- `src/ssh.ts` — SSH command execution (blocking + streaming) with env forwarding
- `src/logs.ts` — File-based log writer + tail reader for streaming output
- `src/orchestrator.ts` — Wires pool + tasks + SSH into startTask/runTask flow
- `src/image/setup.sh` — Golden image bootstrap script (Debian 13)
- `src/cli.ts` — CLI entry point

## Conventions

- Bun auto-loads `.env` — no dotenv
- Use `bun:test` for tests
- Provider implementations must satisfy the `Provider` interface in `types.ts`
- Claude auth on VMs: pass `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` via SSH env, never bake into image
- SSH env forwarding uses `bash -c 'export KEY=val; command'` (not `env` — shell builtins like `cd` need bash)
- Warm pool: VMs are returned to pool after task completion, reaped after `HAL_IDLE_TIMEOUT_S`
- Streaming output: tasks write to `data/logs/<task-id>.log`, CLI tails with 250ms polling
