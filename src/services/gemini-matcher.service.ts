// ============================================================
// Gemini Matcher Service
// Uses Google Gemini AI to intelligently match products (Vision-enabled)
// Store-aware and Category-aware prompts per "Note untuk scrapping mapping.md"
// ============================================================

import { GoogleGenAI } from "@google/genai";
import type { BecexProduct, AmazonSearchResult, GeminiMatchResult, ScraperTarget, MappingCategory } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { loadRules } from "../utils/rules-manager.js";

// ── Store-specific rules (from rules.json) ───────────
function buildStoreRules(scraperTarget: ScraperTarget, mappingCategory: MappingCategory): string {
  const rules: string[] = [];
  const rulesConfig = loadRules();
  const catRules = rulesConfig[mappingCategory];

  if (!catRules) {
    return "";
  }

  if (mappingCategory === "MAPPING REFURBISHED") {
    rules.push("REFURBISHED MAPPING — You are matching refurbished/renewed products.");
    if (catRules.skuMappings) {
      for (const [cond, suffix] of Object.entries(catRules.skuMappings)) {
        rules.push(`Source SKU ending in '${suffix}' = ${cond} condition.`);
      }
    }

    const storeRules = catRules.stores[scraperTarget];
    if (storeRules) {
      rules.push(`STORE: ${scraperTarget}`);
      if (storeRules.conditionMapping) {
        for (const [ourCond, targetConds] of Object.entries(storeRules.conditionMapping)) {
          if (Array.isArray(targetConds)) {
            rules.push(`- ${ourCond} (our) → ${targetConds.join(" or ")} (${scraperTarget}).`);
          }
        }
      }
      if (storeRules.batteryPolicy) {
        rules.push(`- Battery: ONLY matches conforming to '${storeRules.batteryPolicy}' battery rules.`);
      }
      if (storeRules.simPolicy) {
        rules.push(`- SIM: ONLY matches conforming to '${storeRules.simPolicy}' SIM rules.`);
      }
      if (storeRules.excludePristine) {
        const pristineSuffix = catRules.skuMappings?.Pristine || "-VR-ASN-AU";
        rules.push(`- DO NOT map Pristine items to ${scraperTarget} AT ALL. If SKU ends in '${pristineSuffix}', set isMatch=false.`);
      }
      if (storeRules.excludeVeryGood) {
        const vgSuffix = catRules.skuMappings?.["Very Good"] || "-VGC-AU";
        rules.push(`- DO NOT map Very Good items to ${scraperTarget} AT ALL. If SKU ends in '${vgSuffix}', set isMatch=false.`);
      }
      if (storeRules.rejectBonusAccessories) {
        rules.push("- REJECT listings that mention: bonus accessories (case, screen protector, earphones, brick, etc.)");
      }
      if (storeRules.maxWarrantyMonths) {
        rules.push(`- REJECT listings with warranty > ${storeRules.maxWarrantyMonths} months.`);
      }
      if (storeRules.rejectAustralianVersion) {
        rules.push("- REJECT listings that say 'Australian version', 'AU Stock', or similar.");
      }
      if (storeRules.rejectPreOrder) {
        rules.push("- REJECT pre-order listings.");
      }
    }
  } else {
    // Brand New categories
    rules.push(`${mappingCategory} MAPPING — You are matching brand new (sealed) products.`);
    
    // Default store specific instructions
    if (scraperTarget === "jbhifi") {
      rules.push("STORE: JB Hi-Fi (jbhifi.com.au)");
      rules.push("- Products may be nested (with variant picker for connectivity/storage/color) or single.");
      rules.push("- Match the exact variant (storage, color, connectivity).");
    } else if (scraperTarget === "mobileciti") {
      rules.push("STORE: Mobileciti (mobileciti.com.au)");
      rules.push("- Search shows both parent (nested) and child products.");
      rules.push("- ONLY child product URLs are valid (they include specific color/variant in the URL path).");
      rules.push("- Parent URLs are generic and NOT usable.");
    } else if (scraperTarget === "buymobile") {
      rules.push("STORE: Buymobile (buymobile.com.au)");
      rules.push("- Search shows nested products (usually without color).");
      rules.push("- Parent URL is NOT usable. Must select color variant to get URL with 'variant=...' parameter.");
    } else if (scraperTarget === "spectronic") {
      rules.push("STORE: Spectronic (spectronic.com.au)");
      rules.push("- Simple: only single products, no nested. Can copy link from search results.");
      rules.push("- WARNING: Title may be truncated in search results. Verify product carefully.");
    } else if (scraperTarget === "bestmobilephone") {
      rules.push("STORE: BestMobilePhone (bestmobilephone.com.au)");
      rules.push("- Same as Spectronic: single products only, no nested.");
    } else if (scraperTarget === "scorptec") {
      rules.push("STORE: Scorptec (scorptec.com.au)");
      rules.push("- Search bar shows inline results immediately.");
      rules.push("- Can search by model number for accuracy. If model number is available, verify it matches.");
    } else if (scraperTarget === "centrecom") {
      rules.push("STORE: Centrecom (centrecom.com.au)");
      rules.push("- No nested products, but title format differs from other stores.");
      rules.push("- Verify by model number if available.");
    } else if (scraperTarget === "digidirect") {
      rules.push("STORE: Digidirect (digidirect.com.au)");
      rules.push("- Search bar shows inline results; matched text is bolded.");
      rules.push("- Products are NESTED — must select correct mount or bundle variant.");
      rules.push("- Parent URL is NOT usable until the correct variant is selected.");
    } else if (scraperTarget === "georges") {
      rules.push("STORE: Georges (georges.com.au)");
      rules.push("- Search is relatively accurate.");
      rules.push("- Products may be NESTED — must select correct variant for usable URL.");
    }

    const storeRules = catRules.stores[scraperTarget];
    if (storeRules) {
      if (storeRules.rejectBonusAccessories) {
        rules.push("- REJECT listings with bonus accessories (case, screen protector, earphones, etc.).");
      }
      if (storeRules.maxWarrantyYears) {
        rules.push(`- REJECT listings with warranty > ${storeRules.maxWarrantyYears} year.`);
      }
      if (storeRules.rejectAustralianVersion) {
        rules.push("- REJECT 'Australian version', 'AU Stock' listings.");
      }
      if (storeRules.rejectPreOrder) {
        rules.push("- REJECT pre-order listings.");
      }
      if (storeRules.rejectConditionLabels) {
        rules.push("- REJECT listings with ANY condition label (Renewed, Refurbished, Used, etc.). Must be brand new.");
      }
    }
  }

  return rules.join("\n");
}

