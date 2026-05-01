// ============================================================
// CSV Writer
// Writes results as semicolon-delimited CSV matching BecexTech format
// Output format: SKU;Product Name;link;price;...
// ============================================================

import fs from "fs";
import path from "path";
import csvParser from "csv-parser";
import type { ScrapedResult } from "../types/index.js";
import { logger } from "./logger.js";

/**
 * Get the output file path for today's results.
 */
export function getOutputFilePath(outputDir: string): string {
  const todayStamp = new Date().toISOString().slice(0, 10);
  const target = process.env.SCRAPER_TARGET || "results";
  return path.join(outputDir, `${target}_${todayStamp}.csv`);
}

/**
 * Load already-scraped SKUs from an existing output file (for resume support).
 */
export async function loadCompletedSkus(
  outputPath: string
): Promise<Set<string>> {
  const completedSkus = new Set<string>();

  if (!fs.existsSync(outputPath)) {
    return completedSkus;
  }

  return new Promise((resolve) => {
    fs.createReadStream(outputPath)
      .pipe(csvParser({ separator: ";" }))
      .on("data", (row: Record<string, string>) => {
        const sku = (row["SKU"] || row["sku"] || row["\uFEFFSKU"] || row["\uFEFFsku"] || "").trim();
        if (sku) {
          completedSkus.add(sku);
        }
      })
      .on("end", () => {
        if (completedSkus.size > 0) {
          logger.info(
            `Found ${completedSkus.size} already-scraped SKUs (resume mode)`
          );
        }
        resolve(completedSkus);
      })
      .on("error", (error) => {
        logger.warn(`Could not read existing output: ${error.message}`);
        resolve(completedSkus);
      });
  });
}

/**
 * Append a single result row to the semicolon-delimited output CSV.
 * Creates the file with headers if it doesn't exist yet.
 */
export async function appendResultRow(
  outputPath: string,
  result: ScrapedResult
): Promise<void> {
  const fileExists = fs.existsSync(outputPath);

  // Write header if file is new
  if (!fileExists) {
    fs.writeFileSync(
      outputPath,
      "SKU;Product Name;link;amazon_price;amazon_title;match_confidence;status;error_message\n"
    );
  }

  const escapeField = (val: string | number | null): string => {
    const str = String(val ?? "");
    if (str.includes(";") || str.includes("\"") || str.includes("\n")) {
      return `"${str.replace(/"/g, "\"\"")}"`;
    }
    return str;
  };

  const row = [
    result.sku,
    escapeField(result.productName),
    result.amazonUrl,
    result.amazonPrice || "",
    escapeField(result.amazonTitle),
    result.matchConfidence.toString(),
    result.status,
    escapeField(result.errorMessage),
  ].join(";");

  fs.appendFileSync(outputPath, row + "\n");
}
