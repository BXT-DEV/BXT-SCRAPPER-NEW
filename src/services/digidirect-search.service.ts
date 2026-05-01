// ============================================================
// Digidirect Search Service
// Scrapes Digidirect search results and selects Mount/Bundle variants
// ============================================================

import type { Page } from "playwright";
import type { AmazonSearchResult, BecexProduct } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { randomDelay } from "../utils/delay.js";

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
    logger.info("Selecting Digidirect Mount/Bundle variants...");
    await randomDelay(2000, 3000);

    // Try to extract Mount or Bundle from productName
    // e.g. "Sigma 12mm f/1.4 DC Contemporary Lens (Canon RF) - Brand New" -> "Canon RF"
    const mountMatch = product.productName.match(/\(([^)]+)\)/);
    if (mountMatch && mountMatch[1]) {
      const mountTarget = mountMatch[1].trim();
      logger.info(`Attempting to select Mount/Bundle: ${mountTarget}`);
      
      try {
        const labels = await page.$$('div.swatch-option, select.super-attribute-select, option');
        for (const label of labels) {
          const text = (await label.textContent()) || "";
          const aria = (await label.getAttribute('aria-label')) || "";
          const optionLabel = (await label.getAttribute('data-option-label')) || "";
          
          const combined = `${text} ${aria} ${optionLabel}`.toLowerCase();
          
          if (combined.includes(mountTarget.toLowerCase())) {
            // For selects, we might need to selectOption instead of click
            const tagName = await label.evaluate(e => e.tagName.toLowerCase());
            if (tagName === 'option') {
              const parentSelect = await label.evaluateHandle(e => e.parentElement);
              const value = await label.getAttribute('value');
              if (value) {
                await parentSelect.asElement()?.selectOption(value).catch(() => {});
              }
            } else {
              await label.click().catch(() => {});
            }
            await randomDelay(1000, 2000);
            break;
          }
        }
      } catch (e) {
        logger.warn(`Could not select variant: ${mountTarget}`);
      }
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
}
