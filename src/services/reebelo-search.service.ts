// ============================================================
// Reebelo Search Service
// Scrapes Reebelo search results and selects variants
// ============================================================

import type { Page } from "playwright";
import type { AmazonSearchResult, BecexProduct } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { randomDelay } from "../utils/delay.js";

export class ReebeloSearchService {
  private readonly domain: string;
  private readonly maxResults: number;
  private hasSetLocation = false;

  constructor(domain: string, maxResults: number) {
    this.domain = domain;
    this.maxResults = maxResults;
  }

  async searchProduct(page: Page, productQuery: string): Promise<AmazonSearchResult[]> {
    if (!this.hasSetLocation) {
      logger.info("Setting Reebelo location to 3175...");
      await page.goto(`https://${this.domain}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await randomDelay(2000, 3000);

      try {
        // Try to click location trigger
        await page.click('img[alt="Deliver to"]', { timeout: 10000 });
        await randomDelay(1000, 2000);

        // Find input inside the modal
        const zipInput = await page.$('input[placeholder="Enter your zipcode"]');
        if (zipInput) {
          await zipInput.fill('3175');
          await randomDelay(500, 1000);

          // Click Apply
          const applyBtn = await page.evaluateHandle(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            return btns.find(b => b.textContent?.trim().toLowerCase() === 'apply');
          });
          if (applyBtn && applyBtn.asElement()) {
            await applyBtn.asElement()?.click();
            await randomDelay(2000, 3000);
            logger.info("Location successfully set to 3175.");
          }
        }
      } catch (e) {
        logger.warn("Could not set location, proceeding anyway...");
      }
      this.hasSetLocation = true;
    }

    logger.info(`Searching Reebelo for: ${productQuery}`);
    try {
      // Ensure we are on a page where the search bar exists
      const searchInputExists = await page.$('#e2e-searchbar-search-input');
      if (!searchInputExists) {
        await page.goto(`https://${this.domain}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await randomDelay(2000, 3000);
      }

      await page.fill('#e2e-searchbar-search-input', ''); // Clear existing input
      for (const char of productQuery) {
        await page.type('#e2e-searchbar-search-input', char);
        await randomDelay(50, 180); // Random typing delay per character
      }
      await randomDelay(500, 1000);
      await page.click('#e2e-searchbar-search-button');
      
      // Wait for search results to load (SPA transition or full reload)
      await randomDelay(4000, 5000);
    } catch (e) {
      logger.warn("UI search failed, falling back to direct URL...");
      const searchUrl = `https://${this.domain}/search?q=${encodeURIComponent(productQuery)}`;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await randomDelay(2000, 3000);
    }

    const results = await page.evaluate((maxResults) => {
      const items: any[] = [];
      // This selector needs to be adjusted based on Reebelo's actual DOM
      const cards = document.querySelectorAll('a[href*="/products/"], div[data-testid="product-card"]');
      
      for (const card of Array.from(cards).slice(0, maxResults)) {
        const titleEl = card.querySelector('h2, h3, [data-testid="product-title"]');
        const priceEl = card.querySelector('[data-testid="product-price"], .price');
        const aEl = card.tagName === 'A' ? card : card.querySelector('a');
        
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

    logger.info(`Found ${results.length} results on Reebelo.`);
    return results;
  }

  async selectVariantsAndGetPrice(page: Page, product: BecexProduct): Promise<{price: number | null, cleanUrl: string}> {
    logger.info("Selecting Reebelo variants based on mapping rules...");
    await randomDelay(2000, 3000);

    const isPristine = product.sku.endsWith("-VR-ASN-AU");
    const isExcellent = product.sku.endsWith("-RD-VR-EXD-AU");

    // 1. Condition selection
    let conditionSuccess = false;
    if (isPristine) {
      conditionSuccess = await this.clickVariantByText(page, ["Premium", "Pristine"]);
    } else if (isExcellent) {
      conditionSuccess = await this.clickVariantByText(page, ["Excellent"]);
    } else {
      // For other refurbished types if any
      conditionSuccess = true; 
    }

    if (!conditionSuccess) {
      throw new Error(`REQUIRED_VARIANT_NOT_FOUND: Condition (${isPristine ? "Premium" : "Excellent"})`);
    }

    // 2. Battery selection (Strict: Standard only)
    const batterySuccess = await this.clickVariantByText(page, ["Standard Battery", "Standard"]);
    if (!batterySuccess) {
      // Some listings might not have battery choices (if they only have one type)
      // but we should at least check if "Elevated" or "New" is NOT selected.
      logger.warn("Could not explicitly click 'Standard Battery'. Proceeding with caution.");
    }

    // 3. SIM selection (Strict: Physical only)
    const simSuccess = await this.clickVariantByText(page, ["Physical SIM", "Dual SIM", "Nano-SIM", "Single SIM"]);
    if (!simSuccess) {
      // Check if "eSIM" is the only thing present
      const hasEsim = await page.evaluate(() => document.body.innerText.includes("eSIM"));
      if (hasEsim) {
        throw new Error("REQUIRED_VARIANT_NOT_FOUND: Physical SIM (Listing seems to be eSIM only)");
      }
    }

    await randomDelay(1000, 2000);

    const price = await page.evaluate(() => {
      const priceSelectors = ['[data-testid="product-price"]', '.price', '.current-price'];
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
      const buttons = await page.$$('button, div[role="button"], label, span');
      for (const btn of buttons) {
        const text = await btn.textContent();
        if (text && texts.some(t => text.toLowerCase() === t.toLowerCase() || (text.toLowerCase().includes(t.toLowerCase()) && text.length < 30))) {
          // Check if it's actually clickable or already selected
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
