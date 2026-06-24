import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream, statSync, existsSync } from "node:fs";
import path from "node:path";
import { exec, spawn } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { getScraperStatus } from "./utils/status-manager.js";
import { loadRules, saveRules } from "./utils/rules-manager.js";
import { getCostStats } from "./utils/cost-tracker.js";
import {
  ResultValidatorService,
  parseXlsxRows,
} from "./services/result-validator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3333;
const PROJECT_ROOT = process.cwd();
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, ".env.example");
const INPUT_DIR = path.join(PROJECT_ROOT, "input");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "output");
const VALIDATE_UPLOAD_DIR = path.join(PROJECT_ROOT, ".validate-temp");
const isPackaged = (process as any).pkg !== undefined;
const HTML_PATH = isPackaged
  ? path.resolve(__dirname, "../src/ui/index.html")
  : path.join(__dirname, "ui", "index.html");

// ── Helpers ──────────────────────────────────────────────

function openBrowser(url: string) {
  const platform = os.platform();
  const command =
    platform === "win32"
      ? `start "" "${url}"`
      : platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const result: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) result[match[1]] = match[2]?.trim() || "";
    }
    return result;
  } catch {
    return {};
  }
}

async function saveEnvFile(updates: Record<string, string>) {
  let content = "";
  try {
    content = await fs.readFile(ENV_PATH, "utf-8");
  } catch {
    try {
      content = await fs.readFile(ENV_EXAMPLE_PATH, "utf-8");
    } catch {
      /* empty */
    }
  }

  const lines = content.split("\n");
  const updatedKeys = new Set<string>();

  const newLines = lines.map((line) => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match && match[1] in updates) {
      updatedKeys.add(match[1]);
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key) && value.trim() !== "") {
      newLines.push(`${key}=${value}`);
    }
  }

  await fs.writeFile(ENV_PATH, newLines.join("\n"), "utf-8");
}

// ── Multipart Parser (minimal, for single file upload) ──

function parseMultipart(buffer: Buffer, boundary: string) {
  const boundaryStr = `--${boundary}`;
  const parts = buffer.toString("binary").split(boundaryStr);
  for (const part of parts) {
    if (part.includes("filename=")) {
      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd === -1) continue;
      const headers = part.substring(0, headerEnd);
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      const filename = filenameMatch ? filenameMatch[1] : "upload.csv";
      const bodyStart = headerEnd + 4;
      const bodyEnd = part.lastIndexOf("\r\n");
      const fileData = Buffer.from(
        part.substring(bodyStart, bodyEnd),
        "binary",
      );
      return { filename, data: fileData };
    }
  }
  return null;
}

// ── Request Helpers ──

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── Route Handlers ──

async function handleServeHtml(res: http.ServerResponse) {
  const html = await fs.readFile(HTML_PATH, "utf-8");
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

async function handleGetEnv(res: http.ServerResponse) {
  const current = await parseEnvFile(ENV_PATH);
  const example = await parseEnvFile(ENV_EXAMPLE_PATH);
  jsonResponse(res, { current, example });
}

async function handleGetRules(res: http.ServerResponse) {
  try {
    const rules = loadRules();
    jsonResponse(res, rules);
  } catch (e) {
    jsonResponse(res, { error: (e as Error).message }, 500);
  }
}

async function handlePostRules(
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body.toString());
    const success = saveRules(data);
    jsonResponse(res, { success });
  } catch (e) {
    jsonResponse(res, { success: false, error: (e as Error).message }, 500);
  }
}

async function handlePostEnv(
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const body = await readBody(req);
  const data = JSON.parse(body.toString());
  await saveEnvFile(data);
  jsonResponse(res, { success: true });
}

async function handleUploadCsv(
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) {
    jsonResponse(res, { success: false, error: "Missing boundary" }, 400);
    return;
  }

  const body = await readBody(req);
  const parsed = parseMultipart(body, boundaryMatch[1]);
  if (!parsed) {
    jsonResponse(res, { success: false, error: "No file found" }, 400);
    return;
  }

  await fs.mkdir(INPUT_DIR, { recursive: true });
  const savePath = path.join(INPUT_DIR, parsed.filename);
  await fs.writeFile(savePath, parsed.data);

  // Update INPUT_CSV_PATH in .env
  const relativePath = path.relative(PROJECT_ROOT, savePath);
  await saveEnvFile({ INPUT_CSV_PATH: relativePath });

  jsonResponse(res, { success: true, savedPath: relativePath });
}

