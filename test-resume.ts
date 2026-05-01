import { loadCompletedSkus } from "./src/utils/csv-writer.js";
import { logger } from "./src/utils/logger.js";

async function test() {
  const skus = await loadCompletedSkus("output/amazon_2026-04-23.csv");
  console.log("SKUs found:", skus.size);
  console.log("SKU list:", Array.from(skus));
}

test();