// ── Constants ──────────────────────────────────────────────
const MIN_CONFIDENCE_THRESHOLD = 0.7;
const MAX_GEMINI_RETRIES = 2;

// ── Prompt template ────────────────────────────────────────
const MATCH_PROMPT_TEMPLATE = `You are a product matching expert. Your job is to determine which search result in the provided SCREENSHOT and LIST is the EXACT SAME product as the source product.

SOURCE PRODUCT:
Name: {{PRODUCT_NAME}}
SKU: {{PRODUCT_SKU}}

SEARCH RESULTS LIST:
{{SEARCH_RESULTS}}

MAPPING CATEGORY: {{MAPPING_CATEGORY}}
CURRENT STORE: {{SCRAPER_TARGET}}

{{STORE_RULES}}

CRITICAL MATCHING RULES:
1. **MODEL NUMBER MUST MATCH EXACTLY**: The exact model identifier must match. "EOS 250D" is NOT "EOS 2000D". "iPhone 15" is NOT "iPhone 15 Pro". "Galaxy S24" is NOT "Galaxy S24+". "iPad Air M2" is NOT "iPad Air M1". Pay close attention to every digit and word in the model name.
2. **STORAGE & COLOR ARE ABSOLUTE**: If the source says "Titanium Blue" and the result says "Titanium Grey", it is NOT a match. If the source says "1TB" and the result says "512GB", it is NOT a match.
3. **EXACT KEYWORDS**: Look for exact matches for storage (e.g., 128GB, 256GB, 512GB, 1TB) and color names.
4. **CONDITION MATCHING**: For Refurbished, ensure the condition maps correctly per the store-specific rules above.
5. **YEAR MATCHING**: If the source product specifies a release year (e.g., 2021, 2022, 2023), the matched result MUST be from the same year. Do NOT match a 2022 product with a 2023 listing.
6. **BODY vs KIT**: "Body Only" is NOT the same as a "Kit" with a lens. If the source says "Body Only", reject any result that includes a lens kit.
7. If multiple results match, pick the one that matches the title most closely.
8. If NONE match or color/specs/model differ, you MUST set isMatch to false. Do NOT force a match.
9. Set confidence between 0.0 and 1.0. Only use >= 0.8 when model, storage, color, and condition ALL match exactly.

EXAMPLES OF CORRECT MATCHING:
- Source: "Canon EOS 250D Body Only Black" → Result: "Canon EOS 2000D Kit 18-55mm" → isMatch: FALSE (different model: 250D ≠ 2000D, body ≠ kit)
- Source: "iPhone 15 Pro 256GB Titanium Blue" → Result: "iPhone 15 Pro 256GB Titanium Blue" → isMatch: TRUE, confidence: 0.95
- Source: "Samsung Galaxy S25 Ultra 512GB Black" → Result: "Samsung Galaxy S25 Ultra 256GB Black" → isMatch: FALSE (512GB ≠ 256GB)
- Source: "Canon EOS R1 Body Only" → Result: "Canon EOS R8 Body Only" → isMatch: FALSE (R1 ≠ R8)

Respond ONLY with a valid JSON object:
{
  "isMatch": boolean,
  "confidence": number (0.0 to 1.0),
  "matchedResultIndex": number (0-based index from the list, -1 if no match),
  "reasoning": "short explanation highlighting why model/storage/color/condition matches or why rejected"
}`;

