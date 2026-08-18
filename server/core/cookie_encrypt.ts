/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import logger from './logger';
import { SHARED_DIR } from './config';
// SECURITY: the key must NOT live in browser_profile/ (next to the ciphertext it
// protects). Prefer the ENCRYPTION_KEY env var; the file fallback sits in shared/.
const KEY_FILE = path.join(SHARED_DIR, '.encryption.key');
const LEGACY_KEY_FILE = path.join(SHARED_DIR, 'browser_profile', 'encryption.key');

/**
 * Retrieves the encryption key from ENCRYPTION_KEY env var, or falls back to a
 * file in shared/. Migrates a legacy key out of browser_profile/ if present.
 */
function getOrCreateEncryptionKey(): Buffer {
  if (process.env.ENCRYPTION_KEY) {
    return Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  }

  if (!fs.existsSync(SHARED_DIR)) {
    fs.mkdirSync(SHARED_DIR, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(KEY_FILE)) {
    const hexKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
    return Buffer.from(hexKey, 'hex');
  }

  // Migrate a legacy key from browser_profile/ (rename, don't copy).
  if (fs.existsSync(LEGACY_KEY_FILE)) {
    try {
      const hexKey = fs.readFileSync(LEGACY_KEY_FILE, 'utf8').trim();
      fs.writeFileSync(KEY_FILE, hexKey, { mode: 0o600 });
      try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* best effort */ }
      fs.unlinkSync(LEGACY_KEY_FILE);
      logger.warn('[Crypto] Migrated encryption key out of browser_profile/ to shared/.encryption.key');
      return Buffer.from(hexKey, 'hex');
    } catch (e) {
      logger.error('[Crypto] Failed to migrate legacy encryption key:', e);
    }
  }

  logger.warn('[Crypto] No ENCRYPTION_KEY set; generating a key file at shared/.encryption.key. Set ENCRYPTION_KEY env var for production.');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* best effort */ }
  return key;
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 */
export function encryptData(plaintext: string): string {
  try {
    const key = getOrCreateEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    
    // Format: iv_hex:encrypted_hex:authTag_hex
    return `${iv.toString('hex')}:${encrypted}:${tag}`;
  } catch (error) {
    logger.error('Encryption failed:', error);
    throw new Error('Encryption operation failed');
  }
}

/**
 * Decrypts an AES-256-GCM encrypted ciphertext back to plaintext.
 */
export function decryptData(ciphertext: string): string {
  try {
    const key = getOrCreateEncryptionKey();
    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid ciphertext format');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encryptedText, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    logger.error('Decryption failed:', error);
    throw new Error('Decryption operation failed. Invalid or corrupted credentials.');
  }
}
