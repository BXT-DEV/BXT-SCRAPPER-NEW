// ============================================================
// CSV Writer
// Writes results as semicolon-delimited CSV matching BecexTech format
// Output format: SKU;Product Name;link;link_round1;link_round2;...
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
 * Reads and parses the entire output CSV into a list of row objects.
 */
export async function readExistingCsv(outputPath: string): Promise<Record<string, string>[]> {
  if (!fs.existsSync(outputPath)) {
    return [];
  }
  return new Promise((resolve) => {
    const rows: Record<string, string>[] = [];
    fs.createReadStream(outputPath)
      .pipe(csvParser({ separator: ";" }))
      .on("data", (row: Record<string, string>) => {
        const cleanedRow: Record<string, string> = {};
        for (const key of Object.keys(row)) {
          const cleanKey = key.replace(/^\uFEFF/, "");
          cleanedRow[cleanKey] = row[key];
        }
        rows.push(cleanedRow);
      })
      .on("end", () => {
        resolve(rows);
      })
      .on("error", (error) => {
        logger.warn(`Could not read existing output: ${error.message}`);
        resolve([]);
      });
  });
}

/**
 * Determines the current active round based on environment or existing row data.
 */
export function getActiveRound(rows: Record<string, string>[]): number {
  if (process.env.SCRAPER_ROUND) {
    const r = parseInt(process.env.SCRAPER_ROUND, 10);
    if (!isNaN(r) && r > 0) return r;
  }
  if (process.env.ROUND) {
    const r = parseInt(process.env.ROUND, 10);
    if (!isNaN(r) && r > 0) return r;
  }

  if (rows.length === 0) {
    return 1;
  }

  const keys = Object.keys(rows[0]);
  const roundKeys = keys
    .filter((k) => k.startsWith("link_round"))
    .map((k) => {
      const num = parseInt(k.replace("link_round", ""), 10);
      return isNaN(num) ? 0 : num;
    })
    .filter((num) => num > 0);

  if (roundKeys.length === 0) {
    const hasAnyLink = rows.some((r) => r["link"] && r["link"].trim().length > 0);
    return hasAnyLink ? 2 : 1;
  }

  const maxRound = Math.max(...roundKeys);
  const matchedRows = rows.filter(
    (r) => r["status"] === "matched" || (r["link"] && r["link"].trim().length > 0)
  );

  if (matchedRows.length === 0) {
    return maxRound;
  }

  const allHaveMax = matchedRows.every(
    (r) => r[`link_round${maxRound}`] && r[`link_round${maxRound}`].trim().length > 0
  );

  return allHaveMax ? maxRound + 1 : maxRound;
}

/**
 * Load already-scraped SKUs for the active round from an existing output file (for resume support).
 */
export async function loadCompletedSkus(
  outputPath: string,
  activeRound: number
): Promise<Set<string>> {
  const completedSkus = new Set<string>();

  if (!fs.existsSync(outputPath)) {
    return completedSkus;
  }

  const rows = await readExistingCsv(outputPath);
  for (const row of rows) {
    const sku = (row["SKU"] || row["sku"] || "").trim();
    if (!sku) continue;

    const status = row["status"] || "";
    const hasRoundLink =
      row[`link_round${activeRound}`] && row[`link_round${activeRound}`].trim().length > 0;
    const hasBaseLink =
      activeRound === 1 && row["link"] && row["link"].trim().length > 0;

    if (status === "no_match" || status === "error" || hasRoundLink || hasBaseLink) {
      completedSkus.add(sku);
    }
  }

  if (completedSkus.size > 0) {
    logger.info(
      `Found ${completedSkus.size} already-processed SKUs for Round ${activeRound} (resume mode)`
    );
  }
  return completedSkus;
}

/**
 * Update/Append a result row in the semicolon-delimited output CSV.
 * Uses atomic file writing to prevent data corruption.
 */
