// ============================================================
// Amazon Product Service
// Scrapes detailed product info from an Amazon product page
// ============================================================

import type { Page } from "playwright";
import type { AmazonProductDetails } from "../types/index.js";
import { logger } from "../utils/logger.js";

/**
 * Scrapes price and details from an individual Amazon product page.
 */
export class AmazonProductService {
  /**
   * Navigate to a product URL and extract confirmed price + details.
   * Uses multiple selector strategies since Amazon's DOM varies by product.
   */
  async scrapeProductPage(
    page: Page,
    productUrl: string
  ): Promise<AmazonProductDetails> {
    logger.info(`Scraping product page: ${productUrl}`);

    try {
      await page.goto(productUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // Wait for price element to appear
      await page.waitForSelector(
        "#priceblock_ourprice, #priceblock_dealprice, .a-price .a-offscreen, #corePrice_feature_div",
        { timeout: 8000 }
      ).catch(() => {
        logger.warn("Price element not found within timeout");
      });

      const details = await page.evaluate(() => {
        // --- Extract Title ---
        const titleEl = document.querySelector("#productTitle");
        const title = titleEl?.textContent?.trim() || "";

        // --- Extract Price (multiple strategies) ---
        let price: number | null = null;

        const priceSelectors = [
          "#priceblock_ourprice",
          "#priceblock_dealprice",
          ".a-price .a-offscreen",
          "#corePrice_feature_div .a-price .a-offscreen",
          "#apex_offerDisplay_desktop .a-price .a-offscreen",
          ".apexPriceToPay .a-offscreen",
        ];

        for (const selector of priceSelectors) {
          const priceEl = document.querySelector(selector);
          if (priceEl) {
            const priceText = priceEl.textContent?.trim() || "";
            const numericPrice = parseFloat(
              priceText.replace(/[^0-9.]/g, "")
            );
            if (!isNaN(numericPrice) && numericPrice > 0) {
              price = numericPrice;
              break;
            }
          }
        }

        // --- Extract Deal Price ---
        let dealPrice: number | null = null;
        const dealEl = document.querySelector(
          "#priceblock_dealprice, .reinventPriceSavingsPercentageMargin"
        );
        if (dealEl && price) {
          const dealText = dealEl.textContent?.trim() || "";
          const numericDeal = parseFloat(
            dealText.replace(/[^0-9.]/g, "")
          );
          if (!isNaN(numericDeal) && numericDeal > 0 && numericDeal !== price) {
            dealPrice = numericDeal;
          }
        }

        // --- Extract Availability ---
        const availEl = document.querySelector("#availability span");
        const availability = availEl?.textContent?.trim() || null;

        return { title, price, dealPrice, availability };
      });

      if (!details.price) {
        logger.warn(`Could not extract price from ${productUrl}`);
      }

      return details;
    } catch (error) {
      logger.error(
        `Failed to scrape product page: ${(error as Error).message}`
      );
      return {
        title: "",
        price: null,
        dealPrice: null,
        availability: null,
      };
    }
  }
}
