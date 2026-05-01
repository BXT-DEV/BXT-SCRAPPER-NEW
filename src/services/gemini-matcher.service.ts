// ============================================================
// Gemini Matcher Service
// Uses Google Gemini AI to intelligently match products (Vision-enabled)
// Store-aware and Category-aware prompts per "Note untuk scrapping mapping.md"
// ============================================================

import { GoogleGenAI } from "@google/genai";
import type { BecexProduct, AmazonSearchResult, GeminiMatchResult, ScraperTarget, MappingCategory } from "../types/index.js";
import { logger } from "../utils/logger.js";

// ── Store-specific rules (from mapping document) ───────────
function buildStoreRules(scraperTarget: ScraperTarget, mappingCategory: MappingCategory): string {
  const rules: string[] = [];

  // ── REFURBISHED ──────────────────────────────────────────
  if (mappingCategory === "MAPPING REFURBISHED") {
    rules.push("REFURBISHED MAPPING — You are matching refurbished/renewed products.");
    rules.push("Source SKU ending in '-VR-ASN-AU' = Pristine condition.");
    rules.push("Source SKU ending in '-RD-VR-EXD-AU' = Excellent condition.");

    if (scraperTarget === "reebelo") {
      rules.push("STORE: Reebelo (reebelo.com.au)");
      rules.push("- Pristine (our) → Premium (Reebelo). Excellent (our) → Excellent (Reebelo).");
      rules.push("- Battery: ONLY 'Standard Battery'. REJECT if only 'Elevated' or 'New Battery' available.");
      rules.push("- SIM: ONLY listings with Physical SIM. REJECT if only eSIM available.");
    } else if (scraperTarget === "backmarket") {
      rules.push("STORE: Backmarket (backmarket.com.au)");
      rules.push("- Pristine (our) → Excellent (Backmarket). Excellent (our) → Good (Backmarket).");
      rules.push("- SIM: ONLY listings with Physical SIM. REJECT if only eSIM available.");
    } else if (scraperTarget === "amazon") {
      rules.push("STORE: Amazon (amazon.com.au) — REFURBISHED rules");
      rules.push("- DO NOT map Pristine items to Amazon AT ALL. If SKU ends in '-VR-ASN-AU', set isMatch=false.");
      rules.push("- Excellent (our) → ONLY match 'Excellent' or 'Renewed' condition. Renewed = Excellent.");
      rules.push("- REJECT listings that mention: bonus accessories (case, screen protector, earphones, brick, etc.)");
      rules.push("- REJECT listings with warranty > 6 months.");
      rules.push("- REJECT listings that say 'Australian version', 'AU Stock', or similar.");
      rules.push("- REJECT pre-order listings.");
    }
  }

  // ── BRAND NEW ────────────────────────────────────────────
  if (mappingCategory === "MAPPING BRAND NEW") {
    rules.push("BRAND NEW MAPPING — You are matching brand new (sealed) products.");

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
    } else if (scraperTarget === "amazon") {
      rules.push("STORE: Amazon (amazon.com.au) — BRAND NEW rules");
      rules.push("- REJECT listings with bonus accessories (case, screen protector, earphones, etc.).");
      rules.push("- REJECT listings with warranty > 1 year.");
      rules.push("- REJECT 'Australian version', 'AU Stock' listings.");
      rules.push("- REJECT pre-order listings.");
      rules.push("- REJECT listings with ANY condition label (Renewed, Refurbished, Used, etc.). Must be brand new.");
    }
  }

  // ── BRAND NEW LAPTOP ─────────────────────────────────────
  if (mappingCategory === "MAPPING BRAND NEW Laptop") {
    rules.push("BRAND NEW LAPTOP MAPPING — Laptops are harder to match. Same name/image may differ by release year and chipset.");

    if (scraperTarget === "jbhifi") {
      rules.push("STORE: JB Hi-Fi — Same rules as Brand New.");
    } else if (scraperTarget === "scorptec") {
      rules.push("STORE: Scorptec (scorptec.com.au)");
      rules.push("- Search bar shows inline results immediately.");
      rules.push("- Can search by model number for accuracy. If model number is available, verify it matches.");
    } else if (scraperTarget === "centrecom") {
      rules.push("STORE: Centrecom (centrecom.com.au)");
      rules.push("- No nested products, but title format differs from other stores.");
      rules.push("- Verify by model number if available.");
      rules.push("- NOTE: This store has CAPTCHA protection.");
    } else if (scraperTarget === "amazon") {
      rules.push("STORE: Amazon (amazon.com.au) — BRAND NEW LAPTOP rules");
      rules.push("- Same rejection rules as Brand New: no bonus accessories, no AU version, no pre-order, warranty ≤ 1 year.");
      rules.push("- REJECT any listing with a condition label (Renewed, Refurbished, Used).");
      rules.push("- Pay special attention to chipset/release year differences.");
    }
  }

  // ── BRAND NEW LENS & CAMERA ──────────────────────────────
  if (mappingCategory === "MAPPING BRAND NEW Lens dan Camera") {
    rules.push("LENS & CAMERA MAPPING — EXTRA PRECISION REQUIRED. One letter difference = different product.");

    if (scraperTarget === "amazon") {
      rules.push("STORE: Amazon (amazon.com.au) — LENS/CAMERA rules");
      rules.push("- Same rejection rules as Brand New: no bonus accessories, no AU version, no pre-order, warranty ≤ 1 year.");
      rules.push("- REJECT any listing with a condition label.");
      rules.push("- Be EXTREMELY precise with model names. E.g., 'RF 24-70mm f/2.8L IS USM' ≠ 'RF 24-70mm f/4L IS STM'.");
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
  }

  return rules.join("\n");
}

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
1. **STORAGE & COLOR ARE ABSOLUTE**: If the source says "Titanium Blue" and the result says "Titanium Grey", it is NOT a match. If the source says "1TB" and the result says "512GB", it is NOT a match.
2. **EXACT KEYWORDS**: Look for exact matches for storage (e.g., 128GB, 256GB, 512GB, 1TB) and color names.
3. **CONDITION MATCHING**: For Refurbished, ensure the condition maps correctly per the store-specific rules above.
4. If multiple results match, pick the one that matches the title most closely.
5. If none match or color/specs differ, set isMatch to false.

