/**
 * Utilities for processing product names and extracting specifications.
 */

/**
 * Generates a broader search query by keeping the core product identity
 * (brand + model) while stripping specs like storage, color, connectivity.
 * 
 * Example:
 *   "Apple iPad 2 Cellular 16GB, Grey Australian Stock - Excellent"
 *   → "Apple iPad 2"
 *
 *   "Samsung Galaxy S25 Ultra 5G (12GB/512GB) Titanium Black - Brand New"
 *   → "Samsung Galaxy S25 Ultra"
 */
export function getBroadSearchQuery(name: string): string {
  // 1. Remove everything after " - " (usually "- Brand New", "- Excellent", etc.)
  let broad = name.split(" - ")[0];

  // 2. Remove "Brand New" if it's at the end
  broad = broad.replace(/\s*Brand New\s*$/i, "");

  // 2.5 Remove anything in parentheses (usually specs like "(i5, 8GB RAM, 1TB)")
  broad = broad.replace(/\s*\([^)]*\)\s*/g, " ");

  // 3. Remove storage specs: 16GB, 256 GB, 1 TB
  //    Also handle slash patterns like "8GB/512GB" or "(12GB/512GB)"
  broad = broad.replace(/\d+\s*(?:GB|TB|MB)\s*\/\s*\d+\s*(?:GB|TB|MB)/gi, ""); // "8GB/512GB"
  broad = broad.replace(/\d+\s*(?:GB|TB|MB)/gi, ""); // standalone "16GB" or "1 TB"
  broad = broad.replace(/\s+/g, " ").trim(); // normalize spaces after removal

  // 4. Remove connectivity keywords
  broad = broad.replace(/\b(Cellular|Wi-Fi|Wifi)\b/gi, "");
  broad = broad.replace(/\s+/g, " ").trim(); // normalize spaces after removal
  // Keep "5G" and "4G" — they're often part of model names like "Galaxy S25 5G"

  // 5. Remove colors (order matters — multi-word colors first)
  const multiWordColors = [
    "Space Grey", "Space Gray", "Space Black", "Titanium Blue", "Titanium Black", 
    "Titanium Grey", "Titanium Gray", "Titanium Natural", "Titanium White",
    "Alpine Green", "Sierra Blue", "Pacific Blue", "Desert Titanium"
  ];
  for (const color of multiWordColors) {
    broad = broad.replace(new RegExp(`\\s*\\b${color}\\b`, "gi"), "");
  }
  
  const singleColors = [
    "Grey", "Gray", "Silver", "Black", "White", "Gold", "Pink", "Blue", "Green", 
    "Purple", "Yellow", "Red", "Midnight", "Starlight",
    "Cream", "Natural", "Violet", "Orange", "Lavender", "Mint"
  ];
  for (const color of singleColors) {
    broad = broad.replace(new RegExp(`\\s*\\b${color}\\b`, "gi"), "");
  }
  // NOTE: "Titanium" alone is NOT removed — it's part of model names like "iPhone 16 Pro Titanium"

  // 6. Remove "Australian Stock" / "AU Stock"
  broad = broad.replace(/\b(Australian Stock|AU Stock)\b/gi, "");

  // 7. Remove condition labels
  broad = broad.replace(/\b(Excellent|Pristine|Good|Very Good|Refurbished|Renewed)\b/gi, "");

  // 8. Clean up punctuation and multiple spaces
  broad = broad.replace(/[(),]/g, "").replace(/\s+/g, " ").trim();

  // 9. Safety net: if result is too short, keep first 3-4 meaningful words
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

  return {
    storage: storageVariants,
    colors: foundColors,
    connectivity: foundConnectivity
  };
}
