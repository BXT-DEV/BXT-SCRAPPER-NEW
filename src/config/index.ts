// ============================================================
// Environment Configuration Loader
// Validates and exports typed config from .env
// ============================================================

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import type { ScraperTarget, MappingCategory } from "../types/index.js";

// ── Valid scraper targets per mapping category ─────────────
// Enforced from "Note untuk scrapping mapping.md"
export const VALID_TARGETS_BY_CATEGORY: Record<MappingCategory, ScraperTarget[]> = {
  "MAPPING REFURBISHED": ["reebelo", "backmarket", "amazon"],
  "MAPPING BRAND NEW": ["jbhifi", "mobileciti", "buymobile", "spectronic", "bestmobilephone", "amazon"],
  "MAPPING BRAND NEW Laptop": ["jbhifi", "scorptec", "centrecom", "amazon"],
  "MAPPING BRAND NEW Lens dan Camera": ["amazon", "digidirect", "georges"],
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// When using pkg, process.pkg is defined. 
// We want PROJECT_ROOT to be the folder where the .exe is located for .env, input/ and output/.
const isPackaged = (process as any).pkg !== undefined;
const PROJECT_ROOT = isPackaged 
  ? process.cwd() 
  : path.resolve(__dirname, "../..");

dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

interface AppConfig {
  mappingCategory: MappingCategory;
  geminiApiKey: string;
  geminiApiKeys: string[];
  proxyUrl: string | null;
  amazonDomain: string;
  jbhifiDomain: string;
  koganDomain: string;
  phonebotDomain: string;
  reebeloDomain: string;
  backmarketDomain: string;
  mobilecitiDomain: string;
  buymobileDomain: string;
  spectronicDomain: string;
  bestmobilephoneDomain: string;
  scorptecDomain: string;
  centrecomDomain: string;
  digidirectDomain: string;
  georgesDomain: string;
  scraperTarget: ScraperTarget;
  requestDelayMinMs: number;
  requestDelayMaxMs: number;
  maxSearchResults: number;
  inputCsvPath: string;
  outputDir: string;
  projectRoot: string;
  isDryRun: boolean;
}

function validateCategoryTargetPair(category: MappingCategory, target: ScraperTarget): void {
  const validTargets = VALID_TARGETS_BY_CATEGORY[category];
  if (!validTargets) {
    throw new Error(
      `Invalid MAPPING_CATEGORY: "${category}". ` +
      `Valid options: ${Object.keys(VALID_TARGETS_BY_CATEGORY).join(", ")}`
    );
  }
  if (!validTargets.includes(target)) {
    throw new Error(
      `SCRAPER_TARGET "${target}" is NOT valid for MAPPING_CATEGORY "${category}".\n` +
      `Valid targets for "${category}": ${validTargets.join(", ")}`
    );
  }
}

function loadGeminiApiKeys(): string[] {
  const keys: string[] = [];
  // Primary key
  const primary = process.env.GEMINI_API_KEY;
  if (primary && primary !== "your_gemini_api_key_here") {
    keys.push(primary);
  }
  // Numbered keys: GEMINI_API_KEY1 .. GEMINI_API_KEY10
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`GEMINI_API_KEY${i}`];
    if (key && key.trim()) {
      keys.push(key.trim());
    }
  }
  return keys;
}

function loadConfig(): AppConfig {
  const geminiApiKeys = loadGeminiApiKeys();
  if (geminiApiKeys.length === 0) {
    throw new Error(
      "GEMINI_API_KEY is required. Set it in .env file."
    );
  }

  const isDryRun = process.argv.includes("--dry-run");

  const mappingCategory = (process.env.MAPPING_CATEGORY as MappingCategory) || "MAPPING BRAND NEW";
  const scraperTarget = (process.env.SCRAPER_TARGET as ScraperTarget) || "amazon";

  // Validate category ↔ target combination
  validateCategoryTargetPair(mappingCategory, scraperTarget);

  return {
    mappingCategory,
    geminiApiKey: geminiApiKeys[0],
    geminiApiKeys,
    proxyUrl: process.env.PROXY_URL || null,
    amazonDomain: process.env.AMAZON_DOMAIN || "www.amazon.com.au",
    jbhifiDomain: process.env.JBHIFI_DOMAIN || "www.jbhifi.com.au",
    phonebotDomain: process.env.PHONEBOT_DOMAIN || "www.phonebot.com.au",
    koganDomain: process.env.KOGAN_DOMAIN || "www.kogan.com.au",
    reebeloDomain: process.env.REEBELO_DOMAIN || "reebelo.com.au",
    backmarketDomain: process.env.BACKMARKET_DOMAIN || "www.backmarket.com.au",
    mobilecitiDomain: process.env.MOBILECITI_DOMAIN || "www.mobileciti.com.au",
    buymobileDomain: process.env.BUYMOBILE_DOMAIN || "buymobile.com.au",
    spectronicDomain: process.env.SPECTRONIC_DOMAIN || "spectronic.com.au",
    bestmobilephoneDomain: process.env.BESTMOBILEPHONE_DOMAIN || "bestmobilephone.com.au",
    scorptecDomain: process.env.SCORPTEC_DOMAIN || "www.scorptec.com.au",
    centrecomDomain: process.env.CENTRECOM_DOMAIN || "www.centrecom.com.au",
    digidirectDomain: process.env.DIGIDIRECT_DOMAIN || "www.digidirect.com.au",
    georgesDomain: process.env.GEORGES_DOMAIN || "www.georges.com.au",
    scraperTarget,
    requestDelayMinMs: parseInt(process.env.REQUEST_DELAY_MIN_MS || "3000", 10),
    requestDelayMaxMs: parseInt(process.env.REQUEST_DELAY_MAX_MS || "8000", 10),
    maxSearchResults: parseInt(process.env.MAX_SEARCH_RESULTS || "5", 10),
    inputCsvPath: path.resolve(
      PROJECT_ROOT,
      process.env.INPUT_CSV_PATH || "input/products.csv"
    ),
    outputDir: path.resolve(
      PROJECT_ROOT,
      process.env.OUTPUT_DIR || "output"
    ),
    projectRoot: PROJECT_ROOT,
    isDryRun,
  };
}

export const config = loadConfig();
