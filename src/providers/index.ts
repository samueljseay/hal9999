import type { Provider } from "./types.ts";
import { DigitalOceanProvider } from "./digitalocean.ts";

export type ProviderType = "digitalocean";

const PROVIDER_ENV_KEYS: Record<ProviderType, string> = {
  digitalocean: "DO_API_TOKEN",
};

export function createProvider(
  type: ProviderType,
  config?: Record<string, string>
): Provider {
  switch (type) {
    case "digitalocean": {
      const apiKey = config?.apiKey ?? process.env[PROVIDER_ENV_KEYS[type]];
      if (!apiKey) {
        throw new Error(
          `Missing API token. Set ${PROVIDER_ENV_KEYS[type]} in .env or pass config.apiKey`
        );
      }
      return new DigitalOceanProvider({ apiKey });
    }
    default:
      throw new Error(`Unknown provider: ${type}`);
  }
}

export type { Provider, Instance, Snapshot, CreateInstanceOptions } from "./types.ts";
