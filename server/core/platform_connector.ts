/**
 * Platform Connector
 * Manages browser connections for Inkstone and Patreon.
 *
 * Two connection modes:
 * 1. Legacy mode: Launches a visible Chromium browser for manual login
 * 2. CDP mode (recommended): Connects to the user's already-running Chrome
 *    via Chrome DevTools Protocol. This bypasses Cloudflare's TLS fingerprint
 *    checks because we use the user's real browser with valid cookies.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { chromium, Browser, BrowserContext } from 'playwright';
import { savePlatformCookiesEncrypted, loadPlatformCookiesEncrypted, deletePlatformCookies, getPlatformCookieAgeHours, platformHasCookies, normalizeCookies } from './credential_manager';
import { cdpManager } from './cdp_manager';
import { STEALTH_BROWSER_ARGS, applyStealthToContext } from './stealth';
import { renewInkstoneSession } from '../adapters/inkstone_api';
import { loadTracker, saveTrackerAtomic } from './tracker';
import logger from './logger';
import { SHARED_DIR } from './config';

const BASE_PROFILE_DIR = path.join(SHARED_DIR, 'browser_profile');

// Per-novel browser profiles: no slug = legacy global profile dir (today's behavior).
function profileDirFor(slug?: string): string {
  return slug ? path.join(BASE_PROFILE_DIR, slug) : BASE_PROFILE_DIR;
}

// ==========================================
// Orphan-browser doctor (win32)
// ==========================================
// ponytail: a dev server killed without cleanup leaves its Chrome processes alive,
// still holding the profile's SingletonLock. launchPersistentContext then blocks
// forever on that lock, so every scrape silently hangs (confirmed root cause).
// Kill any chrome/chromium whose command line references a profile dir we are
// about to launch into, or all profile browsers at server start.
function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function chromePidsHolding(pathSubstring: string): number[] {
  if (process.platform !== 'win32') return [];
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe' OR Name='chromium.exe'\\" | Where-Object { $_.CommandLine -match '${regexEscape(pathSubstring)}' } | ForEach-Object { $_.ProcessId }"`,
      { timeout: 20000, stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString();
    return out.split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n) && n > 0);
  } catch { return []; }
}

function killPids(pids: number[]): void {
  for (const pid of pids) {
    try { execSync(`taskkill /PID ${pid} /F /T`, { timeout: 15000, stdio: 'ignore' }); } catch {}
  }
}

/**
 * Kill browser processes that hold a browser_profile dir. Run once at server start
 * (no arg → sweeps the whole profile dir) and right before a persistent-context
 * launch for a specific userDataDir. No-ops on non-win32.
 */
export function killOrphanedProfileBrowsers(specificDir?: string): number {
  const needle = specificDir || BASE_PROFILE_DIR;
  const pids = chromePidsHolding(needle);
  if (pids.length > 0) {
    logger.warn(`[PlatformConnector] Killing ${pids.length} orphaned browser process(es) holding ${needle}`);
    killPids(pids);
  }
  return pids.length;
}

// Live-browser map key: per-novel isolation, legacy key when no slug.
function profileKey(platform: string, slug?: string): string {
  return slug ? `${slug}|${platform}` : platform;
}

// ponytail: global cap on concurrent browser launches to bound resource use / DoS
const MAX_CONCURRENT_BROWSERS = 3;
let _activeBrowsers = 0;
const _browserWaiters: Array<() => void> = [];

async function acquireBrowser(): Promise<void> {
  if (_activeBrowsers < MAX_CONCURRENT_BROWSERS) {
    _activeBrowsers++;
    return;
  }
  await new Promise<void>((resolve) => _browserWaiters.push(resolve));
}

function releaseBrowser(): void {
  // Hand the held slot directly to the next waiter (which never incremented the
  // counter); only decrement when no one is waiting. Keeps the count accurate.
  const next = _browserWaiters.shift();
  if (next) { next(); return; }
  _activeBrowsers = Math.max(0, _activeBrowsers - 1);
}

async function launchLimited(opts: any): Promise<Browser> {
  await acquireBrowser();
  try {
    return await chromium.launch(opts);
  } catch (e) {
    releaseBrowser();
    throw e;
  }
}

