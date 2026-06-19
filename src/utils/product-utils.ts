/**
 * Utilities for processing product names and extracting specifications.
 */

/**
 * Generates a SMART search query that keeps the core identity + key storage spec,
 * giving search engines enough specificity for relevant results while still
 * allowing fuzzy matching on color/condition.
 *
 * Example:
 *   "Apple iPad 2 Cellular 16GB, Grey Australian Stock - Excellent"
 *   → "Apple iPad 2 16GB"
 *
 *   "Samsung Galaxy S25 Ultra 5G (12GB/512GB) Titanium Black - Brand New"
 *   → "Samsung Galaxy S25 Ultra 5G 512GB"
 *
 *   "Canon EOS 250D Body Only Kit Box Black Digital Cameras - Brand New"
 *   → "Canon EOS 250D Body Only"
 *
 *   "Canon EOS R10 Mirrorless Camera (18-150mm Lens) With Adapter - Brand New"
 *   → "Canon EOS R10 18-150mm"
 */
export function getSmartSearchQuery(name: string): string {
  // 1. Remove everything after " - " (usually "- Brand New", "- Excellent", etc.)
  let smart = name.split(" - ")[0];

  // 2. Remove "Brand New" if it's at the end
  smart = smart.replace(/\s*Brand New\s*$/i, "");

  // 3. Extract lens spec BEFORE removing parentheses (e.g., "18-150mm")
  const lensMatch = smart.match(/\b(\d+-\d+mm)\b/);
  const lensSpec = lensMatch ? lensMatch[1] : "";

  // 4. Remove anything in parentheses (usually specs like "(i5, 8GB RAM, 1TB)")
  //    But preserve the PRIMARY storage and processor/chip identifier found inside
  const parenContent = smart.match(/\(([^)]*)\)/)?.[1] || "";
  const smartProcessorMatch = parenContent.match(
    /\b(M[1-4](?:\s*(?:Pro|Max|Ultra))?|i[3579])\b/i,
  );
  const smartProcessorSpec = smartProcessorMatch ? smartProcessorMatch[1] : "";
  smart = smart.replace(/\s*\([^)]*\)\s*/g, " ");

  // 5. Extract the primary storage (the LARGEST storage value, as that's usually the disk/flash)
  const allStorageMatches = name.match(/\b(\d+)\s*(GB|TB)\b/gi) || [];
  let primaryStorage = "";
  if (allStorageMatches.length > 0) {
    // Pick the largest value (skip RAM) — e.g., from "8GB RAM, 512GB" pick "512GB"
    let maxBytes = 0;
    for (const s of allStorageMatches) {
      const m = s.match(/(\d+)\s*(GB|TB)/i);
      if (m) {
        const value = parseInt(m[1]);
        const unit = m[2].toUpperCase();
        const bytes = unit === "TB" ? value * 1024 : value;
        if (bytes > maxBytes) {
          maxBytes = bytes;
          primaryStorage = `${m[1]}${unit}`;
        }
      }
    }
  }

  // 6. Remove ALL storage specs from the string (we'll add back the primary one)
  smart = smart.replace(/\d+\s*(?:GB|TB|MB)\s*\/\s*\d+\s*(?:GB|TB|MB)/gi, "");
  smart = smart.replace(/\d+\s*(?:GB|TB|MB)/gi, "");
  smart = smart.replace(/\s+/g, " ").trim();

  // 7. Remove connectivity keywords (but keep 5G/4G as they're part of model names)
  smart = smart.replace(/\b(Cellular|Wi-Fi|Wifi)\b/gi, "");
  smart = smart.replace(/\s+/g, " ").trim();

  // 8. Remove colors (these narrow search too much and search engines handle fuzzy matching)
  const multiWordColors = [
    "Space Grey",
    "Space Gray",
    "Space Black",
    "Deep Purple",
    "Titanium Blue",
    "Titanium Black",
    "Titanium Grey",
    "Titanium Gray",
    "Titanium Natural",
    "Titanium White",
    "Alpine Green",
    "Sierra Blue",
    "Pacific Blue",
    "Desert Titanium",
  ];
  for (const color of multiWordColors) {
    smart = smart.replace(new RegExp(`\\s*\\b${color}\\b`, "gi"), "");
  }

  const singleColors = [
    "Grey",
    "Gray",
    "Silver",
    "Black",
    "White",
    "Gold",
    "Pink",
    "Blue",
    "Green",
    "Purple",
    "Yellow",
    "Red",
    "Midnight",
    "Starlight",
    "Cream",
    "Natural",
    "Violet",
    "Orange",
    "Lavender",
    "Mint",
  ];
  for (const color of singleColors) {
    smart = smart.replace(new RegExp(`\\s*\\b${color}\\b`, "gi"), "");
  }

  // 9. Remove "Australian Stock" / "AU Stock"
  smart = smart.replace(/\b(Australian Stock|AU Stock)\b/gi, "");

  // 10. Remove condition labels
  smart = smart.replace(
    /\b(Excellent|Pristine|Good|Very Good|Refurbished|Renewed)\b/gi,
    "",
  );

  // 11. Remove filler words that add noise
  smart = smart.replace(
    /\b(Digital Cameras|Digital SLR Camera|Mirrorless Camera|With Adapter|Kit Box)\b/gi,
    "",
  );

  // 12. Strip Apple/device model numbers and year adjectives (not in Reebelo/JB titles)
  smart = smart.replace(/\b[Aa]\d{4}\b/g, "");
  smart = smart.replace(/\b(Mid|Early|Late)\b/gi, "");

  // 13. Clean up punctuation and multiple spaces
  smart = smart.replace(/[(),]/g, "").replace(/\s+/g, " ").trim();

  // 13.5. Re-add processor if it came from inside parens and isn't already present
  if (
    smartProcessorSpec &&
    !smart.toLowerCase().includes(smartProcessorSpec.toLowerCase())
  ) {
    smart = `${smart} ${smartProcessorSpec}`;
  }

  // 14. Add back the primary storage if it was removed
  if (primaryStorage && !smart.includes(primaryStorage)) {
    smart = `${smart} ${primaryStorage}`;
  }

  // 15. Add back lens spec if it was in the original name (critical for camera lenses)
  if (lensSpec && !smart.includes(lensSpec)) {
    smart = `${smart} ${lensSpec}`;
  }

  // 16. Safety net: if result is too short, use first 4 meaningful words + storage
  const words = smart.split(" ").filter((w) => w.length > 0);
  if (words.length < 2 && name.split(" ").length > 2) {
    const fallback = name
      .split(" - ")[0]
      .split(" ")
      .slice(0, 5)
      .join(" ")
      .replace(/[(),]/g, "")
      .trim();
    return primaryStorage ? `${fallback} ${primaryStorage}` : fallback;
  }

  return smart;
}

