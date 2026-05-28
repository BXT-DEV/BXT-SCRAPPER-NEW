import fs from "fs";
import path from "path";
import readline from "readline";
import { encrypt, decrypt } from "./crypto.js";
import { fileURLToPath } from "url";
import { 
  hasSqliteFile, 
  loadSqliteCredentials, 
  saveSqliteCredentials 
} from "./sqlite-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isPackaged = (process as any).pkg !== undefined;
const PROJECT_ROOT = isPackaged 
  ? process.cwd() 
  : path.resolve(__dirname, "../..");

const CREDENTIALS_FILE = path.join(PROJECT_ROOT, "credentials.json.enc");

export interface Credentials {
  [key: string]: string;
}

/**
 * Checks if any encrypted credentials backend exists (SQLite or File).
 */
export function hasCredentialsFile(): boolean {
  return hasSqliteFile() || fs.existsSync(CREDENTIALS_FILE);
}

/**
 * Returns the active credentials path/file name for logging or troubleshooting.
 */
export function getCredentialsFilePath(): string {
  if (hasSqliteFile()) {
    return path.join(PROJECT_ROOT, "credentials.db");
  }
  return CREDENTIALS_FILE;
}

/**
 * Prompts the user for a password in the console with masked input.
 */
export function promptPassword(query: string = "Enter password: "): Promise<string> {
  return new Promise((resolve) => {
    // If password is provided in env, use it directly (non-interactive / UI run)
    if (process.env.CREDENTIAL_PASSPHRASE) {
      return resolve(process.env.CREDENTIAL_PASSPHRASE);
    }

    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(query);

    let password = "";
    
    if (stdin.isTTY) {
      stdin.setRawMode(true);
      stdin.resume();

      const onData = (char: Buffer) => {
        const str = char.toString("utf-8");
        for (let i = 0; i < str.length; i++) {
          const c = str[i];
          if (c === "\n" || c === "\r" || c === "\u0004") {
            // Enter key
            stdin.removeListener("data", onData);
            stdin.setRawMode(false);
            stdout.write("\n");
            resolve(password);
            return;
          } else if (c === "\u0003") {
            // Ctrl+C
            stdin.removeListener("data", onData);
            stdin.setRawMode(false);
            stdout.write("\n");
            process.exit(1);
          } else if (c === "\u007f" || c === "\b") {
            // Backspace
            if (password.length > 0) {
              password = password.slice(0, -1);
              stdout.write("\b \b");
            }
          } else {
            password += c;
            stdout.write("*");
          }
        }
      };

      stdin.on("data", onData);
    } else {
      // Fallback for non-interactive / piped stdin
      const rl = readline.createInterface({
        input: stdin,
        output: stdout,
      });
      rl.question("", (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

/**
 * Prompts the user for a password synchronously (useful during module startup).
 */
export function promptPasswordSync(query: string = "Enter password: "): string {
  if (process.env.CREDENTIAL_PASSPHRASE) {
    return process.env.CREDENTIAL_PASSPHRASE;
  }

  const fd = 0; // stdin
  const isTTY = process.stdin.isTTY;

  process.stdout.write(query);

  if (isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch {
      // Ignore setRawMode errors if stdin is redirected
    }
  }

  let password = "";
  const buf = Buffer.alloc(1);

  while (true) {
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buf, 0, 1, null);
    } catch (e) {
      // Fallback if readSync fails
      break;
    }

    if (bytesRead === 0) break;

    const char = buf.toString("utf8");
    if (char === "\n" || char === "\r" || char === "\u0004") {
      process.stdout.write("\n");
      break;
    } else if (char === "\u0003") {
      process.stdout.write("\n");
      if (isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
      }
      process.exit(1);
    } else if (char === "\u007f" || char === "\b") {
      if (password.length > 0) {
        password = password.slice(0, -1);
        process.stdout.write("\b \b");
      }
    } else {
      password += char;
      process.stdout.write("*");
    }
  }

  if (isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {}
  }

  return password;
}

/**
 * Decrypts and loads credentials from the active backend.
 */
export function loadCredentials(password: string): Credentials {
  if (hasSqliteFile()) {
    return loadSqliteCredentials(password);
  }
  if (fs.existsSync(CREDENTIALS_FILE)) {
    const encryptedText = fs.readFileSync(CREDENTIALS_FILE, "utf-8").trim();
    const decryptedText = decrypt(encryptedText, password);
    return JSON.parse(decryptedText);
  }
  return {};
}

/**
 * Encrypts and saves credentials using the preferred backend (SQLite by default).
 */
export function saveCredentials(credentials: Credentials, password: string): void {
  // If SQLite file exists, OR no file backend exists, we default to SQLite.
  // Otherwise, we keep writing to the JSON file.
  if (hasSqliteFile() || !fs.existsSync(CREDENTIALS_FILE)) {
    saveSqliteCredentials(credentials, password);
  } else {
    const plaintext = JSON.stringify(credentials, null, 2);
    const encryptedText = encrypt(plaintext, password);
    fs.writeFileSync(CREDENTIALS_FILE, encryptedText, "utf-8");
  }
}
