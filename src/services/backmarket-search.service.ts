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
  private static sessionWarmedUp = false;

  constructor(domain: string, maxResults: number) {
    this.domain = domain;
    this.maxResults = maxResults;
  }

  /**
   * Search bar selectors — Backmarket uses various data-qa/data-test attributes.
   * We try multiple selectors to handle UI changes.
   */
  private static readonly SEARCH_INPUT_SELECTORS = [
    'input[data-qa="search-bar-input"]',
    'input[data-test="search-bar-input"]',
    'input[name="q"]',
    'input[type="search"]',
    'input[placeholder*="Search"]',
    'input[placeholder*="search"]',
    'input[aria-label*="Search"]',
    'input[aria-label*="search"]',
  ];

  async searchProduct(page: Page, productQuery: string): Promise<AmazonSearchResult[]> {
    try {
      if (!BackmarketSearchService.loggedInChecked) {
        await this.ensureLoggedIn(page);
        BackmarketSearchService.loggedInChecked = true;
      }

      // Warm up session on first search — build "trust score" by browsing naturally
      if (!BackmarketSearchService.sessionWarmedUp) {
        await this.warmupBrowse(page);
        BackmarketSearchService.sessionWarmedUp = true;
      }

      // Dismiss cookie consent if present
      await this.dismissCookieConsent(page);

      // Step 1: Search via search bar (human-like) — with fallback to URL navigation
      const searchSuccess = await this.searchViaSearchBar(page, productQuery);
      if (!searchSuccess) {
        logger.warn("Search bar interaction failed. Falling back to URL navigation...");
        await this.searchViaUrl(page, productQuery);
      }

      // Step 2: Wait for results to load naturally
      await randomDelay(2000, 4000);

      // Step 3: Simulate human reading — scroll down a bit
      await this.humanScroll(page);

      // Step 4: Extract search results with gentle DOM polling
      const results = await this.extractSearchResults(page);

      logger.info(`Found ${results.length} results on Backmarket.`);
      return results;
    } catch (error) {
      logger.error(`Backmarket Search failed: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Browse homepage naturally to build session trust before searching.
   * Backmarket scores sessions — cold sessions that jump to search are flagged.
   */
  private async warmupBrowse(page: Page): Promise<void> {
    try {
      logger.info("Warming up Backmarket session...");
      const currentUrl = page.url();
      const isAlreadyOnBackmarket = currentUrl.includes(this.domain);

      if (!isAlreadyOnBackmarket) {
        await page.goto(`https://${this.domain}/en-au`, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await randomDelay(2000, 4000);
      }

      // Dismiss cookie consent
      await this.dismissCookieConsent(page);

      // Simulate a human browsing: scroll around the homepage
      await this.humanScroll(page);
      await randomDelay(1000, 2000);

      // Move mouse randomly to simulate reading
      await moveMouseRandomly(page);
      await randomDelay(500, 1500);

      logger.info("Backmarket session warm-up complete.");
    } catch (err) {
      logger.warn(`Warmup browse failed: ${(err as Error).message}. Proceeding anyway.`);
    }
  }

  /**
   * Search using the on-page search bar — the natural, human way.
   * Returns true if we successfully submitted a search, false if the search bar wasn't found.
   */
  private async searchViaSearchBar(page: Page, query: string): Promise<boolean> {
    try {
      // Ensure we're on a Backmarket page where the search bar exists
      const currentUrl = page.url();
      if (!currentUrl.includes(this.domain)) {
        await page.goto(`https://${this.domain}/en-au`, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await randomDelay(1500, 2500);
      }

      // Find the search input
      let searchInput = null;
      for (const selector of BackmarketSearchService.SEARCH_INPUT_SELECTORS) {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          searchInput = el;
          logger.info(`Found search bar with selector: ${selector}`);
          break;
        }
      }

      if (!searchInput) {
        // Try clicking a search icon/button to reveal the input
        const searchTriggers = [
          '[data-qa="search-bar"]',
          '[data-test="search-bar"]',
          'button[aria-label*="Search"]',
          'button[aria-label*="search"]',
          'a[aria-label*="Search"]',
          '[data-qa="search-icon"]',
        ];
        for (const triggerSel of searchTriggers) {
          const trigger = page.locator(triggerSel).first();
          if (await trigger.isVisible({ timeout: 1000 }).catch(() => false)) {
            await trigger.click();
            await randomDelay(500, 1000);
            break;
          }
        }

        // Try finding input again after clicking trigger
        for (const selector of BackmarketSearchService.SEARCH_INPUT_SELECTORS) {
          const el = page.locator(selector).first();
          if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
            searchInput = el;
            break;
          }
        }
      }

      if (!searchInput) {
        logger.warn("Could not find Backmarket search bar.");
        return false;
      }

      // Step 1: Click the search input to focus it
      await searchInput.click();
      await randomDelay(300, 700);

      // Step 2: Clear any existing text (Ctrl+A / Cmd+A then Delete)
      const modKey = getModifierKey();
      await page.keyboard.press(`${modKey}+a`);
      await randomDelay(100, 200);
      await page.keyboard.press("Backspace");
      await randomDelay(200, 400);

      // Step 3: Type the query like a human (character by character with random delays)
      logger.info(`Typing search query: "${query}"`);
      await humanType(page, query);
      await randomDelay(500, 1200);

      // Step 4: Press Enter to submit the search
      await page.keyboard.press("Enter");
      logger.info("Search submitted via Enter key.");

      // Step 5: Wait for navigation / search results page to load
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await randomDelay(1500, 3000);

      return true;
    } catch (err) {
      logger.warn(`Search bar interaction error: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Fallback: Navigate directly to search URL (less stealthy, but works if search bar fails).
   */
  private async searchViaUrl(page: Page, query: string): Promise<void> {
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `https://${this.domain}/en-au/search?q=${encodedQuery}`;
    logger.info(`Fallback: navigating to ${searchUrl}`);

    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await randomDelay(2000, 3000);
  }

  /**
   * Dismiss cookie/consent modals if visible.
   */
  private async dismissCookieConsent(page: Page): Promise<void> {
    try {
      const cookieButton = page.locator(
        '#btn-toggle-save, button:has-text("Save"), button:has-text("Accept"), [data-qa="accept-cta"]'
      ).first();
      if (await cookieButton.isVisible({ timeout: 2000 })) {
        await cookieButton.click({ force: true }).catch(() => {});
        await randomDelay(800, 1500);
      }
    } catch (_) {
      // No consent modal — that's fine
    }
  }

  /**
   * Simulate human scrolling behavior on the current page.
   */
  private async humanScroll(page: Page): Promise<void> {
    try {
      const scrollSteps = Math.floor(Math.random() * 3) + 1; // 1-3 scrolls
      for (let i = 0; i < scrollSteps; i++) {
        const scrollAmount = Math.floor(Math.random() * 300) + 100; // 100-400px
        await page.mouse.wheel(0, scrollAmount);
        await randomDelay(300, 800);
      }
    } catch (_) {
      // Scroll failed — non-critical
    }
  }

  /**
   * Extract search results from the page with gentle DOM polling (250ms instead of 50ms).
   * Waits naturally for results to appear rather than aggressively racing.
   */
  private async extractSearchResults(page: Page): Promise<AmazonSearchResult[]> {
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

      // Only treat "no results" messages after at least 5 seconds of waiting
      // (gives time for legitimate results to render via JS)
      const elapsed = Date.now() - start;
      if (elapsed > 5000) {
        const bodyText = document.body.innerText;
        if (bodyText.includes("Nothing to see here") ||
            bodyText.includes("No results") ||
            bodyText.includes("We couldn't find")) {
          return [];
        }
      }

      return null; // Keep waiting
    }, { max: this.maxResults, start: startTime }, {
      timeout: 25000,
      polling: 250,  // Gentle polling — less detectable than 50ms
    }).catch((e) => {
      logger.warn(`Result extraction timed out: ${e.message}`);
      return null;
    });

    return handle ? (await handle.jsonValue() as AmazonSearchResult[]) : [];
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
