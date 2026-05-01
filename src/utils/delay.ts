// ============================================================
// Random Delay Utility
// Prevents detection by randomizing wait times between requests
// ============================================================

/**
 * Sleep for a random duration between minMs and maxMs.
 * Logs the chosen delay for debugging.
 */
export async function randomDelay(
  minMs: number,
  maxMs: number
): Promise<number> {
  const delayMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return delayMs;
}
