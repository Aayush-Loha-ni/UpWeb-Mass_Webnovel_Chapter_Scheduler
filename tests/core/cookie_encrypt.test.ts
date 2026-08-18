import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  encryptData,
  decryptData,
} from '../../server/core/cookie_encrypt';
import {
  savePlatformCookiesEncrypted,
  loadPlatformCookiesEncrypted,
  deletePlatformCookies,
  platformHasCookies,
  isPlatformCookieExpired,
  getPlatformMaxAgeHours,
} from '../../server/core/credential_manager';

const TEST_PLATFORM = '__test_cookie_platform__';
const PROFILE_DIR = path.join(process.cwd(), 'shared', 'browser_profile');
const TEST_MAX_AGE_HOURS = getPlatformMaxAgeHours(TEST_PLATFORM);

function cleanupSecureCookies() {
  const dir = path.join(PROFILE_DIR, TEST_PLATFORM);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('encryptData / decryptData round-trip', () => {
  it('encrypts and decrypts back to the original plaintext', () => {
    const plaintext = 'session_id=abc123; token=xyz789';
    const ciphertext = encryptData(plaintext);
    const decrypted = decryptData(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const plaintext = 'same value';
    const c1 = encryptData(plaintext);
    const c2 = encryptData(plaintext);
    expect(c1).not.toBe(c2); // different IVs => different ciphertext
    expect(decryptData(c1)).toBe(plaintext);
    expect(decryptData(c2)).toBe(plaintext);
  });

  it('ciphertext has 3 colon-separated hex parts (iv:ciphertext:authTag)', () => {
    const ciphertext = encryptData('test');
    const parts = ciphertext.split(':');
    expect(parts.length).toBe(3);
    // Each part should be hex
    for (const part of parts) {
      expect(/^[0-9a-f]+$/i.test(part)).toBe(true);
    }
  });

  it('decryptData fails with tampered ciphertext', () => {
    const plaintext = 'sensitive data';
    const ciphertext = encryptData(plaintext);
    const parts = ciphertext.split(':');
    // Tamper with the encrypted part
    parts[1] = parts[1].split('').reverse().join('');
    const tampered = parts.join(':');

    expect(() => decryptData(tampered)).toThrow();
  });

  it('decryptData fails with invalid format', () => {
    expect(() => decryptData('not:valid')).toThrow();
    expect(() => decryptData('garbage')).toThrow();
  });

  it('handles empty string plaintext', () => {
    const ciphertext = encryptData('');
    const decrypted = decryptData(ciphertext);
    expect(decrypted).toBe('');
  });

  it('handles unicode plaintext', () => {
    const plaintext = '日本語テスト 🎉 émojis';
    const ciphertext = encryptData(plaintext);
    const decrypted = decryptData(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('handles long plaintext', () => {
    const plaintext = 'A'.repeat(10000);
    const ciphertext = encryptData(plaintext);
    const decrypted = decryptData(ciphertext);
    expect(decrypted).toBe(plaintext);
  });
});

describe('platform cookie store (encrypted, demand-driven re-login)', () => {
  beforeEach(cleanupSecureCookies);
  afterEach(cleanupSecureCookies);

  const cookies = [{ name: 'session', value: 'abc123', domain: '.example.com', path: '/' }];

  it('saves and loads cookies through the encrypted store', () => {
    savePlatformCookiesEncrypted(TEST_PLATFORM, cookies, PROFILE_DIR);
    expect(loadPlatformCookiesEncrypted(TEST_PLATFORM, PROFILE_DIR)).toEqual(cookies);
    expect(platformHasCookies(TEST_PLATFORM, PROFILE_DIR)).toBe(true);
  });

  it('writes cookies.json encrypted on disk (not plaintext JSON)', () => {
    savePlatformCookiesEncrypted(TEST_PLATFORM, cookies, PROFILE_DIR);
    const raw = fs.readFileSync(path.join(PROFILE_DIR, TEST_PLATFORM, 'cookies.json'), 'utf8');
    expect(raw.startsWith('[') || raw.startsWith('{')).toBe(false); // not plaintext
    expect(raw.split(':').length).toBe(3); // iv:ciphertext:tag
    expect(decryptData(raw)).toContain('abc123');
  });

  it('returns [] for a platform with no cookies', () => {
    expect(loadPlatformCookiesEncrypted(TEST_PLATFORM, PROFILE_DIR)).toEqual([]);
    expect(platformHasCookies(TEST_PLATFORM, PROFILE_DIR)).toBe(false);
  });

  it('reports age but still loads aged cookies (re-login is demand-driven)', () => {
    savePlatformCookiesEncrypted(TEST_PLATFORM, cookies, PROFILE_DIR);
    // Backdate the file mtime past the expiry window.
    const file = path.join(PROFILE_DIR, TEST_PLATFORM, 'cookies.json');
    const old = new Date(Date.now() - (TEST_MAX_AGE_HOURS + 1) * 3600000);
    fs.utimesSync(file, old, old);

    // Age is informational only — stale cookies are still used; a genuinely dead
    // session is detected at runtime (login redirect / expired token) and only then
    // is re-login prompted.
    expect(isPlatformCookieExpired(TEST_PLATFORM, PROFILE_DIR)).toBe(true);
    expect(loadPlatformCookiesEncrypted(TEST_PLATFORM, PROFILE_DIR)).toEqual(cookies);
    expect(platformHasCookies(TEST_PLATFORM, PROFILE_DIR)).toBe(true);
  });

  it('deletePlatformCookies removes the store', () => {
    savePlatformCookiesEncrypted(TEST_PLATFORM, cookies, PROFILE_DIR);
    deletePlatformCookies(TEST_PLATFORM, PROFILE_DIR);
    expect(platformHasCookies(TEST_PLATFORM, PROFILE_DIR)).toBe(false);
  });
});
