// ============================================================
// BuyMobile Search Service
// Scrapes BuyMobile search results and selects color variants
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

export class BuymobileSearchService {
  private readonly domain: string;
  private readonly maxResults: number;

  constructor(domain: string, maxResults: number) {
    this.domain = domain;
    this.maxResults = maxResults;
  }

  async searchProduct(page: Page, productQuery: string): Promise<AmazonSearchResult[]> {
    try {
      const currentUrl = page.url();
      const isAlreadyOnBuymobile = currentUrl.includes(this.domain);

      if (!isAlreadyOnBuymobile) {
        logger.info(`Visiting BuyMobile homepage...`);
        await page.goto(`https://${this.domain}`, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await page.waitForLoadState("load").catch(() => {});
        await randomDelay(2000, 4000);
      }

      logger.info(`Searching: "${productQuery}"`);

      // Find search input
      const searchInputSelector = "form[action='/search'] input[name='q'], input[type='search'][name='q']";
      
      try {
        await page.waitForSelector(searchInputSelector, { state: "visible", timeout: 10000 });
      } catch {
        logger.error("Search box not visible. Saving debug snapshot...");
        await saveDebugSnapshot(page, "no_searchbox_buymobile");
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
      
      // Press Enter
      await page.keyboard.press("Enter");

      // Wait for navigation
      await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
      
      // Wait for search results grid
      await page.waitForFunction(() => {
        return (
          !!document.querySelector('.product-card, .grid__item, .product-item') ||
          document.body.innerText.includes("Your search for") ||
          document.body.innerText.includes("No results")
        );
      }, { timeout: 15000 }).catch(() => {
        logger.warn("Timeout waiting for BuyMobile search results.");
      });
      
      await randomDelay(2000, 3000);

    const results = await page.evaluate((maxResults) => {
      const items: any[] = [];
      const cards = document.querySelectorAll('.product-card, .grid__item, .product-item');
      
      for (const card of Array.from(cards).slice(0, maxResults)) {
        const titleEl = card.querySelector('.product-card__title, .product-title, h3');
        const priceEl = card.querySelector('.price-item--regular, .price, .money');
        const aEl = card.querySelector('a');
        
        if (!titleEl || !aEl) continue;

        const title = titleEl.textContent?.trim() || "";
        const rawUrl = aEl.getAttribute('href') || "";
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

      logger.info(`Found ${results.length} results on BuyMobile.`);
      return results;
    } catch (error) {
      logger.error(`BuyMobile Search failed: ${(error as Error).message}`);
      return [];
    }
  }

  async selectVariantsAndGetPrice(page: Page, product: BecexProduct): Promise<{price: number | null, cleanUrl: string}> {
    logger.info("Selecting BuyMobile color variants...");
    await randomDelay(2000, 3000);

    // Try to extract color from productName
    // e.g. "Samsung Galaxy S24 Ultra 5G (12GB/512GB) - Titanium Black"
    const colorMatch = product.productName.match(/-\s*([a-zA-Z\s]+?)(?:\s*-\s*Brand New)?$/i);
    if (colorMatch && colorMatch[1]) {
      const colorTarget = colorMatch[1].trim();
      logger.info(`Attempting to select color: ${colorTarget}`);
      
      try {
        const labels = await page.$$('label, .swatch, .color-swatch, button');
        for (const label of labels) {
          const text = (await label.textContent()) || "";
          const value = (await label.getAttribute('value')) || "";
          const aria = (await label.getAttribute('aria-label')) || "";
          
          const combined = `${text} ${value} ${aria}`.toLowerCase();
          
          if (combined.includes(colorTarget.toLowerCase())) {
            await label.click().catch(() => {});
            await randomDelay(1000, 2000);
            break;
          }
        }
      } catch (e) {
        logger.warn(`Could not select variant color: ${colorTarget}`);
      }
    }

    const price = await page.evaluate(() => {
      const priceSelectors = ['.price-item--sale', '.price-item--regular', '.product__price', '.price'];
      for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const match = el.textContent?.replace(/[^0-9.]/g, "");
          if (match) return parseFloat(match);
        }
      }
      return null;
    });

    return { price, cleanUrl: page.url() }; // Keep the ?variant= in URL for BuyMobile
  }
}
