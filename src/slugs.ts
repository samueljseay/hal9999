/**
 * Memorable slug generator for task IDs.
 * Format: adjective-noun (e.g., "orbital-signal", "rogue-beacon")
 * Themed around space, AI, and the HAL concept.
 */

const ADJECTIVES = [
  "astral", "binary", "cold", "cosmic", "covert", "crimson", "dark",
  "deep", "dormant", "dual", "faint", "fatal", "final", "frozen",
  "ghost", "hidden", "hollow", "hyper", "inner", "iron", "latent",
  "linear", "lone", "lost", "low", "lunar", "muted", "neural",
  "null", "outer", "pale", "primal", "prime", "quiet", "rapid",
  "rogue", "sharp", "silent", "slim", "solar", "solid", "spare",
  "stark", "static", "steady", "steep", "stern", "stray", "sub",
  "swift", "thermal", "tight", "twin", "ultra", "upper", "vast",
  "vivid", "void", "warp", "zero",
];

const NOUNS = [
  "arc", "array", "beacon", "bolt", "cache", "cell", "cipher",
  "circuit", "coil", "core", "cycle", "daemon", "deck", "depot",
  "drift", "drone", "epoch", "fault", "field", "flare", "flux",
  "forge", "gate", "grid", "hatch", "helix", "hub", "hull", "index",
  "latch", "lens", "link", "lock", "loop", "mesh", "mode", "nerve",
  "nexus", "node", "notch", "null", "orbit", "panel", "patch",
  "path", "phase", "ping", "pivot", "plume", "pod", "port", "probe",
  "pulse", "rack", "relay", "rift", "ring", "rover", "scan", "scope",
  "shaft", "shell", "shift", "silo", "signal", "slot", "socket",
  "span", "spark", "spike", "stack", "surge", "sync", "trace",
  "valve", "vault", "vector", "vent", "volt", "wire",
];

/** Generate a random adjective-noun slug */
export function generateSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
  return `${adj}-${noun}`;
}

/**
 * Generate a slug that's unique within the tasks table.
 * Retries with different combos if there's a collision.
 */
export function generateUniqueSlug(db: { query: Function }): string {
  for (let i = 0; i < 10; i++) {
    const slug = generateSlug();
    const existing = (db as any)
      .query(`SELECT 1 FROM tasks WHERE slug = ?`)
      .get(slug);
    if (!existing) return slug;
  }
  // Extremely unlikely fallback: append random suffix
  return `${generateSlug()}-${Math.floor(Math.random() * 1000)}`;
}
