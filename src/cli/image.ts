import pc from "picocolors";
import type { DigitalOceanProvider } from "../providers/digitalocean.ts";
import { sshExec, waitForSsh } from "../ssh.ts";
import { getProvider, statusPad } from "./ui.ts";

const GOLDEN_NAME = "hal9999-golden";

export async function imageCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  const subArgv = argv.slice(1);

  if (!sub || sub === "--help" || sub === "-h") {
    console.log(`hal image — manage golden images for fast VM boot

Usage:
  hal image <command> [options]

Commands:
  build                   Build a golden image (provision once, reuse many)
  ls                      List available golden images
  rm                      Remove a golden image

Global options:
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  -h, --help              Show this help`);
    return;
  }

  switch (sub) {
    case "build":
      return imageBuild(subArgv);
    case "ls":
    case "list":
      return imageLs(subArgv);
    case "rm":
    case "remove":
      return imageRm(subArgv);
    default:
      console.error(`Unknown image command: ${sub}`);
      console.log("Available: build, ls, rm");
      process.exit(1);
  }
}

async function imageBuild(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`hal image build — build a golden image

Usage:
  hal image build [options]

Lima:
  Creates a VM from hal9999.yaml, waits for provisioning, stops it.
  Named "${GOLDEN_NAME}". Idempotent — destroys existing golden image first.
  Subsequent VMs use "limactl clone" for ~10s boot instead of ~2min.

DigitalOcean:
  Creates a droplet from base OS, runs setup.sh, snapshots, destroys build droplet.
  Prints snapshot ID to set in .env as HAL_DO_SNAPSHOT_ID.

Options:
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  -h, --help              Show this help`);
    return;
  }

  const { providerType } = getProvider(argv);

  if (providerType === "lima") {
    await buildLimaGolden();
  } else if (providerType === "digitalocean") {
    await buildDoGolden(argv);
  } else {
    console.error(`Golden image build not supported for provider: ${providerType}`);
    process.exit(1);
  }
}

