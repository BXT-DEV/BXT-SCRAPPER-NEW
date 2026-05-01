import { chromium } from 'playwright';
import fs from 'fs';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  
  try {
    await page.goto('https://reebelo.com.au', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 3000));
    
    console.log("Clicking location...");
    await page.click('img[alt="Deliver to"]', { timeout: 5000 });
    await new Promise(r => setTimeout(r, 2000));
    
    console.log("Looking for input...");
    const input = await page.$('input[placeholder*="postcode"]');
    if (input) {
      console.log("Found input!");
      await input.fill('3175');
      await new Promise(r => setTimeout(r, 1000));
      
      const applyBtn = await page.evaluateHandle(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        return btns.find(b => b.textContent?.trim().toLowerCase() === 'apply');
      });
      if (applyBtn) {
        console.log("Found Apply button, clicking...");
        await applyBtn.asElement()?.click();
        await new Promise(r => setTimeout(r, 3000));
        console.log("Applied.");
      }
    } else {
      console.log("Input not found");
    }
  } catch (err) {
    console.error(err);
  }
  
  await browser.close();
})();
