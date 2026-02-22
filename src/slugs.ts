/**
 * Memorable slug generator for task IDs.
 * Format: adjective-noun (e.g., "bold-falcon", "calm-river")
 */

const ADJECTIVES = [
  "bold", "brave", "bright", "calm", "clear", "cool", "crisp", "dark",
  "deep", "dry", "fair", "fast", "firm", "flat", "free", "fresh",
  "full", "glad", "gold", "grand", "green", "grey", "grim", "keen",
  "kind", "late", "lean", "light", "live", "long", "loud", "mild",
  "neat", "new", "odd", "old", "pale", "pink", "plain", "proud",
  "pure", "quick", "rare", "raw", "red", "rich", "ripe", "rough",
  "rust", "safe", "sharp", "shy", "slim", "slow", "soft", "sour",
  "stark", "still", "stone", "strong", "swift", "tall", "tame",
  "thin", "true", "vast", "vivid", "warm", "wet", "wide", "wild",
];

const NOUNS = [
  "ant", "ash", "bay", "bee", "birch", "bloom", "bolt", "brook",
  "cliff", "cloud", "coral", "crane", "creek", "crow", "dawn",
  "dew", "dove", "drift", "dune", "dust", "eagle", "elm", "ember",
  "fern", "finch", "flint", "flux", "fog", "forge", "fox", "frost",
  "gale", "gem", "glen", "grove", "gust", "hawk", "haze", "heron",
  "hill", "ivy", "jade", "jay", "lake", "lark", "leaf", "lynx",
  "marsh", "mist", "moss", "moth", "oak", "onyx", "orca", "owl",
  "palm", "peak", "pine", "plum", "pond", "quail", "rain", "reed",
  "ridge", "river", "robin", "root", "sage", "sand", "seal", "shade",
  "shoal", "slate", "snow", "spark", "spruce", "star", "steel",
  "stone", "storm", "stork", "thorn", "tide", "torch", "trail",
  "vale", "vine", "wave", "wren", "yew",
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
