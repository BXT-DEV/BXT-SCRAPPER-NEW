import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  salt: string;
  authTag: string;
}

/**
 * Encrypts a plaintext string using AES-256-GCM and a password, returning detailed components.
 */
export function encryptGranular(plaintext: string, password: string): EncryptedPayload {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.scryptSync(password, salt, KEY_LENGTH);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let ciphertext = cipher.update(plaintext, "utf8", "hex");
  ciphertext += cipher.final("hex");
  
  const authTag = cipher.getAuthTag();
  
  return {
    ciphertext,
    iv: iv.toString("hex"),
    salt: salt.toString("hex"),
    authTag: authTag.toString("hex")
  };
}

/**
 * Decrypts a ciphertext string using detailed component payloads and a password.
 */
export function decryptGranular(payload: EncryptedPayload, password: string): string {
  const salt = Buffer.from(payload.salt, "hex");
  const iv = Buffer.from(payload.iv, "hex");
  const authTag = Buffer.from(payload.authTag, "hex");
  const ciphertext = payload.ciphertext;
  
  const key = crypto.scryptSync(password, salt, KEY_LENGTH);
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let plaintext = decipher.update(ciphertext, "hex", "utf8");
  plaintext += decipher.final("utf8");
  
  return plaintext;
}

/**
 * Encrypts a plaintext string using AES-256-GCM and a password.
 */
export function encrypt(plaintext: string, password: string): string {
  const p = encryptGranular(plaintext, password);
  return `${p.salt}:${p.iv}:${p.authTag}:${p.ciphertext}`;
}

/**
 * Decrypts a ciphertext string using AES-256-GCM and the password.
 */
export function decrypt(encryptedText: string, password: string): string {
  const parts = encryptedText.split(":");
  if (parts.length !== 4) {
    throw new Error("Invalid encrypted format. Credentials file may be corrupted.");
  }
  return decryptGranular({
    salt: parts[0],
    iv: parts[1],
    authTag: parts[2],
    ciphertext: parts[3]
  }, password);
}
