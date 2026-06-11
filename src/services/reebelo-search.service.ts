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
      const searchInputExists = await page.$('input[type="text"], input[type="search"]');
      if (!searchInputExists) {
        await page.goto(`https://${this.domain}/search`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await randomDelay(2000, 3000);
      }

      // Re-try filling search
      const searchInput = await page.waitForSelector('input[type="text"], input[type="search"]', { timeout: 10000 });
      await searchInput?.fill('');
      
      // Type with delay
      for (const char of query) {
        await searchInput?.type(char, { delay: Math.random() * 200 + 100 });
      }
      
      await randomDelay(500, 1000);
      await page.keyboard.press('Enter');
      
      // Wait for search results to load
      await randomDelay(4000, 5000);
    } catch (e) {
      logger.warn(`UI search failed for "${query}", falling back to direct URL...`);
      const searchUrl = `https://${this.domain}/search?q=${encodeURIComponent(query)}`;
      logger.info(`Direct URL: ${searchUrl}`);
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await randomDelay(4000, 5000);
    }

    const results = await page.evaluate((maxResults) => {
      const items: any[] = [];
      
      // Let's log some information to help debug
      const divs = Array.from(document.querySelectorAll('div'));
      console.log("DEBUG: Total divs: " + divs.length);
      
      // Try to find elements that look like a product card
      const productElements = divs.filter(el => {
        const text = el.innerText || "";
        // Look for price pattern AND a link
        return text.includes('A$') && el.querySelectorAll('a').length > 0;
      });
      
      console.log("DEBUG: Found " + productElements.length + " potential product containers.");
      
      // Find the first link inside this container, which likely is the product link
      const filteredProducts = [];
      for (const el of productElements) {
        const a = el.querySelector('a');
        if (!a) continue;
        
        const title = el.innerText.trim().split('\n')[0].trim();
        const url = a.getAttribute('href') || "";
        const fullUrl = url.startsWith('http') ? url : (url.startsWith('/') ? `https://${window.location.host}${url}` : `https://${window.location.host}/${url}`);
        
        let price = null;
        const priceText = el.innerText.match(/A\$([0-9,.]+)/);
        if (priceText) {
          price = parseFloat(priceText[1].replace(/,/g, ""));
        }

        if (title && fullUrl && (fullUrl.includes('/products/') || fullUrl.includes('/p/') || fullUrl.includes('/collections/'))) {
          // EXCLUSION: Skip known irrelevant accessories
          if (title.toLowerCase().includes('tempered glass protector') || title.toLowerCase().includes('protector')) continue;

          console.log("DEBUG: Found product: " + title + " at " + fullUrl);
          filteredProducts.push({ title, price, url: fullUrl, rating: null, reviewCount: null, isPrime: false });
          
          if (filteredProducts.length >= 10) break;
        }
      }
      return filteredProducts;
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

    const broadQuery = getBroadSearchQuery(productQuery);
    logger.info(`Searching Reebelo with broad query: ${broadQuery}`);
    let results = await this.performSearch(page, broadQuery);

    if (results.length === 0) {
      return results;
    }

    // Rank results based on specs
    const targetSpecs = extractSpecs(productQuery);
    
    const rankedResults = results.map(result => {
      let score = 0;
      const titleLower = result.title.toLowerCase();

      // Score based on storage match
      for (const storage of targetSpecs.storage) {
        if (titleLower.includes(storage.toLowerCase())) score += 10;
      }

      // Score based on color match
      for (const color of targetSpecs.colors) {
        if (titleLower.includes(color.toLowerCase())) score += 5;
      }

      return { result, score };
    });

    // Sort by score descending
    rankedResults.sort((a, b) => b.score - a.score);
    
    // Return sorted results
    return rankedResults.map(r => r.result);
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