export async function appendResultRow(
  outputPath: string,
  result: ScrapedResult,
  activeRound?: number,
  retries = -1 // -1 means infinite retries
): Promise<void> {
  try {
    const fileExists = fs.existsSync(outputPath);
    let rows: Record<string, string>[] = [];
    if (fileExists) {
      rows = await readExistingCsv(outputPath);
    }

    const round = activeRound ?? getActiveRound(rows);

    let existingRow = rows.find(
      (r) => (r["SKU"] || "").trim().toLowerCase() === result.sku.trim().toLowerCase()
    );

    const cleanPrice = result.amazonPrice !== null ? result.amazonPrice.toString() : "";

    if (existingRow) {
      existingRow["Product Name"] = result.productName;
      existingRow["link"] = result.amazonUrl;
      existingRow[`link_round${round}`] = result.amazonUrl;
      existingRow["amazon_price"] = cleanPrice;
      existingRow["amazon_title"] = result.amazonTitle;
      existingRow["match_confidence"] = result.matchConfidence.toString();
      existingRow["status"] = result.status;
      existingRow["error_message"] = result.errorMessage;
      existingRow["spec"] = result.spec || "";
      existingRow["condition"] = result.condition || "";
    } else {
      const newRow: Record<string, string> = {
        "SKU": result.sku,
        "Product Name": result.productName,
        "link": result.amazonUrl,
        [`link_round${round}`]: result.amazonUrl,
        "amazon_price": cleanPrice,
        "amazon_title": result.amazonTitle,
        "match_confidence": result.matchConfidence.toString(),
        "status": result.status,
        "error_message": result.errorMessage,
        "spec": result.spec || "",
        "condition": result.condition || "",
      };
      rows.push(newRow);
    }

    // Determine all round numbers that have columns in the rows
    const roundNums = new Set<number>();
    roundNums.add(round);
    for (const r of rows) {
      for (const key of Object.keys(r)) {
        if (key.startsWith("link_round")) {
          const num = parseInt(key.replace("link_round", ""), 10);
          if (!isNaN(num) && num > 0) {
            roundNums.add(num);
          }
        }
      }
    }

    const maxRound = Math.max(...roundNums);

    // Compile headers
    const headers = ["SKU", "Product Name", "link"];
    for (let r = 1; r <= maxRound; r++) {
      headers.push(`link_round${r}`);
    }
    headers.push("amazon_price", "amazon_title", "match_confidence", "status", "error_message", "spec", "condition");

    const escapeField = (val: string | number | null): string => {
      const str = String(val ?? "");
      if (str.includes(";") || str.includes("\"") || str.includes("\n")) {
        return `"${str.replace(/"/g, "\"\"")}"`;
      }
      return str;
    };

    const headerLine = headers.join(";");
    const dataLines = rows.map((r) => {
      return headers.map((h) => escapeField(r[h])).join(";");
    });

    const csvContent = [headerLine, ...dataLines].join("\n") + "\n";

    // Durability & Atomicity: Write to temporary file first, then atomically rename
    const tmpPath = `${outputPath}.tmp`;
    fs.writeFileSync(tmpPath, csvContent, "utf8");

    // Retry mechanism for rename to handle transient locks
    let renamed = false;
    let renameRetries = 50;
    while (!renamed && renameRetries > 0) {
      try {
        fs.renameSync(tmpPath, outputPath);
        renamed = true;
      } catch (err: any) {
        if (err.code === 'EPERM' || err.code === 'EBUSY') {
          renameRetries--;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } else {
          throw err;
        }
      }
    }
    if (!renamed) {
      throw new Error(`Failed to rename ${tmpPath} to ${outputPath} after retries.`);
    }
  } catch (error: any) {
    if ((error.code === 'EPERM' || error.code === 'EBUSY') && (retries === -1 || retries > 0)) {
      const remainingMessage = retries === -1 ? "indefinitely" : `${retries} attempts left`;
      logger.warn(`File locked (EPERM/EBUSY): ${outputPath}. Retrying in 5 seconds... (${remainingMessage})`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      return appendResultRow(outputPath, result, activeRound, retries === -1 ? -1 : retries - 1);
    }
    logger.error(`Failed to write to CSV: ${error.message}`);
    throw error;
  }
}
