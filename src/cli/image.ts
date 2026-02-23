import pc from "picocolors";
import type { DigitalOceanProvider } from "../providers/digitalocean.ts";
import { sshExec, waitForSsh } from "../ssh.ts";
import { getProvider, statusPad } from "./ui.ts";
import { db } from "./context.ts";

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
  -p, --provider <name>   Provider: local (auto), lima, incus, do/digitalocean (default: local)
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

Incus:
  Creates a VM from images:debian/13, runs setup.sh via incus exec, publishes
  as hal9999-golden-image. Idempotent — destroys existing golden image first.

DigitalOcean:
  Creates a droplet from base OS, runs setup.sh, snapshots, destroys build droplet.
  Prints snapshot ID to set in .env as HAL_DO_SNAPSHOT_ID.

Options:
  -p, --provider <name>   Provider: local (auto), lima, incus, do/digitalocean (default: local)
  -h, --help              Show this help`);
    return;
  }

  const { providerType } = getProvider(argv);

  if (providerType === "lima") {
    await buildLimaGolden();
  } else if (providerType === "incus") {
    await buildIncusGolden();
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
    unregisterImage(GOLDEN_NAME);
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

  // Register in DB so reconcile knows this is an image, not an orphan VM
  registerImage(GOLDEN_NAME, "lima", GOLDEN_NAME);

  console.log(`\nGolden image "${GOLDEN_NAME}" ready.`);
  console.log("New VMs will automatically use clone-based fast boot.");
}

async function buildIncusGolden(): Promise<void> {
  const GOLDEN_IMAGE = "hal9999-golden-image";
  const BUILD_NAME = "hal9999-golden";

  // Auto-detect SSH public key
  const sshPubKeyPath =
    process.env.HAL_INCUS_SSH_PUB_KEY ??
    (await (async () => {
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      for (const name of ["id_ed25519.pub", "id_rsa.pub"]) {
        const p = join(homedir(), ".ssh", name);
        try {
          await Bun.file(p).text();
          return p;
        } catch {
          continue;
        }
      }
      return null;
    })());

  if (!sshPubKeyPath) {
    console.error("No SSH public key found. Set HAL_INCUS_SSH_PUB_KEY.");
    process.exit(1);
  }
  const sshPubKey = (await Bun.file(sshPubKeyPath).text()).trim();

  // 1. Delete existing golden image + build instance (idempotent)
  console.log(`Checking for existing ${GOLDEN_IMAGE}...`);
  let existing = Bun.spawnSync(
    ["incus", "image", "list", GOLDEN_IMAGE, "--format=json"],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (existing.exitCode === 0) {
    const stdout = new TextDecoder().decode(existing.stdout);
    try {
      const images = JSON.parse(stdout);
      if (Array.isArray(images) && images.length > 0) {
        console.log(`Deleting existing ${GOLDEN_IMAGE}...`);
        Bun.spawnSync(["incus", "image", "delete", GOLDEN_IMAGE], {
          stdout: "pipe",
          stderr: "pipe",
        });
      }
    } catch {}
  }

  // Clean up any leftover build instance
  const check = Bun.spawnSync(["incus", "list", BUILD_NAME, "--format=json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (check.exitCode === 0 && new TextDecoder().decode(check.stdout).includes(BUILD_NAME)) {
    console.log(`Cleaning up leftover ${BUILD_NAME}...`);
    Bun.spawnSync(["incus", "stop", BUILD_NAME, "--force"], { stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["incus", "delete", BUILD_NAME, "--force"], { stdout: "pipe", stderr: "pipe" });
  }

  // 2. Launch from base image
  console.log(`Launching ${BUILD_NAME} from images:debian/13...`);
  const launchResult = Bun.spawnSync(
    ["incus", "launch", "images:debian/13", BUILD_NAME, "--vm", "--config=limits.cpu=2", "--config=limits.memory=4GiB"],
    { stdout: "inherit", stderr: "inherit" }
  );
  if (launchResult.exitCode !== 0) {
    console.error(`Failed to launch ${BUILD_NAME}`);
    process.exit(1);
  }

  // 3. Wait for incus agent to be ready
  console.log("Waiting for VM agent to be ready...");
  const agentStart = Date.now();
  while (Date.now() - agentStart < 120_000) {
    const r = Bun.spawnSync(["incus", "exec", BUILD_NAME, "--", "echo", "ready"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode === 0 && new TextDecoder().decode(r.stdout).trim() === "ready") break;
    await new Promise((r) => setTimeout(r, 3_000));
  }

  // 4. Run setup.sh
  console.log("Running setup.sh...");
  const setupResult = Bun.spawnSync(
    ["incus", "exec", BUILD_NAME, "--", "bash", "-s"],
    {
      stdin: Bun.file("src/image/setup.sh"),
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  if (setupResult.exitCode !== 0) {
    console.error("setup.sh failed");
    // Cleanup on failure
    Bun.spawnSync(["incus", "stop", BUILD_NAME, "--force"], { stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["incus", "delete", BUILD_NAME, "--force"], { stdout: "pipe", stderr: "pipe" });
    process.exit(1);
  }

  // 5. Inject SSH public key
  console.log("Injecting SSH public key...");
  const sshResult = Bun.spawnSync(
    [
      "incus", "exec", BUILD_NAME, "--", "bash", "-c",
      `mkdir -p /home/agent/.ssh && echo '${sshPubKey}' >> /home/agent/.ssh/authorized_keys && chown -R agent:agent /home/agent/.ssh && chmod 700 /home/agent/.ssh && chmod 600 /home/agent/.ssh/authorized_keys`,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (sshResult.exitCode !== 0) {
    console.error(`SSH key injection failed: ${new TextDecoder().decode(sshResult.stderr)}`);
    Bun.spawnSync(["incus", "stop", BUILD_NAME, "--force"], { stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["incus", "delete", BUILD_NAME, "--force"], { stdout: "pipe", stderr: "pipe" });
    process.exit(1);
  }

  // 6. Stop
  console.log(`Stopping ${BUILD_NAME}...`);
  const stopResult = Bun.spawnSync(["incus", "stop", BUILD_NAME], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (stopResult.exitCode !== 0) {
    console.error(`Failed to stop ${BUILD_NAME}`);
    process.exit(1);
  }

  // 7. Publish as image
  console.log(`Publishing as ${GOLDEN_IMAGE}...`);
  const pubResult = Bun.spawnSync(
    ["incus", "publish", BUILD_NAME, "--alias", GOLDEN_IMAGE],
    { stdout: "inherit", stderr: "inherit" }
  );
  if (pubResult.exitCode !== 0) {
    console.error("Failed to publish image");
    process.exit(1);
  }

  // 8. Cleanup build instance
  console.log(`Cleaning up ${BUILD_NAME}...`);
  Bun.spawnSync(["incus", "delete", BUILD_NAME, "--force"], { stdout: "pipe", stderr: "pipe" });

  console.log(`\nGolden image "${GOLDEN_IMAGE}" ready.`);
  console.log("New VMs will automatically use this image.");
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
  -p, --provider <name>   Provider: local (auto), lima, incus, do/digitalocean (default: local)
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
  } else if (providerType === "incus") {
    const result = Bun.spawnSync(
      ["incus", "image", "list", "hal9999-golden-image", "--format=json"],
      { stdout: "pipe", stderr: "pipe" }
    );

    if (result.exitCode !== 0) {
      console.log("No golden image found. Run 'hal image build -p incus' to create one.");
      return;
    }

    let images: Array<{ fingerprint: string; aliases: Array<{ name: string }>; size: number; created_at: string }>;
    try {
      images = JSON.parse(new TextDecoder().decode(result.stdout));
    } catch {
      console.log("No golden image found. Run 'hal image build -p incus' to create one.");
      return;
    }

    const golden = images.filter((img) => img.aliases.some((a) => a.name.startsWith("hal9999-")));
    if (golden.length === 0) {
      console.log("No golden image found. Run 'hal image build -p incus' to create one.");
      return;
    }

    console.log(pc.dim(`${"ALIAS".padEnd(30)} ${"FINGERPRINT".padEnd(14)} ${"SIZE".padEnd(10)} CREATED`));
    for (const img of golden) {
      const alias = img.aliases[0]?.name ?? "—";
      const fp = img.fingerprint.slice(0, 12);
      const sizeGb = (img.size / 1_000_000_000).toFixed(1);
      console.log(
        `${alias.padEnd(30)} ${fp.padEnd(14)} ${(sizeGb + "GB").padEnd(10)} ${img.created_at.split("T")[0]}`
      );
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

Incus:
  Deletes the hal9999-golden-image published image. No argument needed.

DigitalOcean:
  Deletes the snapshot by ID (use "hal image ls -p do" to find IDs).

Options:
  -p, --provider <name>   Provider: local (auto), lima, incus, do/digitalocean (default: local)
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
    unregisterImage(GOLDEN_NAME);
    console.log("Done.");
  } else if (providerType === "incus") {
    const GOLDEN_IMAGE = "hal9999-golden-image";
    console.log(`Deleting ${GOLDEN_IMAGE}...`);
    const result = Bun.spawnSync(
      ["incus", "image", "delete", GOLDEN_IMAGE],
      { stdout: "pipe", stderr: "pipe" }
    );
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      if (stderr.includes("not found")) {
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

/** Register a golden image so reconcile knows it's not an orphaned VM */
function registerImage(id: string, provider: string, instanceId: string): void {
  const now = new Date().toISOString();
  db().run(
    `INSERT OR REPLACE INTO images (id, provider, instance_id, created_at) VALUES (?, ?, ?, ?)`,
    [id, provider, instanceId, now]
  );
}

/** Remove a golden image registration */
function unregisterImage(id: string): void {
  db().run(`DELETE FROM images WHERE id = ?`, [id]);
}
