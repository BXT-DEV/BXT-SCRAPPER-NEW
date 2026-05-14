// ============================================================
// Digidirect Search Service
// Scrapes Digidirect search results and selects Mount/Bundle variants
// ============================================================

import type { Page } from "playwright";
import type { AmazonSearchResult, BecexProduct } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { randomDelay } from "../utils/delay.js";
import { extractSpecs } from "../utils/product-utils.js";

export class DigidirectSearchService {
  private readonly domain: string;
  private readonly maxResults: number;

  constructor(domain: string, maxResults: number) {
    this.domain = domain;
    this.maxResults = maxResults;
  }

  async searchProduct(page: Page, productQuery: string): Promise<AmazonSearchResult[]> {
    const searchUrl = `https://${this.domain}/search?q=${encodeURIComponent(productQuery)}`;
    logger.info(`Visiting Digidirect: ${searchUrl}`);
    
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randomDelay(2000, 3000);

    const results = await page.evaluate((maxResults) => {
      const items: any[] = [];
      const cards = document.querySelectorAll('.product-item-info, .item.product');
      
      for (const card of Array.from(cards).slice(0, maxResults)) {
        const titleEl = card.querySelector('.product-item-link, .product-item-name a, h2, h3');
        const priceEl = card.querySelector('.price, [data-price-type="finalPrice"] .price');
        
        if (!titleEl) continue;

        const title = titleEl.textContent?.trim() || "";
        const rawUrl = titleEl.getAttribute('href') || card.querySelector('a')?.getAttribute('href') || "";
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

    logger.info(`Found ${results.length} results on Digidirect.`);
    return results;
  }

  async selectVariantsAndGetPrice(page: Page, product: BecexProduct): Promise<{price: number | null, cleanUrl: string}> {
    logger.info(`Selecting Digidirect variants for: ${product.productName}`);
    await randomDelay(2000, 3000);

    const specs = extractSpecs(product.productName);

    // 1. Storage/Color/Connectivity
    if (specs.storage.length > 0) await this.clickVariantByText(page, specs.storage);
    if (specs.colors.length > 0) await this.clickVariantByText(page, specs.colors);
    if (specs.connectivity.length > 0) await this.clickVariantByText(page, specs.connectivity);

    // 2. Mount selection (Original logic)
    const mountMatch = product.productName.match(/\(([^)]+)\)/);
    if (mountMatch && mountMatch[1]) {
      await this.clickVariantByText(page, [mountMatch[1].trim()]);
    }

    const price = await page.evaluate(() => {
      const priceSelectors = ['[data-price-type="finalPrice"] .price', '.price-final_price .price', '.price'];
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
      const labels = await page.$$('div.swatch-option, select.super-attribute-select, option, label, button, span');
      for (const label of labels) {
        const text = (await label.textContent()) || "";
        const aria = (await label.getAttribute('aria-label')) || "";
        const optionLabel = (await label.getAttribute('data-option-label')) || "";
        
        const combined = `${text} ${aria} ${optionLabel}`.toLowerCase();
        
        if (texts.some(t => combined.includes(t.toLowerCase()))) {
          const tagName = await label.evaluate(e => e.tagName.toLowerCase());
          if (tagName === 'option') {
            const parentSelect = await label.evaluateHandle(e => e.parentElement);
            const value = await label.getAttribute('value');
            if (value) {
              await parentSelect.asElement()?.selectOption(value).catch(() => {});
            }
          } else {
            await label.click({ force: true }).catch(() => {});
          }
          await randomDelay(1000, 2000);
          return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }
}
