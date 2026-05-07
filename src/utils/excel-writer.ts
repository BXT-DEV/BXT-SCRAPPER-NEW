import * as xlsx from "xlsx";
import fs from "fs";
import path from "path";
import csvParser from "csv-parser";
import { logger } from "./logger.js";

/**
 * Converts a semicolon-separated CSV file to an Excel (.xlsx) file.
 * Returns the path to the created Excel file.
 */
export async function convertCsvToExcel(csvFilePath: string): Promise<string> {
  if (!fs.existsSync(csvFilePath)) {
    logger.warn(`Cannot convert to Excel: CSV file not found at ${csvFilePath}`);
    return "";
  }

  const rows: any[] = [];
  
  return new Promise((resolve) => {
    fs.createReadStream(csvFilePath)
      .pipe(csvParser({ separator: ";" }))
      .on("data", (data) => rows.push(data))
      .on("end", () => {
        if (rows.length === 0) {
          logger.warn("CSV is empty, skipping Excel conversion.");
          return resolve("");
        }
        
        try {
          const worksheet = xlsx.utils.json_to_sheet(rows);
          const workbook = xlsx.utils.book_new();
          xlsx.utils.book_append_sheet(workbook, worksheet, "Results");
          
          const excelPath = csvFilePath.replace(/\.csv$/, ".xlsx");
          xlsx.writeFile(workbook, excelPath);
          
          logger.info(`Excel file successfully generated at: ${excelPath}`);
          resolve(excelPath);
        } catch (error) {
          logger.error(`Failed to write Excel file: ${(error as Error).message}`);
          resolve("");
        }
      })
      .on("error", (error) => {
        logger.error(`Error reading CSV for Excel conversion: ${error.message}`);
        resolve("");
      });
  });
}
