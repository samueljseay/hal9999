import { parseArgs } from "node:util";
import pc from "picocolors";
import type { DigitalOceanProvider } from "../providers/digitalocean.ts";
import { getProvider, statusPad } from "./ui.ts";

export async function vmCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  const subArgv = argv.slice(1);

  if (!sub || sub === "--help" || sub === "-h") {
    console.log(`hal vm — manage provider infrastructure

Usage:
  hal vm <command> [options]

Commands:
  ls                      List provider instances
  create --os <id>        Create a raw OS instance
  launch -s <snap>        Launch instance from snapshot
  get <id>                Show instance details (JSON)
  destroy <id>            Destroy an instance
  stop <id>               Stop an instance
  snapshot <id>           Create a snapshot of an instance
  snapshots               List all snapshots
  snapshot rm <id>        Delete a snapshot
  images [--query X]      List OS images (DO only)
  ssh-keys                List SSH keys (DO only)

Global options:
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  -h, --help              Show this help

Run "hal vm <command> --help" for command-specific options.`);
    return;
  }

  // Handle "snapshot rm" as a special two-word subcommand
  if (sub === "snapshot" && subArgv[0] === "rm") {
    return snapshotRm(subArgv.slice(1));
  }

  switch (sub) {
    case "ls":
    case "list":
      return vmList(subArgv);
    case "create":
      return vmCreate(subArgv);
    case "launch":
      return vmLaunch(subArgv);
    case "get":
      return vmGet(subArgv);
    case "destroy":
      return vmDestroy(subArgv);
    case "stop":
      return vmStop(subArgv);
    case "snapshot":
      return vmSnapshot(subArgv);
    case "snapshots":
      return vmSnapshots(subArgv);
    case "images":
      return vmImages(subArgv);
    case "ssh-keys":
      return vmSshKeys(subArgv);
    default:
      console.error(`Unknown vm command: ${sub}`);
      console.log("Available: ls, create, launch, get, destroy, stop, snapshot, snapshots, images, ssh-keys");
      process.exit(1);
  }
}

async function vmList(argv: string[]): Promise<void> {
  const { provider, rest } = getProvider(argv);
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      label: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(`hal vm ls — list provider instances

Usage:
  hal vm ls [options]

Options:
  --label <label>         Filter by instance label
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  -h, --help              Show this help`);
    return;
  }

  const instances = await provider.listInstances(values.label);
  if (instances.length === 0) {
    console.log("No instances found.");
    return;
  }
  console.log(pc.dim(`${"ID".padEnd(40)} ${"LABEL".padEnd(20)} ${"STATUS".padEnd(10)} ${"IP".padEnd(16)} REGION`));
  for (const i of instances) {
    console.log(
      `${i.id.padEnd(40)} ${i.label.padEnd(20)} ${statusPad(i.status, 10)} ${i.ip.padEnd(16)} ${i.region}`
    );
  }
}

async function vmCreate(argv: string[]): Promise<void> {
  const { provider, rest } = getProvider(argv);
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      os: { type: "string" },
      region: { type: "string", default: "nyc1" },
      plan: { type: "string", default: "s-1vcpu-1gb" },
      label: { type: "string" },
      "ssh-key": { type: "string" },
      wait: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(`hal vm create — create a raw OS instance

Usage:
  hal vm create --os <id> [options]

Options:
  --os <id>               OS image ID or slug (required). Use "hal vm images" to find IDs.
  --region <region>       Region code (default: nyc1)
  --plan <plan>           Instance size/plan slug (default: s-1vcpu-1gb)
  --label <label>         Instance label (default: hal9999)
  --ssh-key <id>          SSH key ID to inject
  --wait                  Block until the instance is ready
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  -h, --help              Show this help`);
    return;
  }

  if (!values.os) {
    console.error("Error: --os <id> is required. Run 'hal vm images --query debian' to find IDs.");
    process.exit(1);
  }

  const sshKeyIds = values["ssh-key"] ? [values["ssh-key"]] : (process.env.HAL_SSH_KEY_ID ? [process.env.HAL_SSH_KEY_ID] : undefined);
  const osId = /^\d+$/.test(values.os) ? parseInt(values.os, 10) : values.os;

  console.log(`Creating instance (os=${values.os}, region=${values.region}, plan=${values.plan})...`);
  const instance = await provider.createInstance({
    region: values.region!,
    plan: values.plan!,
    osId,
    label: values.label ?? "hal9999",
    sshKeyIds,
  });
  console.log(`Instance created: ${instance.id}`);
  console.log(`  Status: ${instance.status}`);
  console.log(`  IP:     ${instance.ip}`);

  if (values.wait) {
    console.log("Waiting for instance to be ready...");
    const ready = await provider.waitForReady(instance.id);
    console.log(`Instance ready: ${ready.ip}`);
  }
}

