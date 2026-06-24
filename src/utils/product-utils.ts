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
  //    But preserve the PRIMARY storage found inside
  const parenContent = smart.match(/\(([^)]*)\)/)?.[1] || "";
  smart = smart.replace(/\s*\([^)]*\)\s*/g, " ");

  // 5. Extract the primary storage (the LARGEST storage value, as that's usually the disk/flash)
  const allStorageMatches = (name.match(/\b(\d+)\s*(GB|TB)\b/gi) || []);
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
    "Space Grey", "Space Gray", "Space Black", "Titanium Blue", "Titanium Black", 
    "Titanium Grey", "Titanium Gray", "Titanium Natural", "Titanium White",
    "Alpine Green", "Sierra Blue", "Pacific Blue", "Desert Titanium"
  ];
  for (const color of multiWordColors) {
    smart = smart.replace(new RegExp(`\\s*\\b${color}\\b`, "gi"), "");
  }
  
  const singleColors = [
    "Grey", "Gray", "Silver", "Black", "White", "Gold", "Pink", "Blue", "Green", 
    "Purple", "Yellow", "Red", "Midnight", "Starlight",
    "Cream", "Natural", "Violet", "Orange", "Lavender", "Mint"
  ];
  for (const color of singleColors) {
    smart = smart.replace(new RegExp(`\\s*\\b${color}\\b`, "gi"), "");
  }

  // 9. Remove "Australian Stock" / "AU Stock"
  smart = smart.replace(/\b(Australian Stock|AU Stock)\b/gi, "");

  // 10. Remove condition labels
  smart = smart.replace(/\b(Excellent|Pristine|Good|Very Good|Refurbished|Renewed)\b/gi, "");

  // 11. Remove filler words that add noise
  smart = smart.replace(/\b(Digital Cameras|Digital SLR Camera|Mirrorless Camera|With Adapter|Kit Box)\b/gi, "");

  // 12. Clean up punctuation and multiple spaces
  smart = smart.replace(/[(),]/g, "").replace(/\s+/g, " ").trim();

  // 13. Add back the primary storage if it was removed
  if (primaryStorage && !smart.includes(primaryStorage)) {
    smart = `${smart} ${primaryStorage}`;
  }

  // 14. Add back lens spec if it was in the original name (critical for camera lenses)
  if (lensSpec && !smart.includes(lensSpec)) {
    smart = `${smart} ${lensSpec}`;
  }

  // 15. Safety net: if result is too short, use first 4 meaningful words + storage
  const words = smart.split(" ").filter(w => w.length > 0);
  if (words.length < 2 && name.split(" ").length > 2) {
    const fallback = name.split(" - ")[0]
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

  // 3. Remove anything in parentheses
  broad = broad.replace(/\s*\([^)]*\)\s*/g, " ");

  // 4. Remove storage specs
  broad = broad.replace(/\d+\s*(?:GB|TB|MB)\s*\/\s*\d+\s*(?:GB|TB|MB)/gi, "");
  broad = broad.replace(/\d+\s*(?:GB|TB|MB)/gi, "");
  broad = broad.replace(/\s+/g, " ").trim();

  // 5. Remove connectivity
  broad = broad.replace(/\b(Cellular|Wi-Fi|Wifi|5G|4G)\b/gi, "");
  broad = broad.replace(/\s+/g, " ").trim();

  // 6. Remove colors
  const allColors = [
    "Space Grey", "Space Gray", "Space Black", "Titanium Blue", "Titanium Black", 
    "Titanium Grey", "Titanium Gray", "Titanium Natural", "Titanium White",
    "Alpine Green", "Sierra Blue", "Pacific Blue", "Desert Titanium",
    "Grey", "Gray", "Silver", "Black", "White", "Gold", "Pink", "Blue", "Green", 
    "Purple", "Yellow", "Red", "Midnight", "Starlight",
    "Cream", "Natural", "Violet", "Orange", "Lavender", "Mint"
  ];
  for (const color of allColors) {
    broad = broad.replace(new RegExp(`\\s*\\b${color}\\b`, "gi"), "");
  }

  // 7. Remove condition/stock/filler labels
  broad = broad.replace(/\b(Australian Stock|AU Stock)\b/gi, "");
  broad = broad.replace(/\b(Excellent|Pristine|Good|Very Good|Refurbished|Renewed)\b/gi, "");
  broad = broad.replace(/\b(Digital Cameras|Digital SLR Camera|Mirrorless Camera|With Adapter|Kit Box)\b/gi, "");

  // 8. Clean up
  broad = broad.replace(/[(),]/g, "").replace(/\s+/g, " ").trim();

  // 9. Safety net
  const words = broad.split(" ").filter(w => w.length > 0);
  if (words.length < 2 && name.split(" ").length > 2) {
    return name.split(" - ")[0]
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
  ram: string[];
  cpu: string[];
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
      storageVariants.push(`${num}${unit}`);      // "16GB"
      storageVariants.push(`${num} ${unit}`);      // "16 GB"
    }
  }

  // ── Colors (multi-word first, then single-word) ─────
  const allColors = [
    "Space Grey", "Space Gray", "Space Black", "Titanium Blue", "Titanium Black", 
    "Titanium Grey", "Titanium Gray", "Titanium Natural", "Titanium White",
    "Alpine Green", "Sierra Blue", "Pacific Blue", "Desert Titanium",
    "Grey", "Gray", "Silver", "Black", "White", "Gold", "Pink", "Blue", "Green", 
    "Purple", "Yellow", "Red", "Midnight", "Starlight",
    "Cream", "Natural", "Titanium", "Violet", "Orange", "Lavender", "Mint"
  ];

  const foundColors: string[] = [];
  for (const color of allColors) {
    const regex = new RegExp(`\\b${color}\\b`, "i");
    if (regex.test(name)) {
      // Avoid duplicates: e.g., don't add "Grey" if "Space Grey" already matched
      const isDuplicate = foundColors.some(existing => 
        existing.toLowerCase().includes(color.toLowerCase())
      );
      if (!isDuplicate) {
        foundColors.push(color);
      }
    }
  }

  // ── Connectivity ────────────────────────────────────
  const connectivityKeywords = ["Cellular", "Wi-Fi", "WiFi", "4G", "5G"];
  const foundConnectivity = connectivityKeywords.filter(keyword => {
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    return regex.test(name);
  });

  // ── RAM ──────────────────────────────────────────────
  const ramMatches = name.match(/\b(\d+)\s*(?:GB\s*RAM|RAM)\b/gi) || [];
  const ramVariants: string[] = [];
  for (const raw of ramMatches) {
    const match = raw.match(/(\d+)\s*(?:GB\s*RAM|RAM)/i);
    if (match) {
      const num = match[1];
      ramVariants.push(`${num}GB`);
      ramVariants.push(`${num} GB`);
    }
  }

  // ── CPU / Chip ──────────────────────────────────────
  const cpuKeywords = ["M1", "M2", "M3", "M4", "M5", "i3", "i5", "i7", "i9"];
  const foundCpu: string[] = [];
  for (const cpu of cpuKeywords) {
    const regex = new RegExp(`\\b${cpu}\\b`, "i");
    if (regex.test(name)) {
      foundCpu.push(cpu);
    }
  }

  return {
    storage: storageVariants,
    colors: foundColors,
    connectivity: foundConnectivity,
    ram: ramVariants,
    cpu: foundCpu
  };
}
