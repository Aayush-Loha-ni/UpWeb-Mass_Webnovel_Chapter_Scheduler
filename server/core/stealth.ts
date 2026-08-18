/**
 * Browser Stealth Module
 * Anti-detection patterns ported from Skyvern:
 * - navigator.webdriver suppression
 * - Viewport/UA/locale/timezone consistency
 * - Random human-like delays between actions
 * - Realistic browser fingerprint
 *
 * References:
 * - Skyvern docs/developers/features/captcha-and-bot-bypass.mdx
 * - Skyvern docs/developers/self-hosted/browser.mdx
 */

import { BrowserContext, Page } from 'playwright';

// ==========================================
// Anti-Detection JavaScript Injection
// ==========================================

/**
 * JavaScript to inject that hides automation flags from detection scripts.
 * Ported from Skyvern: suppresses navigator.webdriver and other telltale signs.
 */
const STEALTH_INIT_SCRIPT = `
  // Override navigator.webdriver to undefined (not false - some check for typeof)
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });

  // Override navigator.plugins to look like a real browser
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client', filename: 'internal-nacl-plugin' },
    ],
    configurable: true,
  });

  // Override navigator.languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
    configurable: true,
  });

  // Override permissions query for notifications
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) =>
    parameters.name === 'notifications'
      ? Promise.resolve({ state: 'denied' } as PermissionStatus)
      : originalQuery(parameters);

  // Override chrome.runtime to prevent detection
  if (!window.chrome) {
    (window as any).chrome = {};
  }
  if (!window.chrome.runtime) {
    (window as any).chrome.runtime = {};
  }

  // Remove automation-related properties from window
  delete (window as any).__webdriver_evaluate;
  delete (window as any).__selenium_evaluate;
  delete (window as any).__webdriver_script_function;
  delete (window as any).__fxdriver_evaluate;
  delete (window as any).__driver_unwrapped;
  delete (window as any).__webdriver_unwrapped;
  delete (window as any).__driver_evaluate;
  delete (window as any).__lastWatirAlert;
  delete (window as any).__lastWatirConfirm;
  delete (window as any).__lastWatirPrompt;

  // Override toString to prevent detection via function stringification
  const originalToString = Function.prototype.toString;
  Function.prototype.toString = function() {
    if (this === Function.prototype.toString) return 'function toString() { [native code] }';
    return originalToString.call(this);
  };
`;

// ==========================================
// Safe Page Evaluate (Timeout-Guarded)
// ==========================================

const EVAL_TIMEOUT_MS = 15000;

export function evalWithTimeout<T = any>(page: Page, fn: string | (() => T) | ((arg: any) => T), arg?: any, timeoutMs: number = EVAL_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Playwright evaluate timeout')), timeoutMs);
    timer.unref();
    // page.evaluate with a string doesn't invoke arrow/async functions — wrap in IIFE
    if (typeof fn === 'string') {
      const trimmed = fn.trim();
      if (trimmed.startsWith('(') || trimmed.startsWith('function ') || trimmed.startsWith('async ')) {
        fn = arg !== undefined ? `((...args) => (${fn})(...args))(${JSON.stringify(arg)})` : `(${fn})()`;
        arg = undefined;
      }
    }
    page.evaluate(fn as any, arg).then(
      (val: any) => { clearTimeout(timer); resolve(val); },
      (err: any) => { clearTimeout(timer); reject(err); }
    );
  });
}

// ==========================================
// Force-Visible CSS Injection (for hover-only SPA elements)
// ==========================================

export const FORCE_SHOW_CSS = `
const s = document.createElement('style');
s.id = '_force_visible';
s.textContent = '.hover_btn--iB-3n, [class*="hover_btn"], .ant-btn-dangerous { display: inline-flex !important; visibility: visible !important; opacity: 1 !important; }';
document.head.appendChild(s);
`;

export async function injectForceVisible(page: Page): Promise<void> {
  try {
    const has = await evalWithTimeout<boolean>(page, `!!document.getElementById('_force_visible')`);
    if (!has) {
      await evalWithTimeout(page, FORCE_SHOW_CSS);
    }
  } catch {}
}

// ==========================================
// Browser Configuration
// ==========================================

/** Realistic Chrome user agent (Chrome 131 on Windows 11) */
export const STEALTH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Realistic viewport (most common desktop resolution) */
export const STEALTH_VIEWPORT = { width: 1920, height: 1080 };

/** Browser locale for English (US) */
export const STEALTH_LOCALE = 'en-US';