async function launchPersistentLimited(userDataDir: string, opts: any): Promise<BrowserContext> {
  // ponytail: clear any orphaned browser holding THIS profile's SingletonLock
  // before attempting the launch — otherwise launchPersistentContext blocks on
  // the stale lock and the scrape hangs. Cheap WMI query, win32-only.
  killOrphanedProfileBrowsers(userDataDir);
  await acquireBrowser();
  try {
    return await chromium.launchPersistentContext(userDataDir, opts);
  } catch (e) {
    releaseBrowser();
    throw e;
  }
}

// ponytail: one long-lived headless browser shared by read-only page fetches (Patreon
// tier info, public Webnovel catalogs). Per-call contexts keep the same isolation as
// one-browser-per-call without paying the ~1-3s launch cost each time. Holds one of the
// concurrency-cap slots; per-account browsers if two readers ever contend.
let _readerBrowser: Browser | null = null;

export async function getReaderBrowser(): Promise<Browser> {
  if (_readerBrowser?.isConnected()) return _readerBrowser;
  const stale = _readerBrowser;
  _readerBrowser = null;
  if (stale) releaseBrowser();
  const browser = await launchLimited({ headless: true, args: STEALTH_BROWSER_ARGS });
  _readerBrowser = browser;
  return browser;
}

export async function closeReaderBrowser(): Promise<void> {
  const b = _readerBrowser;
  _readerBrowser = null;
  if (b) {
    releaseBrowser();
    await b.close().catch(() => {});
  }
}

export function bringToFront(): void {
  if (process.platform !== 'win32') return;
  try {
    execSync(
      `powershell -NoProfile -Command "Add-Type -Name Win -Namespace Native -MemberDefinition '[DllImport(\\"user32.dll\\\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\\"user32.dll\\\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'; $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'chrome|chromium' } | Select-Object -First 1; if ($p) { [Native.Native]::ShowWindow($p.MainWindowHandle, 9); [Native.Native]::SetForegroundWindow($p.MainWindowHandle); }"`,
      { timeout: 5000, stdio: 'ignore' }
    );
  } catch { /* best effort */ }
}

const PLATFORM_URLS: Record<string, string> = {
  inkstone: 'https://inkstone.webnovel.com/novels/dashboard',
  patreon: 'https://www.patreon.com/login',
  kofi: 'https://ko-fi.com/account/login',
};

type ConnectionStatus = 'disconnected' | 'launching' | 'waiting_login' | 'saving' | 'connected' | 'error';

interface PlatformConnection {
  platform: string;
  status: ConnectionStatus;
  last_connected: string;
  cookie_age_hours: number | null;
  error: string;
  logs: string[];
}

class PlatformConnector {
  private _connections: Map<string, PlatformConnection> = new Map();
  private _liveBrowsers: Map<string, { browser: Browser; context: BrowserContext }> = new Map();

  getStatus(platform: string, slug?: string): PlatformConnection {
    const key = profileKey(platform, slug);
    const conn = this._connections.get(key);
    if (!conn) {
      const dir = profileDirFor(slug);
      const has = platformHasCookies(platform, dir);
      const age = getPlatformCookieAgeHours(platform, dir);
      return {
        platform,
        status: has ? 'connected' : 'disconnected',
        last_connected: '',
        cookie_age_hours: age,
        error: '',
        logs: [],
      };
    }
    if (conn.status === 'connected') {
      conn.cookie_age_hours = getPlatformCookieAgeHours(platform, profileDirFor(slug));
    }
    return { ...conn };
  }

  getAllStatus(): Record<string, PlatformConnection> {
    const result: Record<string, PlatformConnection> = {};
    for (const platform of Object.keys(PLATFORM_URLS)) {
      result[platform] = this.getStatus(platform);
    }
    return result;
  }

  /**
   * Get a live BrowserContext for a platform, if available.
   * Checks three sources in order:
   * 1. CDP connection (user's real Chrome - best for Cloudflare)
   * 2. Legacy live browser (launched by platformConnector)
   * 3. Returns null if nothing available
   */
  getLiveContext(platform: string, slug?: string): BrowserContext | null {
    // 1. Check CDP connection first (user's real Chrome)
    const cdpCtx = cdpManager.getContext();
    if (cdpCtx) {
      return cdpCtx;
    }

    // 2. Check legacy live browser
    const entry = this._liveBrowsers.get(profileKey(platform, slug));
    if (!entry) return null;

    // Check if the browser process is still connected
    const browser = entry.context.browser();
    if (!browser || !browser.isConnected()) {
      this._liveBrowsers.delete(profileKey(platform, slug));
      // ponytail: a kept-alive live browser holds one browser-launch slot; if it
      // died, that slot must be returned or acquireBrowser() leaks forever and
      // every scrape silently hangs once 3 slots are gone.
      releaseBrowser();
      return null;
    }

    return entry.context;
  }

