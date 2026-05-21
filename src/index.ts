// ============================================================
// BXT-SCRAPPER — Main Orchestrator
// Coordinates: CSV → Search → Match → Scrape Price → Output
// ============================================================

import { config, reloadGeminiKeys } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { readProductsCsv } from "./utils/csv-reader.js";
import {
  getOutputFilePath,
  loadCompletedSkus,
  appendResultRow,
  readExistingCsv,
  getActiveRound,
} from "./utils/csv-writer.js";
import { randomDelay } from "./utils/delay.js";
import { updateScraperStatus, clearScraperStatus } from "./utils/status-manager.js";
import { BrowserService } from "./services/browser.service.js";
import { AmazonSearchService } from "./services/amazon-search.service.js";
import { JbHifiSearchService } from "./services/jbhifi-search.service.js";
import { PhonebotSearchService } from "./services/phonebot-search.service.js";
import { KoganSearchService } from "./services/kogan-search.service.js";
import { ReebeloSearchService } from "./services/reebelo-search.service.js";
import { BackmarketSearchService } from "./services/backmarket-search.service.js";
import { MobilecitiSearchService } from "./services/mobileciti-search.service.js";
import { BuymobileSearchService } from "./services/buymobile-search.service.js";
import { SpectronicSearchService } from "./services/spectronic-search.service.js";
import { BestmobilephoneSearchService } from "./services/bestmobilephone-search.service.js";
import { ScorptecSearchService } from "./services/scorptec-search.service.js";
import { CentrecomSearchService } from "./services/centrecom-search.service.js";
import { DigidirectSearchService } from "./services/digidirect-search.service.js";
import { GeorgesSearchService } from "./services/georges-search.service.js";
import { GeminiMatcherService } from "./services/gemini-matcher.service.js";
import { getSmartSearchQuery, getBroadSearchQuery } from "./utils/product-utils.js";
import type { BecexProduct, ScrapedResult, AmazonSearchResult } from "./types/index.js";
import fs from "fs";
import type { Page } from "playwright";
import { loadRules } from "./utils/rules-manager.js";
import { promisify } from "util";

const sleep = promisify(setTimeout);

// ── Graceful Shutdown ──────────────────────────────────────
let isShuttingDown = false;

function setupGracefulShutdown(browserService: BrowserService): void {
  const handleShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.warn(`Received ${signal}. Shutting down gracefully...`);
    try {
      const { convertCsvToExcel } = await import("./utils/excel-writer.js");
      const { getOutputFilePath } = await import("./utils/csv-writer.js");
      const { config } = await import("./config/index.js");
      const outputPath = getOutputFilePath(config.outputDir);
      await convertCsvToExcel(outputPath);
    } catch (e) {
      logger.error(`Failed to generate Excel on shutdown: ${(e as Error).message}`);
    }

    process.exit(0);
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
}

// ── Build Result Row Helpers ───────────────────────────────

function buildMatchedResult(
  product: BecexProduct,
  amazonUrl: string,
  amazonTitle: string,
  amazonPrice: number | null,
  confidence: number
): ScrapedResult {
  return {
    sku: product.sku,
    productName: product.productName,
    amazonUrl,
    amazonTitle,
    amazonPrice,
    matchConfidence: confidence,
    status: "matched",
    errorMessage: "",
  };
}

function buildNoMatchResult(product: BecexProduct): ScrapedResult {
  return {
    sku: product.sku,
    productName: product.productName,
    amazonUrl: "",
    amazonTitle: "",
    amazonPrice: null,
    matchConfidence: 0,
    status: "no_match",
    errorMessage: "",
  };
}

function buildErrorResult(product: BecexProduct, errorMessage: string): ScrapedResult {
  return {
    sku: product.sku,
    productName: product.productName,
    amazonUrl: "",
    amazonTitle: "",
    amazonPrice: null,
    matchConfidence: 0,
    status: "error",
    errorMessage,
  };
}

