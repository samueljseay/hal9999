const HELP = `
hal — agentic VM orchestration

Usage:
  hal <command> [options]

Run a task:
  hal run <repo> -m "instructions"        Run an agent on a repo
    -a, --agent <name>                    Agent: claude, opencode, goose, or custom (default: claude)
    -p, --provider <name>                 Provider: local (auto), lima, incus, do/digitalocean
    -b, --branch <name>                   Feature branch name (default: hal/<shortId>)
    --base <branch>                       PR target branch (default: repo default)
    --no-pr                               Push branch but skip PR creation
    --plan-first                          Plan then execute (two-phase)

Task queries:
  hal ps [-s <status>]                    List tasks
  hal logs <id>                           Stream task output
  hal events <id> [--raw]                 Structured JSONL events
  hal show <id>                           Full task details

Pool:
  hal pool                                Pool status summary
  hal pool ls [-s <status>]               List tracked VMs
  hal pool sync                           Reconcile DB with provider
  hal pool warm                           Reap idle VMs, top up warm pool

Golden images:
  hal image build [-p <provider>]         Build golden image for fast VM boot
  hal image ls [-p <provider>]            List available golden images
  hal image rm [-p <provider>]            Remove a golden image

Auth:
  hal auth login                          Interactive credential setup
  hal auth logout                         Remove all stored credentials
  hal auth status                         Show configured credentials
  hal auth set <KEY> <VALUE>              Store a credential
  hal auth get <KEY>                      Read a credential to stdout

Infrastructure:
  hal vm ls                               List provider instances
  hal vm create --os <id>                 Create raw OS instance
  hal vm launch -s <snap>                 Launch from snapshot
  hal vm get <id>                         Instance details
  hal vm destroy <id>                     Destroy an instance
  hal vm stop <id>                        Stop an instance
  hal vm snapshot <id> [-d "desc"]        Snapshot an instance
  hal vm snapshots                        List snapshots
  hal vm snapshot rm <id>                 Delete a snapshot
  hal vm images [--query X]               List OS images (DO only)
  hal vm ssh-keys                         List SSH keys (DO only)

Options:
  -h, --help                              Show this help
  --provider <name>                       Override provider for vm commands

Short IDs:  Use any unique prefix of a UUID (e.g. "hal show a1b2").
Repo shorthand:  "owner/repo" expands to https://github.com/owner/repo.
`.trim();

export function printHelp(): void {
  console.log(HELP);
}