  /**
   * Close and remove the live browser for a platform.
   */
  closeLiveBrowser(platform: string, slug?: string): void {
    const key = profileKey(platform, slug);
    const entry = this._liveBrowsers.get(key);
    if (entry) {
      entry.browser.close().catch(() => {});
      this._liveBrowsers.delete(key);
      releaseBrowser();
    }
  }

  /**
   * Get a scraping context for a platform using a 2-option fallback:
   * 1. Live/CDP context (existing browser)
   * 2. Headed browser with cookies from the encrypted store
   */
  async getScrapingContext(platform: string, slug?: string): Promise<{ context: BrowserContext; cleanup: () => Promise<void> } | null> {
    // 0. Reuse existing live context if available (from reconnect flow)
    const live = this.getLiveContext(platform, slug);
    if (live) {
      logger.info(`[PlatformConnector] Reusing live context for ${platform}${slug ? ` (${slug})` : ''}`);
      return { context: live, cleanup: async () => {} };
    }

    const profileDir = profileDirFor(slug);
    // 1. Persistent profile approach (matches pipeline.py):
    //    launch_persistent_context with the same userDataDir that _connectFlow creates.
    //    Cookies live in the profile natively — no injection, no CDP extraction needed.
    const userDataDir = path.join(profileDir, platform, 'playwright_profile');
    if (fs.existsSync(userDataDir)) {
      try {
        const context = await launchPersistentLimited(userDataDir, {
          headless: false,
          args: STEALTH_BROWSER_ARGS,
          ignoreDefaultArgs: ['--enable-automation'],
        });
        await applyStealthToContext(context);
        logger.info(`[PlatformConnector] Launched persistent context for ${platform}${slug ? ` (${slug})` : ''} from ${userDataDir}`);
        return { context, cleanup: async () => { try { await context.close(); } catch {} releaseBrowser(); } };
      } catch (err) {
        logger.warn(`[PlatformConnector] Persistent launch failed for ${platform}: ${err}`);
      }
    }

    // 2. Headed browser with cookies from the encrypted store (before CDP)
    try {
      const cookies = loadPlatformCookiesEncrypted(platform, profileDir);
      if (cookies && cookies.length > 0) {
        const browser = await launchLimited({ headless: false, args: STEALTH_BROWSER_ARGS });
        const context = await browser.newContext();
        await applyStealthToContext(context);
        await context.addCookies(normalizeCookies(cookies));
        logger.info(`[PlatformConnector] Launched headed browser with ${cookies.length} saved cookies for ${platform}${slug ? ` (${slug})` : ''}`);
        return { context, cleanup: async () => { try { await browser.close(); } catch {} releaseBrowser(); } };
      }
    } catch {}

    // 2b. CDP-first: extract live cookies from user's real Chrome (falling back after regular cookies)
    const cdpCtx = cdpManager.getContext();
    if (cdpCtx) {
      try {
        const cookies = await cdpCtx.cookies();
        if (cookies && cookies.length > 0) {
          savePlatformCookiesEncrypted(platform, cookies, profileDir);
          const browser = await launchLimited({ headless: false, args: STEALTH_BROWSER_ARGS });
          const context = await browser.newContext();
          await context.addCookies(normalizeCookies(cookies));
          logger.info(`[PlatformConnector] Launched fresh browser with ${cookies.length} CDP-extracted cookies for ${platform}${slug ? ` (${slug})` : ''}`);
          return { context, cleanup: async () => { try { await browser.close(); } catch {} releaseBrowser(); } };
        }
      } catch {
        // CDP might fail due to HTTP 400 errors - try next option
        logger.debug(`[PlatformConnector] CDP cookie extraction failed for ${platform}, trying alternative...`);
      }
    }

    // 3. Final fallback: attempt persistent context even without cookies
    try {
      const context = await launchPersistentLimited(userDataDir, {
        headless: false,
        args: STEALTH_BROWSER_ARGS,
        ignoreDefaultArgs: ['--enable-automation'],
      });
      await applyStealthToContext(context);
      logger.info(`[PlatformConnector] Launching persistent context without saved cookies for ${platform}`);
      return { context, cleanup: async () => { try { await context.close(); } catch {} releaseBrowser(); } };
    } catch (err) {
      logger.error(`[PlatformConnector] All context launch attempts failed for ${platform}: ${err}`);
    }

    return null;
  }