// ── Extraction Helpers ─────────────────────────────────────

async function extractPriceFromProductPage(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    // Try multiple selectors for price on detail page
    const priceSelectors = [
      ".a-price .a-offscreen",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      ".a-price .a-price-whole",
      '[data-testid="ticket-price"]',
      ".product-price",
      ".price-new",
      '[aria-label^="Price:"]',
      ".price__current",
    ];

    for (const selector of priceSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent || "";
        const match = text.replace(/[^0-9.]/g, "");
        if (match) return parseFloat(match);
      }
    }
    return null;
  });
}

function cleanAmazonUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const dpMatch = url.pathname.match(/\/dp\/([A-Z0-9]{10})/);
    if (dpMatch) {
      return `https://www.amazon.com.au/dp/${dpMatch[1]}`;
    }
    return rawUrl.split("?")[0];
  } catch {
    return rawUrl;
  }
}

async function waitForNewGeminiKeys(matcherService: GeminiMatcherService, currentKeys: string[]): Promise<void> {
  logger.warn("═══════════════════════════════════════════");
  logger.warn(" ⏸️  SCRAPER PAUSED: All Gemini Keys Exhausted ");
  logger.warn(" Please update .env with new API keys.      ");
  logger.warn(" Watching .env for changes...               ");
  logger.warn("═══════════════════════════════════════════");

  const oldKeysSet = new Set(currentKeys);

  while (true) {
    await sleep(10000); // Check every 10 seconds
    const newKeys = reloadGeminiKeys(config.scraperTarget);
    
    // Check if there are any keys not in the old set
    const hasNewKeys = newKeys.some(k => !oldKeysSet.has(k));
    
    if (hasNewKeys) {
      logger.info("✨ New Gemini API keys detected! Resuming...");
      matcherService.updateKeys(newKeys);
      updateScraperStatus("running");
      return;
    }
  }
}

// ── Process Single Product ─────────────────────────────────

