import { chromium } from 'playwright';

async function test() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const url = "https://www.amazon.com.au/s?k=iphone&crid=1DMGKR2XYUHGW&sprefix=%2Caps%2C286&ref=nb_sb_ss_recent_1_0_recent";
  
  console.log("Navigating to:", url);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log("Navigation successful. Waiting 5s...");
    await new Promise(r => setTimeout(r, 5000));
    console.log("Current URL:", page.url());
  } catch (e) {
    console.error("Navigation failed:", e);
  } finally {
    await browser.close();
  }
}

test();