async function vmLaunch(argv: string[]): Promise<void> {
  const { provider, rest } = getProvider(argv);
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      snapshot: { type: "string", short: "s" },
      region: { type: "string", default: "nyc1" },
      plan: { type: "string", default: "s-1vcpu-1gb" },
      label: { type: "string" },
      wait: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(`hal vm launch — launch instance from snapshot

Usage:
  hal vm launch -s <snapshot-id> [options]

Options:
  -s, --snapshot <id>     Snapshot ID (required)
  --region <region>       Region code (default: nyc1)
  --plan <plan>           Instance size/plan slug (default: s-1vcpu-1gb)
  --label <label>         Instance label (default: hal9999)
  --wait                  Block until the instance is ready
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  -h, --help              Show this help`);
    return;
  }

  if (!values.snapshot) {
    console.error("Error: -s/--snapshot <id> is required for launch");
    process.exit(1);
  }

  console.log(`Launching instance from snapshot ${values.snapshot}...`);
  const instance = await provider.createInstance({
    region: values.region!,
    plan: values.plan!,
    snapshotId: values.snapshot,
    label: values.label ?? "hal9999",
  });
  console.log(`Instance created: ${instance.id}`);
  console.log(`  Status: ${instance.status}`);
  console.log(`  IP:     ${instance.ip}`);

  if (values.wait) {
    console.log("Waiting for instance to be ready...");
    const ready = await provider.waitForReady(instance.id);
    console.log(`Instance ready: ${ready.ip}`);
  }
}

async function vmGet(argv: string[]): Promise<void> {
  const { provider, rest } = getProvider(argv);
  const { positionals, values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(`hal vm get — show instance details

Usage:
  hal vm get <instance-id>

Arguments:
  <instance-id>           Provider instance ID

Options:
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  -h, --help              Show this help

Outputs full instance details as JSON.`);
    if (positionals.length === 0 && !values.help) process.exit(1);
    return;
  }

  const instance = await provider.getInstance(positionals[0]!);
  console.log(JSON.stringify(instance, null, 2));
}

async function vmDestroy(argv: string[]): Promise<void> {
  const { provider, rest } = getProvider(argv);
  const { positionals, values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(`hal vm destroy — destroy an instance

Usage:
  hal vm destroy <instance-id>

Arguments:
  <instance-id>           Provider instance ID

Options:
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  -h, --help              Show this help`);
    if (positionals.length === 0 && !values.help) process.exit(1);
    return;
  }

  console.log(`Destroying instance ${positionals[0]}...`);
  await provider.destroyInstance(positionals[0]!);
  console.log("Done.");
}

async function vmStop(argv: string[]): Promise<void> {
  const { provider, rest } = getProvider(argv);
  const { positionals, values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(`hal vm stop — stop an instance

Usage:
  hal vm stop <instance-id>

Arguments:
  <instance-id>           Provider instance ID

Options:
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  -h, --help              Show this help`);
    if (positionals.length === 0 && !values.help) process.exit(1);
    return;
  }

  console.log(`Stopping instance ${positionals[0]}...`);
  await provider.stopInstance(positionals[0]!);
  console.log("Done.");
}

async function vmSnapshot(argv: string[]): Promise<void> {
  const { provider, rest } = getProvider(argv);
  const { positionals, values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      description: { type: "string", short: "d" },
      wait: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(`hal vm snapshot — create a snapshot of an instance

Usage:
  hal vm snapshot <instance-id> [options]

Arguments:
  <instance-id>           Provider instance ID

Options:
  -d, --description <d>   Snapshot description (default: hal9999-YYYY-MM-DD)
  --wait                  Block until the snapshot is complete (can take up to 30 min)
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  -h, --help              Show this help

See also: hal vm snapshots, hal vm snapshot rm <id>`);
    if (positionals.length === 0 && !values.help) process.exit(1);
    return;
  }

  const desc = values.description ?? `hal9999-${new Date().toISOString().split("T")[0]}`;
  console.log(`Creating snapshot of ${positionals[0]} (${desc})...`);
  const snap = await provider.createSnapshot(positionals[0]!, desc);
  console.log(`Snapshot created: ${snap.id}`);
  console.log(`  Status: ${snap.status}`);

  if (values.wait) {
    console.log("Waiting for snapshot to complete (this can take up to 30 min)...");
    const ready = await provider.waitForSnapshot(snap.id);
    console.log(`Snapshot complete: ${ready.id} (${ready.size} bytes)`);
  }
}