  /**
   * Connect to user's Chrome via CDP (Chrome DevTools Protocol).
   * This is the recommended connection mode - it uses the user's real browser
   * with all valid cookies and sessions, bypassing Cloudflare entirely.
   */
  async connectCDP(port?: number): Promise<{ success: boolean; port?: number; error?: string }> {
    const { cdpManager } = await import('./cdp_manager');
    const result = port
      ? await cdpManager.connect(port)
      : await cdpManager.autoConnect();

    if (result.success) {
      const cdpPort = port || cdpManager.getStatus().port;
      // Mark both platforms as connected since they share the same browser
      for (const platform of Object.keys(PLATFORM_URLS)) {
        this._connections.set(platform, {
          platform,
          status: 'connected',
          last_connected: new Date().toISOString(),
          cookie_age_hours: 0,
          error: '',
          logs: [`[CDP] Connected to Chrome on port ${cdpPort}`],
        });
      }
      return { success: true, port: cdpPort ?? undefined };
    }

    return { success: false, error: result.error };
  }

  /**
   * Disconnect from CDP.
   */
  disconnectCDP(): void {
    cdpManager.disconnect();
    for (const platform of Object.keys(PLATFORM_URLS)) {
      this._connections.set(platform, {
        platform,
        status: 'disconnected',
        last_connected: '',
        cookie_age_hours: null,
        error: '',
        logs: [],
      });
    }
  }

  /**
   * Get CDP connection status.
   */
  getCDPStatus(): { connected: boolean; port: number | null; page_count: number; connected_at: string | null } {
    return cdpManager.getStatus();
  }

  startConnect(platform: string, slug?: string): { success: boolean; status?: string; error?: string } {
    if (!(platform in PLATFORM_URLS)) {
      return { success: false, error: `Unknown platform: ${platform}` };
    }

    const key = profileKey(platform, slug);
    const existing = this._connections.get(key);
    if (existing && ['launching', 'waiting_login', 'saving'].includes(existing.status)) {
      return { success: false, error: `Connection already in progress for ${platform}` };
    }

    // Close any existing live browser for this platform before reconnecting
    this.closeLiveBrowser(platform, slug);

    const conn: PlatformConnection = {
      platform,
      status: 'launching',
      last_connected: '',
      cookie_age_hours: null,
      error: '',
      logs: ['[Host] Launching browser...'],
    };
    this._connections.set(key, conn);

    // Run the connection flow asynchronously (non-blocking)
    this._connectFlow(platform, slug).catch((err) => {
      logger.error(`Connection flow failed for ${platform}:`, err);
      const c = this._connections.get(key);
      if (c) {
        c.status = 'error';
        c.error = String(err);
        c.logs.push(`[Error] ${String(err)}`);
      }
    });

    return { success: true, status: 'launching' };
  }

  disconnect(platform: string, slug?: string): { success: boolean } {
    const key = profileKey(platform, slug);
    this.closeLiveBrowser(platform, slug);
    deletePlatformCookies(platform, profileDirFor(slug));
    this._connections.set(key, {
      platform,
      status: 'disconnected',
      last_connected: '',
      cookie_age_hours: null,
      error: '',
      logs: [],
    });
    return { success: true };
  }

