// ============================================================
// Amazon Search Service
// Scrapes Amazon search results page for product listings
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
    const captchaForm = document.querySelector("form[action*='validateCaptcha']");
    const captchaImage = document.querySelector("img[src*='captcha']");
    const captchaTitle = document.title.toLowerCase().includes("robot check");
    const sorryPage = document.querySelector("#captchacharacters");
    return !!(captchaForm || captchaImage || captchaTitle || sorryPage);
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

/**
 * Searches Amazon by typing into the search box to simulate human behavior.
 */
export class AmazonSearchService {
  private readonly amazonDomain: string;
  private readonly maxResults: number;

  constructor(amazonDomain: string, maxResults: number) {
    this.amazonDomain = amazonDomain;
    this.maxResults = maxResults;
  }

  /**
   * Search Amazon by reusing the current page if already on Amazon.
   * Only navigates to the homepage on the first call.
   */
  async searchProduct(
    page: Page,
    productQuery: string
  ): Promise<AmazonSearchResult[]> {
    try {
      const currentUrl = page.url();
      const isAlreadyOnAmazon = currentUrl.includes(this.amazonDomain);

      if (!isAlreadyOnAmazon) {
        logger.info(`Visiting Amazon via organic Ad Link...`);
        // Using an organic ad link ensures traffic appears human
        const organicAdUrl = "https://www.google.com/aclk?sa=L&pf=1&ai=DChsSEwiVpOfmkoGUAxVTP4MDHaVDE2UYACICCAEQARoCc2Y&co=1&ase=2&gclid=CjwKCAjw46HPBhAMEiwASZpLRFOgApD-IWR4k1q4BveGWmORsDK5KJFV1k9upgntMCss8Fp47OOcURoCF9UQAvD_BwE&ei=FZXoab_QIoCZ4-EPqP7Z6Q4&cid=CAASugHkaPjHD4F0cVmMg6m0fEFK0W9RPXHkwGhbFCC-mE4Kj06hT4uBKi-qAIAZlQOMXQoHBCu71Cz2qe7_UAOkVfhoIVAQ-tmZMK_7sLS7SFE5ZSB3i9xpvxAprc9T8QejeGZb6XD3O_vBaU6f7hylXlbOIkwMU1CicJTzZPtgXjucEce-N2BuxIrpa59zPyEkghSfPwqvzHOljYigkgxfjQDnfYSkC4MQrB8VUIYqj9_i7O6GHkMQotv5Vn4&cce=2&category=acrcp_v1_32&sig=AOD64_3ae5FwiShnQku5FXygOZoa4wOBqw&q&sqi=2&nis=4&adurl=https://www.amazon.com.au/b?ie%3DUTF8%26node%3D8125191051%26gad_source%3D1%26gad_campaignid%3D22605646973%26gbraid%3D0AAAAA9f922JYFucfJtTsJ9gdPK5W7W1K7%26gclid%3DCjwKCAjw46HPBhAMEiwASZpLRFOgApD-IWR4k1q4BveGWmORsDK5KJFV1k9upgntMCss8Fp47OOcURoCF9UQAvD_BwE&ved=2ahUKEwj_ruHmkoGUAxWAzDgGHSh_Nu0Q0Qx6BAgNEAE";
        
        await page.goto(organicAdUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });

        // Wait for the Amazon page to fully render
        await page.waitForLoadState("load").catch(() => {});
        await randomDelay(2000, 4000);

        // Set delivery postcode to 3175 Dandenong
        await this.setDeliveryPostcode(page);
      }

      // Check for CAPTCHA
      if (await detectCaptcha(page)) {
        logger.error(`Blocked by CAPTCHA: ${await page.title()}`);
        await saveDebugSnapshot(page, "captcha");
        throw new Error("CAPTCHA_DETECTED");
      }

      logger.info(`Searching: "${productQuery}"`);

      // Ensure we search in "All Departments" to avoid being restricted to a sub-category node
      const selectCategory = await page.$("select#searchDropdownBox");
      if (selectCategory) {
        await selectCategory.selectOption({ label: "All Departments" }).catch(() => {});
      }

      // Find search input — wait for it explicitly
      const searchInputSelector = "#twotabsearchtextbox, input[name='field-keywords']";
      
      try {
        await page.waitForSelector(searchInputSelector, { state: "visible", timeout: 10000 });
      } catch {
        logger.error("Search box not visible. Saving debug snapshot...");
        await saveDebugSnapshot(page, "no_searchbox");
        throw new Error("SEARCH_BOX_NOT_FOUND");
      }

      // Use human-like interactions
      await moveMouseRandomly(page);
      await humanClick(page, searchInputSelector);
      await randomDelay(300, 700);

      // Select all and clear existing text (if any)
      const modifier = getModifierKey();
      await page.keyboard.down(modifier);
      await page.keyboard.press("a");
      await page.keyboard.up(modifier);
      await page.keyboard.press("Backspace");
      await randomDelay(400, 800);

      // Type new query using human-like utility
      await humanType(page, productQuery);

      await randomDelay(500, 1200);

      // Submit search
      await page.keyboard.press("Enter");

      // Wait for navigation to complete and page to settle
      await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
      
      // Wait for either the search results grid OR a "no results" message
      await page.waitForFunction(() => {
        return (
          !!document.querySelector('.s-main-slot .s-result-item') ||
          document.body.innerText.includes("No results for") ||
          document.body.innerText.includes("did not match any products") ||
          document.title.toLowerCase().includes("robot check")
        );
      }, { timeout: 15000 }).catch(() => {
        logger.warn("Timeout waiting for search results grid.");
      });
      
      // Add one more small static delay to let images and scripts hydrate fully
      await randomDelay(2000, 3000);

      if (await detectCaptcha(page)) {
        await saveDebugSnapshot(page, "captcha_results");
        throw new Error("CAPTCHA_DETECTED");
      }

      const results = await this.extractSearchResults(page);

      // Debug: save screenshot when 0 results (first 5 times only)
      if (results.length === 0) {
        logger.warn("0 results found. Saving debug snapshot...");
        await saveDebugSnapshot(page, "zero_results");
      }

      logger.info(`Found ${results.length} search results`);
      return results;
    } catch (error) {
      if (error instanceof Error && error.message === "CAPTCHA_DETECTED") throw error;
      logger.error(`Search failed: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Parse the DOM to extract product cards from Amazon search results.
   */
  private async extractSearchResults(
    page: Page
  ): Promise<AmazonSearchResult[]> {
    const results = await page.evaluate((maxResults: number) => {
      const searchResults: Array<{
        title: string;
        price: number | null;
        url: string;
        rating: number | null;
        reviewCount: number | null;
        isPrime: boolean;
      }> = [];

      // Try multiple selectors for search result containers
      const resultCards = document.querySelectorAll(
        '[data-component-type="s-search-result"], .s-result-item[data-asin]:not([data-asin=""])'
      );

      // Debug: log how many cards we found in total
      console.log(`[extractSearchResults] Found ${resultCards.length} raw cards`);

      for (const card of Array.from(resultCards).slice(0, maxResults)) {
        // Skip sponsored
        const sponsored = card.querySelector('.puis-sponsored-label-info-icon, [data-component-type="sp-sponsored-result"]');
        if (sponsored) continue;

        // Try to find the title anchor using data-cy="title-recipe" or h2
        const linkEl = card.querySelector('[data-cy="title-recipe"] a.a-link-normal') || 
                       card.querySelector("h2 a") || 
                       card.querySelector("a h2")?.closest('a');
                       
        if (!linkEl) continue;

        // Extract title
        const title = linkEl.textContent?.trim() || "";
        if (!title) continue;

        // Extract URL
        const rawHref = linkEl.getAttribute("href") || "";
        if (!rawHref) continue;
        const url = rawHref.startsWith("http") ? rawHref : `https://www.amazon.com.au${rawHref}`;

        // Extract price
        let price: number | null = null;
        const priceWhole = card.querySelector(".a-price-whole");
        const priceFraction = card.querySelector(".a-price-fraction");
        if (priceWhole) {
          const whole = priceWhole.textContent?.replace(/[^0-9]/g, "") || "0";
          const fraction = priceFraction?.textContent?.replace(/[^0-9]/g, "") || "00";
          price = parseFloat(`${whole}.${fraction}`);
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

    return results;
  }

  /**
   * Sets the delivery postcode on Amazon to "3175" (Dandenong) to ensure accurate stock/pricing.
   */
  public async setDeliveryPostcode(page: Page): Promise<void> {
    try {
      // 1. Quick check if already set
      const locationLine2 = await page.$("#glow-ingress-line2");
      if (locationLine2) {
        const locationText = (await locationLine2.textContent()) || "";
        if (locationText.includes("3175")) {
          logger.info("Delivery postcode is already set to 3175.");
          return;
        }
      }

      logger.info("Setting delivery postcode to 3175...");
      
      // 2. Open popover if not already open
      const isModalOpen = await page.evaluate(() => {
        const popover = document.querySelector(".a-popover-modal");
        return popover && window.getComputedStyle(popover).display !== "none";
      });

      if (!isModalOpen) {
        await humanClick(page, "#nav-global-location-popover-link");
        await randomDelay(2000, 3000);
      }

      // 3. Type postcode manually
      // Try both common Amazon selectors and AU-specific ones
      const inputSelectors = ["#GLUXZipUpdateInput", "#GLUXPostalCodeWithCity_PostalCodeInput", "input[id^='GLUX'][id$='Input']"];
      let inputSelector = "";
      
      for (const sel of inputSelectors) {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          inputSelector = sel;
          break;
        }
      }

      if (!inputSelector) {
        // Wait a bit more for modal content to load
        await page.waitForTimeout(2000);
        for (const sel of inputSelectors) {
          const el = await page.$(sel);
          if (el && await el.isVisible()) {
            inputSelector = sel;
            break;
          }
        }
      }

      if (!inputSelector) {
        throw new Error("Could not find postcode input field");
      }

      await page.click(inputSelector);
      
      // Clear existing value if any
      await page.keyboard.down(getModifierKey());
      await page.keyboard.press("A");
      await page.keyboard.up(getModifierKey());
      await page.keyboard.press("Backspace");
           await page.keyboard.type("3175", { delay: 100 });
      await randomDelay(1000, 1200); // Wait 1s after typing

      // New: Check for city dropdown (sometimes required in AU)
      const cityDropdownSelector = "#GLUXPostalCodeWithCity_DropdownList";
      try {
        const dropdown = await page.$(cityDropdownSelector);
        if (dropdown && await dropdown.isVisible()) {
          logger.info("City dropdown detected, selecting DANDENONG...");
          
          // Wait for options to load
          await page.waitForFunction((sel) => {
            const el = document.querySelector(sel) as HTMLSelectElement;
            return el && el.options.length > 1;
          }, cityDropdownSelector, { timeout: 5000 }).catch(() => {});

          // Select DANDENONG exactly
          await page.selectOption(cityDropdownSelector, { label: "DANDENONG" });
          logger.info("Selected DANDENONG from dropdown.");
          await randomDelay(1000, 1200); // Wait 1s after selecting city
        }
      } catch (e) {
        logger.warn(`City dropdown selection failed: ${(e as Error).message}`);
      }

      // 4. Click Apply/Update button
      const applyBtnSelectors = [
        "#GLUXPostalCodeWithCityApplyButton input",
        "span[data-action='GLUXPostalUpdateAction'] input",
        "#GLUXZipUpdate input",
        "input[aria-labelledby='GLUXZipUpdate-announce']",
        ".GLUX_Popover input[type='submit']"
      ];
      
      let applyBtnClicked = false;
      for (const sel of applyBtnSelectors) {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          logger.info(`Clicking Apply button: ${sel}`);
          await btn.click();
          applyBtnClicked = true;
          break;
        }
      }

      if (!applyBtnClicked) {
        const applyBtnByText = await page.$("span:has-text('Apply')");
        if (applyBtnByText) {
          await applyBtnByText.click();
          applyBtnClicked = true;
        }
      }

      // Wait for page to reload/navigation
      logger.info("Waiting for page reload after applying postcode...");
      await Promise.all([
        page.waitForNavigation({ waitUntil: "load", timeout: 15000 }).catch(() => {}),
        randomDelay(3000, 5000)
      ]);

      // 5. Handle 'Done' or 'Continue' if it appears (sometimes stays after reload)
      const doneBtnSelectors = [
        "span.a-button[name='glowDoneButton'] input",
        "#GLUXConfirmClose",
        ".a-popover-footer input",
        "button[name='glowDoneButton']",
        ".a-popover-modal button:has-text('Done')"
      ];
      
      for (const sel of doneBtnSelectors) {
        const doneBtn = await page.$(sel);
        if (doneBtn && await doneBtn.isVisible()) {
          await doneBtn.click();
          await randomDelay(2000, 3000);
          break;
        }
      }

      // Check if page needs to be refreshed (Amazon sometimes doesn't auto-refresh)
      const locationLine2After = await page.$("#glow-ingress-line2");
      if (locationLine2After) {
        const text = await locationLine2After.textContent() || "";
        if (!text.includes("3175")) {
          logger.info("Location not updated, refreshing page...");
          await page.reload();
          await page.waitForLoadState("networkidle").catch(() => {});
          await randomDelay(2000, 3000);
        }
      }

      logger.info("Postcode setting flow completed.");
    } catch (err) {
      logger.warn(`Failed to set delivery postcode: ${(err as Error).message}`);
      // Take a screenshot for debugging if it fails
      await page.screenshot({ path: `./debug/postcode_fail_${Date.now()}.png` }).catch(() => {});
    }
  }
}
