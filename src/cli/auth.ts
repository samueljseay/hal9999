import { createInterface } from "node:readline";
import pc from "picocolors";
import { CREDENTIAL_KEYS, getStore, getCredentialStatuses } from "../auth/index.ts";
import type { CredentialKey } from "../auth/index.ts";

const TOKEN_META: Record<CredentialKey, { pattern?: RegExp; hint?: string }> = {
  GITHUB_TOKEN: {
    pattern: /^(ghp_|gho_|github_pat_)/,
    hint: "should start with ghp_, gho_, or github_pat_",
  },
  CLAUDE_CODE_OAUTH_TOKEN: {},
  ANTHROPIC_API_KEY: {
    pattern: /^sk-ant-/,
    hint: "should start with sk-ant-",
  },
  DO_API_TOKEN: {
    pattern: /^dop_v1_/,
    hint: "should start with dop_v1_",
  },
  OPENAI_API_KEY: {
    pattern: /^sk-/,
    hint: "should start with sk-",
  },
};

interface SetupStep {
  question: string;
  keys: { key: CredentialKey; label: string; url: string }[];
}

const SETUP_STEPS: SetupStep[] = [
  {
    question: "Do you want agents to push branches and create PRs?",
    keys: [{
      key: "GITHUB_TOKEN",
      label: "GitHub token (repo scope)",
      url: "https://github.com/settings/tokens/new?scopes=repo&description=hal9999",
    }],
  },
  {
    question: "Which AI agent will you use?",
    keys: [
      {
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        label: "Claude Code OAuth token (if using Claude with OAuth)",
        url: "Run `claude` locally once to authenticate, then find the token in ~/.claude/.credentials.json",
      },
      {
        key: "ANTHROPIC_API_KEY",
        label: "Anthropic API key (if using an API key instead)",
        url: "https://console.anthropic.com/settings/keys",
      },
    ],
  },
  {
    question: "Do you want to run VMs on DigitalOcean?",
    keys: [{
      key: "DO_API_TOKEN",
      label: "DigitalOcean API token",
      url: "https://cloud.digitalocean.com/account/api/tokens",
    }],
  },
];

async function readHiddenInput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    // Disable echo
    if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(false);
    }

    // Write prompt manually to stderr so it shows even with hidden input
    process.stderr.write(prompt);

    // Use a raw approach: read line with output muted
    const originalWrite = process.stderr.write.bind(process.stderr);
    rl.output!.write = () => true; // suppress echo

    rl.question("", (answer) => {
      rl.output!.write = originalWrite; // restore
      process.stderr.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function setup(): Promise<void> {
  const store = getStore();
  const statuses = getCredentialStatuses();
  const isSet = (key: CredentialKey) => statuses.find((s) => s.key === key)?.source !== "not set";

  console.log(pc.bold("\nHAL9999 Setup\n"));

  let stored = 0;

  for (const step of SETUP_STEPS) {
    // Check if all keys in this step are already configured
    const missing = step.keys.filter((k) => !isSet(k.key));
    if (missing.length === 0) {
      const names = step.keys.map((k) => k.key).join(", ");
      console.log(`${pc.green("✓")} ${step.question} ${pc.dim(`(${names} already set)`)}`);
      continue;
    }

    const answer = await readLine(`${step.question} ${pc.dim("[Y/n]")} `);
    if (answer.toLowerCase() === "n") {
      console.log(pc.dim("  Skipped\n"));
      continue;
    }

    for (const { key, label, url } of missing) {
      console.log(`\n  ${pc.bold(label)}`);
      console.log(`  ${pc.dim(url)}\n`);

      const value = await readHiddenInput(`  Paste token: `);
      if (!value) {
        console.log(pc.dim("  Skipped"));
        continue;
      }

      const meta = TOKEN_META[key];
      if (meta.pattern && !meta.pattern.test(value)) {
        console.log(pc.yellow(`  Warning: ${meta.hint}`));
      }

      store.set(key, value);
      console.log(pc.green(`  Saved to ${store.name}`));
      stored++;
    }
    console.log();
  }

  // Summary
  console.log(pc.bold("─".repeat(40)));
  if (stored > 0) {
    console.log(pc.green(`${stored} credential(s) saved.\n`));
  }
  status();
  console.log();
}

function logout(): void {
  const store = getStore();
  for (const key of CREDENTIAL_KEYS) {
    store.delete(key);
  }
  console.log(`All credentials removed from ${store.name}.`);
}

function status(): void {
  const store = getStore();
  const statuses = getCredentialStatuses();

  console.log(`Backend: ${pc.cyan(store.name)}\n`);

  const keyWidth = Math.max(...CREDENTIAL_KEYS.map((k) => k.length)) + 2;

  for (const { key, source } of statuses) {
    const label = key.padEnd(keyWidth);
    switch (source) {
      case "env":
        console.log(`  ${label} ${pc.green("set")} ${pc.dim("(via env)")}`);
        break;
      case "store":
        console.log(`  ${label} ${pc.green("set")} ${pc.dim(`(via ${store.name.toLowerCase()})`)}`);
        break;
      case "not set":
        console.log(`  ${label} ${pc.dim("not set")}`);
        break;
    }
  }
}

function setCredential(key: string, value: string): void {
  if (!CREDENTIAL_KEYS.includes(key as CredentialKey)) {
    console.error(`Unknown credential key: ${key}`);
    console.error(`Valid keys: ${CREDENTIAL_KEYS.join(", ")}`);
    process.exit(1);
  }

  const store = getStore();
  store.set(key as CredentialKey, value);
  console.log(`${key} stored in ${store.name}.`);
}

function getCredentialCmd(key: string): void {
  if (!CREDENTIAL_KEYS.includes(key as CredentialKey)) {
    console.error(`Unknown credential key: ${key}`);
    console.error(`Valid keys: ${CREDENTIAL_KEYS.join(", ")}`);
    process.exit(1);
  }

  // Respect precedence: env > store
  const envValue = process.env[key];
  if (envValue) {
    process.stdout.write(envValue);
    return;
  }

  const store = getStore();
  const value = store.get(key as CredentialKey);
  if (value) {
    process.stdout.write(value);
  } else {
    process.exit(1);
  }
}

export async function authCommand(argv: string[]): Promise<void> {
  const sub = argv[0];

  if (sub === "--help" || sub === "-h") {
    console.log(`hal auth — manage credentials

Usage:
  hal auth                          Guided setup (skips what's already set)
  hal auth status                   Show configured credentials and their source
  hal auth set <KEY> <VALUE>        Store a single credential
  hal auth get <KEY>                Read a credential to stdout
  hal auth logout                   Remove all stored credentials

Keys: ${CREDENTIAL_KEYS.join(", ")}

Precedence: environment variables (.env) > credential store

Examples:
  hal auth
  hal auth status
  hal auth set GITHUB_TOKEN ghp_abc123`);
    return;
  }

  switch (sub) {
    case undefined:
    case "login":
      return setup();
    case "logout":
      return void logout();
    case "status":
      return void status();
    case "set": {
      const key = argv[1];
      const value = argv[2];
      if (!key || !value) {
        console.error("Usage: hal auth set <KEY> <VALUE>");
        process.exit(1);
      }
      return void setCredential(key, value);
    }
    case "get": {
      const key = argv[1];
      if (!key) {
        console.error("Usage: hal auth get <KEY>");
        process.exit(1);
      }
      return void getCredentialCmd(key);
    }
    default:
      console.error(`Unknown auth command: ${sub}`);
      console.log("Available: login, logout, status, set, get");
      process.exit(1);
  }
}
