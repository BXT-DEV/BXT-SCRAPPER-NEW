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

const createFileTransport = (filename: string, level: string = 'info') => {
  try {
    return new winston.transports.File({
      filename: path.join(LOGS_DIR, filename),
      level,
      format: fileFormat,
    });
  } catch (error) {
    console.error(`Failed to initialize file transport for ${filename}:`, error);
    return null;
  }
};

const transports: any[] = [
  new winston.transports.Console({ format: consoleFormat }),
];

const fileTransport = createFileTransport(`scraper_${todayStamp}.log`);
if (fileTransport) transports.push(fileTransport);

const errorTransport = createFileTransport(`errors_${todayStamp}.log`, 'error');
if (errorTransport) transports.push(errorTransport);

export const logger = winston.createLogger({
  level: "info",
  transports,
});
