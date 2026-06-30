// ============================================================
// Amazon Search Service
// Scrapes Amazon search results page for product listings
// ============================================================

import type { Page } from "playwright";
import type { AmazonSearchResult, BecexProduct } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { randomDelay } from "../utils/delay.js";
import { humanType, humanClick, moveMouseRandomly, getModifierKey } from "../utils/human-interaction.js";
import { extractSpecs } from "../utils/product-utils.js";
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
  private isInitialized = false;

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

      if (!this.isInitialized || !isAlreadyOnAmazon) {
        logger.info(`Visiting Amazon via initial search link...`);
        // Using a search link to establish session
        const organicAdUrl = "https://www.amazon.com.au/s?k=iphone&crid=1DMGKR2XYUHGW&sprefix=%2Caps%2C286&ref=nb_sb_ss_recent_1_0_recent";
        
        await page.goto(organicAdUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        }).catch(err => {
          logger.warn(`Initial navigation warning: ${err.message}`);
        });

        // Wait for the Amazon page to fully render
        await page.waitForLoadState("load").catch(() => {});
        await randomDelay(2000, 4000);

        // Check for CAPTCHA immediately after initial load
        if (await detectCaptcha(page)) {
          logger.error(`Blocked by CAPTCHA on initial load: ${await page.title()}`);
          await saveDebugSnapshot(page, "captcha_initial");
          throw new Error("CAPTCHA_DETECTED");
        }

        // Set delivery postcode to 3175 Dandenong
        await this.setDeliveryPostcode(page);
        this.isInitialized = true;
      }

      // Check for CAPTCHA again before searching
      if (await detectCaptcha(page)) {
        logger.error(`Blocked by CAPTCHA before search: ${await page.title()}`);
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

  /**
   * Helper to clean Amazon URLs by removing search/tracking parameters.
   */
  private cleanAmazonUrl(rawUrl: string): string {
    try {
      const url = new URL(rawUrl);
      const dpMatch = url.pathname.match(/\/dp\/([A-Z0-9]{10})/);
      if (dpMatch) {
        return `https://${this.amazonDomain}/dp/${dpMatch[1]}`;
      }
      return rawUrl.split("?")[0];
    } catch {
      return rawUrl;
    }
  }

  /**
   * Helper to click a variant swatch by its text.
   */
  private async clickVariantByText(page: Page, dimension: string, texts: string[]): Promise<boolean> {
    try {
      const argsObj = { dim: dimension, targetTexts: texts };
      const evalFnStr = `
        (() => {
          const { dim, targetTexts } = ${JSON.stringify(argsObj)};
          const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, "");
          const normalizedTargets = targetTexts.map(normalize);

          // Find the specific container for this dimension
          let container = document.getElementById("inline-twister-row-" + dim) || 
                          document.getElementById("variation_" + dim) ||
                          document.querySelector("[id*=\\"" + dim + "\\"]");
                          
          if (!container) {
            // Fallback to general twister containers
            container = document.querySelector('#twister-plus-inline-twister, #inline-twister-container, #twister');
          }
          
          if (!container) return false;

          // Find all swatch-like elements inside this container
          const elements = Array.from(container.querySelectorAll('li, button, a, [role="button"], .a-declarative'));

          for (const el of elements) {
            // Ignore parent elements if they are also in the list
            if (el.querySelector('li, button, a')) {
              continue;
            }

            // Get text content (exclude style tags or scripts if any)
            let text = "";
            if (el.firstChild && el.firstChild.nodeType === 3) {
              text = el.firstChild.textContent || "";
            } else {
              const clone = el.cloneNode(true);
              const style = clone.querySelectorAll('style, script');
              style.forEach(s => s.remove());
              text = clone.textContent || "";
            }

            const title = el.getAttribute('title') || "";
            const aria = el.getAttribute('aria-label') || "";
            const id = el.getAttribute('id') || "";
            
            let imgAlt = "";
            const img = el.querySelector('img');
            if (img) {
              imgAlt = img.getAttribute('alt') || "";
            }

            const combined = text + " " + title + " " + aria + " " + id + " " + imgAlt;
            const normalizedCombined = normalize(combined);

            if (normalizedTargets.some(t => normalizedCombined.includes(t))) {
              const classList = Array.from(el.classList).join(' ').toLowerCase();
              const parentClassList = el.parentElement ? Array.from(el.parentElement.classList).join(' ').toLowerCase() : '';
              const isSelected = classList.includes('selected') || classList.includes('active') || classList.includes('swatchselect') ||
                                 parentClassList.includes('selected') || parentClassList.includes('active') || parentClassList.includes('swatchselect');
              
              if (isSelected) {
                return true; // Already selected
              }

              try {
                el.click();
                return true;
              } catch (e) {
                const clickable = el.querySelector('a, button, input');
                if (clickable) {
                  clickable.click();
                  return true;
                }
              }
            }
          }
          return false;
        })()
      `;
      return await page.evaluate(evalFnStr) as boolean;
    } catch (e) {
      logger.error(`Error in clickVariantByText: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Extracts price from product detail page, clicking "See All Buying Options" if needed.
   */
  async selectVariantsAndGetPrice(
    page: Page,
    product: BecexProduct
  ): Promise<{ price: number | null; cleanUrl: string }> {
    logger.info(`Selecting Amazon variants & extracting price details for: ${product.productName}`);

    // Wait for the twister/variation container to load if present
    await page.waitForSelector('#inline-twister-container, #twister, #variation_size_name, #variation_color_name, #twister-plus-inline-twister', { timeout: 6000 }).catch(() => {});
    
    // Expand all collapsed twister rows first
    await page.evaluate(`() => {
      const headers = Array.from(document.querySelectorAll('[id^="inline-twister-expander-header-"]'));
      headers.forEach(header => {
        const label = header.getAttribute('aria-label') || "";
        if (label.toLowerCase().includes("expand")) {
          header.click();
        }
      });
    }`).catch(() => {});
    await randomDelay(1500, 2000);

    // Try selecting storage variant
    const specs = extractSpecs(product.productName);
    if (specs.storage.length > 0) {
      logger.info(`Amazon variant selection: attempting to select storage: ${specs.storage.join(", ")}`);
      const clicked = await this.clickVariantByText(page, "size_name", specs.storage);
      if (clicked) {
        logger.info("Storage variant clicked/verified.");
        await randomDelay(2000, 3000);
      } else {
        logger.warn("Storage variant not found / not clicked.");
      }
    }

    // Try selecting color variant
    if (specs.colors.length > 0) {
      logger.info(`Amazon variant selection: attempting to select color: ${specs.colors.join(", ")}`);
      const clicked = await this.clickVariantByText(page, "color_name", specs.colors);
      if (clicked) {
        logger.info("Color variant clicked/verified.");
        await randomDelay(2000, 3000);
      } else {
        logger.warn("Color variant not found / not clicked.");
      }
    }

    // Try selecting Refurbished/Renewed option if specified
    const isRefurbished = product.productName.toLowerCase().includes("refurbished") || product.productName.toLowerCase().includes("renewed");
    if (isRefurbished) {
      logger.info("Amazon variant selection: product is Refurbished/Renewed. Attempting to select Renewed variant...");
      const clicked = await this.clickVariantByText(page, "style_name", ["Renewed", "Refurbished"]);
      if (clicked) {
        logger.info("Renewed variant clicked/verified.");
        await randomDelay(2000, 3000);
      }
    }
    
    // 1. Try to get price directly first
    let price = await page.evaluate(() => {
      const priceSelectors = [
        ".a-price .a-offscreen",
        "#priceblock_ourprice",
        "#priceblock_dealprice",
        ".a-price .a-price-whole",
        "#corePrice_feature_div .a-price .a-offscreen",
        "#apex_offerDisplay_desktop .a-price .a-offscreen",
        ".apexPriceToPay .a-offscreen",
      ];
      for (const selector of priceSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          const text = el.textContent || "";
          const match = text.replace(/[^0-9.]/g, "");
          if (match) {
            const parsed = parseFloat(match);
            if (!isNaN(parsed) && parsed > 0) return parsed;
          }
        }
      }
      return null;
    });

    const cleanUrl = this.cleanAmazonUrl(page.url());

    // 2. Check if "See All Buying Options" button exists and click it
    const seeAllBtnSelector = "a:has-text('See All Buying Options'), span:has-text('See All Buying Options'), #buybox-see-all-buying-choices, [data-action='show-all-offers-display']";
    const seeAllBtn = page.locator(seeAllBtnSelector).first();
    const hasSeeAllBtn = await seeAllBtn.isVisible().catch(() => false);

    if (hasSeeAllBtn) {
      logger.info(`"See All Buying Options" button detected. Clicking to show pricing options...`);
      try {
        await seeAllBtn.click();
        // Wait for the drawer/modal container to appear
        await page.waitForSelector("#all-offers-display, #aod-container", { timeout: 8000 });
        await randomDelay(1500, 3000); // Allow content to load fully

        // Extract all options
        const offers = await page.evaluate(() => {
          const extracted: Array<{
            price: number | null;
            condition: string;
            shipsFrom: string;
            soldBy: string;
          }> = [];

          // A. Pinned Offer
          const pinnedOffer = document.querySelector("#aod-pinned-offer");
          if (pinnedOffer) {
            let price: number | null = null;
            const priceSelectors = [
              ".a-price",
              ".a-price .a-offscreen",
              ".a-color-price",
              ".a-price-whole"
            ];
            for (const selector of priceSelectors) {
              const priceEl = pinnedOffer.querySelector(selector);
              if (priceEl) {
                const text = priceEl.textContent || "";
                const match = text.replace(/[^0-9.]/g, "");
                if (match) {
                  const val = parseFloat(match);
                  if (!isNaN(val) && val > 0) {
                    price = val;
                    break;
                  }
                }
              }
            }

            const condEl = pinnedOffer.querySelector("[id$='-heading']") || 
                           pinnedOffer.querySelector(".aod-offer-heading") ||
                           pinnedOffer.querySelector(".aod-heading");
            const condition = condEl && condEl.textContent ? condEl.textContent.replace(/\s+/g, " ").trim() : "";

            const shipsEl = pinnedOffer.querySelector("[id$='-shipsFrom']") || 
                            pinnedOffer.querySelector(".aod-shipfrom") ||
                            pinnedOffer.querySelector("[id*='shipsFrom']");
            const shipsValEl = shipsEl?.querySelector(".a-color-base") || shipsEl;
            const shipsFrom = shipsValEl && shipsValEl.textContent ? shipsValEl.textContent.replace(/\s+/g, " ").trim() : "";

            const soldEl = pinnedOffer.querySelector("[id$='-soldBy']") || 
                           pinnedOffer.querySelector(".aod-soldby") ||
                           pinnedOffer.querySelector("[id*='soldBy']");
            const soldValEl = soldEl?.querySelector(".a-color-base") || soldEl?.querySelector("a") || soldEl;
            const soldBy = soldValEl && soldValEl.textContent ? soldValEl.textContent.replace(/\s+/g, " ").trim() : "";

            if (price !== null || condition) {
              extracted.push({ price, condition, shipsFrom, soldBy });
            }
          }

          // B. Other Offers
          const offerRows = document.querySelectorAll("#aod-offer-list #aod-offer, #aod-offer-list div[role='listitem'], .aod-offer");
          for (const row of Array.from(offerRows)) {
            let price: number | null = null;
            const priceSelectors = [
              ".a-price",
              ".a-price .a-offscreen",
              ".a-color-price",
              ".a-price-whole"
            ];
            for (const selector of priceSelectors) {
              const priceEl = row.querySelector(selector);
              if (priceEl) {
                const text = priceEl.textContent || "";
                const match = text.replace(/[^0-9.]/g, "");
                if (match) {
                  const val = parseFloat(match);
                  if (!isNaN(val) && val > 0) {
                    price = val;
                    break;
                  }
                }
              }
            }

            const condEl = row.querySelector("[id$='-heading']") || 
                           row.querySelector(".aod-offer-heading") ||
                           row.querySelector(".aod-heading");
            const condition = condEl && condEl.textContent ? condEl.textContent.replace(/\s+/g, " ").trim() : "";

            const shipsEl = row.querySelector("[id$='-shipsFrom']") || 
                            row.querySelector(".aod-shipfrom") ||
                            row.querySelector("[id*='shipsFrom']");
            const shipsValEl = shipsEl?.querySelector(".a-color-base") || shipsEl;
            const shipsFrom = shipsValEl && shipsValEl.textContent ? shipsValEl.textContent.replace(/\s+/g, " ").trim() : "";

            const soldEl = row.querySelector("[id$='-soldBy']") || 
                           row.querySelector(".aod-soldby") ||
                           row.querySelector("[id*='soldBy']");
            const soldValEl = soldEl?.querySelector(".a-color-base") || soldEl?.querySelector("a") || soldEl;
            const soldBy = soldValEl && soldValEl.textContent ? soldValEl.textContent.replace(/\s+/g, " ").trim() : "";

            if (price !== null || condition) {
              extracted.push({ price, condition, shipsFrom, soldBy });
            }
          }

          return extracted;
        });

        if (offers.length > 0) {
          logger.info(`Scraped ${offers.length} offers from buying choices side modal:`);
          offers.forEach((opt, idx) => {
            logger.info(`  [Option ${idx + 1}]: Price: ${opt.price ? `A$${opt.price}` : "N/A"}, Condition: "${opt.condition}", Ships From: "${opt.shipsFrom}", Sold By: "${opt.soldBy}"`);
          });

          // Select the lowest price among valid options
          const validOffers = offers.filter(o => o.price !== null && o.price > 0);
          if (validOffers.length > 0) {
            validOffers.sort((a, b) => (a.price as number) - (b.price as number));
            price = validOffers[0].price;
            logger.info(`Selected lowest price from buying options: A$${price}`);
          }
        } else {
          logger.warn("No offers found inside the Buying Choices sidebar.");
        }
      } catch (err) {
        logger.error(`Error while interacting with Buying Options modal: ${(err as Error).message}`);
      }
    }

    return { price, cleanUrl };
  }
}
