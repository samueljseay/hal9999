import type { Provider } from "./types.ts";
import { DigitalOceanProvider } from "./digitalocean.ts";
import { LimaProvider } from "./lima.ts";
import { getCredential } from "../auth/index.ts";

export type ProviderType = "digitalocean" | "lima";

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
    default:
      throw new Error(`Unknown provider: ${type}`);
  }
}

export type { Provider, Instance, Snapshot, CreateInstanceOptions } from "./types.ts";
