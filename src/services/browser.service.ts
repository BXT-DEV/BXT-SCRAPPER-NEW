// ============================================================
// Browser Service
// Playwright browser lifecycle with stealth anti-detection
// ============================================================

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { logger } from "../utils/logger.js";

// Randomize viewport to avoid fingerprinting
const VIEWPORT_BASE = { width: 1920, height: 1080 };
const VIEWPORT_JITTER = 50;

function randomViewport() {
  const jitterW = Math.floor(Math.random() * VIEWPORT_JITTER * 2) - VIEWPORT_JITTER;
  const jitterH = Math.floor(Math.random() * VIEWPORT_JITTER * 2) - VIEWPORT_JITTER;
  return {
    width: VIEWPORT_BASE.width + jitterW,
    height: VIEWPORT_BASE.height + jitterH,
  };
}

/**
 * Manages Playwright browser lifecycle with stealth configuration.
 * Singleton — call initialize() once, then newPage() for each task.
 */
export class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly proxyUrl: string | null;

  constructor(proxyUrl: string | null) {
    this.proxyUrl = proxyUrl;
  }

  async initialize(): Promise<void> {
    logger.info("Launching stealth browser...");

    const launchOptions: Record<string, unknown> = {
      headless: false,
      slowMo: 100,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
      ],
    };

    if (this.proxyUrl) {
      launchOptions.proxy = { server: this.proxyUrl };
      logger.info(`Using proxy: ${this.proxyUrl.replace(/\/\/.*@/, "//***@")}`);
    } else {
      logger.warn("No proxy configured — Amazon may block after ~10-20 requests");
    }

    try {
      this.browser = await chromium.launch(launchOptions);
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes("Executable doesn't exist") || msg.includes("look like playwright was installed")) {
        logger.error("══════════════════════════════════════════════════════════════");
        logger.error("  BROWSER NOT FOUND!                                          ");
        logger.error("  Playwright requires Chromium to be installed.               ");
        logger.error("  Please run this command in your terminal:                  ");
        logger.error("  npx playwright install chromium                             ");
        logger.error("══════════════════════════════════════════════════════════════");
        process.exit(1);
      }
      throw error;
    }

    this.context = await this.browser.newContext({
      viewport: randomViewport(),
      locale: "en-AU",
      timezoneId: "Australia/Sydney",
      userAgent: this.getRandomUserAgent(),
      extraHTTPHeaders: {
        "Accept-Language": "en-AU,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    // Stealth: override navigator.webdriver
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });

      // Override chrome runtime
      (window as unknown as Record<string, unknown>).chrome = { runtime: {} };

      // Override permissions query
      const originalQuery = window.navigator.permissions.query.bind(
        window.navigator.permissions
      );
      window.navigator.permissions.query = (parameters: PermissionDescriptor) => {
        if (parameters.name === "notifications") {
          return Promise.resolve({
            state: Notification.permission,
          } as PermissionStatus);
        }
        return originalQuery(parameters);
      };

      // Override plugins length
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });

      // Override languages
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-AU", "en"],
      });
    });

    logger.info("Browser launched successfully");
  }

  async newPage(): Promise<Page> {
    if (!this.context) {
      throw new Error("Browser not initialized. Call initialize() first.");
    }
    return this.context.newPage();
  }

  async shutdown(): Promise<void> {
    try {
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }
      logger.info("Browser shut down");
    } catch {
      // Suppress errors during shutdown — browser may already be disposed
      logger.warn("Browser shutdown completed with warnings");
    }
  }

  private getRandomUserAgent(): string {
    const userAgents = [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }
}
