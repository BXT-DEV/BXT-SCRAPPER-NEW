// ============================================================
// Reebelo Search Service
// Scrapes Reebelo search results and selects variants
// ============================================================

import type { Page } from "playwright";
import type { AmazonSearchResult, BecexProduct } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { randomDelay } from "../utils/delay.js";
import { extractSpecs, getBroadSearchQuery } from "../utils/product-utils.js";
import { loadRules } from "../utils/rules-manager.js";

export class ReebeloSearchService {
  private readonly domain: string;
  private readonly maxResults: number;
  private hasSetLocation = false;

  constructor(domain: string, maxResults: number) {
    this.domain = domain;
    this.maxResults = maxResults;
  }

  private async performSearch(page: Page, query: string): Promise<AmazonSearchResult[]> {
    logger.info(`Searching Reebelo for: "${query}"`);
    try {
      // Ensure we are on a page where the search bar exists
      const searchInputExists = await page.$('#e2e-searchbar-search-input');
      if (!searchInputExists) {
        await page.goto(`https://${this.domain}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await randomDelay(2000, 3000);
      }

      await page.fill('#e2e-searchbar-search-input', ''); // Clear existing
      await page.fill('#e2e-searchbar-search-input', query);
      await randomDelay(500, 1000);
      await page.click('#e2e-searchbar-search-button');
      
      // Wait for search results to load (SPA transition or full reload)
      await randomDelay(4000, 5000);
    } catch (e) {
      logger.warn(`UI search failed for "${query}", falling back to direct URL...`);
      const searchUrl = `https://${this.domain}/search?q=${encodeURIComponent(query)}`;
      logger.info(`Direct URL: ${searchUrl}`);
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await randomDelay(2000, 3000);
    }

    const results = await page.evaluate((maxResults) => {
      const items: any[] = [];
      // Look for product cards: try more robust selectors
      // Reebelo might use different structures; look for containers that link to product pages
      const cards = document.querySelectorAll('a[href*="/products/"], div[data-testid*="product-card"], article, .product-item, .search-result-item');
      
      for (const card of Array.from(cards).slice(0, maxResults)) {
        // Look for title and price inside the container
        const titleEl = card.querySelector('h2, h3, [data-testid="product-title"], .product-title, .title');
        const priceEl = card.querySelector('[data-testid="product-price"], .price, .product-price');
        
        // Ensure we have a way to navigate to the product
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

  async searchProduct(page: Page, productQuery: string): Promise<AmazonSearchResult[]> {
    if (!this.hasSetLocation) {
      logger.info("Setting Reebelo location to 3175...");
      await page.goto(`https://${this.domain}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await randomDelay(2000, 3000);

      try {
        // Try multiple selectors for location trigger
        const locationTriggerSelectors = ['img[alt="Deliver to"]', '[data-testid="delivery-location"]', '.delivery-location-trigger'];
        let triggerClicked = false;
        
        for (const selector of locationTriggerSelectors) {
          const trigger = await page.$(selector);
          if (trigger) {
            await trigger.click();
            triggerClicked = true;
            await randomDelay(1000, 2000);
            break;
          }
        }
        
        if (!triggerClicked) {
          logger.warn("Could not find location trigger.");
        }

        // Find input with more robust selector
        const zipInput = await page.waitForSelector('input[placeholder*="zipcode"], input[placeholder*="postcode"]', { timeout: 5000 }).catch(() => null);
        
        if (zipInput) {
          await zipInput.fill('3175');
          await randomDelay(500, 1000);

          // Click Apply: search for buttons containing "Apply" text
          const applyBtn = await page.evaluateHandle(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            return btns.find(b => b.textContent?.trim().toLowerCase() === 'apply' || b.textContent?.trim().toLowerCase() === 'save');
          });
          
          if (applyBtn && applyBtn.asElement()) {
            await applyBtn.asElement()?.click();
            await randomDelay(2000, 3000);
            logger.info("Location successfully set to 3175.");
          } else {
            logger.warn("Could not find Apply/Save button in location modal.");
          }
        } else {
          logger.warn("Could not find zipcode input field.");
        }
      } catch (e) {
        logger.warn(`Error setting location: ${(e as Error).message}`);
      }
      this.hasSetLocation = true;
    }

    let results = await this.performSearch(page, productQuery);
    
    if (results.length === 0) {
      const broadQuery = getBroadSearchQuery(productQuery);
      if (broadQuery !== productQuery) {
        logger.info(`Retrying Reebelo search with broad query: ${broadQuery}`);
        results = await this.performSearch(page, broadQuery);
      }
    }

    return results;
  }

  async selectVariantsAndGetPrice(page: Page, product: BecexProduct): Promise<{price: number | null, cleanUrl: string}> {
    logger.info(`Selecting Reebelo variants for: ${product.productName}`);
    await randomDelay(2000, 3000);

    const rulesConfig = loadRules();
    const catRules = rulesConfig["MAPPING REFURBISHED"];
    const pristineSuffix = catRules?.skuMappings?.Pristine || "-VR-ASN-AU";
    const excellentSuffix = catRules?.skuMappings?.Excellent || "-RD-VR-EXD-AU";

    const specs = extractSpecs(product.productName);
    const isPristine = product.sku.endsWith(pristineSuffix);
    const isExcellent = product.sku.endsWith(excellentSuffix);

    const storeRules = catRules?.stores?.reebelo;

    // 1. Condition selection
    if (isPristine && storeRules?.conditionMapping?.Pristine) {
      await this.clickOrThrow(page, storeRules.conditionMapping.Pristine, "Condition: Pristine");
    } else if (isExcellent && storeRules?.conditionMapping?.Excellent) {
      await this.clickOrThrow(page, storeRules.conditionMapping.Excellent, "Condition: Excellent");
    }

    // 2. Storage selection
    if (specs.storage.length > 0) {
      await this.clickOrThrow(page, specs.storage, "Storage");
    }

    // 3. Color selection
    if (specs.colors.length > 0) {
      await this.clickOrThrow(page, specs.colors, "Color");
    }

    // 4. Connectivity selection
    if (specs.connectivity.length > 0) {
      await this.clickOrThrow(page, specs.connectivity, "Connectivity");
    }

    // 5. Battery selection
    if (storeRules?.batteryPolicy === "Standard Only") {
      const batterySuccess = await this.clickVariantByText(page, ["Standard Battery", "Standard"]);
      if (!batterySuccess) {
        const hasOtherBatteryOptions = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, div[role="button"], label, span'));
          return buttons.some(btn => {
            const txt = btn.textContent?.toLowerCase() || '';
            return (txt.includes('elevated') || txt.includes('new battery')) && txt.length < 30;
          });
        });
        if (hasOtherBatteryOptions) {
          throw new Error("REQUIRED_VARIANT_NOT_FOUND: Standard Battery (Only Elevated or New Battery option is available)");
        }
      }
    }

    // 6. SIM selection
    if (storeRules?.simPolicy === "Physical Only") {
      const simSuccess = await this.clickVariantByText(page, ["Physical SIM", "Dual SIM", "Nano-SIM", "Single SIM"]);
      if (!simSuccess) {
        const hasEsimOption = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, div[role="button"], label, span'));
          const title = document.querySelector('h1')?.innerText || '';
          if (title.toLowerCase().includes('esim')) return true;
          return buttons.some(btn => {
            const txt = btn.textContent?.toLowerCase() || '';
            return txt.includes('esim') && txt.length < 30;
          });
        });
        if (hasEsimOption) {
          throw new Error("REQUIRED_VARIANT_NOT_FOUND: Physical SIM (Only eSIM option is available)");
        }
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

    return { price, cleanUrl: page.url() };
  }

  private async clickOrThrow(page: Page, texts: string[], variantName: string): Promise<void> {
    const success = await this.clickVariantByText(page, texts);
    if (!success) {
      throw new Error(`REQUIRED_VARIANT_NOT_FOUND: ${variantName} (${texts.join(", ")})`);
    }
  }

  private async clickVariantByText(page: Page, texts: string[]): Promise<boolean> {
    try {
      const buttons = await page.$$('button, div[role="button"], label, span');
      for (const btn of buttons) {
        const text = await btn.textContent();
        if (text && texts.some(t => text.toLowerCase() === t.toLowerCase() || (text.toLowerCase().includes(t.toLowerCase()) && text.length < 30))) {
          // Check if it's actually clickable or already selected
          const isVisible = await btn.isVisible();
          const isEnabled = await btn.isEnabled();
          if (isVisible && isEnabled) {
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
