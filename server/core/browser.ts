/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path';
import { SHARED_DIR } from './config';
import { BrowserProfileStatus } from './models';
import {
  savePlatformCookiesEncrypted,
  deletePlatformCookies,
  platformHasCookies,
  getPlatformCookieAgeHours,
  getPlatformMaxAgeHours,
} from './credential_manager';
import { loadTracker, saveTrackerAtomic } from './tracker';
import logger from './logger';

const BASE_PROFILE_DIR = path.join(SHARED_DIR, 'browser_profile');

// Per-novel browser profiles: no slug = legacy global profile dir (today's behavior).
function profileDirFor(slug?: string): string {
  return slug ? path.join(BASE_PROFILE_DIR, slug) : BASE_PROFILE_DIR;
}

const PLATFORM_DOMAINS: Record<string, string> = {
  inkstone: '.inkstone.webnovel.com',
  patreon: '.patreon.com',
  kofi: '.ko-fi.com',
};

export class BrowserManager {
  /**
   * Retrieves the folder path holding a platform's stored cookies.
   */
  static getProfilePath(platform: 'inkstone' | 'patreon' | 'kofi', slug?: string): string {
    return path.join(profileDirFor(slug), platform);
  }

  /**
   * Gets the authentication and cookie age status for a platform.
   * ponytail: re-login is demand-driven. session_expired fires only when the
   * platform actually rejected the session at runtime (tracker.auth_error set by
   * the runner on [SESSION_EXPIRED]/login_required), never based on cookie age.
   */
  static getStatus(platform: 'inkstone' | 'patreon' | 'kofi', slug?: string): BrowserProfileStatus {
    const dir = profileDirFor(slug);
    const age = getPlatformCookieAgeHours(platform, dir);
    const authenticated = platformHasCookies(platform, dir);

    let session_expired = false;
    if (slug) {
      try {
        const tracker = loadTracker(slug);
        // ponytail: "session expired" only applies to a platform that actually HAS
        // a session (cookies). A disconnected/unused platform carrying a stale
        // auth_error from a prior run must NOT surface a reconnect alert — that's
        // what made the Patreon Reconnect banner stick and auto-abort scrapes.
        session_expired = authenticated && tracker.auth_error?.platform === platform;
      } catch { /* no tracker for this slug */ }
    }

    return {
      platform,
      authenticated,
      cookie_age_hours: age ?? 0,
      expires_at: null,
      profile_path: this.getProfilePath(platform, slug),
      session_expired,
      session_max_hours: getPlatformMaxAgeHours(platform),
    };
  }

  /**
   * Connects/authenticates a platform profile from pasted session cookies.
   * Accepts a Playwright cookie array (JSON), a name→value map (JSON), or a
   * raw "a=b; c=d" cookie header string.
   */
  static connectProfile(platform: 'inkstone' | 'patreon' | 'kofi', userEmail: string, rawCookies?: string, slug?: string): BrowserProfileStatus {
    const cookies = this._parseCookies(platform, rawCookies);
    if (cookies.length > 0) {
      savePlatformCookiesEncrypted(platform, cookies, profileDirFor(slug));
      this.clearAuthError(platform, slug);
      logger.info(`Connected ${platform} for ${userEmail} with ${cookies.length} cookies${slug ? ` (${slug})` : ''}.`);
    } else {
      logger.warn(`connectProfile for ${platform} received no usable cookies.`);
    }
    return this.getStatus(platform, slug);
  }

  /**
   * Clear the runtime auth-failure flag for a platform once fresh cookies are saved.
   */
  static clearAuthError(platform: 'inkstone' | 'patreon' | 'kofi', slug?: string): void {
    if (!slug) return;
    try {
      const tracker = loadTracker(slug);
      if (tracker.auth_error?.platform === platform) {
        tracker.auth_error = null;
        saveTrackerAtomic(slug, tracker);
      }
    } catch { /* no tracker for this slug */ }
  }

  /**
   * Disconnects / clears credentials for a platform profile.
   */
  static disconnectProfile(platform: 'inkstone' | 'patreon' | 'kofi', slug?: string): BrowserProfileStatus {
    deletePlatformCookies(platform, profileDirFor(slug));
    return this.getStatus(platform, slug);
  }

  private static _parseCookies(platform: string, rawCookies?: string): any[] {
    if (!rawCookies) return [];
    const domain = PLATFORM_DOMAINS[platform] || '';
    const trimmed = rawCookies.trim();

    try {
      if (trimmed.startsWith('[')) {
        const arr = JSON.parse(trimmed);
        return Array.isArray(arr) ? arr : [];
      }
      if (trimmed.startsWith('{')) {
        const map = JSON.parse(trimmed) as Record<string, string>;
        return Object.entries(map).map(([name, value]) => ({ name, value: String(value), domain, path: '/' }));
      }
    } catch (err) {
      logger.error('Failed to parse cookies JSON:', err);
      return [];
    }

    // Fallback: "name=value; name2=value2" header string
    const cookies: any[] = [];
    trimmed.split(';').forEach(pair => {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (name) cookies.push({ name, value, domain, path: '/' });
      }
    });
    return cookies;
  }
}
