#!/usr/bin/env tsx
// ============================================================
// check-results  —  Post-processing validation script
//
// Usage:
//   npx tsx src/scripts/check-results.ts [path-to-csv]
//
// If no path is given it scans the ./output directory for the
// most recently modified CSV file.
//
// Checks performed:
//   1. Storage mismatch  — scraped title has a different storage
//      than the original product name (e.g. 128 GB vs 512 GB).
//   2. Color mismatch    — scraped title shows an obviously
//      different color than the original product.
//   3. Duplicate URLs    — two or more BecexTech SKUs share the
//      same Reebelo URL (indicates condition selection failed).
//
// Output:
//   • Console summary with counts and examples
//   • A new file  <original-name>.checked.csv  with extra
//     validation columns appended to every row
// ============================================================

import fs from "fs";
import path from "path";
import csvParser from "csv-parser";
import { getPrimaryStorage, findDuplicateUrls } from "../utils/result-validator.js";
import { extractSpecs } from "../utils/product-utils.js";

// ── CSV helpers ───────────────────────────────────────────────

async function readCsv(filePath: string): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, string>[] = [];
    fs.createReadStream(filePath)
      .pipe(csvParser({ separator: ";" }))
      .on("data", (row: Record<string, string>) => {
        // Strip BOM from first column key
        const clean: Record<string, string> = {};
        for (const k of Object.keys(row)) {
          clean[k.replace(/^\uFEFF/, "")] = row[k];
        }
        rows.push(clean);
      })
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