async function handleGetOutputFiles(res: http.ServerResponse) {
  try {
    const entries = await fs.readdir(OUTPUT_DIR);
    const csvFiles = entries.filter((f) => f.endsWith(".csv"));
    const files = csvFiles.map((name) => {
      const fullPath = path.join(OUTPUT_DIR, name);
      const stat = statSync(fullPath);
      return { name, size: formatFileSize(stat.size), mtime: stat.mtimeMs };
    });
    files.sort((a, b) => b.mtime - a.mtime);
    jsonResponse(res, files);
  } catch {
    jsonResponse(res, []);
  }
}

function handleDownloadFile(res: http.ServerResponse, filename: string) {
  const safeName = path.basename(filename);
  const filePath = path.join(OUTPUT_DIR, safeName);

  try {
    const stat = statSync(filePath);
    res.writeHead(200, {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Content-Length": stat.size,
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end("File not found");
  }
}

// ── Scraper Management ──
let currentScraperProcess: any = null;

// ── Validator Management ─────────────────────────────────────────────────────
const validator = new ResultValidatorService();
let validatorRunning = false;
let lastUploadedXlsxPath: string | null = null;
let lastParsedRowCount = 0;

async function handleValidateUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) {
    jsonResponse(res, { success: false, error: "Missing boundary" }, 400);
    return;
  }

  const body = await readBody(req);
  const parsed = parseMultipart(body, boundaryMatch[1]);
  if (!parsed) {
    jsonResponse(res, { success: false, error: "No file found" }, 400);
    return;
  }

  if (!parsed.filename.endsWith(".xlsx")) {
    jsonResponse(
      res,
      { success: false, error: "Only .xlsx files are supported" },
      400,
    );
    return;
  }

  await fs.mkdir(VALIDATE_UPLOAD_DIR, { recursive: true });
  const savePath = path.join(VALIDATE_UPLOAD_DIR, "validate_upload.xlsx");
  await fs.writeFile(savePath, parsed.data);
  lastUploadedXlsxPath = savePath;

  try {
    const rows = parseXlsxRows(savePath);
    lastParsedRowCount = rows.length;
    jsonResponse(res, {
      success: true,
      rowCount: rows.length,
      filename: parsed.filename,
    });
  } catch (e) {
    jsonResponse(
      res,
      {
        success: false,
        error: `Failed to parse xlsx: ${(e as Error).message}`,
      },
      500,
    );
  }
}

async function handleValidateStart(
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  if (validatorRunning) {
    jsonResponse(
      res,
      { success: false, error: "Validation is already running" },
      400,
    );
    return;
  }
  if (!lastUploadedXlsxPath || !existsSync(lastUploadedXlsxPath)) {
    jsonResponse(
      res,
      { success: false, error: "No xlsx file uploaded yet" },
      400,
    );
    return;
  }

  const bodyBuf = await readBody(req);
  let concurrency = 3;
  try {
    const bodyJson = JSON.parse(bodyBuf.toString());
    concurrency = Math.min(
      Math.max(parseInt(bodyJson.concurrency) || 3, 1),
      10,
    );
  } catch {
    /* use default */
  }

  const rows = parseXlsxRows(lastUploadedXlsxPath);
  validatorRunning = true;

  // Run in background — do not await
  validator.run(rows, concurrency).finally(() => {
    validatorRunning = false;
  });

  jsonResponse(res, { success: true, total: rows.length, concurrency });
}

function handleValidateProgress(res: http.ServerResponse) {
  const progress = validator.getProgress();
  jsonResponse(res, { ...progress, isRunning: validatorRunning });
}