async function processSingleProduct(
  product: BecexProduct,
  searchService: AmazonSearchService | JbHifiSearchService | KoganSearchService | PhonebotSearchService | ReebeloSearchService | BackmarketSearchService | MobilecitiSearchService | BuymobileSearchService | SpectronicSearchService | BestmobilephoneSearchService | ScorptecSearchService | CentrecomSearchService | DigidirectSearchService | GeorgesSearchService,
  matcherService: GeminiMatcherService,
  page: Page
): Promise<ScrapedResult> {
  // Pre-filter using rules.json
  const rulesConfig = loadRules();
  const catRules = rulesConfig[config.mappingCategory];
  if (catRules) {
    const storeRules = catRules.stores[config.scraperTarget];
    if (storeRules) {
      if (storeRules.excludePristine) {
        const pristineSuffix = catRules.skuMappings?.Pristine || "-VR-ASN-AU";
        if (product.sku.endsWith(pristineSuffix)) {
          logger.info(`Skipping Pristine item (${product.sku}) for ${config.scraperTarget} mapping (per rules).`);
          return buildNoMatchResult(product);
        }
      }
      if (storeRules.excludeVeryGood) {
        const vgSuffix = catRules.skuMappings?.["Very Good"] || "-VGC-AU";
        if (product.sku.endsWith(vgSuffix)) {
          logger.info(`Skipping Very Good item (${product.sku}) for ${config.scraperTarget} mapping (per rules).`);
          return buildNoMatchResult(product);
        }
      }
    }
  }

  // Step 1: Smart Search (with storage/model specificity)
  const smartQuery = getSmartSearchQuery(product.productName);
  const broadQuery = getBroadSearchQuery(product.productName);

  logger.info(`  Original : "${product.productName}"`);
  logger.info(`  Smart    : "${smartQuery}"`);
  logger.info(`  Broad    : "${broadQuery}"`);

  let searchResults = await searchService.searchProduct(page, smartQuery);

  // Fallback: If smart query returns nothing, try the broader query
  if (searchResults.length === 0 && smartQuery !== broadQuery) {
    logger.info(`  Smart query returned 0 results. Retrying with broad query...`);
    searchResults = await searchService.searchProduct(page, broadQuery);
  }

  if (searchResults.length === 0) {
    return buildNoMatchResult(product);
  }

  // Step 2: Take screenshot and use AI matching
  const screenshot = await page.screenshot({ fullPage: false });
  const matchResult = await matcherService.findBestMatch(product, searchResults, screenshot);

  if (!matchResult.isMatch || matchResult.matchedResultIndex < 0) {
    return buildNoMatchResult(product);
  }

  const matchedResult = searchResults[matchResult.matchedResultIndex];
  
  // Step 3: Visit product page
  logger.info(`AI selected result [${matchResult.matchedResultIndex}]. Visiting...`);
  await page.goto(matchedResult.url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Step 4: Extract Price from detail page
  let price: number | null = null;
  let cleanUrl = matchedResult.url.split("?")[0];

  if ("selectVariantsAndGetPrice" in searchService) {
    const result = await (searchService as any).selectVariantsAndGetPrice(page, product, matchedResult.url);
    price = result.price;
    cleanUrl = result.cleanUrl;
  } else {
    price = await extractPriceFromProductPage(page);
    if (config.scraperTarget === "amazon") {
      cleanUrl = cleanAmazonUrl(matchedResult.url);
    }
  }

  return buildMatchedResult(
    product,
    cleanUrl,
    matchedResult.title,
    price,
    matchResult.confidence
  );
}

// ── Main Orchestrator ──────────────────────────────────────

async function main(): Promise<void> {
  updateScraperStatus("running");
  const startTime = Date.now();

  logger.info("═══════════════════════════════════════════");
  logger.info("  BXT-SCRAPPER — Price Finder              ");
  logger.info("═══════════════════════════════════════════");
  logger.info(`  Category : ${config.mappingCategory}`);
  logger.info(`  Target   : ${config.scraperTarget}`);
  logger.info(`  Mode     : ${config.scraperMode.toUpperCase()}`);
  logger.info("═══════════════════════════════════════════");

  const products = await readProductsCsv(config.inputCsvPath);
  const outputPath = getOutputFilePath(config.outputDir);
  fs.mkdirSync(config.outputDir, { recursive: true });

  let completedSkus = new Set<string>();
  let activeRound = 1;

  if (config.scraperMode === "fresh") {
    // Delete existing output files for a clean start
    const xlsxPath = outputPath.replace(/\.csv$/, ".xlsx");
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
      logger.info(`🗑️ Fresh mode: deleted old output ${outputPath}`);
    }
    if (fs.existsSync(xlsxPath)) {
      fs.unlinkSync(xlsxPath);
      logger.info(`🗑️ Fresh mode: deleted old output ${xlsxPath}`);
    }
  } else {
    const existingRows = await readExistingCsv(outputPath);
    activeRound = getActiveRound(existingRows);
    completedSkus = await loadCompletedSkus(outputPath, activeRound);
  }

  logger.info(`  Active Rd: Round ${activeRound}`);
  logger.info("═══════════════════════════════════════════");

  const pendingProducts = products.filter(p => !completedSkus.has(p.sku)).slice(0, 50);

  if (pendingProducts.length === 0) {
    logger.info("Nothing to do.");
    return;
  }

  const browserService = new BrowserService(config.proxyUrl);
  setupGracefulShutdown(browserService);

  await browserService.initialize();
  const page = await browserService.newPage();

  let searchService;
  if (config.scraperTarget === "jbhifi") {
    searchService = new JbHifiSearchService(config.jbhifiDomain, config.maxSearchResults);
  } else if (config.scraperTarget === "phonebot") {
    searchService = new PhonebotSearchService(config.phonebotDomain, config.maxSearchResults);
  } else if (config.scraperTarget === "kogan") {
    searchService = new KoganSearchService(config.koganDomain, config.maxSearchResults);
  } else if (config.scraperTarget === "reebelo") {
    searchService = new ReebeloSearchService(config.reebeloDomain, config.maxSearchResults);
  } else if (config.scraperTarget === "backmarket") {
    searchService = new BackmarketSearchService(config.backmarketDomain, config.maxSearchResults);
  } else if (config.scraperTarget === "mobileciti") {
    searchService = new MobilecitiSearchService(config.mobilecitiDomain, config.maxSearchResults);
  } else if (config.scraperTarget === "buymobile") {
    searchService = new BuymobileSearchService(config.buymobileDomain, config.maxSearchResults);
  } else if (config.scraperTarget === "spectronic") {
    searchService = new SpectronicSearchService(config.spectronicDomain, config.maxSearchResults);
  } else if (config.scraperTarget === "bestmobilephone") {
    searchService = new BestmobilephoneSearchService(config.bestmobilephoneDomain, config.maxSearchResults);
  } else if (config.scraperTarget === "scorptec") {
    searchService = new ScorptecSearchService(config.scorptecDomain, config.maxSearchResults);
  } else if (config.scraperTarget === "centrecom") {
    searchService = new CentrecomSearchService(config.centrecomDomain, config.maxSearchResults);
  } else if (config.scraperTarget === "digidirect") {
    searchService = new DigidirectSearchService(config.digidirectDomain, config.maxSearchResults);
  } else if (config.scraperTarget === "georges") {
    searchService = new GeorgesSearchService(config.georgesDomain, config.maxSearchResults);
  } else {
    searchService = new AmazonSearchService(config.amazonDomain, config.maxSearchResults);
  }
    
  const matcherService = new GeminiMatcherService(config.geminiApiKeys, config.mappingCategory, config.scraperTarget);

  for (let i = 0; i < pendingProducts.length; i++) {
    if (isShuttingDown) break;

    const product = pendingProducts[i];
    const progress = `[${i + 1}/${pendingProducts.length}]`;

    logger.info(`${progress} Processing: ${product.productName}`);

    try {
      const result = await processSingleProduct(product, searchService, matcherService, page);
      await appendResultRow(outputPath, result, activeRound);

      const statusEmoji = result.status === "matched" ? "✅" : "❌";
      const priceLog = result.amazonPrice ? ` — A$${result.amazonPrice}` : "";
      logger.info(`${progress} ${statusEmoji} ${result.status}${priceLog}`);
    } catch (error) {
      const errorMessage = (error as Error).message;
      if (errorMessage === "CAPTCHA_DETECTED") {
        logger.error("CAPTCHA detected! Waiting 60s...");
        await randomDelay(60000, 90000);
        i--; continue;
      }
      // Write error result to CSV so output file always has data
      const errorResult = buildErrorResult(product, errorMessage);
      await appendResultRow(outputPath, errorResult, activeRound);
      logger.error(`${progress} ⚠️ Error: ${errorMessage}`);

      if (errorMessage === "ALL_GEMINI_KEYS_EXHAUSTED") {
        updateScraperStatus("paused", "ALL_GEMINI_KEYS_EXHAUSTED");
        await waitForNewGeminiKeys(matcherService, matcherService.getApiKeys());
        i--; // Retry the same product
        continue;
      }
    }

    if (i < pendingProducts.length - 1 && !isShuttingDown) {
      await randomDelay(config.requestDelayMinMs, config.requestDelayMaxMs);
    }
  }

  await browserService.shutdown();
  clearScraperStatus();
  logger.info(`Done! Results: ${outputPath}`);

  try {
    const { convertCsvToExcel } = await import("./utils/excel-writer.js");
    await convertCsvToExcel(outputPath);
  } catch (e) {
    logger.error(`Failed to generate Excel on complete: ${(e as Error).message}`);
  }
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
