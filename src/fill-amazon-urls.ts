import fs from "fs";
import path from "path";
import csvParser from "csv-parser";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { BrowserService } from "./services/browser.service.js";
import { AmazonSearchService } from "./services/amazon-search.service.js";
import { GeminiMatcherService } from "./services/gemini-matcher.service.js";
import { randomDelay } from "./utils/delay.js";

const INPUT_CSV = config.inputCsvPath;
const OUTPUT_CSV = path.join("output", path.basename(INPUT_CSV, ".csv") + "_Filled.csv");

async function main() {
  logger.info("═══════════════════════════════════════════");
  logger.info("  BXT-SCRAPPER — Amazon URL Filler (bxt)  ");
  logger.info("═══════════════════════════════════════════");

  // Determine which file to read from (resume support)
  let fileToRead = INPUT_CSV;
  if (fs.existsSync(OUTPUT_CSV)) {
    logger.info(`Found existing output file. Resuming from: ${OUTPUT_CSV}`);
    fileToRead = OUTPUT_CSV;
  } else if (!fs.existsSync(INPUT_CSV)) {
    logger.error(`Input file not found: ${INPUT_CSV}`);
    return;
  }

  const rows: any[] = [];
  let headers: string[] = [];

  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(fileToRead)
      .pipe(csvParser({ separator: "," }))
      .on("headers", (h) => {
        headers = h;
      })
      .on("data", (data) => rows.push(data))
      .on("end", () => resolve())
      .on("error", reject);
  });

  logger.info(`Loaded ${rows.length} rows.`);

  const browserService = new BrowserService(config.proxyUrl);
  await browserService.initialize();
  const page = await browserService.newPage();

  const searchService = new AmazonSearchService(config.amazonDomain, config.maxSearchResults);
  const matcherService = new GeminiMatcherService(config.geminiApiKeys, config.mappingCategory, config.scraperTarget);

  const escapeCsv = (val: string) => {
    if (!val) return "";
    const str = String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  // We will process in-memory and write out fully after each match to avoid partial writes.
  // Actually, we can write to a temp file and rename it, or just rewrite the whole file.
  // Since the file is small (1MB), rewriting the whole file on each update is safe and guarantees consistency.
  const saveIncremental = () => {
    const lines = [headers.map(escapeCsv).join(",")];
    for (const row of rows) {
      lines.push(headers.map(h => escapeCsv(row[h])).join(","));
    }
    fs.writeFileSync(OUTPUT_CSV + ".tmp", lines.join("\n"));
    fs.renameSync(OUTPUT_CSV + ".tmp", OUTPUT_CSV);
  };

  if (!fs.existsSync("output")) {
    fs.mkdirSync("output", { recursive: true });
  }

  // Initial save if we are starting fresh
  if (fileToRead === INPUT_CSV && !fs.existsSync(OUTPUT_CSV)) {
      saveIncremental();
  }

  let updatedCount = 0;
  let isFirstAmazonLoad = true;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const productName = row["PRODUCT NAME"] || "";
    let comp3Url = (row["Competitor #3 URL"] || "").trim();

    // Skip and clear if pristine (per rules: DO NOT map Pristine items to Amazon)
    const sku = row["GTIN / EAN / UPC"] || "";
    if (sku.endsWith("-VR-ASN-AU")) {
      if (row["Competitor #3 URL"] || row["Harga AMAZON"]) {
        row["Competitor #3 URL"] = "";
        row["Harga AMAZON"] = "#N/A";
        saveIncremental();
      }
      continue;
    }

    // 2. Search and Fill if empty
    if (!comp3Url && productName) {
      const progress = `[${i + 1}/${rows.length}]`;
      logger.info(`${progress} Empty URL for: ${productName}. Searching...`);
      
      try {
        // Set postcode and initial navigation is handled inside searchProduct now

        const searchQuery = productName.replace(/\s*-\s*Brand New\s*$/i, "").replace(/[()"]/g, "").trim();
        const searchResults = await searchService.searchProduct(page, searchQuery);

        if (searchResults.length > 0) {
          const screenshot = await page.screenshot({ fullPage: false });
          const productObj = { sku, productName };
          const matchResult = await matcherService.findBestMatch(productObj, searchResults, screenshot);

          if (matchResult.isMatch && matchResult.matchedResultIndex >= 0) {
            const matchedUrl = searchResults[matchResult.matchedResultIndex].url;
            let cleanUrl = matchedUrl.split("?")[0];
            try {
              const urlMatch = new URL(matchedUrl).pathname.match(/\/dp\/([A-Z0-9]{10})/);
              if (urlMatch) cleanUrl = `https://www.amazon.com.au/dp/${urlMatch[1]}`;
            } catch (e) {}

            row["Competitor #3 URL"] = cleanUrl;
            logger.info(`  -> ✅ Found NEW valid URL: ${cleanUrl}`);
            
            saveIncremental();
            updatedCount++;

            await randomDelay(config.requestDelayMinMs, config.requestDelayMaxMs);
          } else {
            logger.info(`  -> ❌ No valid match found (AI rejected or no candidates).`);
            await randomDelay(1000, 2000);
          }
        } else {
          logger.info(`  -> ❌ No search results found.`);
          await randomDelay(1000, 2000);
        }
      } catch (error: any) {
        if (error.message.includes("429") || error.message.includes("quota") || error.message === "ALL_GEMINI_KEYS_EXHAUSTED") {
          logger.error("All Gemini API keys exhausted! Stopping.");
          break;
        }
        if (error.message === "CAPTCHA_DETECTED") {
          logger.error("CAPTCHA detected! Waiting 60s...");
          await randomDelay(60000, 90000);
          i--; continue;
        }
        logger.error(`  -> ⚠️ Error: ${error.message}`);
      }
    }
  }

  await browserService.shutdown();
  logger.info(`Done! Updated ${updatedCount} URLs. Final file: ${OUTPUT_CSV}`);
}

let isShuttingDown = false;
process.on("SIGINT", () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.warn("Received SIGINT. Shutting down gracefully...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.warn("Received SIGTERM. Shutting down gracefully...");
  process.exit(0);
});

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
