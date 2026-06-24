// ============================================================
// Result Validator Service
// Opens each scraped URL in Playwright and checks if the live
// page title still matches the recorded product name.
// ============================================================

import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import * as xlsx from "xlsx";
import { readFileSync } from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { GeminiMatcherService } from "./gemini-matcher.service.js";

// ── Types ────────────────────────────────────────────────────

export type ValidationStatus = "VALID" | "MISMATCH" | "ERROR" | "SKIPPED";

export interface ValidationRow {
  rowIndex: number;
  sourceName: string;
  matchedTitle: string;
  url: string;
  store: string;
}

export interface ValidationResult extends ValidationRow {
  status: ValidationStatus;
  liveTitle: string;
  reason: string;
  checkedAt: string;
}

export interface ValidationProgress {
  state: "idle" | "running" | "done" | "stopped";
  total: number;
  checked: number;
  valid: number;
  mismatch: number;
  error: number;
  results: ValidationResult[];
  startedAt: string | null;
  finishedAt: string | null;
}

// ── Column name auto-detection helpers ───────────────────────

const COLUMN_ALIASES = {
  sourceName: [
    "Product Name",
    "BXT Product Name",
    "Source Name",
    "Source",
    "ProductName",
    "product_name",
  ],
  matchedTitle: [
    "Matched Title",
    "Title",
    "Competitor Title",
    "Matched Product Name",
    "Result Title",
    "MatchedTitle",
  ],
  url: [
    "Matched URL",
    "URL",
    "Competitor URL",
    "Link",
    "Product URL",
    "MatchedURL",
    "matched_url",
  ],
  store: [
    "Source",
    "Store",
    "Competitor",
    "Target",
    "site",
  ],
};

function resolveColumn(row: Record<string, unknown>, aliases: string[]): string {
  for (const alias of aliases) {
    if (row[alias] !== undefined && String(row[alias]).trim() !== "") {
      return String(row[alias]).trim();
    }
  }
  return "";
}

// ── Parse xlsx ───────────────────────────────────────────────

export function parseXlsxRows(filePath: string): ValidationRow[] {
  const buffer = readFileSync(filePath);
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows: Record<string, unknown>[] = xlsx.utils.sheet_to_json(sheet, { defval: "" });

  const rows: ValidationRow[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const raw = rawRows[i];
    const url = resolveColumn(raw, COLUMN_ALIASES.url);

    // Skip rows without a URL — nothing to validate
    if (!url || !url.startsWith("http")) continue;

    rows.push({
      rowIndex: i + 2, // 1-indexed + header row
      sourceName: resolveColumn(raw, COLUMN_ALIASES.sourceName),
      matchedTitle: resolveColumn(raw, COLUMN_ALIASES.matchedTitle),
      url,
      store: resolveColumn(raw, COLUMN_ALIASES.store),
    });
  }

  return rows;
}

// ── Live page title extraction ────────────────────────────────

/**
 * Navigates to a URL and extracts the most prominent product title.
 * Tries <h1> first, falls back to <title>.
 */
async function fetchLiveTitle(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Small wait for JS-rendered titles
  await page.waitForTimeout(2000);

  const liveTitle = await page.evaluate((): string => {
    const h1 = document.querySelector("h1");
    if (h1 && h1.textContent?.trim()) return h1.textContent.trim();
    return document.title.trim();
  });

  return liveTitle;
}

// ── Main Service ─────────────────────────────────────────────

export class ResultValidatorService {
  private progress: ValidationProgress = {
    state: "idle",
    total: 0,
    checked: 0,
    valid: 0,
    mismatch: 0,
    error: 0,
    results: [],
    startedAt: null,
    finishedAt: null,
  };

  private stopRequested = false;

  // Dummy matcher — we only use the local verifyMatchConsistency (no Gemini calls)
  private readonly matcher = new GeminiMatcherService(["dummy"], "MAPPING BRAND NEW", "reebelo");

  getProgress(): ValidationProgress {
    return { ...this.progress, results: [...this.progress.results] };
  }

  stop(): void {
    this.stopRequested = true;
  }

  /**
   * Runs validation for all rows. Designed to run in background (not awaited
   * by the HTTP server). Progress is tracked via `this.progress`.
   */
  async run(rows: ValidationRow[], concurrency = 3): Promise<void> {
    this.stopRequested = false;
    this.progress = {
      state: "running",
      total: rows.length,
      checked: 0,
      valid: 0,
      mismatch: 0,
      error: 0,
      results: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };

    let browser: Browser | null = null;

    try {
      browser = await chromium.launch({ headless: true });

      // Process rows with limited concurrency using a queue
      const queue = [...rows];
      const activeWorkers: Promise<void>[] = [];

      const spawnWorker = (): Promise<void> => {
        const row = queue.shift();
        if (!row) return Promise.resolve();

        return (async () => {
          if (this.stopRequested) return;

          let context: BrowserContext | null = null;
          let result: ValidationResult;

          try {
            context = await browser!.newContext({
              userAgent:
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            });
            const page = await context.newPage();

            const liveTitle = await fetchLiveTitle(page, row.url);

            // Use local matcher for fast, offline verification
            const { passed, reason } = this.matcher.verifyMatchConsistency(
              row.sourceName,
              liveTitle
            );

            result = {
              ...row,
              status: passed ? "VALID" : "MISMATCH",
              liveTitle,
              reason,
              checkedAt: new Date().toISOString(),
            };
          } catch (e) {
            result = {
              ...row,
              status: "ERROR",
              liveTitle: "",
              reason: (e as Error).message,
              checkedAt: new Date().toISOString(),
            };
          } finally {
            if (context) {
              try { await context.close(); } catch { /* ignore */ }
            }
          }

          // Update shared progress (single-threaded JS — no race condition)
          this.progress.checked++;
          this.progress.results.push(result);
          if (result.status === "VALID") this.progress.valid++;
          else if (result.status === "MISMATCH") this.progress.mismatch++;
          else this.progress.error++;

          logger.info(
            `[Validator] [${result.status}] Row ${result.rowIndex}: ${result.sourceName.substring(0, 60)}`
          );
        })();
      };

      // Seed initial workers
      for (let i = 0; i < Math.min(concurrency, rows.length); i++) {
        activeWorkers.push(
          (async () => {
            while (queue.length > 0 && !this.stopRequested) {
              await spawnWorker();
            }
          })()
        );
      }

      await Promise.all(activeWorkers);
    } catch (e) {
      logger.error(`[Validator] Fatal error: ${(e as Error).message}`);
    } finally {
      if (browser) {
        try { await browser.close(); } catch { /* ignore */ }
      }
      this.progress.state = this.stopRequested ? "stopped" : "done";
      this.progress.finishedAt = new Date().toISOString();
    }
  }
}