  private async _connectFlow(platform: string, slug?: string): Promise<void> {
    const key = profileKey(platform, slug);
    const conn = this._connections.get(key)!;
    const targetUrl = PLATFORM_URLS[platform];
    const profileDir = profileDirFor(slug);
    const platformDir = path.join(profileDir, platform);

    if (!fs.existsSync(platformDir)) {
      fs.mkdirSync(platformDir, { recursive: true });
    }

    const userDataDir = path.join(platformDir, 'playwright_profile');
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    // Fresh profiles (no stored cookies) should land on the login page for the
    // user to sign in manually. Only previously-saved sessions hitting /login
    // mean the session actually expired.
    const hadCookies = loadPlatformCookiesEncrypted(platform, profileDir).length > 0;

    conn.logs.push(`[Host] Profile directory: ${userDataDir}`);
    conn.logs.push(`[Browser] Launching headed Chromium with persistent context...`);

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      context = await launchPersistentLimited(userDataDir, {
        headless: false,
        acceptDownloads: false,
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
        args: STEALTH_BROWSER_ARGS,
        ignoreDefaultArgs: ['--enable-automation'],
      });

      // Get the browser from the context (persistent context manages its own browser)
      browser = context.browser()!;
      conn.logs.push('[Browser] Chromium launched successfully.');
      bringToFront();

      const page = context.pages()[0] || await context.newPage();

      let navError: any = null;
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (page.url().includes('/login')) {
          if (platform === 'inkstone' && await renewInkstoneSession(page, PLATFORM_URLS.inkstone)) {
            conn.logs.push('[Browser] Inkstone session silently renewed via SSO.');
          } else if (!hadCookies) {
            conn.logs.push('[Browser] Fresh profile — waiting for manual login.');
          } else {
            throw new Error('Login page detected - the profile has expired.');
          }
        }
        conn.logs.push(`[Browser] Navigated to: ${targetUrl}`);
      } catch (err) {
        navError = err;
        conn.logs.push(`[Browser] Navigation error: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (navError) {
        conn.status = 'error';
        conn.error = 'Navigation failed';
        await context.close();
        releaseBrowser();
        return;
      }

      conn.status = 'waiting_login';
      conn.logs.push('[Browser] Browser is open. Please log in and close the window when done.');

      let lastCookies: any[] = [];

      // Poll cookies every 3 seconds while browser is open (max 30 minutes)
      const CONNECT_POLL_MAX_MS = 30 * 60 * 1000;
      const connectStart = Date.now();
      while (true) {
        if (context.pages().length === 0) break;
        if (Date.now() - connectStart > CONNECT_POLL_MAX_MS) {
          conn.logs.push('[Host] Connection polling timed out after 30 minutes.');
          break;
        }

        try {
          const current = await context.cookies();
          if (current.length > 0) {
            if (lastCookies.length === 0) {
              savePlatformCookiesEncrypted(platform, current, profileDir);
            }
            lastCookies = current;
          }
        } catch {
          break;
        }

        try {
          // Check if page is still alive
          const pages = context.pages();
          if (pages.length > 0) {
            void pages[0].url(); // Will throw if page is closed
          }
        } catch {
          break;
        }

        // Wait 3 seconds before next poll
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      // Final cookie capture
      try {
        const final = await context.cookies();
        if (final.length > 0) {
          lastCookies = final;
        }
      } catch {
        // ignore
      }

      if (lastCookies.length > 0) {
        conn.status = 'saving';
        conn.logs.push(`[Browser] Captured ${lastCookies.length} cookies. Saving...`);
        savePlatformCookiesEncrypted(platform, lastCookies, profileDir);
        // ponytail: fresh cookies prove the session is alive — clear the runtime auth-failure flag
        if (slug) {
          try {
            const t = loadTracker(slug);
            if (t.auth_error?.platform === platform) { t.auth_error = null; saveTrackerAtomic(slug, t); }
          } catch {}
        }
        conn.status = 'connected';
        conn.last_connected = new Date().toISOString();
        conn.cookie_age_hours = 0;
        conn.error = '';
        conn.logs.push(`[Host] Connected to ${platform}! ${lastCookies.length} cookies saved.`);

        // Keep the browser alive so scrapers can reuse it
        // (Cloudflare cf_clearance is bound to the TLS fingerprint)
        this._liveBrowsers.set(key, { browser: browser!, context });
        conn.logs.push('[Host] Browser kept alive for scraping.');
      } else {
        conn.status = 'disconnected';
        conn.error = '';
        conn.logs.push('[Host] No cookies captured. Browser was closed without logging in.');
        await context.close();
        releaseBrowser();
      }
    } catch (err: any) {
      logger.error(`Connection failed for ${platform}:`, err);
      conn.status = 'error';
      conn.error = String(err);
      conn.logs.push(`[Error] ${String(err)}`);
      if (context) {
        try { await context.close(); } catch { /* ignore */ }
        releaseBrowser();
      }
    }
  }
}

// Singleton instance
export const platformConnector = new PlatformConnector();
