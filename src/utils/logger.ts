// ============================================================
// Winston Logger
// Structured logging to console + daily log files
// ============================================================

import winston from "winston";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isPackaged = (process as any).pkg !== undefined;
const PROJECT_ROOT = isPackaged 
  ? process.cwd() 
  : path.resolve(__dirname, "../..");

const LOGS_DIR = path.join(PROJECT_ROOT, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });

const todayStamp = new Date().toISOString().slice(0, 10);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `[${timestamp}] ${level}: ${message}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `[${timestamp}] ${level}: ${message}`;
  })
);

export const logger = winston.createLogger({
  level: "info",
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({
      filename: path.join(LOGS_DIR, `scraper_${todayStamp}.log`),
      format: fileFormat,
    }),
    new winston.transports.File({
      filename: path.join(LOGS_DIR, `errors_${todayStamp}.log`),
      level: "error",
      format: fileFormat,
    }),
  ],
});