function handleValidateStop(res: http.ServerResponse) {
  if (!validatorRunning) {
    jsonResponse(res, { success: false, error: "No validation is running" });
    return;
  }
  validator.stop();
  jsonResponse(res, { success: true, message: "Stop signal sent" });
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const fullUrl = req.url || "/";
  const url = fullUrl.split("?")[0].replace(/\/$/, "") || "/";
  const method = req.method || "GET";

  try {
    if (method === "GET" && url === "/") return await handleServeHtml(res);
    if (method === "GET" && url === "/api/env") return await handleGetEnv(res);
    if (method === "POST" && url === "/api/env")
      return await handlePostEnv(req, res);
    if (method === "GET" && url === "/api/rules")
      return await handleGetRules(res);
    if (method === "POST" && url === "/api/rules")
      return await handlePostRules(req, res);
    if (method === "POST" && url === "/api/upload-csv")
      return await handleUploadCsv(req, res);
    if (method === "GET" && url === "/api/output-files")
      return await handleGetOutputFiles(res);
    if (method === "GET" && url === "/api/cost-stats") {
      const stats = await getCostStats();
      return jsonResponse(res, stats);
    }

    if (method === "GET" && url === "/api/scraper-status") {
      return jsonResponse(res, {
        running: !!currentScraperProcess,
        pid: currentScraperProcess ? currentScraperProcess.pid : null,
      });
    }

    if (method === "GET" && url === "/api/scraper-status-detail") {
      const status = getScraperStatus();
      return jsonResponse(res, {
        ...status,
        processRunning: !!currentScraperProcess,
      });
    }

    if (method === "POST" && url === "/api/run-scraper") {
      if (currentScraperProcess) {
        return jsonResponse(
          res,
          { success: false, error: "Scraper is already running" },
          400,
        );
      }

      const currentEnv = await parseEnvFile(ENV_PATH);
      const scraperTarget = (
        currentEnv["SCRAPER_TARGET"] || "amazon"
      ).toLowerCase();
      const inputPath = currentEnv["INPUT_CSV_PATH"] || "input/upload.csv";

      // Determine which command to run based on SCRAPER_TARGET and CSV format.
      // `npm run bxt` (fill-amazon-urls.ts) is an Amazon-only URL filler for BXT-format CSVs.
      // `npm run scrape` (index.ts) is the main orchestrator that supports ALL targets.
      let commandToRun = "npm run scrape";

      if (scraperTarget === "amazon") {
        try {
          const fullInputPath = path.join(PROJECT_ROOT, inputPath);
          const fileContent = await fs.readFile(fullInputPath, "utf-8");
          const firstLine = fileContent.split("\n")[0];

          // Only use the BXT-specific Amazon filler when the CSV has the full BXT format
          if (
            firstLine &&
            (firstLine.includes("Competitor #3 URL") ||
              firstLine.includes("Harga AMAZON"))
          ) {
            commandToRun = "npm run bxt";
          }
        } catch (e) {
          console.warn("Could not read input CSV for format detection", e);
        }
      }

      console.log(`Executing: ${commandToRun} (target: ${scraperTarget})`);

      const parts = commandToRun.split(" ");
      const cmd = parts[0];
      const args = parts.slice(1);

      currentScraperProcess = spawn(cmd, args, {
        shell: true,
        detached: os.platform() !== "win32", // detached for process group kill on unix
        stdio: "pipe",
      });

      // Stream output to console to avoid buffer limits
      currentScraperProcess.stdout?.on("data", (data: any) =>
        process.stdout.write(data),
      );
      currentScraperProcess.stderr?.on("data", (data: any) =>
        process.stderr.write(data),
      );

      currentScraperProcess.on("close", (code: number) => {
        console.log(`Scraper process exited with code ${code}`);
        currentScraperProcess = null;
      });

      currentScraperProcess.on("error", (err: Error) => {
        console.error(`Failed to start scraper: ${err.message}`);
        currentScraperProcess = null;
      });

      return jsonResponse(res, {
        success: true,
        pid: currentScraperProcess.pid,
        command: commandToRun,
        target: scraperTarget,
      });
    }

    if (method === "POST" && url === "/api/stop-scraper") {
      if (currentScraperProcess) {
        console.log(`Stopping scraper (PID: ${currentScraperProcess.pid})...`);
        // On Windows, taskkill is more reliable for stopping sub-processes
        if (os.platform() === "win32") {
          exec(`taskkill /pid ${currentScraperProcess.pid} /t /f`);
        } else {
          try {
            // Kill the entire process group
            process.kill(-currentScraperProcess.pid, "SIGINT");
          } catch (e) {
            // Fallback to normal kill if process group kill fails
            currentScraperProcess.kill("SIGINT");
          }
        }
        currentScraperProcess = null;
        return jsonResponse(res, { success: true, message: "Scraper stopped" });
      }
      return jsonResponse(res, {
        success: false,
        error: "No scraper is running",
      });
    }

    if (method === "GET" && url.startsWith("/api/download/")) {
      const filename = decodeURIComponent(url.replace("/api/download/", ""));
      return handleDownloadFile(res, filename);
    }

    // ── Validate Result Routes ────────────────────────────────────────────────
    if (method === "POST" && url === "/api/validate/upload")
      return await handleValidateUpload(req, res);
    if (method === "POST" && url === "/api/validate/start")
      return await handleValidateStart(req, res);
    if (method === "GET" && url === "/api/validate/progress")
      return handleValidateProgress(res);
    if (method === "POST" && url === "/api/validate/stop")
      return handleValidateStop(res);

    res.writeHead(404);
    res.end();
  } catch (e) {
    console.error("Request error:", e);
    jsonResponse(res, { error: (e as Error).message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Configuration UI is running at: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
  openBrowser(`http://localhost:${PORT}`);
});
