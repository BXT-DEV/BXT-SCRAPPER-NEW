import { chromium } from 'playwright';
import fs from 'fs';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  
  try {
    await page.goto('https://reebelo.com.au', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 3000));
    
    await page.click('img[alt="Deliver to"]', { timeout: 5000 });
    await new Promise(r => setTimeout(r, 2000)); // wait for modal
    
    // Dump all inputs
    const html = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) return dialog.innerHTML;
      return Array.from(document.querySelectorAll('input')).map(i => i.outerHTML).join('\n');
    });
    fs.writeFileSync('scratch_reebelo_out.txt', "DIALOG:\n" + html);
  } catch (err) {
    console.error(err);
  }
  
  await browser.close();
})();
