import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { encryptGranular, decryptGranular } from "./crypto.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isPackaged = (process as any).pkg !== undefined;
const PROJECT_ROOT = isPackaged 
  ? process.cwd() 
  : path.resolve(__dirname, "../..");

const DB_FILE = path.join(PROJECT_ROOT, "credentials.db");

let dbInstance: any = null;

function getDb() {
  if (!dbInstance) {
    dbInstance = new Database(DB_FILE);
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        key TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        salt TEXT NOT NULL,
        auth_tag TEXT NOT NULL
      )
    `);
  }
  return dbInstance;
}

/**
 * Checks if the credentials SQLite database file exists.
 */
export function hasSqliteFile(): boolean {
  return fs.existsSync(DB_FILE);
}

/**
 * Returns the absolute path to the SQLite credentials file.
 */
export function getSqliteFilePath(): string {
  return DB_FILE;
}

/**
 * Decrypts and loads credentials from the SQLite database.
 */
export function loadSqliteCredentials(password: string): Record<string, string> {
  const db = getDb();
  const rows = db.prepare("SELECT key, ciphertext, iv, salt, auth_tag FROM credentials").all() as any[];
  
  const creds: Record<string, string> = {};
  for (const row of rows) {
    try {
      const plaintext = decryptGranular({
        ciphertext: row.ciphertext,
        iv: row.iv,
        salt: row.salt,
        authTag: row.auth_tag
      }, password);
      creds[row.key] = plaintext;
    } catch (e) {
      throw new Error("Decryption failed. Incorrect master password.");
    }
  }
  return creds;
}

/**
 * Encrypts and saves credentials into the SQLite database.
 */
export function saveSqliteCredentials(creds: Record<string, string>, password: string): void {
  const db = getDb();
  
  // Wrap operations in transaction to guarantee consistency and atomicity
  const runTx = db.transaction(() => {
    // 1. Get existing keys in database
    const existingRows = db.prepare("SELECT key FROM credentials").all() as { key: string }[];
    const existingKeysInDb = new Set(existingRows.map(r => r.key));

    // 2. Insert or update the new credentials list
    const upsertStmt = db.prepare(`
      INSERT INTO credentials (key, ciphertext, iv, salt, auth_tag)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        iv = excluded.iv,
        salt = excluded.salt,
        auth_tag = excluded.auth_tag
    `);

    for (const [key, val] of Object.entries(creds)) {
      const encrypted = encryptGranular(val, password);
      upsertStmt.run(key, encrypted.ciphertext, encrypted.iv, encrypted.salt, encrypted.authTag);
      existingKeysInDb.delete(key);
    }

    // 3. Delete any keys that are no longer present in the updated list
    const deleteStmt = db.prepare("DELETE FROM credentials WHERE key = ?");
    for (const keyToDelete of existingKeysInDb) {
      deleteStmt.run(keyToDelete);
    }
  });

  runTx();
}
