
import { promises as fs } from "fs";
import { chromium } from "playwright";
import { logger } from "./src/utils/logger.js";

async function testReebeloSearch() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const query = "iPhone 15";
  const url = `https://reebelo.com.au/search?q=${encodeURIComponent(query)}`;
  
  logger.info(`Navigating to: ${url}`);
  await page.goto(url, { waitUntil: "networkidle" });
  
  // Wait a bit for potential SPA loading
  await new Promise(r => setTimeout(r, 15000));
  
  const content = await page.content();
  await fs.writeFile('reebelo_debug_full.html', content);
  
  const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 5000));
  console.log("BODY TEXT SAMPLE:", bodyText);
  
  const results = await page.evaluate(() => {
    // Look for all 'div' or 'li' tags that might be product containers.
    const containers = Array.from(document.querySelectorAll('div, li'));
    
    // Find containers that look like product cards (e.g., contains 'A$' and a link)
    const productContainers = containers.filter(el => {
        const text = el.innerText || "";
        return text.includes('A$') && el.querySelectorAll('a').length > 0;
    });
    
    // Log class names of potential containers
    console.log("DEBUG: Found " + productContainers.length + " potential product containers.");
    productContainers.slice(0, 5).forEach((el, index) => {
        console.log("DEBUG: Container " + index + " classes: " + el.className);
        console.log("DEBUG: Container " + index + " text snippet: " + el.innerText.substring(0, 50));
    });
    
    return [];
  });
  
  logger.info(`Found ${results.length} links`);
  console.log(results);
  
  await browser.close();
}

testReebeloSearch().catch(console.error);
