import { createInterface } from "node:readline";
import pc from "picocolors";
import { CREDENTIAL_KEYS, getStore, getCredentialStatuses } from "../auth/index.ts";
import type { CredentialKey } from "../auth/index.ts";

const TOKEN_HELP: Record<CredentialKey, { description: string; url: string; pattern?: RegExp; hint?: string }> = {
  GITHUB_TOKEN: {
    description: "GitHub personal access token (for repo cloning, PR creation)",
    url: "https://github.com/settings/tokens",
    pattern: /^(ghp_|gho_|github_pat_)/,
    hint: "should start with ghp_, gho_, or github_pat_",
  },
  CLAUDE_CODE_OAUTH_TOKEN: {
    description: "Claude Code OAuth token (for Claude agent)",
    url: "https://console.anthropic.com",
  },
  ANTHROPIC_API_KEY: {
    description: "Anthropic API key (for Claude/OpenCode/Goose agents)",
    url: "https://console.anthropic.com/settings/keys",
    pattern: /^sk-ant-/,
    hint: "should start with sk-ant-",
  },
  DO_API_TOKEN: {
    description: "DigitalOcean API token (for cloud VMs)",
    url: "https://cloud.digitalocean.com/account/api/tokens",
    pattern: /^dop_v1_/,
    hint: "should start with dop_v1_",
  },
  OPENAI_API_KEY: {
    description: "OpenAI API key (for OpenAI-based agents)",
    url: "https://platform.openai.com/api-keys",
    pattern: /^sk-/,
    hint: "should start with sk-",
  },
};

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

async function login(): Promise<void> {
  const store = getStore();
  console.log(`Credential backend: ${pc.cyan(store.name)}\n`);
  console.log("Enter credentials for each service. Press Enter to skip.\n");

  let stored = 0;

  for (const key of CREDENTIAL_KEYS) {
    const help = TOKEN_HELP[key];
    console.log(`${pc.bold(key)}`);
    console.log(`  ${help.description}`);
    console.log(`  ${pc.dim(help.url)}`);

    const value = await readHiddenInput(`  Token: `);

    if (!value) {
      console.log(pc.dim("  Skipped\n"));
      continue;
    }

    // Soft format validation
    if (help.pattern && !help.pattern.test(value)) {
      console.log(pc.yellow(`  Warning: ${help.hint}`));
    }

    store.set(key, value);
    console.log(pc.green(`  Stored in ${store.name}\n`));
    stored++;
  }

  if (stored > 0) {
    console.log(pc.green(`\nDone. ${stored} credential(s) stored.`));
  } else {
    console.log("\nNo credentials stored.");
  }
  console.log(`Run ${pc.cyan("hal auth status")} to verify.`);
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

  if (!sub || sub === "--help" || sub === "-h") {
    console.log(`hal auth — manage credentials

Usage:
  hal auth <command>

Commands:
  login                   Interactive credential setup
  logout                  Remove all stored credentials
  status                  Show configured credentials and their source
  set <KEY> <VALUE>       Store a single credential
  get <KEY>               Read a credential to stdout (respects precedence)

Keys: ${CREDENTIAL_KEYS.join(", ")}

Precedence: environment variables (.env) > credential store

Examples:
  hal auth login
  hal auth status
  hal auth set GITHUB_TOKEN ghp_abc123
  hal auth get GITHUB_TOKEN`);
    return;
  }

  switch (sub) {
    case "login":
      return login();
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
