// ============================================================
// Backmarket Search Service
// Scrapes Backmarket search results and selects variants
// ============================================================

import type { Page } from "playwright";
import type { AmazonSearchResult, BecexProduct } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { randomDelay } from "../utils/delay.js";
import { extractSpecs } from "../utils/product-utils.js";
import { humanType, humanClick, moveMouseRandomly, getModifierKey } from "../utils/human-interaction.js";
import { loadRules } from "../utils/rules-manager.js";
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
  private static loggedInChecked = false;

  constructor(domain: string, maxResults: number) {
    this.domain = domain;
    this.maxResults = maxResults;
  }

  async searchProduct(page: Page, productQuery: string): Promise<AmazonSearchResult[]> {
    try {
      if (!BackmarketSearchService.loggedInChecked) {
        await this.ensureLoggedIn(page);
        BackmarketSearchService.loggedInChecked = true;
      }

      // Use explicit %20 instead of + for spaces to prevent weird redirects
      // Adding a timestamp cache-buster can sometimes stop the server from "normalizing" the URL to a broken version.
      const encodedQuery = productQuery.split(' ').join('%20');
      const searchUrl = `https://${this.domain}/en-au/search?q=${encodedQuery}&t=${Date.now()}`;
      logger.info(`Searching via URL: ${searchUrl}`);
      
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await randomDelay(2000, 3000);

      // Handle Cookies (Didomi / Backmarket consent modal) - only need to do this once per session usually, but safe to check
      try {
        const cookieButton = page.locator('#btn-toggle-save, button:has-text("Save"), button:has-text("Accept")').first();
        if (await cookieButton.isVisible({ timeout: 3000 })) {
           await cookieButton.click({ force: true }).catch(() => {});
           await randomDelay(1000, 2000);
        }
      } catch (e) {}
      
      // RACING GRAB: Continuously monitor DOM and return results the moment they appear
      // This catches the data if it "flashes" before a redirect or shadowban kicks in.
      const startTime = Date.now();
      const handle = await page.waitForFunction(({ max, start }) => {
        const cardSelectors = 'a[data-qa="product-thumb"], [data-test="product-card"] a, .productCard a, a.productCard, a[href*="/en-au/p/"]';
        const cards = document.querySelectorAll(cardSelectors);
        
        if (cards.length > 0) {
          const items: any[] = [];
          for (const card of Array.from(cards).slice(0, max)) {
            const titleEl = card.querySelector('h2, .productTitle, [data-qa="product-title"]');
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
          if (items.length > 0) return items;
        }

        // Only allow "Nothing to see here" to trigger AFTER at least 3 seconds of waiting
        const elapsed = Date.now() - start;
        if (elapsed > 3000) {
          if (document.body.innerText.includes("Nothing to see here") || 
              document.body.innerText.includes("No results") || 
              document.body.innerText.includes("We couldn't find")) {
            return [];
          }
        }

        return null; // Keep waiting
      }, { max: this.maxResults, start: startTime }, { 
        timeout: 20000, 
        polling: 50 
      }).catch((e) => {
        logger.warn(`Racing Grab timed out: ${e.message}`);
        return null;
      });

      const results: AmazonSearchResult[] = handle ? (await handle.jsonValue() as AmazonSearchResult[]) : [];

      logger.info(`Found ${results.length} results on Backmarket.`);
      return results;
    } catch (error) {
      logger.error(`Backmarket Search failed: ${(error as Error).message}`);
      return [];
    }
  }

  private async ensureLoggedIn(page: Page): Promise<void> {
    try {
      logger.info("Checking Backmarket login status...");
      await page.goto(`https://${this.domain}/en-au`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await randomDelay(1000, 2000);

      // Dismiss cookies if needed
      try {
        const cookieButton = page.locator('#btn-toggle-save, button:has-text("Save"), button:has-text("Accept")').first();
        if (await cookieButton.isVisible({ timeout: 3000 })) {
           await cookieButton.click({ force: true }).catch(() => {});
        }
      } catch (e) {}

      const isLogged = await page.evaluate(() => {
        // If logout button exists anywhere (even hidden), we are logged in
        const hasLogout = !!document.querySelector('[data-test="logout-button"], a[href*="/logout"]');
        // If we see dashboard links, we are logged in
        const hasDashboard = !!document.querySelector('a[href*="/dashboard"], a[href*="/profile"]');
        return hasLogout || hasDashboard;
      });

      if (isLogged) {
        logger.info("Already logged into Backmarket.");
        return;
      }

      logger.info("Initiating Backmarket login via user icon...");
      const avatar = page.locator('[data-qa="icon-avatar"], [aria-label="Log in or sign up"]').first();
      if (await avatar.isVisible()) {
        await avatar.click();
      } else {
        logger.info("User icon not found, navigating directly to login page...");
        await page.goto(`https://${this.domain}/en-au/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
      }
      await randomDelay(2000, 3000);

      // Step 1: Email
      const emailInput = page.locator('input[name="email"], #email, [type="email"]').first();
      if (await emailInput.isVisible({ timeout: 5000 })) {
        logger.info("Entering email...");
        await emailInput.click();
        await humanType(page, "ifailamir@gmail.com");
        await randomDelay(1000, 2000);
        
        const nextBtn = page.locator('button:has-text("Next"), [type="submit"]').first();
        await nextBtn.click();
        await randomDelay(2000, 3000);
      }

      // Step 2: Password
      const passwordInput = page.locator('input[name="password"], #password, [type="password"]').first();
      if (await passwordInput.isVisible({ timeout: 10000 })) {
        logger.info("Entering password...");
        await passwordInput.click();
        await humanType(page, "Wasabi3-Clutch7-Approach1-Sank6-Devouring0");
        await randomDelay(1000, 2000);
        
        const loginBtn = page.locator('button:has-text("Log in"), [type="submit"]').first();
        await loginBtn.click();
        
        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        logger.info("Backmarket login flow completed.");
        await randomDelay(2000, 3000);
      } else {
        logger.warn("Password field did not appear. Maybe blocked or UI different.");
      }
    } catch (error) {
      logger.warn(`Backmarket login attempt failed: ${(error as Error).message}. Proceeding as guest...`);
    }
  }

  async selectVariantsAndGetPrice(page: Page, product: BecexProduct): Promise<{price: number | null, cleanUrl: string}> {
    logger.info(`Selecting Backmarket variants for: ${product.productName}`);
    await randomDelay(2000, 3000);

    const rulesConfig = loadRules();
    const catRules = rulesConfig["MAPPING REFURBISHED"];
    const pristineSuffix = catRules?.skuMappings?.Pristine || "-VR-ASN-AU";
    const excellentSuffix = catRules?.skuMappings?.Excellent || "-RD-VR-EXD-AU";

    const specs = extractSpecs(product.productName);
    const isPristine = product.sku.endsWith(pristineSuffix) || product.productName.toLowerCase().includes("pristine");
    const isExcellent = product.sku.includes(excellentSuffix) || product.sku.includes("EXD-AU") || product.productName.toLowerCase().includes("excellent");

    const storeRules = catRules?.stores?.backmarket;

    // 1. Condition selection
    if (isPristine && storeRules?.conditionMapping?.Pristine) {
      await this.clickVariantByText(page, storeRules.conditionMapping.Pristine);
    } else if (isExcellent && storeRules?.conditionMapping?.Excellent) {
      await this.clickVariantByText(page, storeRules.conditionMapping.Excellent);
    }

    // 2. Storage selection
    if (specs.storage.length > 0) {
      await this.clickVariantByText(page, specs.storage);
    }

    // 3. Color selection
    if (specs.colors.length > 0) {
      await this.clickVariantByText(page, specs.colors);
    }

    // 4. Connectivity selection
    if (specs.connectivity.length > 0) {
      await this.clickVariantByText(page, specs.connectivity);
    }

    // 5. SIM rules
    if (storeRules?.simPolicy === "Physical Only") {
      const simSuccess = await this.clickVariantByText(page, ["Physical SIM", "Dual SIM", "Nano-SIM"]);
      if (!simSuccess) {
         const isEsimOnly = await page.evaluate(() => {
           const title = document.querySelector('h1')?.innerText || '';
           return title.toLowerCase().includes('esim');
         });
         if (isEsimOnly) {
           throw new Error("REQUIRED_VARIANT_NOT_FOUND: Physical SIM (Listing title indicates eSIM only)");
         }
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

    return { price, cleanUrl: page.url() };
  }

  private async clickVariantByText(page: Page, texts: string[]): Promise<boolean> {
    try {
      for (const text of texts) {
        // Try multiple ways to find the button/label
        const selectors = [
          page.getByRole('button', { name: new RegExp(`^${text}$`, 'i') }),
          page.getByText(text, { exact: true }),
          page.locator(`button:has-text("${text}")`),
          page.locator(`label:has-text("${text}")`),
          page.locator(`span:has-text("${text}")`),
        ];

        for (const selector of selectors) {
          if (await selector.isVisible()) {
            await selector.click({ force: true });
            await randomDelay(1000, 2000);
            return true;
          }
        }
      }

      // Fallback: search for any element that might be a variant picker
      const buttons = await page.$$('button, label, [role="button"], span');
      for (const btn of buttons) {
        const text = await btn.textContent();
        if (text && texts.some(t => text.trim().toLowerCase() === t.toLowerCase())) {
          if (await btn.isVisible()) {
            await btn.click({ force: true }).catch(() => {});
            await randomDelay(1000, 2000);
            return true;
          }
        }
      }
      return false;
    } catch (e) {
      logger.warn(`Error while looking for variant: ${texts.join(" or ")} - ${(e as Error).message}`);
      return false;
    }
  }
}
