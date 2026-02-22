import type { AgentConfig } from "./types.ts";
import { getCredentialEnv } from "../auth/index.ts";

export function claudeAgent(opts: {
  oauthToken?: string;
  apiKey?: string;
  githubToken?: string;
}): AgentConfig {
  if (!opts.oauthToken && !opts.apiKey) {
    throw new Error("Claude agent requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY");
  }

  return {
    name: "claude",
    command: "claude -p {{context}} --dangerously-skip-permissions",
    install: "command -v claude > /dev/null || curl -fsSL https://claude.ai/install.sh | bash",
    env: {
      ...(opts.oauthToken
        ? { CLAUDE_CODE_OAUTH_TOKEN: opts.oauthToken }
        : { ANTHROPIC_API_KEY: opts.apiKey! }),
      ...(opts.githubToken ? { GITHUB_TOKEN: opts.githubToken } : {}),
    },
  };
}

export function opencodeAgent(opts: {
  apiKey: string;
  provider?: string;
  githubToken?: string;
}): AgentConfig {
  return {
    name: "opencode",
    command: "opencode run --prompt {{context}}",
    install: "command -v opencode > /dev/null || curl -fsSL https://opencode.ai/install | bash",
    env: {
      ANTHROPIC_API_KEY: opts.apiKey,
      ...(opts.provider ? { OPENCODE_PROVIDER: opts.provider } : {}),
      ...(opts.githubToken ? { GITHUB_TOKEN: opts.githubToken } : {}),
    },
  };
}

export function gooseAgent(opts: {
  apiKey?: string;
  oauthToken?: string;
  provider?: string;
  githubToken?: string;
}): AgentConfig {
  const provider = opts.provider ?? (opts.oauthToken ? "claude-code" : "anthropic");
  const useClaude = provider === "claude-code";

  const gooseInstall = "command -v goose > /dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq libxcb1 && curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash)";
  const claudeInstall = "command -v claude > /dev/null || curl -fsSL https://claude.ai/install.sh | bash";

  return {
    name: "goose",
    command: useClaude
      ? "goose run --no-session --provider claude-code --model claude-sonnet-4-5 --text {{context}}"
      : "goose run --no-session --provider anthropic --model claude-sonnet-4-5 --text {{context}}",
    install: useClaude
      ? `${gooseInstall} && ${claudeInstall}`
      : gooseInstall,
    env: {
      ...(useClaude
        ? { CLAUDE_CODE_OAUTH_TOKEN: opts.oauthToken! }
        : { ANTHROPIC_API_KEY: opts.apiKey! }),
      ...(opts.githubToken ? { GITHUB_TOKEN: opts.githubToken } : {}),
    },
  };
}

export function customAgent(opts: {
  command: string;
  env?: Record<string, string>;
  name?: string;
}): AgentConfig {
  if (!opts.command.includes("{{context}}")) {
    throw new Error("Custom agent command must include {{context}} placeholder");
  }

  return {
    name: opts.name ?? "custom",
    command: opts.command,
    env: opts.env,
  };
}

/** Resolve an agent name or command string into an AgentConfig */
export async function resolveAgent(
  agent: string,
  env?: Record<string, string | undefined>
): Promise<AgentConfig> {
  const resolvedEnv = env ?? { ...getCredentialEnv(), ...process.env as Record<string, string | undefined> };
  const githubToken = resolvedEnv.GITHUB_TOKEN;

  switch (agent) {
    case "claude":
      return claudeAgent({
        oauthToken: resolvedEnv.CLAUDE_CODE_OAUTH_TOKEN,
        apiKey: resolvedEnv.ANTHROPIC_API_KEY,
        githubToken,
      });

    case "opencode":
      if (!resolvedEnv.ANTHROPIC_API_KEY) {
        throw new Error("OpenCode agent requires ANTHROPIC_API_KEY");
      }
      return opencodeAgent({ apiKey: resolvedEnv.ANTHROPIC_API_KEY, githubToken });

    case "goose":
      if (!resolvedEnv.ANTHROPIC_API_KEY && !resolvedEnv.CLAUDE_CODE_OAUTH_TOKEN) {
        throw new Error("Goose agent requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN");
      }
      return gooseAgent({
        apiKey: resolvedEnv.ANTHROPIC_API_KEY,
        oauthToken: resolvedEnv.CLAUDE_CODE_OAUTH_TOKEN,
        githubToken,
      });

    default:
      // Treat as a custom command string
      return customAgent({
        command: agent,
        env: buildEnvFromProcess(resolvedEnv),
      });
  }
}

/** Forward common API keys from the host environment */
function buildEnvFromProcess(
  env: Record<string, string | undefined>
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  const keys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GITHUB_TOKEN",
  ];
  for (const key of keys) {
    if (env[key]) forwarded[key] = env[key];
  }
  return forwarded;
}
