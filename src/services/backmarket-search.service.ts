// ============================================================
// Backmarket Search Service
// Scrapes Backmarket search results and selects variants
// ============================================================

import type { Page } from "playwright";
import type { AmazonSearchResult, BecexProduct } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { randomDelay } from "../utils/delay.js";
import { humanType, humanClick, moveMouseRandomly, getModifierKey } from "../utils/human-interaction.js";
import fs from "fs";
import path from "path";

const DEBUG_DIR = "debug";

/**
 * Save a debug screenshot + HTML dump when something goes wrong.
 */
async function saveDebugSnapshot(page: Page, label: string): Promise<void> {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const timestamp = Date.now();
    const safeName = label.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 40);

    await page.screenshot({ path: path.join(DEBUG_DIR, `${safeName}_${timestamp}.png`), fullPage: false });

    const html = await page.content();
    fs.writeFileSync(path.join(DEBUG_DIR, `${safeName}_${timestamp}.html`), html);

    const title = await page.title();
    const url = page.url();
    logger.info(`[DEBUG] Screenshot saved. Title: "${title}", URL: ${url}`);
  } catch (err) {
    logger.warn(`Debug snapshot failed: ${(err as Error).message}`);
  }
}

export class BackmarketSearchService {
  private readonly domain: string;
  private readonly maxResults: number;

  constructor(domain: string, maxResults: number) {
    this.domain = domain;
    this.maxResults = maxResults;
  }

  async searchProduct(page: Page, productQuery: string): Promise<AmazonSearchResult[]> {
    try {
      const currentUrl = page.url();
      const isAlreadyOnBackmarket = currentUrl.includes(this.domain);

      if (!isAlreadyOnBackmarket) {
        logger.info(`Visiting Backmarket homepage...`);
        await page.goto(`https://${this.domain}/en-au`, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await page.waitForLoadState("load").catch(() => {});
        await randomDelay(2000, 4000);
      }

      logger.info(`Searching: "${productQuery}"`);

      // Find search input
      const searchInputSelector = "input#search, input[data-qa='search-bar-input']";
      
      try {
        await page.waitForSelector(searchInputSelector, { state: "visible", timeout: 10000 });
      } catch {
        logger.error("Search box not visible. Saving debug snapshot...");
        await saveDebugSnapshot(page, "no_searchbox_backmarket");
        throw new Error("SEARCH_BOX_NOT_FOUND");
      }

      // Use human-like interactions
      await moveMouseRandomly(page);
      await humanClick(page, searchInputSelector);
      await randomDelay(300, 700);

      // Clear existing text if any
      const modifier = getModifierKey();
      await page.keyboard.down(modifier);
      await page.keyboard.press("a");
      await page.keyboard.up(modifier);
      await page.keyboard.press("Backspace");
      await randomDelay(400, 800);

      // Type new query using human-like utility
      await humanType(page, productQuery);

      await randomDelay(500, 1200);
      await page.keyboard.press("Enter");

      // Wait for navigation
      await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
      
      // Wait for search results grid
      await page.waitForFunction(() => {
        return (
          !!document.querySelector('a[data-qa="product-thumb"]') ||
          document.body.innerText.includes("No results") ||
          document.body.innerText.includes("We couldn't find")
        );
      }, { timeout: 15000 }).catch(() => {
        logger.warn("Timeout waiting for Backmarket search results.");
      });
      
      await randomDelay(2000, 3000);

    const results = await page.evaluate((maxResults) => {
      const items: any[] = [];
      const cards = document.querySelectorAll('a[data-qa="product-thumb"]');
      
      for (const card of Array.from(cards).slice(0, maxResults)) {
        const titleEl = card.querySelector('h2');
        const priceEl = card.querySelector('[data-qa="price"]');
        
        if (!titleEl) continue;

        const title = titleEl.textContent?.trim() || "";
        const rawUrl = card.getAttribute('href') || "";
        const url = rawUrl.startsWith('http') ? rawUrl : `https://${window.location.host}${rawUrl}`;
        
        let price = null;
        if (priceEl) {
          const match = priceEl.textContent?.replace(/[^0-9.]/g, "");
          if (match) price = parseFloat(match);
        }

        items.push({ title, price, url, rating: null, reviewCount: null, isPrime: false });
      }
      return items;
    }, this.maxResults);

      logger.info(`Found ${results.length} results on Backmarket.`);
      return results;
    } catch (error) {
      logger.error(`Backmarket Search failed: ${(error as Error).message}`);
      return [];
    }
  }

  async selectVariantsAndGetPrice(page: Page, product: BecexProduct): Promise<{price: number | null, cleanUrl: string}> {
    logger.info("Selecting Backmarket variants based on mapping rules...");
    await randomDelay(2000, 3000);

    const isPristine = product.sku.endsWith("-VR-ASN-AU");
    const isExcellent = product.sku.endsWith("-RD-VR-EXD-AU");

    // 1. Condition selection
    let conditionSuccess = false;
    if (isPristine) {
      conditionSuccess = await this.clickVariantByText(page, ["Excellent"]);
    } else if (isExcellent) {
      conditionSuccess = await this.clickVariantByText(page, ["Good"]);
    } else {
      conditionSuccess = true;
    }

    if (!conditionSuccess) {
      throw new Error(`REQUIRED_VARIANT_NOT_FOUND: Condition (${isPristine ? "Excellent" : "Good"})`);
    }

    // 2. SIM rules (Strict: Physical only)
    const simSuccess = await this.clickVariantByText(page, ["Physical SIM", "Dual SIM", "Nano-SIM"]);
    if (!simSuccess) {
       // Backmarket usually displays SIM type in the title or a badge if it's specific
       const pageText = await page.evaluate(() => document.body.innerText);
       if (pageText.includes("eSIM") && !pageText.includes("Physical SIM")) {
         throw new Error("REQUIRED_VARIANT_NOT_FOUND: Physical SIM (Listing seems to be eSIM only)");
       }
    }

    await randomDelay(1000, 2000);

    const price = await page.evaluate(() => {
      const priceSelectors = ['[data-qa="price"]', '.price'];
      for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const match = el.textContent?.replace(/[^0-9.]/g, "");
          if (match) return parseFloat(match);
        }
      }
      return null;
    });

    return { price, cleanUrl: page.url().split('?')[0] };
  }

  private async clickVariantByText(page: Page, texts: string[]): Promise<boolean> {
    try {
      const buttons = await page.$$('button, label, [role="button"], span');
      for (const btn of buttons) {
        const text = await btn.textContent();
        if (text && texts.some(t => text.toLowerCase() === t.toLowerCase() || (text.toLowerCase().includes(t.toLowerCase()) && text.length < 30))) {
          const isVisible = await btn.isVisible();
          if (isVisible) {
            await btn.click({ force: true }).catch(() => {});
            await randomDelay(500, 1000);
            return true;
          }
        }
      }
      return false;
    } catch (e) {
      logger.warn(`Error while looking for variant: ${texts.join(" or ")}`);
      return false;
    }
  }
}
