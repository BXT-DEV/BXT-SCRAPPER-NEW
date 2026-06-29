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
      const searchUrl = `https://${this.domain}/search?q=${encodeURIComponent(query)}`;
      logger.info(`Direct URL: ${searchUrl}`);
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await randomDelay(4000, 5000);
    } catch (e) {
      logger.warn(`Direct URL search navigation failed: ${(e as Error).message}`);
    }

    const results = await page.evaluate((maxResults) => {
      const links = Array.from(document.querySelectorAll('a'));
      const productLinks = links.filter(a => {
        const href = a.getAttribute('href') || "";
        return (href.includes('/collections/') || href.includes('/products/') || href.includes('/p/')) && href.includes('skuId=');
      });
      
      const filteredProducts = [];
      const seenUrls = new Set();
      
      for (const a of productLinks) {
        const href = a.getAttribute('href') || "";
        const fullUrl = href.startsWith('http') ? href : (href.startsWith('/') ? `https://${window.location.host}${href}` : `https://${window.location.host}/${href}`);
        
        if (seenUrls.has(fullUrl)) continue;
        
        const img = a.querySelector('img');
        let title = img ? img.getAttribute('alt') || "" : "";
        if (!title) {
          const h3 = a.querySelector('h3');
          title = h3 ? h3.textContent?.trim() || "" : "";
        }
        if (!title) {
          title = a.textContent?.trim() || "";
        }
        
        title = title.trim();
        if (!title) continue;
        
        let price = null;
        const priceMatch = a.textContent?.match(/A\$([0-9,.]+)/);
        if (priceMatch) {
          price = parseFloat(priceMatch[1].replace(/,/g, ""));
        }
        
        const accessoryKeywords = ['protector', 'case', 'cover', 'glass', 'film', 'sticker'];
        const titleLower = title.toLowerCase();
        const urlLower = fullUrl.toLowerCase();
        
        const isAccessory = accessoryKeywords.some(keyword => 
          titleLower.includes(keyword) || urlLower.includes(keyword)
        );

        if (isAccessory) continue;
        
        seenUrls.add(fullUrl);
        filteredProducts.push({ title, price, url: fullUrl, rating: null, reviewCount: null, isPrime: false });
        
        if (filteredProducts.length >= maxResults) break;
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
        // Try finding the button that contains 'Deliver to'
        const trigger = await page.evaluateHandle(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          return buttons.find(b => b.innerText.includes('Deliver to'));
        });
        
        if (trigger && trigger.asElement()) {
          await trigger.asElement()?.click();
          logger.info("Clicked location trigger based on 'Deliver to' text.");
          await randomDelay(1000, 2000);
        } else {
          logger.warn("Could not find location trigger button containing 'Deliver to'.");
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

  /**
   * Deterministic matching for Reebelo — one product page = all variants.
   * Navigates to the first valid product page and selects the exact variant.
   * Bypasses Gemini AI entirely — no false negatives from prompt gaps.
   * 
   * Returns null if no valid product page was found in search results.
   */
  async matchDirectly(
    page: Page,
    product: BecexProduct,
    searchResults: AmazonSearchResult[]
  ): Promise<{ url: string; title: string; price: number | null } | null> {
    // Find the first valid product page that matches the model name (without specs)
    const broadModelName = getBroadSearchQuery(product.productName);
    const validResult = searchResults.find(r => {
      const isProductPage = r.url.includes("/collections/") || r.url.includes("/products/") || r.url.includes("/p/");
      if (!isProductPage) return false;
      return this.isModelMatch(broadModelName, r.title);
    });

    if (!validResult) {
      logger.warn(`No valid matching Reebelo product page found for ${product.productName} in ${searchResults.length} results.`);
      return null;
    }

    logger.info(`Navigating to Reebelo product page: ${validResult.title}`);
    await page.goto(validResult.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randomDelay(2000, 3000);

    // Select all variants using the existing full flow
    try {
      const { price, cleanUrl } = await this.selectVariantsAndGetPrice(page, product);

      // Read the final page title after variant selection
      const pageTitle = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        const subtitle = document.querySelector('h1 + p, h1 + div, [class*="subtitle"]');
        return [h1?.textContent?.trim(), subtitle?.textContent?.trim()].filter(Boolean).join(' - ');
      }) || validResult.title;

      return { url: cleanUrl, title: pageTitle, price };
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.startsWith("REQUIRED_VARIANT_NOT_FOUND")) {
        logger.info(`  ✗ Variant not available: ${msg}`);
        return null;
      }
      throw error;
    }
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

    // ── CORRECT ORDER: CPU → RAM → Storage → Color → Condition → Battery → SIM ──
    // Reebelo is nested: condition options only appear after storage+color are set.

    // 1. CPU selection
    if (specs.cpu && specs.cpu.length > 0) {
      await this.clickReebeloVariant(page, "cpu", specs.cpu, "CPU");
    }

    // 2. RAM selection
    if (specs.ram && specs.ram.length > 0) {
      await this.clickReebeloVariant(page, "ram", specs.ram, "RAM");
    }

    // 3. Storage selection
    if (specs.storage.length > 0) {
      await this.clickReebeloVariant(page, "storage", specs.storage, "Storage");
    }

    // 4. Color selection (must be before condition)
    if (specs.colors.length > 0) {
      await this.clickReebeloVariant(page, "color", specs.colors, "Color");
    }

    // Wait for page to update after storage+color selection
    await randomDelay(1500, 2500);

    // 3. Condition selection (now available after storage+color)
    // Mapping: Pristine -> 'Like New', Excellent -> 'Very Good'
    if (isPristine && storeRules?.conditionMapping?.Pristine) {
      await this.clickReebeloVariant(page, "condition", storeRules.conditionMapping.Pristine, "Condition: Pristine");
    } else if (isExcellent && storeRules?.conditionMapping?.Excellent) {
      await this.clickReebeloVariant(page, "condition", storeRules.conditionMapping.Excellent, "Condition: Excellent");
    }

    // 4. Connectivity selection
    if (specs.connectivity.length > 0) {
      const hasConnectivityOption = await page.evaluate(() => {
        return !!(
          document.querySelector('#e2e-pdp-connectivity') || 
          document.querySelector('[id^="e2e-pdp-connectivity-"]')
        );
      });
      if (hasConnectivityOption) {
        await this.clickReebeloVariant(page, "connectivity", specs.connectivity, "Connectivity");
      } else {
        logger.info(`  ✓ Skipping Connectivity selection ("${specs.connectivity.join(", ")}") because no connectivity variant options exist on this page.`);
      }
    }

    // 5. Battery selection
    if (storeRules?.batteryPolicy === "Standard Only") {
      const batterySuccess = await this.clickReebeloVariant(page, "battery", ["Standard Battery", "Standard"], "Battery", false);
      if (!batterySuccess) {
        const hasOtherBatteryOptions = await page.evaluate(() => {
          const batterySection = document.querySelector('#e2e-pdp-battery');
          if (!batterySection) return false;
          const links = batterySection.querySelectorAll('a');
          return Array.from(links).some(a => {
            const txt = a.textContent?.toLowerCase() || '';
            return txt.includes('elevated') || txt.includes('new battery');
          });
        });
        if (hasOtherBatteryOptions) {
          throw new Error("REQUIRED_VARIANT_NOT_FOUND: Standard Battery (Only Elevated or New Battery option is available)");
        }
      }
    }

    // 6. SIM selection
    if (storeRules?.simPolicy === "Physical Only") {
      const simSuccess = await this.clickReebeloVariant(page, "sim", ["Physical SIM", "Dual SIM", "Nano-SIM", "Single SIM"], "SIM", false);
      if (!simSuccess) {
        const hasEsimOption = await page.evaluate(() => {
          const title = document.querySelector('h1')?.innerText || '';
          if (title.toLowerCase().includes('esim')) return true;
          const simSection = document.querySelector('#e2e-pdp-sim');
          if (!simSection) return false;
          return Array.from(simSection.querySelectorAll('a')).some(a =>
            a.textContent?.toLowerCase().includes('esim')
          );
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

  /**
   * Color alias map for matching abbreviated → brand-prefixed colors.
   * Example: "Gray" should also try "Titanium Gray", "Titanium Grey".
   */
  private static readonly COLOR_ALIASES: ReadonlyMap<string, string[]> = new Map([
    ["gray",   ["Titanium Gray", "Titanium Grey"]],
    ["grey",   ["Titanium Gray", "Titanium Grey"]],
    ["black",  ["Titanium Black", "Titanium Jet Black"]],
    ["blue",   ["Titanium Blue", "Titanium Silver Blue"]],
    ["silver", ["Titanium Silver", "Titanium White Silver", "Silver Shadow"]],
    ["white",  ["Titanium White", "Titanium White Silver"]],
    ["pink",   ["Titanium Pink", "Titanium Pink Gold"]],
    ["green",  ["Titanium Green", "Titanium Jade Green", "Midnight Green"]],
    ["gold",   ["Titanium Gold", "Titanium Pink Gold"]],
    ["natural",["Titanium Natural", "Natural Titanium"]],
  ]);

  /**
   * Clicks a Reebelo variant using their structured e2e-pdp-* IDs.
   * Falls back to generic text-based matching if IDs are not found.
   */
  private async clickReebeloVariant(
    page: Page,
    variantType: string,
    targetValues: string[],
    displayName: string,
    throwOnMiss = true
  ): Promise<boolean> {
    // Build expanded search list with color aliases
    const expandedValues = [...targetValues];
    if (variantType === "color") {
      for (const val of targetValues) {
        const aliases = ReebeloSearchService.COLOR_ALIASES.get(val.toLowerCase());
        if (aliases) {
          expandedValues.push(...aliases);
        }
      }
    }

    // Strategy 1: Use e2e-pdp-{type}-{value} IDs (most reliable)
    for (const value of expandedValues) {
      const elementId = `e2e-pdp-${variantType}-${value}`;
      // Use attribute selector — IDs may contain spaces (e.g., "e2e-pdp-condition-Very Good")
      const element = await page.$(`[id="${elementId}"]`).catch(() => null);
      if (element) {
        const isVisible = await element.isVisible().catch(() => false);
        if (isVisible) {
          await element.click({ force: true }).catch(() => {});
          logger.info(`  ✓ Selected ${displayName}: "${value}" (via ID)`);
          await randomDelay(500, 1000);
          return true;
        }
      }
    }

    // Strategy 2: Search within e2e-pdp-{type} section container
    const sectionId = `e2e-pdp-${variantType}`;
    const sectionExists = await page.$(`#${sectionId}`).catch(() => null);
    if (sectionExists) {
      for (const value of expandedValues) {
        const found = await page.evaluate(({ sectionId, value }) => {
          const section = document.getElementById(sectionId);
          if (!section) return false;
          const links = Array.from(section.querySelectorAll('a'));
          for (const link of links) {
            const text = link.textContent?.trim() || '';
            const ariaLabel = link.getAttribute('aria-label') || '';
            if (
              text.toLowerCase() === value.toLowerCase() ||
              text.toLowerCase().includes(value.toLowerCase()) ||
              ariaLabel.toLowerCase().includes(value.toLowerCase())
            ) {
              (link as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, { sectionId, value });

        if (found) {
          logger.info(`  ✓ Selected ${displayName}: "${value}" (via section)`);
          await randomDelay(500, 1000);
          return true;
        }
      }
    }

    // Strategy 3: Fallback to generic text-based matching (legacy approach)
    const fallbackSuccess = await this.clickVariantByText(page, expandedValues);
    if (fallbackSuccess) {
      logger.info(`  ✓ Selected ${displayName} (via text fallback)`);
      return true;
    }

    if (throwOnMiss) {
      throw new Error(`REQUIRED_VARIANT_NOT_FOUND: ${displayName} (${targetValues.join(", ")})`);
    }

    logger.warn(`  ✗ Could not find ${displayName}: ${targetValues.join(", ")}`);
    return false;
  }

  private async clickVariantByText(page: Page, texts: string[]): Promise<boolean> {
    try {
      const elements = await page.$$('a, button, div[role="button"], label, span');
      for (const element of elements) {
        const text = await element.textContent();
        if (text && texts.some(t => text.toLowerCase() === t.toLowerCase() || (text.toLowerCase().includes(t.toLowerCase()) && text.length < 30))) {
          const isVisible = await element.isVisible();
          const isEnabled = await element.isEnabled();
          if (isVisible && isEnabled) {
            await element.click({ force: true }).catch(() => {});
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

  private isModelMatch(query: string, candidateTitle: string): boolean {
    const cleanQuery = query.toLowerCase().replace(/\bplus\b/g, "+").replace(/[^a-z0-9+ ]/g, "");
    const cleanCandidate = candidateTitle.toLowerCase().replace(/\bplus\b/g, "+").replace(/[^a-z0-9+ ]/g, "");

    const queryWords = cleanQuery.split(/\s+/).filter(Boolean);
    const candidateNormalized = cleanCandidate.replace(/\s+/g, "");

    // Extract model identifiers (words containing digits)
    const modelIdentifiers = queryWords.filter(word => /\d/.test(word));

    // Core name words (excluding brands and generic words)
    const ignoreWords = new Set([
      "samsung", "apple", "google", "oppo", "sony", "nintendo", "canon", "nikon",
      "galaxy", "iphone", "pixel", "ipad", "watch", "phone", "camera", "lens", "console",
      "refurbished", "excellent", "pristine", "good", "very"
    ]);

    const coreWords = queryWords.filter(word => {
      if (word === "+") return true;
      if (word.length <= 2) return false;
      if (ignoreWords.has(word)) return false;
      if (/\d/.test(word)) return false; // Already checked in modelIdentifiers
      return true;
    });

    // Check model identifiers (e.g., "s24", "5")
    for (const id of modelIdentifiers) {
      if (!candidateNormalized.includes(id)) {
        return false;
      }
    }

    // Check core words (e.g., "ultra", "fold")
    for (const word of coreWords) {
      if (!candidateNormalized.includes(word)) {
        return false;
      }
    }

    return true;
  }

}