/**
 * Generates a broader search query (fallback when smart query returns no results).
 * Strips everything except brand + model.
 *
 * Example:
 *   "Samsung Galaxy S25 Ultra 5G (12GB/512GB) Titanium Black - Brand New"
 *   → "Samsung Galaxy S25 Ultra"
 */
export function getBroadSearchQuery(name: string): string {
  // 1. Remove everything after " - "
  let broad = name.split(" - ")[0];

  // 2. Remove "Brand New"
  broad = broad.replace(/\s*Brand New\s*$/i, "");

  // 2.5. Before removing parens: extract processor/chip identifier (M1, M2, i5, i7, etc.)
  //      so it can be preserved in the query (e.g. "MacBook Air 2020 (M1,...)" → keep "M1")
  const broadParenContent = broad.match(/\(([^)]*)\)/)?.[1] || "";
  const broadProcessorMatch = broadParenContent.match(
    /\b(M[1-4](?:\s*(?:Pro|Max|Ultra))?|i[3579])\b/i,
  );
  const broadProcessorSpec = broadProcessorMatch ? broadProcessorMatch[1] : "";

  // 3. Remove anything in parentheses
  broad = broad.replace(/\s*\([^)]*\)\s*/g, " ");

  // Re-add processor if it was extracted from inside parens and isn't already in the string
  if (
    broadProcessorSpec &&
    !broad.toLowerCase().includes(broadProcessorSpec.toLowerCase())
  ) {
    broad = `${broad} ${broadProcessorSpec}`.trim();
  }

  // 4. Remove storage specs
  broad = broad.replace(/\d+\s*(?:GB|TB|MB)\s*\/\s*\d+\s*(?:GB|TB|MB)/gi, "");
  broad = broad.replace(/\d+\s*(?:GB|TB|MB)/gi, "");
  broad = broad.replace(/\s+/g, " ").trim();

  // 5. Remove connectivity
  broad = broad.replace(/\b(Cellular|Wi-Fi|Wifi|5G|4G)\b/gi, "");
  broad = broad.replace(/\s+/g, " ").trim();

  // 6. Remove colors
  const allColors = [
    "Space Grey",
    "Space Gray",
    "Space Black",
    "Deep Purple",
    "Titanium Blue",
    "Titanium Black",
    "Titanium Grey",
    "Titanium Gray",
    "Titanium Natural",
    "Titanium White",
    "Alpine Green",
    "Sierra Blue",
    "Pacific Blue",
    "Desert Titanium",
    "Grey",
    "Gray",
    "Silver",
    "Black",
    "White",
    "Gold",
    "Pink",
    "Blue",
    "Green",
    "Purple",
    "Yellow",
    "Red",
    "Midnight",
    "Starlight",
    "Cream",
    "Natural",
    "Violet",
    "Orange",
    "Lavender",
    "Mint",
  ];
  for (const color of allColors) {
    broad = broad.replace(new RegExp(`\\s*\\b${color}\\b`, "gi"), "");
  }

  // 7. Remove condition/stock/filler labels
  broad = broad.replace(/\b(Australian Stock|AU Stock)\b/gi, "");
  broad = broad.replace(
    /\b(Excellent|Pristine|Good|Very Good|Refurbished|Renewed)\b/gi,
    "",
  );
  broad = broad.replace(
    /\b(Digital Cameras|Digital SLR Camera|Mirrorless Camera|With Adapter|Kit Box)\b/gi,
    "",
  );

  // 8. Strip Apple/device model numbers (A2337, A2179, A2141, etc.) – not used in Reebelo titles
  broad = broad.replace(/\b[Aa]\d{4}\b/g, "");

  // 9. Strip year adjectives (Mid 2017, Early 2019, Late 2020) – not in Reebelo titles
  broad = broad.replace(/\b(Mid|Early|Late)\b/gi, "");

  // 10. Clean up
  broad = broad.replace(/[(),]/g, "").replace(/\s+/g, " ").trim();

  // 11. Safety net
  const words = broad.split(" ").filter((w) => w.length > 0);
  if (words.length < 2 && name.split(" ").length > 2) {
    return name
      .split(" - ")[0]
      .split(" ")
      .slice(0, 4)
      .join(" ")
      .replace(/[(),]/g, "")
      .trim();
  }

  return broad;
}

