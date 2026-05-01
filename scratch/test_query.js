import { chromium } from "playwright";

async function testSearch() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const query = "Apple iPad 10 Wifi 10.9 4GB RAM, 64GB, Yellow";
  console.log(`Searching for: ${query}`);
  
  await page.goto(`https://www.amazon.com.au/s?k=${encodeURIComponent(query)}`);
  await page.waitForLoadState('domcontentloaded');
  
  const html = await page.content();
  if (html.includes("No results for")) {
    console.log("Amazon says: No results for this query.");
  } else if (html.includes("did not match any products")) {
     console.log("Amazon says: did not match any products.");
  } else {
    const results = await page.$$('[data-component-type="s-search-result"]');
    console.log(`Found ${results.length} result elements.`);
  }
  
  await browser.close();
}

testSearch().catch(console.error);
