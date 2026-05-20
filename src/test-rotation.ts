import { GeminiMatcherService } from "./services/gemini-matcher.service.js";
import { GoogleGenAI } from "@google/genai";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";
import type { BecexProduct, AmazonSearchResult } from "./types/index.js";

// Keep track of which keys generated requests
const apiKeysUsed: string[] = [];

Object.defineProperty(GoogleGenAI.prototype, "models", {
  get() {
    const key = (this as any).apiKey;
    
    return {
      generateContent: async (args: any) => {
        apiKeysUsed.push(key);
        // If the key is one of the failing ones, throw 429 RESOURCE_EXHAUSTED
        if (key && key.includes("FAIL")) {
          const err = new Error("RESOURCE_EXHAUSTED: Quota exceeded (429).");
          (err as any).status = 429;
          throw err;
        }
        
        // Otherwise succeed!
        return {
          text: JSON.stringify({
            isMatch: true,
            confidence: 0.95,
            matchedResultIndex: 0,
            reasoning: "Perfect match on name and storage."
          })
        };
      }
    };
  },
  set(val) {},
  configurable: true
});

async function runTests() {
  logger.info("🧪 Starting API Key Rotation Test Suite...\n");

  // ==========================================
  // TEST 1: SUCCESSFUL ROTATION
  // ==========================================
  logger.info("--------------------------------------------");
  logger.info("Test 1: Rotate through 2 failing keys and succeed on the 3rd key");
  logger.info("--------------------------------------------");
  
  apiKeysUsed.length = 0; // reset
  const mockKeys = ["KEY_1_FAIL", "KEY_2_FAIL", "KEY_3_SUCCESS"];
  const service = new GeminiMatcherService(mockKeys, "MAPPING REFURBISHED", "amazon");

  const product: BecexProduct = {
    sku: "IPH15-128-BLK-EXD-AU",
    productName: "Apple iPhone 15 128GB Black"
  };

  const results: AmazonSearchResult[] = [{
    title: "Apple iPhone 15 128GB Black",
    price: 1100,
    url: "https://amazon.com.au/dp/B0CHX3D123",
    rating: 4.5,
    reviewCount: 120,
    isPrime: true
  }];

  try {
    const match = await service.findBestMatch(product, results);
    logger.info(`Result isMatch: ${match.isMatch}`);
    logger.info(`Result reasoning: ${match.reasoning}`);
    logger.info(`Keys used in sequence: ${JSON.stringify(apiKeysUsed)}`);

    if (match.isMatch && apiKeysUsed.length === 3 && apiKeysUsed[2] === "KEY_3_SUCCESS") {
      logger.info("✅ Test 1 PASSED: Successfully rotated and matched!");
    } else {
      logger.error("❌ Test 1 FAILED: Incorrect rotation behavior or match result.");
    }
  } catch (err) {
    logger.error(`❌ Test 1 FAILED: Unexpected error: ${(err as Error).message}`);
  }

  // ==========================================
  // TEST 2: ALL KEYS EXHAUSTED
  // ==========================================
  logger.info("\n--------------------------------------------");
  logger.info("Test 2: All keys in the pool throw 429 Quota Exceeded");
  logger.info("--------------------------------------------");
  
  apiKeysUsed.length = 0; // reset
  const allFailingKeys = ["KEY_A_FAIL", "KEY_B_FAIL"];
  const service2 = new GeminiMatcherService(allFailingKeys, "MAPPING REFURBISHED", "amazon");

  try {
    await service2.findBestMatch(product, results);
    logger.error("❌ Test 2 FAILED: Expected ALL_GEMINI_KEYS_EXHAUSTED but it succeeded.");
  } catch (err) {
    const msg = (err as Error).message;
    logger.info(`Caught expected error: ${msg}`);
    logger.info(`Keys used in sequence: ${JSON.stringify(apiKeysUsed)}`);

    if (msg === "ALL_GEMINI_KEYS_EXHAUSTED" && apiKeysUsed.length === 2) {
      logger.info("✅ Test 2 PASSED: Correctly threw ALL_GEMINI_KEYS_EXHAUSTED after trying all keys.");
    } else {
      logger.error("❌ Test 2 FAILED: Unexpected error message or rotation sequence.");
    }
  }

  // ==========================================
  // TEST 3: DISPLAY ENVIRONMENT KEYS
  // ==========================================
  logger.info("\n--------------------------------------------");
  logger.info("Test 3: Verify and list keys configured in current .env");
  logger.info("--------------------------------------------");

  const envKeys = config.geminiApiKeys;
  logger.info(`Found ${envKeys.length} Gemini API Key(s) in configuration.`);
  envKeys.forEach((key, index) => {
    const masked = key.length > 8 
      ? `${key.slice(0, 6)}...${key.slice(-4)}` 
      : "***";
    logger.info(`  Key [${index + 1}]: ${masked}`);
  });

  logger.info("\n🧪 Rotation Test Suite finished.");
}

runTests().catch(err => {
  logger.error(`Fatal Test Error: ${err.message}`);
});
