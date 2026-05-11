import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATUS_FILE = path.join(process.cwd(), "scraper_status.json");

export type ScraperStatus = "running" | "paused" | "stopped" | "idle";

export interface StatusData {
  status: ScraperStatus;
  reason?: string;
  timestamp: number;
}

export function updateScraperStatus(status: ScraperStatus, reason?: string) {
  const data: StatusData = {
    status,
    reason,
    timestamp: Date.now()
  };
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    // Ignore errors for status updates
  }
}

export function getScraperStatus(): StatusData {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const content = fs.readFileSync(STATUS_FILE, "utf-8");
      return JSON.parse(content);
    }
  } catch (e) {
    // fallback
  }
  return { status: "idle", timestamp: Date.now() };
}

export function clearScraperStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      fs.unlinkSync(STATUS_FILE);
    }
  } catch (e) {
    // Ignore
  }
}
