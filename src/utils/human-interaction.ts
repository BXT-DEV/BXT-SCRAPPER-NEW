// ============================================================
// Human Interaction Utilities
// Simulations of human behavior to bypass anti-bot systems
// ============================================================

import type { Page } from "playwright";
import { randomDelay } from "./delay.js";

/**
 * Gets the correct modifier key based on the current platform.
 */
export function getModifierKey(): string {
  return process.platform === "darwin" ? "Meta" : "Control";
}

/**
 * Moves mouse randomly around the current viewport.
 */
export async function moveMouseRandomly(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) return;

  const points = Math.floor(Math.random() * 3) + 2; // 2-4 points
  for (let i = 0; i < points; i++) {
    const x = Math.floor(Math.random() * viewport.width);
    const y = Math.floor(Math.random() * viewport.height);
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 10) + 5 });
    await randomDelay(100, 300);
  }
}

/**
 * Moves mouse to an element and clicks it human-likely.
 */
export async function humanClick(page: Page, selector: string): Promise<void> {
  const element = await page.waitForSelector(selector, { state: "visible" });
  const box = await element.boundingBox();
  
  if (box) {
    // Move to random point within the bounding box
    const x = box.x + Math.random() * box.width;
    const y = box.y + Math.random() * box.height;
    
    // Move mouse to the target with a bit of "jitters"
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 15) + 10 });
    await randomDelay(200, 500);
    
    // Click with a slight hold
    await page.mouse.down();
    await randomDelay(50, 150);
    await page.mouse.up();
  } else {
    // Fallback if bounding box is null (hidden element or weird layout)
    await page.click(selector);
  }
}

/**
 * Types text with random human-like delays and occasional pauses.
 */
export async function humanType(page: Page, text: string): Promise<void> {
  for (const char of text) {
    // Random delay between characters: 40ms to 180ms
    const delay = Math.floor(Math.random() * 140) + 40;
    await page.keyboard.type(char, { delay });
    
    // Occasional longer pause (simulating a "thought" or "check")
    if (Math.random() > 0.92) {
      await randomDelay(600, 1500);
    }
  }
}
