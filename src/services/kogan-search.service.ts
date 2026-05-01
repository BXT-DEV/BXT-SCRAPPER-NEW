// ============================================================
// Kogan Search Service
// Scrapes Kogan.com search results page for product listings
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
 * Checks if the page is actually a CAPTCHA challenge page.
 */
async function detectCaptcha(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const isCaptchaDelivery = !!document.querySelector("iframe[src*='captcha-delivery.com']");
    const isDataDome = document.body.innerText.includes("DataDome") || document.title.includes("DataDome");
    return isCaptchaDelivery || isDataDome;
  });
}

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

export class KoganSearchService {
  private readonly domain: string;
  private readonly maxResults: number;

  constructor(domain: string, maxResults: number) {
    this.domain = domain;
    this.maxResults = maxResults;
  }

  /**
   * Search Kogan by typing into the search box.
   */
  async searchProduct(
    page: Page,
    productQuery: string
  ): Promise<AmazonSearchResult[]> {
    try {
      const currentUrl = page.url();
      const isAlreadyOnKogan = currentUrl.includes(this.domain);

      if (!isAlreadyOnKogan) {
        logger.info(`Visiting Kogan homepage...`);
        await page.goto(`https://${this.domain}`, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await page.waitForLoadState("load").catch(() => {});
        await randomDelay(2000, 4000);
      }

      // Check for CAPTCHA
      if (await detectCaptcha(page)) {
        logger.error(`Blocked by Kogan CAPTCHA: ${await page.title()}`);
        await saveDebugSnapshot(page, "captcha_kogan");
        throw new Error("CAPTCHA_DETECTED");
      }

      logger.info(`Searching: "${productQuery}"`);

      // Find search input
      const searchInputSelector = "input[role='searchbox']";
      
      try {
        await page.waitForSelector(searchInputSelector, { state: "visible", timeout: 10000 });
      } catch {
        logger.error("Search box not visible. Saving debug snapshot...");
        await saveDebugSnapshot(page, "no_searchbox_kogan");
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
          !!document.querySelector('section.grid a[href*="/buy/"]') ||
          document.body.innerText.includes("No results found") ||
          document.body.innerText.includes("We couldn't find")
        );
      }, { timeout: 15000 }).catch(() => {
        logger.warn("Timeout waiting for Kogan search results.");
      });
      
      await randomDelay(2000, 3000);

      if (await detectCaptcha(page)) {
        await saveDebugSnapshot(page, "captcha_results_kogan");
        throw new Error("CAPTCHA_DETECTED");
      }
 
      const results = await this.extractSearchResults(page);

      if (results.length === 0) {
        logger.warn("0 results found on Kogan. Saving debug snapshot...");
        await saveDebugSnapshot(page, "zero_results_kogan");
      }

      logger.info(`Found ${results.length} search results on Kogan`);
      return results;
    } catch (error) {
      if (error instanceof Error && error.message === "CAPTCHA_DETECTED") throw error;
      logger.error(`Kogan Search failed: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Parse the DOM to extract product cards from Kogan search results.
   */
  private async extractSearchResults(
    page: Page
  ): Promise<AmazonSearchResult[]> {
    return page.evaluate((maxResults: number) => {
      const searchResults: any[] = [];
      const resultCards = document.querySelectorAll('section.grid a[href*="/buy/"]');

      for (const card of Array.from(resultCards).slice(0, maxResults)) {
        const titleEl = card.querySelector('h6');
        const priceEl = card.querySelector('[aria-label^="Price:"]');

        if (!titleEl) continue;

        const title = titleEl.textContent?.trim() || "";
        const rawHref = card.getAttribute("href") || "";
        const url = rawHref.startsWith("http") ? rawHref : `https://www.kogan.com.au${rawHref}`;

        let price: number | null = null;
        if (priceEl) {
          const priceText = priceEl.getAttribute("aria-label")?.replace(/[^0-9.]/g, "") || "";
          if (priceText) price = parseFloat(priceText);
        }

        searchResults.push({
          title,
          price,
          url,
          rating: null,
          reviewCount: null,
          isPrime: false,
        });
      }

      return searchResults;
    }, this.maxResults);
  }
}
