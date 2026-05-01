import { chromium } from 'playwright';
import fs from 'fs';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    await page.goto('https://reebelo.com.au', { waitUntil: 'domcontentloaded' });
    
    // Wait a bit
    await new Promise(r => setTimeout(r, 3000));
    
    console.log("Clicking location...");
    await page.click('text="Deliver to"').catch(e => console.log(e.message));
    
    await new Promise(r => setTimeout(r, 2000));
    
    console.log("Looking for input...");
    const input = await page.$('div[role="dialog"] input[type="text"], .modal input[type="text"], input[placeholder*="postcode"], input[placeholder*="location"]');
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
      } else {
        console.log("Apply button not found");
      }
    } else {
      console.log("Input not found");
      const dialogHtml = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return d ? d.outerHTML : 'No dialog';
      });
      fs.writeFileSync('scratch_reebelo_out.txt', "DIALOG HTML:\n" + dialogHtml);
    }
  } catch (err) {
    console.error(err);
  }
  
  await browser.close();
})();
