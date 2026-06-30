/**
 * Sanity test to run Amazon search & variant selection in NO_AI mode.
 * Run: npx tsx src/test-amazon-noai.ts
 */

import { BrowserService } from "./services/browser.service.js";
import { AmazonSearchService } from "./services/amazon-search.service.js";
import { extractSpecs } from "./utils/product-utils.js";
import type { BecexProduct } from "./types/index.js";
import { logger } from "./utils/logger.js";

async function main() {
  logger.info("=============================================");
  logger.info("   Testing Amazon Search + Variant Selection ");
  logger.info("=============================================");

  const browserService = new BrowserService(null);
  
  try {
    await browserService.initialize();
    const page = await browserService.newPage();
    page.on('console', msg => logger.info(`[BROWSER] ${msg.text()}`));

    const searchService = new AmazonSearchService("amazon.com.au", 5);

    // Test product
    const product: BecexProduct = {
      sku: "iPhone125G128GBBlue-VR-ASN-AU",
      productName: "Apple iPhone 12 5G (128GB, Blue) - Pristine"
    };

    logger.info(`Starting Amazon search for: "${product.productName}"`);
    
    // Execute search (broad or smart)
    const query = "Apple iPhone 12 128GB";
    const results = await searchService.searchProduct(page, query);

    if (results.length === 0) {
      logger.error("❌ No results found on Amazon!");
      return;
    }

    logger.info(`Found ${results.length} search results. Selecting first candidate: "${results[0].title}"`);
    const candidate = results[0];

    logger.info(`Navigating to candidate URL: ${candidate.url}`);
    await page.goto(candidate.url, { waitUntil: "domcontentloaded", timeout: 30000 });

    logger.info("Running selectVariantsAndGetPrice...");
    const result = await searchService.selectVariantsAndGetPrice(page, product);

    logger.info("========================================");
    logger.info(`🎉 RESULT:`);
    logger.info(`  Price: ${result.price ? `A$${result.price}` : "N/A"}`);
    logger.info(`  Clean URL: ${result.cleanUrl}`);
    logger.info("========================================");

    // Take screenshot for verification
    const screenshotPath = "debug/amazon_noai_test.png";
    await page.screenshot({ path: screenshotPath, fullPage: false });
    logger.info(`Screenshot saved to ${screenshotPath}`);

  } catch (err) {
    logger.error(`❌ Error during test: ${(err as Error).message}`);
  } finally {
    await browserService.shutdown();
    logger.info("Done.");
  }
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
});
