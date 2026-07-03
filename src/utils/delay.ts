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
  const multiplierStr = process.env.DELAY_MULTIPLIER;
  const multiplier = multiplierStr ? parseFloat(multiplierStr) : 1.0;
  const scaledMin = Math.max(100, minMs * multiplier);
  const scaledMax = Math.max(scaledMin, maxMs * multiplier);
  
  const delayMs = Math.floor(Math.random() * (scaledMax - scaledMin + 1)) + scaledMin;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return delayMs;
}
