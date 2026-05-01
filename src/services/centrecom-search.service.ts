// ============================================================
// Centre Com Search Service
// Scrapes Centre Com search results for laptops
// ============================================================

import type { Page } from "playwright";
import type { AmazonSearchResult } from "../types/index.js";
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

export class CentrecomSearchService {
  private readonly domain: string;
  private readonly maxResults: number;

  constructor(domain: string, maxResults: number) {
    this.domain = domain;
    this.maxResults = maxResults;
  }

  async searchProduct(page: Page, productQuery: string): Promise<AmazonSearchResult[]> {
    try {
      const currentUrl = page.url();
      const isAlreadyOnCentrecom = currentUrl.includes(this.domain) && currentUrl !== 'about:blank';

      if (!isAlreadyOnCentrecom) {
        logger.info(`Visiting Centre Com homepage...`);
        await page.goto(`https://${this.domain}`, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await page.waitForLoadState("load").catch(() => {});
        await randomDelay(2000, 4000);
      }

      // Detect CAPTCHA challenges
      const hasCaptcha = await page.evaluate(() => {
        const body = document.body.innerText.toLowerCase();
        const title = document.title.toLowerCase();
        return (
          body.includes("captcha") ||
          body.includes("verify you are human") ||
          body.includes("confirm you are human") ||
          body.includes("robot") ||
          title.includes("captcha") ||
          title.includes("security check") ||
          !!document.querySelector("iframe[src*='captcha']") ||
          !!document.querySelector("iframe[src*='recaptcha']") ||
          !!document.querySelector("#captcha") ||
          !!document.querySelector(".g-recaptcha")
        );
      });

      if (hasCaptcha) {
        logger.error("CAPTCHA detected on Centre Com! Waiting for manual resolution or retry...");
        await saveDebugSnapshot(page, "captcha_centrecom");
        throw new Error("CAPTCHA_DETECTED");
      }

      logger.info(`Searching: "${productQuery}"`);

      // Find search input
      const searchInputSelector = "input.search-box-text, input.search_textfield, #custom-search-input input[type='search']";
      
      try {
        await page.waitForSelector(searchInputSelector, { state: "visible", timeout: 10000 });
      } catch {
        logger.error("Search box not visible. Saving debug snapshot...");
        await saveDebugSnapshot(page, "no_searchbox_centrecom");
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
      
      // Click search button or press Enter
      const searchButtonSelector = "input.search-box-button, button[type='submit']";
      await page.click(searchButtonSelector).catch(() => page.keyboard.press("Enter"));

      // Wait for navigation
      await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
      
      // Wait for search results grid
      await page.waitForFunction(() => {
        return (
          !!document.querySelector('.product-box, .product-item, .card') ||
          document.body.innerText.includes("We couldn't find any products") ||
          document.body.innerText.includes("No results") ||
          document.body.innerText.includes("No products were found")
        );
      }, { timeout: 15000 }).catch(() => {
        logger.warn("Timeout waiting for Centre Com search results.");
      });
      
      await randomDelay(2000, 3000);

    const results = await page.evaluate((maxResults) => {
      const items: any[] = [];
      const cards = document.querySelectorAll('.product-box, .product-item, .card');
      
      for (const card of Array.from(cards).slice(0, maxResults)) {
        const titleEl = card.querySelector('.product-title, h2, h3, a');
        const priceEl = card.querySelector('.price, .product-price');
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

      logger.info(`Found ${results.length} results on Centre Com.`);
      return results;
    } catch (error) {
      logger.error(`Centre Com Search failed: ${(error as Error).message}`);
      return [];
    }
  }
}