/** Timezone matching locale */
export const STEALTH_TIMEZONE = 'America/New_York';

/**
 * Chrome launch arguments for anti-detection.
 * Ported from Skyvern: disable AutomationControlled and other automation flags.
 */
export const STEALTH_BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-dev-shm-usage',
  '--disable-infobars',
  '--window-size=1920,1080',
];

/**
 * Default Playwright launch options with anti-detection enabled.
 */
export const STEALTH_LAUNCH_OPTIONS = {
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
  args: STEALTH_BROWSER_ARGS,
  viewport: STEALTH_VIEWPORT,
  userAgent: STEALTH_USER_AGENT,
  locale: STEALTH_LOCALE,
  timezoneId: STEALTH_TIMEZONE,
};

// ==========================================
// Human-Like Delay Utilities
// ==========================================

/**
 * Random delay between min and max milliseconds.
 * Simulates human reading/thinking time between actions.
 */
export function humanDelay(minMs: number = 500, maxMs: number = 2000): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Short pause after page navigation (simulates page reading).
 */
export function postNavigationDelay(): Promise<void> {
  return humanDelay(1500, 3500);
}

/**
 * Short pause between clicks (simulates hand movement).
 */
export function betweenClicksDelay(): Promise<void> {
  return humanDelay(300, 800);
}

/**
 * Longer pause after login form submission (simulates waiting for response).
 */
export function postLoginDelay(): Promise<void> {
  return humanDelay(2000, 5000);
}

// ==========================================
// Stealth Application Functions
// ==========================================

/**
 * Apply stealth scripts to a BrowserContext.
 * Call this after creating a context but before navigating to any pages.
 */
export async function applyStealthToContext(context: BrowserContext): Promise<void> {
  // Inject anti-detection script into every new page
  await context.addInitScript(STEALTH_INIT_SCRIPT);
}

/**
 * Apply stealth to a single page (for existing pages).
 */
export async function applyStealthToPage(page: Page): Promise<void> {
  try {
    await page.evaluate(STEALTH_INIT_SCRIPT.replace(/^/gm, ''));
  } catch {
    // Page may have already navigated away
  }
}

// ==========================================
// Event-Driven Waits (replace fixed sleeps)
// ==========================================

/**
 * Wait until the page navigates to a URL matching `pattern`. Resolves true as soon
 * as the navigation happens; falls back to a short settle if the pattern never
 * matches (so the caller's post-wait state check still runs).
 */
export async function waitForNavOrTimeout(page: Page, pattern: RegExp, timeoutMs = 20000): Promise<boolean> {
  try {
    await page.waitForURL(pattern, { timeout: timeoutMs });
    return true;
  } catch {
    await humanDelay(500, 1000);
    return false;
  }
}

/**
 * Wait until the SPA has a localStorage auth token (Inkstone stores its JWT there).
 * Resolves the moment the token appears instead of sleeping a fixed 10s; the token
 * normally lands in 1-3s after the dashboard script runs.
 */
export async function waitForLocalStorageAuth(page: Page, timeoutMs = 20000): Promise<void> {
  await page.waitForFunction(() => {
    try { return Object.keys(localStorage).some((k) => k.toLowerCase().includes('token') || k.toLowerCase().includes('jwt')); }
    catch { return false; }
  }, { timeout: timeoutMs }).catch(() => page.waitForTimeout(3000));
}

/**
 * Create a stealth browser context with all anti-detection measures applied.
 * Use this instead of raw browser.newContext() for scraping.
 */
export async function createStealthContext(
  browser: import('playwright').Browser,
  options?: {
    viewport?: { width: number; height: number };
    userAgent?: string;
    locale?: string;
    timezone?: string;
  }
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: options?.viewport || STEALTH_VIEWPORT,
    userAgent: options?.userAgent || STEALTH_USER_AGENT,
    locale: options?.locale || STEALTH_LOCALE,
    timezoneId: options?.timezone || STEALTH_TIMEZONE,
  });

  await applyStealthToContext(context);
  return context;
}

/**
 * Navigate to a URL with stealth and human-like delays.
 */
export async function stealthNavigate(
  page: Page,
  url: string,
  options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }
): Promise<void> {
  await page.goto(url, {
    waitUntil: options?.waitUntil || 'domcontentloaded',
    timeout: options?.timeout || 60000,
  });

  // Wait for network to settle
  try {
    await page.waitForLoadState('load', { timeout: 15000 });
  } catch {
    // Continue even if load event times out
  }

  // Human-like delay after navigation
  await postNavigationDelay();
}