Respond ONLY with a valid JSON object:
{
  "isMatch": boolean,
  "confidence": number,
  "matchedResultIndex": number (0-based index from the list),
  "reasoning": "short explanation highlighting why storage/color/condition matches or why rejected"
}`;

export class GeminiMatcherService {
  private readonly apiKeys: string[];
  private currentKeyIndex: number;
  private readonly mappingCategory: MappingCategory;
  private readonly scraperTarget: ScraperTarget;

  constructor(apiKeys: string[], mappingCategory: MappingCategory, scraperTarget: ScraperTarget) {
    this.apiKeys = apiKeys;
    this.currentKeyIndex = 0;
    this.mappingCategory = mappingCategory;
    this.scraperTarget = scraperTarget;
    logger.info(`Gemini API key pool loaded: ${apiKeys.length} key(s) available.`);
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

    // Try with key rotation on quota errors
    const startKeyIndex = this.currentKeyIndex;
    while (true) {
      try {
        const genAI = this.getGenAI();
        const response = await genAI.models.generateContent({
          model: "gemini-2.0-flash",
          contents,
          config: {
            temperature: 0.1,
            maxOutputTokens: 1000
          }
        });

        const text = response.text || "";
        const match = this.parseGeminiResponse(text, searchResults.length);

        // --- Post-Verification (Zero-Debt Safety Net) ---
        if (match.isMatch && match.matchedResultIndex >= 0) {
          const result = searchResults[match.matchedResultIndex];
          const isVerified = this.verifyMatchConsistency(becexProduct.productName, result.title);
          if (!isVerified) {
            logger.warn(`Gemini match REJECTED by local verification for: ${becexProduct.productName} -> ${result.title}`);
            return { isMatch: false, confidence: 0, matchedResultIndex: -1, reasoning: "Rejected by local verification (Color/Storage mismatch)" };
          }
        }

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

        // Non-quota error — fallback
        logger.error(`Gemini Error: ${err.message}`);
        return { isMatch: true, confidence: 0.5, matchedResultIndex: 0, reasoning: "AI Error fallback" };
      }
    }
  }

  public verifyMatchConsistency(sourceName: string, targetTitle: string): boolean {
    const sourceLower = sourceName.toLowerCase();
    const targetLower = targetTitle.toLowerCase();

    // 1. Storage Check (e.g., 128GB, 1TB)
    const storagePattern = /\b(\d+(?:GB|TB))\b/gi;
    const sourceStorages = sourceName.match(storagePattern) || [];
    for (const storage of sourceStorages) {
      if (!targetLower.includes(storage.toLowerCase())) return false;
    }

    // 2. Color Check
    const commonColors = [
      "blue", "grey", "gray", "black", "white", "silver", "gold", "green", "pink", "purple", "violet", "orange", "yellow", "cream", "natural", "titanium"
    ];
    
    for (const color of commonColors) {
      if (sourceLower.includes(color)) {
        if (!targetLower.includes(color)) {
          // Special case for Grey/Gray
          if (color === "grey" && targetLower.includes("gray")) continue;
          if (color === "gray" && targetLower.includes("grey")) continue;
          return false;
        }
      }
    }

    return true;
  }

  private parseGeminiResponse(responseText: string, maxResults: number): GeminiMatchResult {
    try {
      const cleaned = responseText.replace(/```json\s?|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      let index = parseInt(parsed.matchedResultIndex);
      if (isNaN(index) || index < 0 || index >= maxResults) index = 0;

      return {
        isMatch: !!parsed.isMatch,
        confidence: parsed.confidence || 0,
        matchedResultIndex: index,
        reasoning: parsed.reasoning || ""
      };
    } catch {
      return { isMatch: true, confidence: 0, matchedResultIndex: 0, reasoning: "Parse error fallback" };
    }
  }
}
