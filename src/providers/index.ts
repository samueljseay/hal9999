import type { Provider } from "./types.ts";
import { DigitalOceanProvider } from "./digitalocean.ts";
import { LimaProvider } from "./lima.ts";
import { IncusProvider } from "./incus.ts";
import { getCredential } from "../auth/index.ts";

export type ProviderType = "digitalocean" | "lima" | "incus";

export function createProvider(
  type: ProviderType,
  config?: Record<string, string>
): Provider {
  switch (type) {
    case "digitalocean": {
      const apiKey = config?.apiKey ?? getCredential("DO_API_TOKEN");
      if (!apiKey) {
        throw new Error(
          `Missing API token. Set DO_API_TOKEN in .env, run "hal auth login", or pass config.apiKey`
        );
      }
      return new DigitalOceanProvider({ apiKey });
    }
    case "lima": {
      const templatePath = config?.templatePath ?? process.env.HAL_LIMA_TEMPLATE ?? "src/image/hal9999.yaml";
      return new LimaProvider({ templatePath });
    }
    case "incus": {
      return new IncusProvider({
        cpus: config?.cpus ? parseInt(config.cpus, 10) : (process.env.HAL_INCUS_CPUS ? parseInt(process.env.HAL_INCUS_CPUS, 10) : undefined),
        memory: config?.memory ?? process.env.HAL_INCUS_MEMORY,
        remote: config?.remote ?? process.env.HAL_INCUS_REMOTE,
        sshPubKeyPath: config?.sshPubKeyPath ?? process.env.HAL_INCUS_SSH_PUB_KEY,
      });
    }
    default:
      throw new Error(`Unknown provider: ${type}`);
  }
}

export type { Provider, Instance, Snapshot, CreateInstanceOptions } from "./types.ts";
