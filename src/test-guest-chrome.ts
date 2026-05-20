/**
 * Quick smoke test: Launch Chrome Guest mode, connect via CDP, navigate to Backmarket.
 * Run: npx tsx src/test-guest-chrome.ts
 */

import { BrowserService } from "./services/browser.service.js";

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  TEST: Chrome Guest Mode + CDP Connection ");
  console.log("═══════════════════════════════════════════");

  const browserService = new BrowserService(null);
  
  try {
    await browserService.initialize();
    console.log("✅ Chrome launched and CDP connected!");

    const page = await browserService.newPage();
    console.log("✅ Page created!");

    // Navigate to Backmarket search
    console.log("Navigating to Backmarket search...");
    await page.goto("https://www.backmarket.com.au/en-au/search?q=iPhone+15+Pro", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait a bit for JS to render
    await new Promise(r => setTimeout(r, 5000));

    // Check the page title and URL
    const title = await page.title();
    const url = page.url();
    console.log(`Page title: "${title}"`);
    console.log(`Page URL: ${url}`);

    // Check if results appeared
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    const hasResults = !bodyText.includes("Nothing to see here") && !bodyText.includes("No results");
    
    if (hasResults) {
      console.log("✅ RESULTS VISIBLE! Anti-bot bypassed successfully!");
      
      // Count product cards
      const cardCount = await page.evaluate(() => {
        const cards = document.querySelectorAll('a[href*="/en-au/p/"]');
        return cards.length;
      });
      console.log(`Found ${cardCount} product cards on page.`);
    } else {
      console.log("❌ No results visible. Page content preview:");
      console.log(bodyText.substring(0, 300));
    }

    // Take screenshot for verification
    await page.screenshot({ path: "debug/guest_mode_test.png", fullPage: false });
    console.log("Screenshot saved to debug/guest_mode_test.png");

  } catch (err) {
    console.error("❌ Error:", (err as Error).message);
  } finally {
    await browserService.shutdown();
    console.log("Done.");
  }
}

main();