function writeCsv(filePath: string, rows: Record<string, string>[]): void {
  if (rows.length === 0) return;

  const allKeys = new Set<string>();
  for (const r of rows) Object.keys(r).forEach((k) => allKeys.add(k));
  const headers = Array.from(allKeys);

  const escape = (v: string | undefined): string => {
    const s = v ?? "";
    if (s.includes(";") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines = [
    headers.join(";"),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(";")),
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

// ── Find latest CSV in output dir ────────────────────────────

function findLatestCsv(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".csv") && !f.endsWith(".checked.csv"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].f) : null;
}

// ── Validation helpers ────────────────────────────────────────

type ValidationStatus = "ok" | "storage_mismatch" | "color_mismatch" | "duplicate_url" | "multiple_issues";

function validateRow(
  productName: string,
  amazonTitle: string
): { status: ValidationStatus; reason: string; expectedStorage: string; scrapedStorage: string; expectedColor: string; scrapedColor: string } {
  const issues: string[] = [];

  // Storage
  const expectedStorage = getPrimaryStorage(productName) ?? "";
  const scrapedStorage  = getPrimaryStorage(amazonTitle)  ?? "";
  if (expectedStorage && scrapedStorage) {
    const a = expectedStorage.replace(/\s/g, "").toUpperCase();
    const b = scrapedStorage.replace(/\s/g, "").toUpperCase();
    if (a !== b) issues.push(`Storage: expected ${expectedStorage}, got ${scrapedStorage}`);
  }

  // Color — compare loosely (one must include the other)
  const expectedColors = extractSpecs(productName).colors;
  const scrapedColors  = extractSpecs(amazonTitle).colors;
  const expectedColor  = expectedColors[0] ?? "";
  const scrapedColor   = scrapedColors[0]  ?? "";
  if (expectedColor && scrapedColor) {
    const ec = expectedColor.toLowerCase();
    const sc = scrapedColor.toLowerCase();
    if (!ec.includes(sc) && !sc.includes(ec)) {
      issues.push(`Color: expected ${expectedColor}, got ${scrapedColor}`);
    }
  }

  if (issues.length === 0) return { status: "ok", reason: "", expectedStorage, scrapedStorage, expectedColor, scrapedColor };
  if (issues.length === 1) {
    const status: ValidationStatus = issues[0].startsWith("Storage") ? "storage_mismatch" : "color_mismatch";
    return { status, reason: issues[0], expectedStorage, scrapedStorage, expectedColor, scrapedColor };
  }
  return { status: "multiple_issues", reason: issues.join(" | "), expectedStorage, scrapedStorage, expectedColor, scrapedColor };
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  // 1. Resolve CSV path
  let csvPath = process.argv[2];
  if (!csvPath) {
    const guesses = ["./output", "."];
    for (const dir of guesses) {
      const found = findLatestCsv(dir);
      if (found) { csvPath = found; break; }
    }
  }
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error("Usage: npx tsx src/scripts/check-results.ts <path-to-csv>");
    console.error("       (or run from project root — it will auto-detect the latest output CSV)");
    process.exit(1);
  }

  console.log(`\n📂 Reading: ${csvPath}`);
  const rows = await readCsv(csvPath);
  console.log(`   ${rows.length} total rows\n`);

  // 2. Filter to matched rows only
  const matched = rows.filter((r) => (r["status"] || "").trim() === "matched");
  console.log(`✅ Matched rows: ${matched.length}`);

  // 3. Per-row validation
  let storageMismatch = 0;
  let colorMismatch   = 0;
  let multiIssues     = 0;
  let okCount         = 0;

  const enriched: Record<string, string>[] = rows.map((row) => {
    const status = (row["status"] || "").trim();
    if (status !== "matched") {
      return {
        ...row,
        val_expected_storage: "",
        val_scraped_storage:  "",
        val_expected_color:   "",
        val_scraped_color:    "",
        val_status:           "",
        val_reason:           "",
      };
    }

    const productName = row["Product Name"] || "";
    const amazonTitle = row["amazon_title"]  || "";

    const v = validateRow(productName, amazonTitle);

    if (v.status === "storage_mismatch") storageMismatch++;
    else if (v.status === "color_mismatch") colorMismatch++;
    else if (v.status === "multiple_issues") multiIssues++;
    else okCount++;

    return {
      ...row,
      val_expected_storage: v.expectedStorage,
      val_scraped_storage:  v.scrapedStorage,
      val_expected_color:   v.expectedColor,
      val_scraped_color:    v.scrapedColor,
      val_status:           v.status,
      val_reason:           v.reason,
    };
  });

  // 4. Duplicate URL detection (across ALL matched rows)
  const urlRows = matched.map((r) => ({
    sku:         r["SKU"]          || "",
    url:         r["link"]         || r["link_round1"] || "",
    productName: r["Product Name"] || "",
  }));

  const duplicates = findDuplicateUrls(urlRows);

  // Mark duplicate rows
  const duplicateSkus = new Set<string>();
  for (const [url, skus] of duplicates) {
    for (const sku of skus) duplicateSkus.add(sku);
  }

  const finalRows = enriched.map((row) => {
    const sku = row["SKU"] || "";
    if (duplicateSkus.has(sku) && (row["val_status"] === "ok" || row["val_status"] === "")) {
      const dupeUrl = row["link"] || row["link_round1"] || "";
      const sharing = duplicates.get(dupeUrl) ?? [];
      row = {
        ...row,
        val_status: "duplicate_url",
        val_reason: `URL shared with: ${sharing.filter((s) => s !== sku).join(", ")}`,
      };
    }
    return row;
  });

  // 5. Console summary
  console.log(`\n── Validation Summary ────────────────────────────`);
  console.log(`   ✅  OK (matched rows):        ${okCount}`);
  console.log(`   ❌  Storage mismatch:         ${storageMismatch}`);
  console.log(`   🎨  Color mismatch:           ${colorMismatch}`);
  console.log(`   ⚠️   Multiple issues:          ${multiIssues}`);
  console.log(`   🔁  Duplicate URLs:            ${duplicates.size} URL(s) shared`);
  console.log(`─────────────────────────────────────────────────\n`);

  if (storageMismatch > 0 || multiIssues > 0) {
    console.log("Storage mismatches:");
    finalRows
      .filter((r) => r["val_status"] === "storage_mismatch" || r["val_status"] === "multiple_issues")
      .forEach((r) => {
        console.log(
          `  [${r["SKU"]}] ${r["Product Name"]}\n` +
          `    → ${r["val_reason"]}\n` +
          `    → amazon_title: "${r["amazon_title"]}"\n` +
          `    → link: ${r["link"]}\n`
        );
      });
  }

  if (duplicates.size > 0) {
    console.log("Duplicate URLs:");
    for (const [url, skus] of duplicates) {
      console.log(`  ${url}`);
      for (const sku of skus) {
        const row = rows.find((r) => r["SKU"] === sku);
        console.log(`    └─ [${sku}] ${row?.["Product Name"] ?? ""}`);
      }
      console.log();
    }
  }

  // 6. Write output
  const ext      = path.extname(csvPath);
  const base     = path.basename(csvPath, ext);
  const dir      = path.dirname(csvPath);
  const outPath  = path.join(dir, `${base}.checked${ext}`);
  writeCsv(outPath, finalRows);
  console.log(`📄 Checked CSV written to: ${outPath}\n`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