async function vmSnapshots(argv: string[]): Promise<void> {
  const { provider, rest } = getProvider(argv);
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(`hal vm snapshots — list all snapshots

Usage:
  hal vm snapshots [options]

Options:
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  -h, --help              Show this help`);
    return;
  }

  const snapshots = await provider.listSnapshots();
  if (snapshots.length === 0) {
    console.log("No snapshots found.");
    return;
  }
  console.log(pc.dim(`${"ID".padEnd(40)} ${"DESCRIPTION".padEnd(30)} ${"STATUS".padEnd(10)} SIZE`));
  for (const s of snapshots) {
    const sizeMb = (s.size / 1_000_000).toFixed(1);
    console.log(
      `${s.id.padEnd(40)} ${s.description.padEnd(30)} ${statusPad(s.status, 10)} ${sizeMb}MB`
    );
  }
}

async function snapshotRm(argv: string[]): Promise<void> {
  const { provider, rest } = getProvider(argv);
  const { positionals, values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(`hal vm snapshot rm — delete a snapshot

Usage:
  hal vm snapshot rm <snapshot-id>

Arguments:
  <snapshot-id>           Snapshot ID to delete

Options:
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  -h, --help              Show this help`);
    if (positionals.length === 0 && !values.help) process.exit(1);
    return;
  }

  console.log(`Deleting snapshot ${positionals[0]}...`);
  await provider.deleteSnapshot(positionals[0]!);
  console.log("Done.");
}

async function vmImages(argv: string[]): Promise<void> {
  // Check help before provider init (provider may not be configured)
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`hal vm images — list available OS images (DigitalOcean only)

Usage:
  hal vm images [options]

Options:
  --query <text>          Filter images (e.g. "debian", "ubuntu")
  -p, --provider do       Must be DigitalOcean (default when DO_API_TOKEN is set)
  -h, --help              Show this help

Examples:
  hal vm images -p do --query debian`);
    return;
  }

  const { provider, providerType, rest } = getProvider(argv);
  if (providerType !== "digitalocean") {
    console.error("Error: 'vm images' is only available for the digitalocean provider. Use: hal vm images -p do");
    process.exit(1);
  }

  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      query: { type: "string" },
    },
  });

  const doProvider = provider as DigitalOceanProvider;
  const images = await doProvider.listImages(values.query);
  if (images.length === 0) {
    console.log(`No images found${values.query ? ` matching "${values.query}"` : ""}.`);
    return;
  }
  console.log(pc.dim(`${"ID".padEnd(12)} ${"SLUG".padEnd(24)} ${"NAME".padEnd(40)} DISTRO`));
  for (const img of images) {
    console.log(
      `${String(img.id).padEnd(12)} ${(img.slug ?? "-").padEnd(24)} ${img.name.padEnd(40)} ${img.distribution}`
    );
  }
}

async function vmSshKeys(argv: string[]): Promise<void> {
  // Check help before provider init (provider may not be configured)
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`hal vm ssh-keys — list registered SSH keys (DigitalOcean only)

Usage:
  hal vm ssh-keys [options]

Options:
  -p, --provider do       Must be DigitalOcean (default when DO_API_TOKEN is set)
  -h, --help              Show this help`);
    return;
  }

  const { provider, providerType } = getProvider(argv);
  if (providerType !== "digitalocean") {
    console.error("Error: 'vm ssh-keys' is only available for the digitalocean provider. Use: hal vm ssh-keys -p do");
    process.exit(1);
  }

  const doProvider = provider as DigitalOceanProvider;
  const keys = await doProvider.listSshKeys();
  if (keys.length === 0) {
    console.log("No SSH keys registered.");
    return;
  }
  for (const k of keys) {
    console.log(`${k.id}  ${k.name}  ${k.fingerprint}`);
  }
}
