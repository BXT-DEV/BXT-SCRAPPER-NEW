import { chromium } from 'playwright';
import fs from 'fs';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  try {
    console.log("Navigating to homepage to set postcode...");
    await page.goto('https://reebelo.com.au', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    // Deliver to
    const trigger = await page.evaluateHandle(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      return buttons.find(b => b.innerText.includes('Deliver to'));
    });
    
    if (trigger && trigger.asElement()) {
      await trigger.asElement().click();
      await new Promise(r => setTimeout(r, 2000));
      const zipInput = await page.waitForSelector('input[placeholder*="zipcode"], input[placeholder*="postcode"]', { timeout: 5000 });
      await zipInput.fill('3175');
      await new Promise(r => setTimeout(r, 1000));

      const applyBtn = await page.evaluateHandle(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        return btns.find(b => b.textContent?.trim().toLowerCase() === 'apply' || b.textContent?.trim().toLowerCase() === 'save');
      });
      if (applyBtn && applyBtn.asElement()) {
        await applyBtn.asElement().click();
        await new Promise(r => setTimeout(r, 3000));
        console.log("Location set to 3175.");
      }
    }

    console.log("Navigating to iPhone 12 Pro page...");
    await page.goto('https://reebelo.com.au/collections/apple-iphone-12-pro', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    // Let's click storage 512GB
    console.log("Clicking 512GB storage...");
    const storageElement = await page.$('[id="e2e-pdp-storage-512GB"]');
    if (storageElement) {
      await storageElement.click({ force: true });
      await new Promise(r => setTimeout(r, 2000));
      console.log("Clicked 512GB storage.");
    } else {
      console.log("Could not find 512GB storage element by ID.");
    }

    // Let's click color Gold
    console.log("Clicking Gold color...");
    const colorElement = await page.$('[id="e2e-pdp-color-Gold"]');
    if (colorElement) {
      await colorElement.click({ force: true });
      await new Promise(r => setTimeout(r, 2500));
      console.log("Clicked Gold color.");
    } else {
      console.log("Could not find Gold color element by ID.");
    }

    // Now let's dump condition container HTML and take a screenshot
    const conditionHtml = await page.evaluate(() => {
      const condContainer = document.querySelector('#e2e-pdp-condition');
      if (condContainer) return condContainer.outerHTML;
      // Let's find any element containing condition info
      const allDivs = Array.from(document.querySelectorAll('div, a'));
      const conditionDivs = allDivs.filter(d => d.id && d.id.includes('condition'));
      return conditionDivs.map(d => `${d.tagName} id=${d.id} class=${d.className} text=${d.textContent?.trim()}`).join('\n');
    });

    console.log("Condition section HTML/info:");
    console.log(conditionHtml);

    // Write to a text file
    fs.writeFileSync('scratch_reebelo_condition.txt', conditionHtml);

    // Save screenshot
    await page.screenshot({ path: 'scratch_reebelo_pdp.png', fullPage: false });
    console.log("Screenshot saved.");

  } catch (err) {
    console.error("Error in script:", err);
  } finally {
    await browser.close();
  }
})();
