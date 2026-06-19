// ============================================================
// Result Validator
// Validates scraped results against original product specs
// to catch obvious mismatches (wrong storage, duplicate URLs).
// ============================================================

import { extractSpecs } from "./product-utils.js";

// ── Storage ───────────────────────────────────────────────────

/**
 * Extracts the primary (largest) storage value from any text string.
 * Returns null if no storage found.
 * e.g. "MacBook Air (M1, 8GB RAM, 512GB)" → "512GB"
 *       "iPhone 12 Pro Max 128GB Silver"   → "128GB"
 */
export function getPrimaryStorage(text: string): string | null {
  const matches = text.match(/\b(\d+)\s*(GB|TB)\b/gi) || [];
  if (matches.length === 0) return null;

  let maxBytes = 0;
  let primary = "";
  for (const m of matches) {
    const match = m.match(/(\d+)\s*(GB|TB)/i);
    if (match) {
      const val = parseInt(match[1], 10);
      const unit = match[2].toUpperCase();
      const bytes = unit === "TB" ? val * 1024 : val;
      if (bytes > maxBytes) {
        maxBytes = bytes;
        primary = `${val}${unit}`;
      }
    }
  }
  return primary || null;
}

// ── Match Validation ──────────────────────────────────────────

export interface ValidationResult {
  isValid: boolean;
  reason?: string;
}

/**
 * Compares an original product name against a scraped title/document-title
 * to catch obvious spec mismatches.
 *
 * Rules:
 *  1. Storage: primary (largest) storage must be identical.
 *
 * Returns { isValid: true } whenever there is insufficient information to
 * compare (e.g. scraped title has no storage → guard is skipped, not failed).
 *
 * @param originalProductName  BecexTech product name, e.g. "Apple iPhone 12 Pro Max (512GB, Silver) - Excellent"
 * @param scrapedInfo          Reebelo document.title or page subtitle after variant selection
 */
export function validateProductMatch(
  originalProductName: string,
  scrapedInfo: string
): ValidationResult {
  if (!scrapedInfo || scrapedInfo.trim().length === 0) {
    return { isValid: true };
  }

  const expectedStorage = getPrimaryStorage(originalProductName);
  const scrapedStorage = getPrimaryStorage(scrapedInfo);

  // Only reject when both sides have explicit storage that disagrees
  if (expectedStorage && scrapedStorage) {
    const expected = expectedStorage.replace(/\s/g, "").toUpperCase();
    const scraped = scrapedStorage.replace(/\s/g, "").toUpperCase();
    if (expected !== scraped) {
      return {
        isValid: false,
        reason: `Storage mismatch: expected ${expectedStorage}, got ${scrapedStorage}`,
      };
    }
  }

  return { isValid: true };
}

// ── Duplicate URL detection (for post-processing) ─────────────

/**
 * Given an array of { sku, url, productName } rows, returns a Map
 * of url → [sku, …] for every URL that appears more than once.
 */
export function findDuplicateUrls(
  rows: Array<{ sku: string; url: string; productName: string }>
): Map<string, string[]> {
  const urlToSkus = new Map<string, string[]>();

  for (const { sku, url } of rows) {
    if (!url) continue;
    const list = urlToSkus.get(url) ?? [];
    list.push(sku);
    urlToSkus.set(url, list);
  }

  const duplicates = new Map<string, string[]>();
  for (const [url, skus] of urlToSkus) {
    if (skus.length > 1) duplicates.set(url, skus);
  }
  return duplicates;
}
