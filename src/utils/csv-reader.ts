// ============================================================
// CSV Reader
// Parses semicolon-delimited BecexTech CSV into BecexProduct[]
// Format: SKU;Product Name
// ============================================================

import fs from "fs";
import csvParser from "csv-parser";
import type { BecexProduct } from "../types/index.js";
import { logger } from "./logger.js";

/**
 * Read and validate the products CSV file (semicolon-delimited).
 * Handles the BecexTech format: SKU;Product Name
 */
export async function readProductsCsv(
  filePath: string
): Promise<BecexProduct[]> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input CSV not found: ${filePath}`);
  }

  const products: BecexProduct[] = [];
  const validationErrors: string[] = [];

  return new Promise((resolve, reject) => {
    // Detect separator from first line
    const firstLine = fs.readFileSync(filePath, "utf-8").split("\n")[0] || "";
    const separator = firstLine.includes(";") ? ";" : ",";

    fs.createReadStream(filePath)
      .pipe(csvParser({ separator }))
      .on("data", (row: Record<string, string>) => {
        const rowIndex = products.length + 1;

        // Map CSV headers: handle both old format and new BXT format
        // The real SKU is often in 'GTIN / EAN / UPC' in the BXT format
        const sku = (row["SKU"] || row["GTIN / EAN / UPC"] || row["sku"] || row["\uFEFFSKU"] || row["\uFEFFsku"] || "").trim();
        const productName = (row["Product Name"] || row["PRODUCT NAME"] || row["product_name"] || row["\uFEFFProduct Name"] || "").trim();

        if (!sku || !productName) {
          validationErrors.push(
            `Row ${rowIndex}: missing required field (SKU or Product Name)`
          );
          return;
        }

        products.push({
          sku: sku.trim(),
          productName: productName.trim(),
        });
      })
      .on("end", () => {
        if (validationErrors.length > 0) {
          logger.warn(
            `CSV validation warnings (first 5):\n  ${validationErrors.slice(0, 5).join("\n  ")}`
          );
        }

        if (products.length === 0) {
          reject(new Error("No valid products found in CSV"));
          return;
        }

        logger.info(`Loaded ${products.length} products from CSV`);
        resolve(products);
      })
      .on("error", (error) => {
        reject(new Error(`Failed to read CSV: ${error.message}`));
      });
  });
}
