import { chromium } from 'playwright';
import fs from 'fs';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://reebelo.com.au', { waitUntil: 'domcontentloaded' });
  
  // Wait a bit
  await new Promise(r => setTimeout(r, 5000));
  
  // Find location element HTML
  const html = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const loc = els.find(el => el.textContent && (el.textContent.includes('Deliver to') || el.textContent.includes('select your postcode')) && el.children.length === 0);
    if (loc) {
      let parent = loc.parentElement;
      for(let i = 0; i < 3; i++) {
        if(parent && parent.parentElement) parent = parent.parentElement;
      }
      return parent ? parent.outerHTML : loc.outerHTML;
    }
    return 'Not found';
  });
  
  fs.writeFileSync('scratch_reebelo_out.txt', "LOCATION HTML:\n" + html);
  
  await browser.close();
})();
