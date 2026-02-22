import pc from "picocolors";
import { createProvider, type ProviderType } from "../providers/index.ts";
import { normalizeProvider, defaultProvider } from "./context.ts";

// ── HAL 9000 spinner — throbbing mechanical eye ─────────────────────

// Constant dim-red housing ( ), inner ● pulses brightness independently
// 16-frame ramp: dark → bright → dark, ~2.4s per cycle
const RING_COLOR = 88;
const THROB = [52, 52, 88, 88, 124, 124, 160, 196, 196, 160, 124, 124, 88, 88, 52, 52];
const INTERVAL = 150;

export interface Spinner {
  update(msg: string): void;
  stop(msg?: string): void;
}

export function hal(msg: string): Spinner {
  let frame = 0;
  let text = msg;

  const render = () => {
    const inner = THROB[frame % THROB.length]!;
    const eye = `\x1b[38;5;${RING_COLOR}m(\x1b[38;5;${inner}m●\x1b[38;5;${RING_COLOR}m)\x1b[0m`;
    process.stderr.write(`\r\x1b[K${eye} ${text}`);
    frame++;
  };

  const timer = setInterval(render, INTERVAL);
  render();
  let stopped = false;

  return {
    update(m: string) {
      text = m;
    },
    stop(m?: string) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.stderr.write("\r\x1b[K");
      if (m) process.stderr.write(`${m}\n`);
    },
  };
}

// ── getProvider ─────────────────────────────────────────────────────

export function getProvider(argv: string[]): {
  provider: ReturnType<typeof createProvider>;
  providerType: ProviderType;
  rest: string[];
} {
  let providerType: ProviderType = defaultProvider();
  const rest = [...argv];

  const providerIdx = argv.indexOf("--provider");
  if (providerIdx !== -1 && argv[providerIdx + 1]) {
    providerType = normalizeProvider(argv[providerIdx + 1]!);
    rest.splice(providerIdx, 2);
  } else {
    const shortIdx = argv.indexOf("-p");
    if (shortIdx !== -1 && argv[shortIdx + 1]) {
      providerType = normalizeProvider(argv[shortIdx + 1]!);
      rest.splice(shortIdx, 2);
    }
  }

  return { provider: createProvider(providerType), providerType, rest };
}

// ── Status colors ───────────────────────────────────────────────────

export function statusColor(status: string): string {
  switch (status) {
    case "completed":
    case "ready":
    case "active":
      return pc.green(status);
    case "failed":
    case "error":
      return pc.red(status);
    case "running":
    case "assigned":
    case "provisioning":
    case "pending":
      return pc.yellow(status);
    case "stopped":
    case "destroyed":
    case "destroying":
      return pc.dim(status);
    default:
      return status;
  }
}

/** Pad status to width, then colorize — works in both TTY and non-TTY */
export function statusPad(status: string, width: number): string {
  return statusColor(status.padEnd(width));
}