/**
 * Extracts product specifications from a full product name.
 * Returns both the raw value (as-is in the name) and normalized versions
 * so that variant buttons like "16 GB" and "16GB" both match.
 *
 * Example:
 *   "Apple iPad 2 Cellular 16GB, Grey Australian Stock - Excellent"
 *   → storage: ["16GB", "16 GB"], colors: ["Grey"], connectivity: ["Cellular"]
 */
export function extractSpecs(name: string): {
  storage: string[];
  colors: string[];
  connectivity: string[];
  sizes: string[];
} {
  // ── Storage ──────────────────────────────────────────
  const storageMatches = name.match(/\b(\d+)\s*(GB|TB|MB)\b/gi) || [];
  // Generate both "16GB" and "16 GB" variants for matching
  const storageVariants: string[] = [];
  for (const raw of storageMatches) {
    const match = raw.match(/(\d+)\s*(GB|TB|MB)/i);
    if (match) {
      const num = match[1];
      const unit = match[2].toUpperCase();
      storageVariants.push(`${num}${unit}`); // "16GB"
      storageVariants.push(`${num} ${unit}`); // "16 GB"
    }
  }

  // ── Colors (multi-word first, then single-word) ─────
  const allColors = [
    "Space Grey",
    "Space Gray",
    "Space Black",
    "Deep Purple",
    "Titanium Blue",
    "Titanium Black",
    "Titanium Grey",
    "Titanium Gray",
    "Titanium Natural",
    "Titanium White",
    "Alpine Green",
    "Sierra Blue",
    "Pacific Blue",
    "Desert Titanium",
    "Grey",
    "Gray",
    "Silver",
    "Black",
    "White",
    "Gold",
    "Pink",
    "Blue",
    "Green",
    "Purple",
    "Yellow",
    "Red",
    "Midnight",
    "Starlight",
    "Cream",
    "Natural",
    "Titanium",
    "Violet",
    "Orange",
    "Lavender",
    "Mint",
  ];

  const foundColors: string[] = [];
  for (const color of allColors) {
    const regex = new RegExp(`\\b${color}\\b`, "i");
    if (regex.test(name)) {
      // Avoid duplicates: e.g., don't add "Grey" if "Space Grey" already matched
      const isDuplicate = foundColors.some((existing) =>
        existing.toLowerCase().includes(color.toLowerCase()),
      );
      if (!isDuplicate) {
        foundColors.push(color);
      }
    }
  }

  // ── Sizes (MM) – for Watches (40mm, 44mm, 45mm, 46mm, etc.) ──
  const sizeMatches = name.match(/\b(\d+)\s*[Mm][Mm]\b/g) || [];
  const sizeVariants: string[] = [];
  for (const raw of sizeMatches) {
    const match = raw.match(/(\d+)\s*[Mm][Mm]/i);
    if (match) {
      const num = match[1];
      sizeVariants.push(`${num}mm`); // "40mm"
      sizeVariants.push(`${num} mm`); // "40 mm"
      sizeVariants.push(`${num}MM`); // "40MM"
    }
  }

  // ── Connectivity ────────────────────────────────────
  // Includes Bluetooth and LTE for Watch products
  const connectivityKeywords = [
    "Cellular",
    "Wi-Fi",
    "WiFi",
    "4G",
    "5G",
    "LTE",
    "Bluetooth",
  ];
  const foundConnectivity = connectivityKeywords.filter((keyword) => {
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    return regex.test(name);
  });

  return {
    storage: storageVariants,
    colors: foundColors,
    connectivity: foundConnectivity,
    sizes: sizeVariants,
  };
}
