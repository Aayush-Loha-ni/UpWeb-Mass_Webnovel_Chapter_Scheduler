/**
 * Credential Manager
 * Single source of truth for platform cookies.
 *
 * Storage: shared/browser_profile/<platform>/cookies.json
 *   - Always AES-256-GCM encrypted (see cookie_encrypt.ts).
 *   - File mode 0o600, directory mode 0o700.
 *   - Cookie age is tracked for the UI only (getPlatformCookieAgeHours).
 *     Re-login is demand-driven: it is prompted only when a platform call
 *     actually fails auth (login redirect / expired token), never on age.
 */

import * as fs from 'fs';
import * as path from 'path';
import { encryptData, decryptData } from './cookie_encrypt';
import logger from './logger';

export const PLATFORM_MAX_AGE_HOURS: Record<string, number> = {
  inkstone: 336,
  patreon: 336,
  kofi: 336,
};

export function getPlatformMaxAgeHours(platform: string): number {
  return PLATFORM_MAX_AGE_HOURS[platform] ?? 24;
}

export interface CookieData {
  cookies: any[];
  saved_at: string;
  platform: string;
}

function getPlatformCookieDir(profileDir: string, platform: string): string {
  const dir = path.join(profileDir, platform);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort (no-op on Windows) */ }
  }
  return dir;
}

function getPlatformCookieFile(profileDir: string, platform: string): string {
  return path.join(getPlatformCookieDir(profileDir, platform), 'cookies.json');
}

/**
 * Hours since cookies were last saved (mtime-based), or null if none.
 */
export function getPlatformCookieAgeHours(platform: string, profileDir: string): number | null {
  const cookieFile = getPlatformCookieFile(profileDir, platform);
  if (!fs.existsSync(cookieFile)) return null;
  try {
    const stat = fs.statSync(cookieFile);
    const age = (Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60);
    return Math.round(age * 10) / 10;
  } catch {
    return null;
  }
}

/**
 * True if a platform's stored cookies are older than the max age.
 * Informational only (drives the UI age display); does not force re-login.
 */
export function isPlatformCookieExpired(platform: string, profileDir: string): boolean {
  const age = getPlatformCookieAgeHours(platform, profileDir);
  return age === null || age > getPlatformMaxAgeHours(platform);
}

/**
 * True only if fresh, non-empty cookies exist for the platform.
 * ponytail: age is informational only — re-login is demand-driven, triggered by a
 * real runtime auth failure (tracker.auth_error), not by cookie age. So aged cookies
 * still count as present; a dead session is caught the next time a platform call is made.
 */
export function platformHasCookies(platform: string, profileDir: string): boolean {
  const cookieFile = getPlatformCookieFile(profileDir, platform);
  if (!fs.existsSync(cookieFile)) return false;
  try {
    if (fs.statSync(cookieFile).size <= 10) return false;
  } catch {
    return false;
  }
  return true;
}

export function normalizeCookies(rawCookies: any[]): any[] {
  return rawCookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expires || -1,
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: c.sameSite || 'Lax',
  }));
}

/**
 * Encrypt and persist cookies for a platform (0o600).
 */
export function savePlatformCookiesEncrypted(
  platform: string,
  cookies: any[],
  profileDir: string
): void {
  const cookieFile = getPlatformCookieFile(profileDir, platform);
  const data: CookieData = {
    cookies,
    saved_at: new Date().toISOString(),
    platform,
  };
  const encrypted = encryptData(JSON.stringify(data));
  fs.writeFileSync(cookieFile, encrypted, { mode: 0o600 });
  try { fs.chmodSync(cookieFile, 0o600); } catch { /* best effort */ }
  logger.info(`Saved and encrypted ${cookies.length} cookies for ${platform}`);
}

/**
 * Decrypt and load cookies for a platform.
 * Returns [] if missing, corrupt, or un-decryptable. Cookie age does NOT force
 * recollection — a stale session is detected at runtime (login redirect / 4001)
 * and that is when re-login is prompted. No plaintext fallback: a file that does
 * not decrypt is treated as untrusted.
 */
export function loadPlatformCookiesEncrypted(platform: string, profileDir: string): any[] {
  const cookieFile = getPlatformCookieFile(profileDir, platform);
  if (!fs.existsSync(cookieFile)) return [];

  try {
    const ciphertext = fs.readFileSync(cookieFile, 'utf8');
    const data = JSON.parse(decryptData(ciphertext)) as CookieData;
    return data.cookies || [];
  } catch (e) {
    logger.warn(`Failed to decrypt cookies for ${platform}; treating as absent.`);
    return [];
  }
}

/**
 * Delete stored cookies for a platform.
 */
export function deletePlatformCookies(platform: string, profileDir: string): void {
  const cookieFile = getPlatformCookieFile(profileDir, platform);
  if (fs.existsSync(cookieFile)) {
    fs.unlinkSync(cookieFile);
    logger.info(`Deleted cookies for ${platform}: ${cookieFile}`);
  }
}
