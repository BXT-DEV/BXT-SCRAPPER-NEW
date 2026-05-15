// ============================================================
// Browser Service
// Playwright browser lifecycle with stealth anti-detection
// ============================================================

import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";

const execAsync = promisify(exec);

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
  private context: BrowserContext | null = null;
  private readonly proxyUrl: string | null;

  constructor(proxyUrl: string | null) {
    this.proxyUrl = proxyUrl;
  }

  async initialize(): Promise<void> {
    logger.info("Preparing environment...");
    await this.forceCloseChrome();
    
    logger.info("Launching stealth browser...");

    const userDataDir = config.chromeUserDataDir;
    if (!fs.existsSync(userDataDir)) {
      try {
        fs.mkdirSync(userDataDir, { recursive: true });
      } catch (e) {
        logger.warn(`Could not create user data directory: ${userDataDir}. Chrome might fail to launch if the path is invalid.`);
      }
    }
    
    logger.info(`Using Chrome user data dir: ${userDataDir}`);

    const activeProfile = this.getActiveChromeProfile(userDataDir);
    const profileArg = activeProfile ? `--profile-directory=${activeProfile}` : undefined;
    if (activeProfile) {
      logger.info(`Detected active Chrome profile: ${activeProfile}`);
    } else {
      logger.info(`Using Default Chrome profile`);
    }

    const launchOptions: Record<string, unknown> = {
      headless: false,
      channel: "chrome", // Uses real Google Chrome instead of Chromium
      viewport: randomViewport(),
      locale: "en-AU",
      timezoneId: "Australia/Sydney",
      userAgent: this.getRandomUserAgent(),
      extraHTTPHeaders: {
        "Accept-Language": "en-AU,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1",
      },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        ...(profileArg ? [profileArg] : []),
      ],
    };

    if (this.proxyUrl) {
      launchOptions.proxy = { server: this.proxyUrl };
      logger.info(`Using proxy: ${this.proxyUrl.replace(/\/\/.*@/, "//***@")}`);
    } else {
      logger.warn("No proxy configured — Amazon may block after ~10-20 requests");
    }

    try {
      this.context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes("Executable doesn't exist")) {
        logger.error("Google Chrome is required but not found on this system.");
        process.exit(1);
      }
      throw error;
    }

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

      // WebGL Fingerprint stealth
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        // UNMASKED_VENDOR_WEBGL
        if (parameter === 37445) return "Apple Inc.";
        // UNMASKED_RENDERER_WEBGL
        if (parameter === 37446) return "Apple GPU";
        return getParameter.apply(this, [parameter]);
      };

      // Hardware/Memory overrides
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });

      // Override chrome object
      (window as any).chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {}
      };
    });

    logger.info("Browser launched successfully");
  }

  async newPage(): Promise<Page> {
    if (!this.context) {
      throw new Error("Browser not initialized. Call initialize() first.");
    }
    return this.context.newPage();
  }

  private async forceCloseChrome(): Promise<void> {
    const platform = process.platform;
    try {
      if (platform === "darwin") {
        logger.info("Checking for running Chrome instances (Mac)...");
        await execAsync("pkill -i 'Google Chrome'").catch(() => {});
      } else if (platform === "win32") {
        logger.info("Checking for running Chrome instances (Windows)...");
        await execAsync("taskkill /F /IM chrome.exe /T").catch(() => {});
      }
      // Give it a second to release file locks
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (err) {
      logger.warn(`Attempt to force close Chrome failed: ${(err as Error).message}`);
    }
  }

  private getActiveChromeProfile(userDataDir: string): string | null {
    try {
      const localStatePath = path.join(userDataDir, "Local State");
      if (fs.existsSync(localStatePath)) {
        const localStateStr = fs.readFileSync(localStatePath, "utf-8");
        const localState = JSON.parse(localStateStr);
        if (localState && localState.profile && localState.profile.last_used) {
          return localState.profile.last_used as string;
        }
      }
    } catch (err) {
      logger.warn(`Could not read Chrome Local State to detect active profile: ${(err as Error).message}`);
    }
    return null;
  }

  async shutdown(): Promise<void> {
    try {
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
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