export class GeminiMatcherService {
  private readonly apiKeys: string[];
  private currentKeyIndex: number;
  private readonly mappingCategory: MappingCategory;
  private readonly scraperTarget: ScraperTarget;
  private consecutiveFailures: number = 0;

  constructor(apiKeys: string[], mappingCategory: MappingCategory, scraperTarget: ScraperTarget) {
    this.apiKeys = apiKeys;
    this.currentKeyIndex = 0;
    this.mappingCategory = mappingCategory;
    this.scraperTarget = scraperTarget;
    logger.info(`Gemini API key pool loaded: ${apiKeys.length} key(s) available.`);
  }

  public updateKeys(newKeys: string[]) {
    this.apiKeys.length = 0;
    this.apiKeys.push(...newKeys);
    this.currentKeyIndex = 0;
    logger.info(`Gemini API key pool updated: ${newKeys.length} key(s) available.`);
  }

  public getApiKeys(): string[] {
    return [...this.apiKeys];
  }

  private getGenAI(): GoogleGenAI {
    return new GoogleGenAI({ apiKey: this.apiKeys[this.currentKeyIndex] });
  }

  private rotateKey(): boolean {
    const nextIndex = this.currentKeyIndex + 1;
    if (nextIndex >= this.apiKeys.length) {
      return false; // No more keys
    }
    this.currentKeyIndex = nextIndex;
    logger.warn(`🔄 Rotated to API key [${this.currentKeyIndex + 1}/${this.apiKeys.length}]`);
    return true;
  }

  private isQuotaError(error: Error): boolean {
    const msg = error.message || "";
    return msg.includes("429") || msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED");
  }

