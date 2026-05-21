// ============================================================
// Browser Service
// Launches REAL Chrome (Guest mode) + connects via CDP
// This approach is undetectable because Chrome runs as a normal
// process — not launched by automation tools.
// ============================================================

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import path from "path";
import fs from "fs";
import os from "os";
import { exec, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";
import http from "http";

const execAsync = promisify(exec);

const CDP_PORT = 9222;
const MAX_CDP_WAIT_MS = 15000;
const CDP_POLL_INTERVAL_MS = 500;

/**
 * Resolves the path to the real Google Chrome executable.
 */
function getChromePath(): string {
  const platform = process.platform;

  if (platform === "darwin") {
    const paths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
  } else if (platform === "win32") {
    const paths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
  } else {
    // Linux
    const paths = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser"];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
  }

  throw new Error(
    "Google Chrome not found. Please install Google Chrome.\n" +
    "  Mac: https://www.google.com/chrome/\n" +
    "  Windows: https://www.google.com/chrome/"
  );
}

/**
 * Polls the CDP endpoint until Chrome is ready to accept connections.
 */
async function waitForCdpReady(port: number, timeoutMs: number): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const wsUrl = await new Promise<string>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              const json = JSON.parse(body);
              resolve(json.webSocketDebuggerUrl);
            } catch {
              reject(new Error("Invalid CDP response"));
            }
          });
        });
        req.on("error", reject);
        req.setTimeout(2000, () => {
          req.destroy();
          reject(new Error("CDP timeout"));
        });
      });

      return wsUrl;
    } catch {
      await new Promise((r) => setTimeout(r, CDP_POLL_INTERVAL_MS));
    }
  }

  throw new Error(`Chrome CDP not ready after ${timeoutMs}ms. Is Chrome running on port ${port}?`);
}

/**
 * Manages browser lifecycle using REAL Chrome (Guest mode) + CDP connection.
 *
 * WHY THIS APPROACH:
 * - Playwright's `launchPersistentContext` adds internal automation flags
 *   that anti-bot systems (DataDome, PerimeterX, etc.) detect.
 * - Launching Chrome as a normal subprocess with `--guest` and connecting
 *   via CDP makes it indistinguishable from a real user session.
 * - Guest mode = clean profile every time, no leftover cookies/fingerprints.
 */
export class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private chromeProcess: ChildProcess | null = null;
  private readonly proxyUrl: string | null;
  private userDataDir: string | null = null;

  constructor(proxyUrl: string | null) {
    this.proxyUrl = proxyUrl;
  }

  async initialize(): Promise<void> {
    logger.info("Preparing environment...");
    await this.forceCloseChrome();

    const chromePath = getChromePath();
    logger.info(`Found Chrome at: ${chromePath}`);

    // Create a temporary user data dir to avoid cluttering project
    this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-chrome-"));

    // Build Chrome launch arguments
    const chromeArgs = this.buildChromeArgs(chromePath);
    logger.info(`Launching Chrome in Guest mode (CDP port ${CDP_PORT})...`);

    // Launch Chrome as a real subprocess
    this.chromeProcess = spawn(chromePath, chromeArgs, {
      detached: false,
      stdio: "ignore",
    });

    this.chromeProcess.on("error", (err) => {
      logger.error(`Chrome process error: ${err.message}`);
    });

    this.chromeProcess.on("exit", (code) => {
      logger.info(`Chrome process exited with code ${code}`);
      this.chromeProcess = null;
    });

    // Wait for CDP to be ready
    logger.info("Waiting for Chrome CDP to be ready...");
    const wsUrl = await waitForCdpReady(CDP_PORT, MAX_CDP_WAIT_MS);
    logger.info(`Chrome CDP ready: ${wsUrl}`);

    // Connect Playwright to the running Chrome via CDP
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    
    // Get the default context (the Guest profile context)
    const contexts = this.browser.contexts();
    if (contexts.length > 0) {
      this.context = contexts[0];
    } else {
      this.context = await this.browser.newContext();
    }

    logger.info("✅ Connected to Chrome Guest mode via CDP. Fully undetectable.");
  }

  async newPage(): Promise<Page> {
    if (!this.context) {
      throw new Error("Browser not initialized. Call initialize() first.");
    }

    // Close any existing about:blank tabs from Chrome startup
    const existingPages = this.context.pages();
    for (const existingPage of existingPages) {
      const url = existingPage.url();
      if (url === "about:blank" || url === "chrome://newtab/" || url.startsWith("chrome://")) {
        // Reuse this tab instead of creating a new one
        return existingPage;
      }
    }

    return this.context.newPage();
  }

  /**
   * Build Chrome command-line arguments for Guest mode + CDP.
   */
  private buildChromeArgs(chromePath: string): string[] {
    const userDataDir = this.userDataDir || config.chromeUserDataDir;
    const args: string[] = [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--guest",                              // Guest mode — clean profile, no login
      "--no-first-run",                       // Skip "Welcome to Chrome" screen
      "--no-default-browser-check",           // Don't ask to be default browser
      "--disable-default-apps",               // No default apps popup
      "--disable-popup-blocking",             // Allow popups for some stores
      "--disable-translate",                  // No translation bar
      "--disable-background-timer-throttling",// Keep timers running in background
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-hang-monitor",
      "--window-size=1920,1080",
      "--lang=en-AU",
    ];

    // Proxy support
    if (this.proxyUrl) {
      args.push(`--proxy-server=${this.proxyUrl}`);
      logger.info(`Using proxy: ${this.proxyUrl.replace(/\/\/.*@/, "//***@")}`);
    }

    return args;
  }

  private async forceCloseChrome(): Promise<void> {
    const platform = process.platform;
    try {
      if (platform === "darwin") {
        logger.info("Checking for running Chrome instances (Mac)...");
        // Kill any Chrome with our CDP port
        await execAsync(`lsof -ti :${CDP_PORT} | xargs kill -9 2>/dev/null`).catch(() => {});
        // Also kill any lingering Chrome processes
        await execAsync("pkill -f 'Google Chrome.*--remote-debugging-port' 2>/dev/null").catch(() => {});
      } else if (platform === "win32") {
        logger.info("Checking for running Chrome instances (Windows)...");
        await execAsync("taskkill /F /IM chrome.exe /T 2>nul").catch(() => {});
      }
      // Give it a moment to release file locks
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (err) {
      logger.warn(`Attempt to force close Chrome failed: ${(err as Error).message}`);
    }
  }

  async shutdown(): Promise<void> {
    try {
      // Disconnect Playwright (does NOT close Chrome)
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
        this.context = null;
      }

      // Now kill the Chrome process
      if (this.chromeProcess) {
        this.chromeProcess.kill("SIGTERM");
        // Give it 2 seconds to close gracefully, then force kill
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (this.chromeProcess && !this.chromeProcess.killed) {
          this.chromeProcess.kill("SIGKILL");
        }
        this.chromeProcess = null;
      }

      // Cleanup temp user data dir
      if (this.userDataDir && fs.existsSync(this.userDataDir)) {
        try {
          fs.rmSync(this.userDataDir, { recursive: true, force: true });
        } catch (err) {
          logger.warn(`Failed to clean up temp user data dir: ${(err as Error).message}`);
        }
        this.userDataDir = null;
      }

      logger.info("Browser shut down");
    } catch {
      // Suppress errors during shutdown — browser may already be disposed
      logger.warn("Browser shutdown completed with warnings");
    }
  }
}
