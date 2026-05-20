/**
 * Quick sanity test for the accuracy improvements.
 * Run: npx tsx src/test-accuracy.ts
 */

import { getSmartSearchQuery, getBroadSearchQuery } from "./utils/product-utils.js";
import { GeminiMatcherService } from "./services/gemini-matcher.service.js";

// ══════════════════════════════════════════════════════════════
//  TEST 1: Smart Search Query Generation
// ══════════════════════════════════════════════════════════════

const searchQueryTestCases = [
  {
    input: "Samsung Galaxy S25 Ultra 5G (12GB/512GB) Titanium Black - Brand New",
    expectInSmart: ["Samsung", "Galaxy", "S25", "Ultra", "512GB"],
    expectNotInSmart: ["Titanium", "Black", "Brand New", "12GB/"],
  },
  {
    input: "Apple iPad 2 Cellular 16GB, Grey Australian Stock - Excellent",
    expectInSmart: ["Apple", "iPad", "16GB"],
    expectNotInSmart: ["Grey", "Excellent", "Australian"],
  },
  {
    input: "Canon EOS 250D Body Only Kit Box Black Digital Cameras - Brand New",
    expectInSmart: ["Canon", "EOS", "250D", "Body", "Only"],
    expectNotInSmart: ["Black", "Digital Cameras", "Brand New"],
  },
  {
    input: "Canon EOS R10 Mirrorless Camera (18-150mm Lens) With Adapter - Brand New",
    expectInSmart: ["Canon", "EOS", "R10", "18-150mm"],
    expectNotInSmart: ["Mirrorless Camera", "With Adapter"],
  },
  {
    input: 'Apple iMac 2021 (M1, 16GB RAM, 2TB, Blue) - Excellent',
    expectInSmart: ["Apple", "iMac", "2021", "2TB"],
    expectNotInSmart: ["Blue", "Excellent"],
  },
];

console.log("═══════════════════════════════════════════");
console.log("  TEST 1: Smart Search Query Generation    ");
console.log("═══════════════════════════════════════════");

let passed = 0;
let failed = 0;

for (const tc of searchQueryTestCases) {
  const smart = getSmartSearchQuery(tc.input);
  const broad = getBroadSearchQuery(tc.input);
  
  console.log(`\n  Input  : "${tc.input}"`);
  console.log(`  Smart  : "${smart}"`);
  console.log(`  Broad  : "${broad}"`);

  let ok = true;
  for (const keyword of tc.expectInSmart) {
    if (!smart.includes(keyword)) {
      console.log(`  ❌ FAIL: Expected "${keyword}" in smart query`);
      ok = false;
    }
  }
  for (const keyword of tc.expectNotInSmart) {
    if (smart.includes(keyword)) {
      console.log(`  ❌ FAIL: Did NOT expect "${keyword}" in smart query`);
      ok = false;
    }
  }

  if (ok) {
    console.log(`  ✅ PASS`);
    passed++;
  } else {
    failed++;
  }
}

// ══════════════════════════════════════════════════════════════
//  TEST 2: Local Verification (Model Number + Specs)
// ══════════════════════════════════════════════════════════════

console.log("\n═══════════════════════════════════════════");
console.log("  TEST 2: Local Verification Logic         ");
console.log("═══════════════════════════════════════════");

// Create a matcher instance with dummy keys
const matcher = new GeminiMatcherService(["dummy"], "MAPPING BRAND NEW", "amazon");

const verifyTestCases = [
  // Should REJECT
  {
    source: "Canon EOS 250D Body Only Kit Box Black",
    target: "EOS 2000D DSLR Camera and EF-S 18-55mm",
    shouldPass: false,
    reason: "Different model (250D vs 2000D) + body vs kit"
  },
  {
    source: "Canon EOS R1 Mirrorless Camera Body Only",
    target: "EOS R8 Mirrorless Camera Body Only",
    shouldPass: false,
    reason: "Different model (R1 vs R8)"
  },
  {
    source: "iPhone 15 Pro 256GB Titanium Blue",
    target: "iPhone 15 256GB Blue",
    shouldPass: false,
    reason: "iPhone 15 Pro ≠ iPhone 15"
  },
  {
    source: "Samsung Galaxy S25 Ultra 512GB Black",
    target: "Samsung Galaxy S25 Ultra 256GB Black",
    shouldPass: false,
    reason: "Storage mismatch (512GB vs 256GB)"
  },
  {
    source: "Samsung Galaxy S25 Ultra 512GB Black",
    target: "Samsung Galaxy S25 512GB Black",
    shouldPass: false,
    reason: "Model mismatch (S25 Ultra vs S25)"
  },
  // Should PASS
  {
    source: "iPhone 15 Pro 256GB Titanium Blue",
    target: "Apple iPhone 15 Pro 256GB Titanium Blue",
    shouldPass: true,
    reason: "Exact match with brand prefix"
  },
  {
    source: "Samsung Galaxy A14 (128GB, Black) - Excellent",
    target: "Samsung Galaxy A14 - 128GB - Black - 4G - Single Sim - 4GB RAM - Excellent",
    shouldPass: true,
    reason: "Exact match with extra details"
  },
  {
    source: "Apple iMac 2020 5K (i5, 16GB RAM, 1TB)",
    target: "Apple iMac 2020 27\" 5K (i5, 16GB RAM, 1000GB)",
    shouldPass: true,
    reason: "1TB = 1000GB equivalence"
  },
];

for (const tc of verifyTestCases) {
  const result = matcher.verifyMatchConsistency(tc.source, tc.target);
  const isCorrect = result.passed === tc.shouldPass;

  console.log(`\n  Source : "${tc.source}"`);
  console.log(`  Target : "${tc.target}"`);
  console.log(`  Expected: ${tc.shouldPass ? "PASS" : "REJECT"} (${tc.reason})`);
  console.log(`  Actual  : ${result.passed ? "PASS" : "REJECT"} (${result.reason})`);

  if (isCorrect) {
    console.log(`  ✅ CORRECT`);
    passed++;
  } else {
    console.log(`  ❌ WRONG`);
    failed++;
  }
}

// ══════════════════════════════════════════════════════════════
//  SUMMARY
// ══════════════════════════════════════════════════════════════

console.log("\n═══════════════════════════════════════════");
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log("═══════════════════════════════════════════");

process.exit(failed > 0 ? 1 : 0);