  async findBestMatch(
    becexProduct: BecexProduct,
    searchResults: AmazonSearchResult[],
    screenshotBuffer?: Buffer
  ): Promise<GeminiMatchResult> {
    if (this.apiKeys.length === 0) {
      logger.warn("No Gemini API key found. Falling back to first search result.");
      return { isMatch: true, confidence: 1, matchedResultIndex: 0, reasoning: "Fallback (No AI Key)" };
    }

    const formattedResults = searchResults
      .map((r, i) => `[${i}] "${r.title}" — Price: ${r.price || "N/A"}`)
      .join("\n");

    const storeRules = buildStoreRules(this.scraperTarget, this.mappingCategory);

    const promptText = MATCH_PROMPT_TEMPLATE
      .replace("{{PRODUCT_NAME}}", becexProduct.productName)
      .replace("{{PRODUCT_SKU}}", becexProduct.sku)
      .replace("{{MAPPING_CATEGORY}}", this.mappingCategory)
      .replace("{{SCRAPER_TARGET}}", this.scraperTarget)
      .replace("{{STORE_RULES}}", storeRules)
      .replace("{{SEARCH_RESULTS}}", formattedResults);

    const contents: any[] = [{ role: "user", parts: [{ text: promptText }] }];

    if (screenshotBuffer) {
      contents[0].parts.push({
        inlineData: {
          data: screenshotBuffer.toString("base64"),
          mimeType: "image/png"
        }
      });
    }

    // Try with key rotation on quota errors + retry on transient failures
    let retryCount = 0;

    while (true) {
      try {
        const genAI = this.getGenAI();
        const response = await genAI.models.generateContent({
          model: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
          contents,
          config: {
            temperature: 0.1,
            maxOutputTokens: 1000
          }
        });

        const text = response.text || "";
        const match = this.parseGeminiResponse(text, searchResults.length);

        // --- Confidence Threshold Gate ---
        if (match.isMatch && match.confidence < MIN_CONFIDENCE_THRESHOLD) {
          logger.warn(`Gemini match REJECTED due to low confidence (${match.confidence} < ${MIN_CONFIDENCE_THRESHOLD}) for: ${becexProduct.productName}`);
          return { isMatch: false, confidence: match.confidence, matchedResultIndex: -1, reasoning: `Low confidence (${match.confidence}): ${match.reasoning}` };
        }

        // --- Post-Verification (Zero-Debt Safety Net) ---
        if (match.isMatch && match.matchedResultIndex >= 0) {
          const result = searchResults[match.matchedResultIndex];
          const verification = this.verifyMatchConsistency(becexProduct.productName, result.title);
          if (!verification.passed) {
            logger.warn(`Gemini match REJECTED by local verification for: ${becexProduct.productName} -> ${result.title} (${verification.reason})`);
            return { isMatch: false, confidence: 0, matchedResultIndex: -1, reasoning: `Rejected by local verification: ${verification.reason}` };
          }
        }

        this.consecutiveFailures = 0;
        return match;
      } catch (error) {
        const err = error as Error;

        if (this.isQuotaError(err)) {
          logger.warn(`⚠️ Quota exceeded on key [${this.currentKeyIndex + 1}/${this.apiKeys.length}]: ${err.message}`);

          if (this.rotateKey()) {
            logger.info(`Retrying with next key [${this.currentKeyIndex + 1}/${this.apiKeys.length}]...`);
            continue; // Retry immediately with new key
          } else {
            // All keys exhausted — throw so caller can decide (e.g., break the loop)
            logger.error(`❌ ALL ${this.apiKeys.length} Gemini API keys exhausted!`);
            throw new Error("ALL_GEMINI_KEYS_EXHAUSTED");
          }
        }

        // Non-quota error — retry before giving up
        retryCount++;
        this.consecutiveFailures++;
        logger.error(`Gemini Error (attempt ${retryCount}/${MAX_GEMINI_RETRIES}): ${err.message}`);

        if (retryCount < MAX_GEMINI_RETRIES) {
          const backoffMs = retryCount * 2000;
          logger.info(`Retrying Gemini in ${backoffMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }

        // All retries exhausted — mark as no_match (NEVER blindly pick result[0])
        logger.error(`Gemini failed after ${MAX_GEMINI_RETRIES} retries. Marking as no_match.`);
        return { isMatch: false, confidence: 0, matchedResultIndex: -1, reasoning: `AI Error after ${MAX_GEMINI_RETRIES} retries: ${err.message}` };
      }
    }
  }

  public verifyMatchConsistency(sourceName: string, targetTitle: string): { passed: boolean; reason: string } {
    const sourceLower = sourceName.toLowerCase();
    const targetLower = targetTitle.toLowerCase();

    // Helper to normalize "8GB" and "8 GB" to "8gb"
    const normalize = (text: string) => text.replace(/\s*(gb|tb)\b/gi, "$1").toLowerCase();
    
    const sourceNorm = normalize(sourceLower);
    const targetNorm = normalize(targetLower);

    // 1. Model Number Check (e.g., "250D" vs "2000D", "R1" vs "R8", "S25" vs "S24")
    const modelCheck = this.verifyModelNumber(sourceLower, targetLower);
    if (!modelCheck.passed) {
      return modelCheck;
    }

    // 2. Body vs Kit Check
    const sourceIsBodyOnly = sourceLower.includes("body only") || sourceLower.includes("body digital");
    const targetHasLensKit = /\b(kit|lens|\d+-\d+mm)\b/i.test(targetLower) && !targetLower.includes("kit box");
    if (sourceIsBodyOnly && targetHasLensKit) {
      return { passed: false, reason: `Body-only source matched to lens kit target` };
    }

    // 3. Storage/RAM Check (e.g., 128GB, 1TB, 8GB RAM)
    const storagePattern = /\b(\d+\s*(?:GB|TB))\b/gi;
    const sourceStorages = sourceName.match(storagePattern) || [];
    
    for (const storage of sourceStorages) {
      const normStorage = normalize(storage);
      if (!targetNorm.includes(normStorage)) {
        // Special check: sometimes Backmarket says "1000 GB" instead of "1 TB"
        if (normStorage === "1tb" && (targetNorm.includes("1000gb") || targetNorm.includes("1024gb"))) continue;
        if (normStorage === "1000gb" && targetNorm.includes("1tb")) continue;
        
        return { passed: false, reason: `Storage mismatch: source has ${storage}, target missing` };
      }
    }

    // 4. Color Check
    const commonColors = [
      "blue", "grey", "gray", "black", "white", "silver", "gold", "green", "pink", "purple", "violet", "orange", "yellow", "cream", "natural", "titanium"
    ];

    for (const color of commonColors) {
      if (sourceLower.includes(color)) {
        if (!targetLower.includes(color)) {
          // Special case for Grey/Gray
          if (color === "grey" && targetLower.includes("gray")) continue;
          if (color === "gray" && targetLower.includes("grey")) continue;
          // Special case for Space Grey
          if (color === "grey" && targetLower.includes("space")) continue;
          return { passed: false, reason: `Color mismatch: source has "${color}", target missing` };
        }
      }
    }

    // 5. Year Check (e.g., 2020, 2021, 2022, 2023, 2024)
    const yearPattern = /\b(201\d|202\d)\b/g;
    const sourceYears: string[] = sourceName.match(yearPattern) ?? [];
    const targetYears: string[] = targetTitle.match(yearPattern) ?? [];

    for (const year of sourceYears) {
      if (targetYears.length > 0 && !targetYears.includes(year)) {
        return { passed: false, reason: `Year mismatch: source has ${year}, target has ${targetYears.join(",")}` };
      }
    }

    return { passed: true, reason: "All checks passed" };
  }

  /**
   * Extracts and compares model numbers/identifiers between source and target.
   * Catches cases like "EOS 250D" vs "EOS 2000D", "R1" vs "R8", "iPhone 15" vs "iPhone 15 Pro".
   */
  private verifyModelNumber(sourceLower: string, targetLower: string): { passed: boolean; reason: string } {
    // Remove condition/spec suffixes for cleaner model extraction
    const cleanForModel = (text: string) => 
      text.replace(/\b(excellent|pristine|good|very good|refurbished|renewed|brand new)\b/gi, "")
          .replace(/\b(australian stock|au stock|au version)\b/gi, "")
          .replace(/\(.*?\)/g, "")
          .replace(/\b\d+\s*(gb|tb|mb)\b/gi, "")
          .trim();

    const sourceClean = cleanForModel(sourceLower);
    const targetClean = cleanForModel(targetLower);

    // Model-number patterns to extract and compare
    const modelPatterns: RegExp[] = [
      // Camera models: "EOS 250D", "EOS R10", "EOS R1", "EOS R5 Mark II"
      /\beos\s+([a-z0-9]+(?:\s+mark\s+[iv]+)?)/i,
      // iPhone models: "iPhone 15", "iPhone 15 Pro", "iPhone 15 Pro Max"
      /\biphone\s+(\d+(?:\s+pro)?(?:\s+max)?(?:\s+plus)?)/i,
      // Samsung Galaxy models: "Galaxy S25", "Galaxy S25 Ultra", "Galaxy S25+", "Galaxy A14"
      /\bgalaxy\s+([a-z]\d+(?:\+|\s+ultra|\s+fe|\s+plus)?)/i,
      // iPad models: "iPad Pro 11", "iPad Air M2", "iPad Mini", "iPad 10"
      /\bipad\s+(pro|air|mini)?\s*(\d+)?/i,
      // MacBook models: "MacBook Pro 14", "MacBook Air M3"
      /\bmacbook\s+(pro|air)?\s*(\d+)?/i,
      // Google Pixel: "Pixel 9", "Pixel 9 Pro"
      /\bpixel\s+(\d+(?:\s+pro)?(?:\s+a)?(?:\s+xl)?)/i,
      // Generic alphanumeric model numbers: "A14", "S25", "2000D", "250D"
      /\b([a-z]?\d{2,5}[a-z]?)\b/i,
    ];

    for (const pattern of modelPatterns) {
      const sourceMatch = sourceClean.match(pattern);
      const targetMatch = targetClean.match(pattern);

      if (sourceMatch && targetMatch) {
        const sourceModel = sourceMatch[0].trim().toLowerCase();
        const targetModel = targetMatch[0].trim().toLowerCase();

        // If source model is clearly present in target (or vice versa), pass
        if (sourceModel === targetModel) continue;

        // Check if one is a substring-but-different (e.g., "iphone 15" in "iphone 15 pro")
        // Source: "iPhone 15" must NOT match "iPhone 15 Pro" (Pro is extra)
        if (sourceModel !== targetModel) {
          // Only flag if the pattern is specific enough (skip generic single-number patterns)
          const isSpecificPattern = pattern.source.includes("eos") || 
                                     pattern.source.includes("iphone") || 
                                     pattern.source.includes("galaxy") || 
                                     pattern.source.includes("pixel") ||
                                     pattern.source.includes("ipad") ||
                                     pattern.source.includes("macbook");
          if (isSpecificPattern) {
            return { passed: false, reason: `Model mismatch: "${sourceMatch[0]}" ≠ "${targetMatch[0]}"` };
          }
        }
      }
    }

    return { passed: true, reason: "Model check passed" };
  }

  private parseGeminiResponse(responseText: string, maxResults: number): GeminiMatchResult {
    try {
      const cleaned = responseText.replace(/```json\s?|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      let index = parseInt(parsed.matchedResultIndex);

      // If index is invalid, treat as no match (NEVER blindly pick result[0])
      if (isNaN(index) || index < 0 || index >= maxResults) {
        return {
          isMatch: false,
          confidence: 0,
          matchedResultIndex: -1,
          reasoning: `Invalid matchedResultIndex (${parsed.matchedResultIndex}). Treating as no_match.`
        };
      }

      return {
        isMatch: !!parsed.isMatch,
        confidence: parsed.confidence || 0,
        matchedResultIndex: parsed.isMatch ? index : -1,
        reasoning: parsed.reasoning || ""
      };
    } catch (parseError) {
      // Parse error — NEVER blindly pick result[0]. Return no_match.
      logger.warn(`Failed to parse Gemini response: ${(parseError as Error).message}. Raw: ${responseText.substring(0, 200)}`);
      return { isMatch: false, confidence: 0, matchedResultIndex: -1, reasoning: "Parse error: AI response was not valid JSON" };
    }
  }
}
