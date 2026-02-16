import type { AgentConfig } from "./types.ts";

export function claudeAgent(opts: {
  oauthToken?: string;
  apiKey?: string;
}): AgentConfig {
  if (!opts.oauthToken && !opts.apiKey) {
    throw new Error("Claude agent requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY");
  }

  return {
    name: "claude",
    command: "claude -p {{context}} --dangerously-skip-permissions",
    env: opts.oauthToken
      ? { CLAUDE_CODE_OAUTH_TOKEN: opts.oauthToken }
      : { ANTHROPIC_API_KEY: opts.apiKey! },
  };
}

export function opencodeAgent(opts: {
  apiKey: string;
  provider?: string;
}): AgentConfig {
  return {
    name: "opencode",
    command: "opencode run --prompt {{context}}",
    env: {
      ANTHROPIC_API_KEY: opts.apiKey,
      ...(opts.provider ? { OPENCODE_PROVIDER: opts.provider } : {}),
    },
  };
}

export function gooseAgent(opts: {
  apiKey: string;
  provider?: string;
}): AgentConfig {
  return {
    name: "goose",
    command: "goose run --text {{context}}",
    env: {
      ANTHROPIC_API_KEY: opts.apiKey,
      ...(opts.provider ? { GOOSE_PROVIDER: opts.provider } : {}),
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
export function resolveAgent(
  agent: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): AgentConfig {
  switch (agent) {
    case "claude":
      return claudeAgent({
        oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
        apiKey: env.ANTHROPIC_API_KEY,
      });

    case "opencode":
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error("OpenCode agent requires ANTHROPIC_API_KEY");
      }
      return opencodeAgent({ apiKey: env.ANTHROPIC_API_KEY });

    case "goose":
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error("Goose agent requires ANTHROPIC_API_KEY");
      }
      return gooseAgent({ apiKey: env.ANTHROPIC_API_KEY });

    default:
      // Treat as a custom command string
      return customAgent({
        command: agent,
        env: buildEnvFromProcess(env),
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
  ];
  for (const key of keys) {
    if (env[key]) forwarded[key] = env[key];
  }
  return forwarded;
}
