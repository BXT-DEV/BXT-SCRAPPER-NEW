// ============================================================
// BXT-SCRAPPER — Main Orchestrator
// Coordinates: CSV → Search → Match → Scrape Price → Output
// ============================================================

import {
  config,
  reloadGeminiKeys,
  VALID_TARGETS_BY_CATEGORY,
} from "./config/index.js";
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
import {
  updateScraperStatus,
  clearScraperStatus,
} from "./utils/status-manager.js";
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
import {
  getSmartSearchQuery,
  getBroadSearchQuery,
  extractSpecs,
} from "./utils/product-utils.js";
import type {
  BecexProduct,
  ScrapedResult,
  AmazonSearchResult,
  DetailedCandidate,
  ScraperTarget,
} from "./types/index.js";
import fs from "fs";
import type { Page } from "playwright";
import { loadRules } from "./utils/rules-manager.js";
import { promisify } from "util";

const sleep = promisify(setTimeout);

// ── Graceful Shutdown ──────────────────────────────────────
let isShuttingDown = false;
let currentOutputPath: string | undefined;

function setupGracefulShutdown(browserService: BrowserService): void {
  const handleShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.warn(`Received ${signal}. Shutting down gracefully...`);
    try {
      const { convertCsvToExcel } = await import("./utils/excel-writer.js");
      if (currentOutputPath) {
        await convertCsvToExcel(currentOutputPath);
      }
    } catch (e) {
      logger.error(
        `Failed to generate Excel on shutdown: ${(e as Error).message}`,
      );
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
  confidence: number,
  spec?: string,
  condition?: string,
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
    spec,
    condition,
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

function buildErrorResult(
  product: BecexProduct,
  errorMessage: string,
): ScrapedResult {
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

async function waitForNewGeminiKeys(
  matcherService: GeminiMatcherService,
  currentKeys: string[],
  target: ScraperTarget,
): Promise<void> {
  logger.warn("═══════════════════════════════════════════");
  logger.warn(" ⏸️  SCRAPER PAUSED: All Gemini Keys Exhausted ");
  logger.warn(" Please update .env with new API keys.      ");
  logger.warn(" Watching .env for changes...               ");
  logger.warn("═══════════════════════════════════════════");

  const oldKeysSet = new Set(currentKeys);

  while (true) {
    await sleep(10000); // Check every 10 seconds
    const newKeys = reloadGeminiKeys(target);

    // Check if there are any keys not in the old set
    const hasNewKeys = newKeys.some((k) => !oldKeysSet.has(k));

    if (hasNewKeys) {
      logger.info("✨ New Gemini API keys detected! Resuming...");
      matcherService.updateKeys(newKeys);
      updateScraperStatus("running");
      return;
    }
  }
}

function getResultCondition(
  product: BecexProduct,
  target: string,
  category: string,
  matchedTitle: string,
  matchedUrl: string,
  selectedConditionFromPicker?: string,
): string {
  if (category !== "MAPPING REFURBISHED") {
    return "Brand New";
  }

  if (selectedConditionFromPicker) {
    return selectedConditionFromPicker;
  }

  // Load rules to find target condition mappings
  try {
    const rulesConfig = loadRules();
    const catRules = rulesConfig["MAPPING REFURBISHED"];
    const storeRules = catRules?.stores?.[target];

    if (storeRules?.conditionMapping) {
      const pristineSuffix = catRules?.skuMappings?.Pristine || "-VR-ASN-AU";
      const excellentSuffix =
        catRules?.skuMappings?.Excellent || "-RD-VR-EXD-AU";
      const veryGoodSuffix = catRules?.skuMappings?.["Very Good"] || "-VGC-AU";

      const isPristine =
        product.sku.endsWith(pristineSuffix) ||
        product.productName.toLowerCase().includes("pristine");
      const isExcellent =
        product.sku.includes(excellentSuffix) ||
        product.sku.includes("EXD-AU") ||
        product.productName.toLowerCase().includes("excellent");
      const isVeryGood =
        product.sku.includes(veryGoodSuffix) ||
        product.productName.toLowerCase().includes("very good") ||
        product.productName.toLowerCase().includes("vgc");

      if (isPristine && storeRules.conditionMapping.Pristine) {
        return storeRules.conditionMapping.Pristine[0];
      }
      if (isExcellent && storeRules.conditionMapping.Excellent) {
        return storeRules.conditionMapping.Excellent[0];
      }
      if (isVeryGood && storeRules.conditionMapping["Very Good"]) {
        return storeRules.conditionMapping["Very Good"][0];
      }
    }
  } catch (err) {
    logger.warn(`Could not load condition mappings: ${(err as Error).message}`);
  }

  // Fallback keyword matching on title/URL
  const titleLower = matchedTitle.toLowerCase();
  if (
    titleLower.includes("pristine") ||
    titleLower.includes("like new") ||
    titleLower.includes("premium")
  ) {
    return "Pristine";
  } else if (
    titleLower.includes("excellent") ||
    titleLower.includes("very good")
  ) {
    return "Excellent";
  } else if (titleLower.includes("good")) {
    return "Good";
  } else if (titleLower.includes("fair")) {
    return "Fair";
  }

  return "Refurbished";
}

// ── Process Single Product ─────────────────────────────────

async function processSingleProduct(
  product: BecexProduct,
  searchService:
    | AmazonSearchService
    | JbHifiSearchService
    | KoganSearchService
    | PhonebotSearchService
    | ReebeloSearchService
    | BackmarketSearchService
    | MobilecitiSearchService
    | BuymobileSearchService
    | SpectronicSearchService
    | BestmobilephoneSearchService
    | ScorptecSearchService
    | CentrecomSearchService
    | DigidirectSearchService
    | GeorgesSearchService,
  matcherService: GeminiMatcherService | null,
  page: Page,
  target: ScraperTarget,
): Promise<ScrapedResult> {
  // Pre-filter: Exclude accessories
  const accessoryKeywords = ["Protector", "Case", "Cover", "Glass"];
  if (
    accessoryKeywords.some((keyword) =>
      product.productName.toLowerCase().includes(keyword.toLowerCase()),
    )
  ) {
    logger.info(`Skipping accessory item: ${product.productName}`);
    return buildNoMatchResult(product);
  }

  // Pre-filter using rules.json
  const rulesConfig = loadRules();
  const catRules = rulesConfig[config.mappingCategory];
  if (catRules) {
    const storeRules = catRules.stores[target];
    if (storeRules) {
      if (storeRules.excludePristine) {
        const pristineSuffix = catRules.skuMappings?.Pristine || "-VR-ASN-AU";
        if (product.sku.endsWith(pristineSuffix)) {
          logger.info(
            `Skipping Pristine item (${product.sku}) for ${target} mapping (per rules).`,
          );
          return buildNoMatchResult(product);
        }
      }
      if (storeRules.excludeVeryGood) {
        const vgSuffix = catRules.skuMappings?.["Very Good"] || "-VGC-AU";
        if (product.sku.endsWith(vgSuffix)) {
          logger.info(
            `Skipping Very Good item (${product.sku}) for ${target} mapping (per rules).`,
          );
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
    logger.info(
      `  Smart query returned 0 results. Retrying with broad query...`,
    );
    searchResults = await searchService.searchProduct(page, broadQuery);
  }

  if (searchResults.length === 0) {
    return buildNoMatchResult(product);
  }

  // ── Step 2: Match and Extract Price ──────────────────────

  // Fast path for nested stores (e.g., Reebelo) — one product page = all variants.
  // Deterministic variant selection, no Gemini needed.
  const hasMatchDirectly =
    typeof (searchService as any).matchDirectly === "function";
  logger.info(
    `matchDirectly available: ${hasMatchDirectly} (service: ${searchService.constructor.name})`,
  );

  if (hasMatchDirectly) {
    logger.info(`Using direct matching for ${product.productName}`);
    const directMatch = await (searchService as any).matchDirectly(
      page,
      product,
      searchResults,
    );
    if (!directMatch) {
      return buildNoMatchResult(product);
    }
    const decodedUrlForDirectMatch = decodeURIComponent(
      directMatch.url,
    ).replace(/[-_/]/g, " ");
    const combinedTextForDirectMatch = `${directMatch.title} ${decodedUrlForDirectMatch}`;
    const specs = extractSpecs(combinedTextForDirectMatch);
    const specStr =
      [
        specs.cpu.join(", "),
        specs.ram.join(", "),
        specs.storage.join(", "),
        specs.colors.join(", "),
        specs.connectivity.join(", "),
      ]
        .filter(Boolean)
        .join(" | ") || "No specs detected";

    const conditionStr = getResultCondition(
      product,
      target,
      config.mappingCategory,
      directMatch.title,
      directMatch.url,
      directMatch.selectedCondition,
    );
    return buildMatchedResult(
      product,
      directMatch.url,
      directMatch.title,
      directMatch.price,
      1.0,
      specStr,
      conditionStr,
    );
  }

  // ── No-AI fast path: take first search result directly ─────────────
  if (config.noAi) {
    logger.info(
      `[NO_AI] Finding best candidate from search results (deterministic matching)...`,
    );
    const cleanName = product.productName.toLowerCase();
    const nameSpecs = extractSpecs(product.productName);

    const accessoryKeywords = [
      "case",
      "cover",
      "protector",
      "glass",
      "strap",
      "band",
      "sleeve",
      "pouch",
      "housing",
      "cable",
      "charger",
      "holder",
      "mount",
      "cap",
    ];
    const queryHasAccessory = accessoryKeywords.some((kw) =>
      cleanName.includes(kw),
    );

    let bestCandidate = null;

    for (const result of searchResults) {
      const resTitle = result.title.toLowerCase();

      // 1. Accessory check
      if (!queryHasAccessory) {
        const resultHasAccessory = accessoryKeywords.some((kw) =>
          resTitle.includes(kw),
        );
        if (resultHasAccessory) {
          logger.info(
            `  Skipping "${result.title}" (Reason: Query is not an accessory, but result title contains accessory keyword)`,
          );
          continue;
        }
      }

      // 2. Core Model Token Match
      const mainTokens = cleanName
        .replace(
          /apple|samsung|sony|canon|nikon|oppo|nintendo|google|microsoft/g,
          "",
        )
        .replace(/\d+\s*(gb|tb|mb)/g, "")
        .replace(/\b(cellular|wifi|wi-fi|gps|lte|5g|4g|3g)\b/g, "")
        .replace(
          /\b(excellent|pristine|good|very good|refurbished|renewed|brand new)\b/g,
          "",
        )
        .replace(
          /\b(grey|gray|silver|black|white|gold|pink|blue|green|purple|yellow|red|midnight|starlight)\b/g,
          "",
        )
        .replace(/[(),\-]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1);

      const matchesModel = mainTokens.every((token) =>
        resTitle.includes(token),
      );
      if (!matchesModel) {
        logger.info(
          `  Skipping "${result.title}" (Reason: Main model tokens [${mainTokens.join(", ")}] not found)`,
        );
        continue;
      }

      // 3. Modifier Match (Pro, Max, Mini, FE, Plus, etc.)
      const modelModifiers = [
        "mini",
        "pro",
        "max",
        "ultra",
        "plus",
        "s",
        "xs",
        "xr",
        "fe",
      ];
      let modifierMismatch = false;
      for (const mod of modelModifiers) {
        const nameHasMod = new RegExp(`\\b${mod}\\b`, "i").test(cleanName);
        const resHasMod = new RegExp(`\\b${mod}\\b`, "i").test(resTitle);
        if (nameHasMod !== resHasMod) {
          logger.info(
            `  Skipping "${result.title}" (Reason: Modifier "${mod}" mismatch. Target: ${nameHasMod}, Result: ${resHasMod})`,
          );
          modifierMismatch = true;
          break;
        }
      }
      if (modifierMismatch) continue;

      // 4. Storage Match
      const supportsVariantPicker =
        "selectVariantsAndGetPrice" in searchService ||
        typeof (searchService as any).matchDirectly === "function";
      if (!supportsVariantPicker && nameSpecs.storage.length > 0) {
        const resSpecs = extractSpecs(result.title);
        if (resSpecs.storage.length > 0) {
          const normStorage = (s: string) =>
            s.replace(/\s+/g, "").toLowerCase();
          const nameStorageNorm = nameSpecs.storage.map(normStorage);
          const resStorageNorm = resSpecs.storage.map(normStorage);
          const hasStorageMatch = nameStorageNorm.some((ns) =>
            resStorageNorm.includes(ns),
          );
          if (!hasStorageMatch) {
            logger.info(
              `  Skipping "${result.title}" (Reason: Storage mismatch. Target: [${nameSpecs.storage.join(", ")}], Result: [${resSpecs.storage.join(", ")}])`,
            );
            continue;
          }
        }
      }

      bestCandidate = result;
      break;
    }

    if (!bestCandidate) {
      logger.warn(
        `[NO_AI] No deterministic match found for: ${product.productName}`,
      );
      return buildNoMatchResult(product);
    }

    logger.info(`[NO_AI] Selected candidate: "${bestCandidate.title}"`);

    // Navigate to detail page and extract price
    await page.goto(bestCandidate.url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    let price: number | null = null;
    let cleanUrl = bestCandidate.url.split("?")[0];
    let selectedConditionFromPicker: string | undefined;

    if ("selectVariantsAndGetPrice" in searchService) {
      const variantResult = await (
        searchService as any
      ).selectVariantsAndGetPrice(page, product, bestCandidate.url);
      price = variantResult.price;
      cleanUrl = variantResult.cleanUrl;
      selectedConditionFromPicker = variantResult.selectedCondition;
    } else {
      price = await extractPriceFromProductPage(page);
      if (target === "amazon") {
        cleanUrl = cleanAmazonUrl(bestCandidate.url);
      }
    }

    const pageH1 =
      (await page
        .locator("h1")
        .first()
        .textContent()
        .catch(() => "")) || "";
    const pageTitleText = await page.title().catch(() => "");
    const decodedUrl = decodeURIComponent(cleanUrl).replace(/[-_/]/g, " ");
    const combinedText = `${bestCandidate.title} ${pageH1} ${pageTitleText} ${decodedUrl}`;
    const specs = extractSpecs(combinedText);
    const specStr =
      [
        specs.cpu.join(", "),
        specs.ram.join(", "),
        specs.storage.join(", "),
        specs.colors.join(", "),
        specs.connectivity.join(", "),
      ]
        .filter(Boolean)
        .join(" | ") || "No specs detected";

    // Use the page H1 after variant selection as the output title (more complete than search result title)
    const outputTitle = pageH1.trim() || bestCandidate.title;
    const conditionStr = getResultCondition(
      product,
      target,
      config.mappingCategory,
      outputTitle,
      cleanUrl,
      selectedConditionFromPicker,
    );

    return buildMatchedResult(
      product,
      cleanUrl,
      outputTitle,
      price,
      0.5,
      specStr,
      conditionStr,
    );
  }

  // Standard path: AI-powered candidate evaluation (for stores without nested variants)
  let screenshot: Buffer | undefined;
  try {
    screenshot = await page.screenshot({ fullPage: false, timeout: 5000 });
  } catch (screenshotError) {
    logger.warn(
      `⚠️ Warning: page.screenshot failed or timed out: ${(screenshotError as Error).message}.`,
    );
  }

  // 1. Identify candidates
  const candidates = await matcherService!.getTopCandidates(
    product,
    searchResults,
  );
  const detailedCandidates: DetailedCandidate[] = [];

  // 2. Gather details
  for (const candidate of candidates) {
    const result = searchResults[candidate.index];
    logger.info(`Inspecting candidate [${candidate.index}]: ${result.title}`);

    await page.goto(result.url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    const details = await page.evaluate(() =>
      document.body.innerText.substring(0, 1000),
    );
    detailedCandidates.push({ ...result, index: candidate.index, details });
  }

  // 3. Confirm match
  const matchResult = await matcherService!.confirmMatch(
    product,
    detailedCandidates,
  );

  if (!matchResult.isMatch || matchResult.matchedResultIndex < 0) {
    return buildNoMatchResult(product);
  }

  const matchedResult = searchResults[matchResult.matchedResultIndex];

  // Step 3: Finalize and extract price
  logger.info(
    `AI confirmed result [${matchResult.matchedResultIndex}]. Finalizing...`,
  );
  await page.goto(matchedResult.url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // Step 4: Extract Price from detail page
  let price: number | null = null;
  let cleanUrl = matchedResult.url.split("?")[0];
  let selectedConditionFromPicker: string | undefined;

  if ("selectVariantsAndGetPrice" in searchService) {
    const result = await (searchService as any).selectVariantsAndGetPrice(
      page,
      product,
      matchedResult.url,
    );
    price = result.price;
    cleanUrl = result.cleanUrl;
    selectedConditionFromPicker = result.selectedCondition;
  } else {
    price = await extractPriceFromProductPage(page);
    if (target === "amazon") {
      cleanUrl = cleanAmazonUrl(matchedResult.url);
    }
  }

  const searchTitle = matchedResult.title;
  const pageH1 =
    (await page
      .locator("h1")
      .first()
      .textContent()
      .catch(() => "")) || "";
  const pageTitleText = await page.title().catch(() => "");
  const decodedUrl = decodeURIComponent(cleanUrl).replace(/[-_/]/g, " ");
  const combinedText = `${searchTitle} ${pageH1} ${pageTitleText} ${decodedUrl}`;
  const specs = extractSpecs(combinedText);
  const specStr =
    [
      specs.cpu.join(", "),
      specs.ram.join(", "),
      specs.storage.join(", "),
      specs.colors.join(", "),
      specs.connectivity.join(", "),
    ]
      .filter(Boolean)
      .join(" | ") || "No specs detected";

  // Use the page H1 after variant selection as the output title (more complete than search result title)
  const finalTitle = pageH1.trim() || searchTitle;
  const conditionStr = getResultCondition(
    product,
    target,
    config.mappingCategory,
    finalTitle,
    cleanUrl,
    selectedConditionFromPicker,
  );

  return buildMatchedResult(
    product,
    cleanUrl,
    finalTitle,
    price,
    matchResult.confidence,
    specStr,
    conditionStr,
  );
}

async function main(): Promise<void> {
  updateScraperStatus("running");
  const startTime = Date.now();

  logger.info("═══════════════════════════════════════════");
  logger.info("  BXT-SCRAPPER — Price Finder              ");
  logger.info("═══════════════════════════════════════════");
  logger.info(`  Category : ${config.mappingCategory}`);
  logger.info(`  Target   : ${config.scraperTarget}`);
  logger.info(`  Mode     : ${config.scraperMode.toUpperCase()}`);
  logger.info(
    `  AI       : ${config.noAi ? "DISABLED (No AI)" : "ENABLED (Gemini)"}`,
  );
  logger.info("═══════════════════════════════════════════");

  const products = await readProductsCsv(config.inputCsvPath);
  fs.mkdirSync(config.outputDir, { recursive: true });

  const targets =
    config.scraperTarget === "all"
      ? VALID_TARGETS_BY_CATEGORY[config.mappingCategory]
      : [config.scraperTarget];

  const browserService = new BrowserService(config.proxyUrl);
  setupGracefulShutdown(browserService);
  await browserService.initialize();
  let page = await browserService.newPage();

  for (const target of targets) {
    if (isShuttingDown) break;

    // Set process.env.SCRAPER_TARGET for other services (csv-writer etc)
    process.env.SCRAPER_TARGET = target;

    logger.info("═══════════════════════════════════════════");
    logger.info(`🚀 Starting Target: ${target.toUpperCase()}`);
    logger.info("═══════════════════════════════════════════");

    const outputPath = getOutputFilePath(config.outputDir);
    currentOutputPath = outputPath;
    let completedSkus = new Set<string>();
    let activeRound = 1;

    if (config.scraperMode === "fresh") {
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

    const pendingProducts = products.filter((p) => !completedSkus.has(p.sku));
    if (pendingProducts.length === 0) {
      logger.info(`Nothing to do for target: ${target}`);
      continue;
    }

    let searchService;
    if (target === "jbhifi") {
      searchService = new JbHifiSearchService(
        config.jbhifiDomain,
        config.maxSearchResults,
      );
    } else if (target === "phonebot") {
      searchService = new PhonebotSearchService(
        config.phonebotDomain,
        config.maxSearchResults,
      );
    } else if (target === "kogan") {
      searchService = new KoganSearchService(
        config.koganDomain,
        config.maxSearchResults,
      );
    } else if (target === "reebelo") {
      searchService = new ReebeloSearchService(
        config.reebeloDomain,
        config.maxSearchResults,
      );
    } else if (target === "backmarket") {
      searchService = new BackmarketSearchService(
        config.backmarketDomain,
        config.maxSearchResults,
      );
    } else if (target === "mobileciti") {
      searchService = new MobilecitiSearchService(
        config.mobilecitiDomain,
        config.maxSearchResults,
      );
    } else if (target === "buymobile") {
      searchService = new BuymobileSearchService(
        config.buymobileDomain,
        config.maxSearchResults,
      );
    } else if (target === "spectronic") {
      searchService = new SpectronicSearchService(
        config.spectronicDomain,
        config.maxSearchResults,
      );
    } else if (target === "bestmobilephone") {
      searchService = new BestmobilephoneSearchService(
        config.bestmobilephoneDomain,
        config.maxSearchResults,
      );
    } else if (target === "scorptec") {
      searchService = new ScorptecSearchService(
        config.scorptecDomain,
        config.maxSearchResults,
      );
    } else if (target === "centrecom") {
      searchService = new CentrecomSearchService(
        config.centrecomDomain,
        config.maxSearchResults,
      );
    } else if (target === "digidirect") {
      searchService = new DigidirectSearchService(
        config.digidirectDomain,
        config.maxSearchResults,
      );
    } else if (target === "georges") {
      searchService = new GeorgesSearchService(
        config.georgesDomain,
        config.maxSearchResults,
      );
    } else {
      searchService = new AmazonSearchService(
        config.amazonDomain,
        config.maxSearchResults,
      );
    }

    // Load gemini keys for this specific target (skip if NO_AI)
    let matcherService: GeminiMatcherService | null = null;
    if (!config.noAi) {
      const targetKeys = reloadGeminiKeys(target);
      matcherService = new GeminiMatcherService(
        targetKeys,
        config.mappingCategory,
        target,
      );
    } else {
      logger.info(`[NO_AI] Gemini matcher disabled — running without AI`);
    }

    for (let i = 0; i < pendingProducts.length; i++) {
      if (isShuttingDown) break;

      // Recreate page every 40 products to prevent memory leaks and crashes
      if (i > 0 && i % 40 === 0) {
        logger.info("Recreating browser page to prevent memory leaks and crashes...");
        try {
          await page.close().catch(() => {});
        } catch (e) {}
        page = await browserService.newPage();
        if (searchService && "hasSetLocation" in searchService) {
          (searchService as any).hasSetLocation = false;
        }
      }

      // Close all extra pages/tabs in the context to save memory
      try {
        const pages = page.context().pages();
        for (const p of pages) {
          if (p !== page) {
            await p.close().catch(() => {});
          }
        }
      } catch (e) {
        logger.warn(`Failed to clean up extra pages: ${(e as Error).message}`);
      }

      const product = pendingProducts[i];
      const progress = `[${i + 1}/${pendingProducts.length}]`;

      logger.info(`${progress} [${target}] Processing: ${product.productName}`);

      try {
        const result = await processSingleProduct(
          product,
          searchService,
          matcherService,
          page,
          target,
        );
        await appendResultRow(outputPath, result, activeRound);

        const statusEmoji = result.status === "matched" ? "✅" : "❌";
        const priceLog = result.amazonPrice ? ` — A$${result.amazonPrice}` : "";
        logger.info(
          `${progress} [${target}] ${statusEmoji} ${result.status}${priceLog}`,
        );
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage === "CAPTCHA_DETECTED") {
          logger.error("CAPTCHA detected! Waiting 60s...");
          await randomDelay(60000, 90000);
          i--;
          continue;
        }
        // Write error result to CSV so output file always has data
        const errorResult = buildErrorResult(product, errorMessage);
        await appendResultRow(outputPath, errorResult, activeRound);
        logger.error(`${progress} [${target}] ⚠️ Error: ${errorMessage}`);

        if (
          errorMessage === "ALL_GEMINI_KEYS_EXHAUSTED" &&
          !config.noAi &&
          matcherService
        ) {
          updateScraperStatus("paused", "ALL_GEMINI_KEYS_EXHAUSTED");
          await waitForNewGeminiKeys(
            matcherService,
            matcherService.getApiKeys(),
            target,
          );
          i--; // Retry the same product
          continue;
        }
      }

      if (i < pendingProducts.length - 1 && !isShuttingDown) {
        await randomDelay(config.requestDelayMinMs, config.requestDelayMaxMs);
      }
    }

    // Navigate to blank to clear state before the next target
    try {
      await page.goto("about:blank");
    } catch {
      // Ignore if page navigation fails on transition
    }

    try {
      const { convertCsvToExcel } = await import("./utils/excel-writer.js");
      await convertCsvToExcel(outputPath);
    } catch (e) {
      logger.error(
        `Failed to generate Excel on complete for ${target}: ${(e as Error).message}`,
      );
    }
  }

  await browserService.shutdown();
  clearScraperStatus();
  logger.info(`Done! All targets finished.`);
}

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