async function buildLimaGolden(): Promise<void> {
  const templatePath = process.env.HAL_LIMA_TEMPLATE ?? "src/image/hal9999.yaml";

  // Destroy existing golden image if present (idempotent)
  console.log(`Checking for existing ${GOLDEN_NAME}...`);
  const checkResult = Bun.spawnSync(
    ["limactl", "list", GOLDEN_NAME, "--json"],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (checkResult.exitCode === 0 && new TextDecoder().decode(checkResult.stdout).includes(GOLDEN_NAME)) {
    console.log(`Destroying existing ${GOLDEN_NAME}...`);
    Bun.spawnSync(["limactl", "stop", GOLDEN_NAME, "--tty=false"], { stdout: "pipe", stderr: "pipe" });
    const delResult = Bun.spawnSync(
      ["limactl", "delete", "--force", GOLDEN_NAME, "--tty=false"],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (delResult.exitCode !== 0) {
      console.error(`Failed to delete existing ${GOLDEN_NAME}: ${new TextDecoder().decode(delResult.stderr)}`);
      process.exit(1);
    }
    console.log("Existing golden image removed.");
  }

  // Create and provision from template
  console.log(`Building ${GOLDEN_NAME} from ${templatePath}...`);
  console.log("This will take 1-2+ minutes (image download + provisioning)...");
  const startResult = Bun.spawnSync(
    ["limactl", "start", "--name", GOLDEN_NAME, templatePath, "--tty=false"],
    { stdout: "inherit", stderr: "inherit" }
  );
  if (startResult.exitCode !== 0) {
    console.error(`Failed to create ${GOLDEN_NAME}`);
    process.exit(1);
  }

  // Stop it so it can be cloned
  console.log(`Stopping ${GOLDEN_NAME}...`);
  const stopResult = Bun.spawnSync(
    ["limactl", "stop", GOLDEN_NAME, "--tty=false"],
    { stdout: "inherit", stderr: "inherit" }
  );
  if (stopResult.exitCode !== 0) {
    console.error(`Failed to stop ${GOLDEN_NAME}`);
    process.exit(1);
  }

  console.log(`\nGolden image "${GOLDEN_NAME}" ready.`);
  console.log("New VMs will automatically use clone-based fast boot.");
}

async function buildDoGolden(argv: string[]): Promise<void> {
  const { provider } = getProvider(argv);
  const doProvider = provider as DigitalOceanProvider;

  const region = process.env.HAL_DO_REGION ?? process.env.HAL_REGION ?? "nyc1";
  const plan = process.env.HAL_DO_PLAN ?? process.env.HAL_PLAN ?? "s-1vcpu-1gb";
  const sshKeyIds = process.env.HAL_SSH_KEY_ID ? [process.env.HAL_SSH_KEY_ID] : undefined;
  const buildName = `${GOLDEN_NAME}-build-${Date.now()}`;

  // 1. Create build droplet from base OS
  console.log(`Creating build droplet (${buildName})...`);
  const instance = await doProvider.createInstance({
    region,
    plan,
    osId: "debian-13-x64",
    label: buildName,
    sshKeyIds,
  });
  console.log(`Droplet created: ${instance.id}`);

  try {
    // 2. Wait for ready + SSH
    console.log("Waiting for droplet to be ready...");
    const ready = await doProvider.waitForReady(instance.id);
    console.log(`Droplet ready: ${ready.ip}`);

    console.log("Waiting for SSH...");
    await waitForSsh(ready.ip, "root");

    // 3. Run setup.sh
    console.log("Running setup.sh on build droplet...");
    const setupScript = await Bun.file("src/image/setup.sh").text();
    const result = await sshExec({
      host: ready.ip,
      user: "root",
      command: `bash -s <<'SETUP_EOF'\n${setupScript}\nSETUP_EOF`,
      timeoutMs: 600_000, // 10 min
    });

    if (result.exitCode !== 0) {
      console.error(`Setup failed (exit ${result.exitCode}):`);
      console.error(result.stderr);
      throw new Error("Setup script failed");
    }
    console.log(result.stdout);

    // 4. Stop droplet
    console.log("Stopping build droplet...");
    await doProvider.stopInstance(instance.id);

    // Wait for stopped state
    const start = Date.now();
    while (Date.now() - start < 120_000) {
      const inst = await doProvider.getInstance(instance.id);
      if (inst.status === "stopped") break;
      await new Promise((r) => setTimeout(r, 5_000));
    }

    // 5. Snapshot
    const snapName = `hal9999-golden-${new Date().toISOString().split("T")[0]}`;
    console.log(`Creating snapshot "${snapName}"...`);
    const snap = await doProvider.createSnapshot(instance.id, snapName);
    console.log(`Snapshot created: ${snap.id}`);

    // 6. Destroy build droplet
    console.log("Destroying build droplet...");
    await doProvider.destroyInstance(instance.id);

    console.log(`\nGolden image ready. Set in .env:`);
    console.log(`  HAL_DO_SNAPSHOT_ID=${snap.id}`);
  } catch (err) {
    // Clean up build droplet on failure
    console.error("Build failed, destroying build droplet...");
    await doProvider.destroyInstance(instance.id).catch(() => {});
    throw err;
  }
}

async function imageLs(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`hal image ls — list available golden images

Usage:
  hal image ls [options]

Options:
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  -h, --help              Show this help`);
    return;
  }

  const { providerType } = getProvider(argv);

  if (providerType === "lima") {
    const result = Bun.spawnSync(
      ["limactl", "list", GOLDEN_NAME, "--json"],
      { stdout: "pipe", stderr: "pipe" }
    );

    const stdout = new TextDecoder().decode(result.stdout).trim();
    if (result.exitCode !== 0 || !stdout || !stdout.includes(GOLDEN_NAME)) {
      console.log("No golden image found. Run 'hal image build' to create one.");
      return;
    }

    console.log(pc.dim(`${"NAME".padEnd(24)} ${"STATUS".padEnd(12)} ${"ARCH".padEnd(8)} ${"CPUS".padEnd(6)} ${"MEMORY".padEnd(10)} DISK`));
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      try {
        const inst = JSON.parse(line);
        if (inst.name !== GOLDEN_NAME) continue;
        const memGb = (inst.memory / (1024 * 1024 * 1024)).toFixed(1);
        const diskGb = (inst.disk / (1024 * 1024 * 1024)).toFixed(0);
        console.log(
          `${inst.name.padEnd(24)} ${statusPad(inst.status, 12)} ${inst.arch.padEnd(8)} ${String(inst.cpus).padEnd(6)} ${(memGb + "GB").padEnd(10)} ${diskGb}GB`
        );
      } catch {
        continue;
      }
    }
  } else if (providerType === "digitalocean") {
    const { provider } = getProvider(argv);
    const snapshots = await provider.listSnapshots();
    const golden = snapshots.filter((s) => s.description.startsWith("hal9999-golden"));

    if (golden.length === 0) {
      console.log("No golden snapshots found. Run 'hal image build -p do' to create one.");
      return;
    }

    console.log(pc.dim(`${"ID".padEnd(16)} ${"NAME".padEnd(40)} ${"STATUS".padEnd(10)} ${"SIZE".padEnd(10)} CREATED`));
    for (const s of golden) {
      const sizeGb = (s.size / 1_000_000_000).toFixed(1);
      console.log(
        `${s.id.padEnd(16)} ${s.description.padEnd(40)} ${statusPad(s.status, 10)} ${(sizeGb + "GB").padEnd(10)} ${s.createdAt.split("T")[0]}`
      );
    }
  }
}

async function imageRm(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`hal image rm — remove a golden image

Usage:
  hal image rm [snapshot-id]        Remove golden image (ID required for DO)

Lima:
  Deletes the "${GOLDEN_NAME}" instance. No argument needed.

DigitalOcean:
  Deletes the snapshot by ID (use "hal image ls -p do" to find IDs).

Options:
  -p, --provider <name>   Provider: lima, do/digitalocean (default: lima)
  -h, --help              Show this help`);
    return;
  }

  const { providerType, rest } = getProvider(argv);

  if (providerType === "lima") {
    console.log(`Deleting ${GOLDEN_NAME}...`);
    // Stop first (ignore errors)
    Bun.spawnSync(["limactl", "stop", GOLDEN_NAME, "--tty=false"], { stdout: "pipe", stderr: "pipe" });
    const result = Bun.spawnSync(
      ["limactl", "delete", "--force", GOLDEN_NAME, "--tty=false"],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      if (stderr.includes("not found") || stderr.includes("does not exist")) {
        console.log("No golden image found.");
        return;
      }
      console.error(`Failed to delete: ${stderr}`);
      process.exit(1);
    }
    console.log("Done.");
  } else if (providerType === "digitalocean") {
    const snapshotId = rest[0];
    if (!snapshotId) {
      console.error("Error: snapshot ID required for DO. Use 'hal image ls -p do' to find IDs.");
      process.exit(1);
    }

    const { provider } = getProvider(argv);
    console.log(`Deleting snapshot ${snapshotId}...`);
    await provider.deleteSnapshot(snapshotId);
    console.log("Done.");
  }
}
