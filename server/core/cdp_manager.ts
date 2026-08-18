/**
 * CDP (Chrome DevTools Protocol) Manager
 * Connects to the user's already-running Chrome browser via remote debugging.
 * This bypasses Cloudflare's TLS fingerprint checks because we use the
 * user's real browser with all valid cookies and sessions.
 *
 * Patterns imported from Skyvern:
 * - DevToolsActivePort auto-discovery (scripts/windows_chrome_inspect_cdp.ps1)
 * - CDP connection with fallback chain (docs/developers/self-hosted/browser.mdx)
 * - Session cookie persist/restore (docs/developers/optimization/browser-sessions.mdx)
 * - Anti-detection: connect to real Chrome instead of launching headless
 */

import { chromium, Browser, BrowserContext } from 'playwright';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { encryptData, decryptData } from './cookie_encrypt';
import logger from './logger';
import { SHARED_DIR } from './config';

const CDP_SCAN_PORTS = [9222, 9223, 9224, 9225, 9226, 9229];
const CDP_SCAN_TIMEOUT_MS = 2000;
const SESSION_DIR = path.join(SHARED_DIR, 'browser_profile', '_cdp_sessions');

interface CDPServerInfo {
  webSocketDebuggerUrl: string;
  browser: string;
  protocolVersion: string;
  title: string;
}

interface CDPConnection {
  browser: Browser;
  context: BrowserContext;
  connectedAt: string;
  port: number;
}

/**
 * Probe a single port for Chrome DevTools Protocol availability.
 * Returns Chrome version info if the port has a debugging server.
 */
async function probePort(port: number): Promise<CDPServerInfo | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: CDP_SCAN_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          if (info.webSocketDebuggerUrl) {
            resolve(info);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Auto-discover Chrome's debugging port by reading DevToolsActivePort file.
 * Ported from Skyvern: scripts/windows_chrome_inspect_cdp.ps1
 *
 * Chrome writes a DevToolsActivePort file when remote debugging is enabled.
 * The file contains two lines: the port number and the browser WebSocket path.
 */
async function findDevToolsActivePort(): Promise<{ port: number; browserPath: string } | null> {
  const roots: string[] = [];

  // Chrome writes DevToolsActivePort to LOCALAPPDATA or TEMP
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    roots.push(path.join(localAppData, 'Google', 'Chrome', 'User Data'));
  }
  const temp = process.env.TEMP || process.env.tmp;
  if (temp) {
    roots.push(temp);
  }

  // Also check common Windows paths (sanitize USERNAME to prevent path traversal)
  const safeUsername = (process.env.USERNAME || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (safeUsername) {
    roots.push('C:\\Users\\' + safeUsername + '\\AppData\\Local\\Google\\Chrome\\User Data');
  }

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;

    try {
      // Search recursively for DevToolsActivePort (max 3 levels deep)
      const found = findFileRecursive(root, 'DevToolsActivePort', 3);
      if (found) {
        const content = fs.readFileSync(found, 'utf-8').trim();
        const lines = content.split('\n');
        if (lines.length >= 2) {
          const port = parseInt(lines[0], 10);
          const browserPath = lines[1].trim();
          if (port > 0 && browserPath.startsWith('/devtools/browser/')) {
            logger.info(`[CDP] Found DevToolsActivePort: port=${port}, path=${browserPath}`);
            return { port, browserPath };
          }
        }
      }
    } catch {
      // Continue searching
    }
  }

  return null;
}

/**
 * Recursively search for a file up to maxDepth levels.
 */
function findFileRecursive(dir: string, fileName: string, maxDepth: number): string | null {
  if (maxDepth <= 0) return null;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === fileName) {
        return fullPath;
      }
      if (entry.isDirectory() && maxDepth > 1) {
        const found = findFileRecursive(fullPath, fileName, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch {
    // Permission denied or other errors
  }
  return null;
}

/**
 * Scan common Chrome debugging ports and return the first available server.
 * Falls back to DevToolsActivePort discovery if port scan fails.
 */
export async function discoverCDPServer(): Promise<{ port: number; info: CDPServerInfo; browserPath?: string } | null> {
  // Method 1: Scan common ports
  for (const port of CDP_SCAN_PORTS) {
    const info = await probePort(port);
    if (info) {
      logger.info(`[CDP] Found Chrome debugging server on port ${port}: ${info.title || 'Chrome'}`);
      return { port, info };
    }
  }

  // Method 2: DevToolsActivePort file (from Skyvern pattern)
  const devToolsPort = await findDevToolsActivePort();
  if (devToolsPort) {
    const info = await probePort(devToolsPort.port);
    if (info) {
      logger.info(`[CDP] Found Chrome via DevToolsActivePort on port ${devToolsPort.port}`);
      return { port: devToolsPort.port, info, browserPath: devToolsPort.browserPath };
    }
  }

  return null;
}

/**
 * Connect to Chrome via CDP on a specific port.
 * Returns a Playwright Browser + BrowserContext that wraps the existing Chrome.
 */
export async function connectToChrome(port: number): Promise<CDPConnection> {
  const info = await probePort(port);
  if (!info) {
    throw new Error(
      `No Chrome debugging server found on port ${port}. ` +
      `Please enable remote debugging in Chrome:\n` +
      `1. Open chrome://inspect/#remote-debugging\n` +
      `2. Click "Enable" next to "Remote debugging"\n` +
      `3. Ensure the server is running at 127.0.0.1:${port}`
    );
  }

  const cdpUrl = `http://127.0.0.1:${port}`;
  logger.info(`[CDP] Connecting to Chrome at ${cdpUrl}...`);

  const browser = await chromium.connectOverCDP(cdpUrl);
  const contexts = browser.contexts();

  // Use existing context or create a new one
  let context: BrowserContext;
  if (contexts.length > 0) {
    context = contexts[0];
    logger.info(`[CDP] Connected to existing browser context (${context.pages().length} pages)`);
  } else {
    context = await browser.newContext();
    logger.info(`[CDP] Connected to browser, created new context`);
  }

  // Restore session cookies if available
  await restoreSessionCookies(context, port);

  return {
    browser,
    context,
    connectedAt: new Date().toISOString(),
    port,
  };
}

/**
 * Persist session cookies to disk.
 * Ported from Skyvern: session_cookies.py pattern.
 * This allows restoring cookies across browser launches.
 */
export async function persistSessionCookies(context: BrowserContext, port: number): Promise<void> {
  try {
    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
    }

    const cookies = await context.cookies();
    const sessionFile = path.join(SESSION_DIR, `session_${port}.json`);
    const plaintext = JSON.stringify(cookies);
    const encrypted = encryptData(plaintext);
    fs.writeFileSync(sessionFile, encrypted, { mode: 0o600 });
    try { fs.chmodSync(sessionFile, 0o600); } catch { /* best effort */ }
    logger.info(`[CDP] Persisted ${cookies.length} cookies for port ${port}`);
  } catch (err) {
    logger.warn(`[CDP] Failed to persist cookies: ${err}`);
  }
}

/**
 * Restore session cookies from disk.
 * Ported from Skyvern: session_cookies.py pattern.
 * Cookies older than COOKIE_MAX_AGE_HOURS are ignored (must be re-collected).
 */
export async function restoreSessionCookies(context: BrowserContext, port: number): Promise<void> {
  try {
    const sessionFile = path.join(SESSION_DIR, `session_${port}.json`);
    if (!fs.existsSync(sessionFile)) return;

    const ciphertext = fs.readFileSync(sessionFile, 'utf-8');
    const plaintext = decryptData(ciphertext);
    const cookies = JSON.parse(plaintext);
    if (Array.isArray(cookies) && cookies.length > 0) {
      await context.addCookies(cookies);
      logger.info(`[CDP] Restored ${cookies.length} cookies for port ${port}`);
    }
  } catch (err) {
    logger.warn(`[CDP] Failed to restore cookies: ${err}`);
  }
}

/**
 * CDPManager - Singleton that manages CDP connections to the user's Chrome.
 */
class CDPManager {
  private _connection: CDPConnection | null = null;
  private _connectedPort: number | null = null;

  /**
   * Check if we have an active CDP connection.
   */
  isConnected(): boolean {
    if (!this._connection) return false;
    const browser = this._connection.browser;
    if (!browser || !browser.isConnected()) {
      this._connection = null;
      this._connectedPort = null;
      return false;
    }
    return true;
  }

  /**
   * Get the active BrowserContext, or null if not connected.
   */
  getContext(): BrowserContext | null {
    if (!this.isConnected()) return null;
    return this._connection!.context;
  }

  /**
   * Get the active Browser, or null if not connected.
   */
  getBrowser(): Browser | null {
    if (!this.isConnected()) return null;
    return this._connection!.browser;
  }

  /**
   * Auto-discover and connect to Chrome.
   * Tries port scanning first, then DevToolsActivePort file.
   */
  async autoConnect(): Promise<{ success: boolean; port?: number; error?: string }> {
    if (this.isConnected()) {
      return { success: true, port: this._connectedPort! };
    }

    const discovery = await discoverCDPServer();
    if (!discovery) {
      return {
        success: false,
        error: 'No Chrome debugging server found. Please enable remote debugging in Chrome.',
      };
    }

    try {
      this._connection = await connectToChrome(discovery.port);
      this._connectedPort = discovery.port;
      return { success: true, port: discovery.port };
    } catch (err: any) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Connect to Chrome on a specific port.
   */
  async connect(port: number): Promise<{ success: boolean; error?: string }> {
    // Validate port
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { success: false, error: 'Invalid port number. Must be between 1 and 65535.' };
    }

    if (this.isConnected() && this._connectedPort === port) {
      return { success: true };
    }

    // Disconnect existing connection first
    if (this.isConnected()) {
      this.disconnect();
    }

    try {
      this._connection = await connectToChrome(port);
      this._connectedPort = port;
      return { success: true };
    } catch (err: any) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Disconnect from Chrome.
   * Persists cookies before disconnecting, then disconnects Playwright.
   * Does NOT close the actual Chrome browser.
   */
  async disconnect(): Promise<void> {
    if (this._connection) {
      // Persist cookies before disconnecting
      await persistSessionCookies(this._connection.context, this._connectedPort!);

      // Try to disconnect the Playwright browser gracefully
      try {
        await this._connection.browser.close();
      } catch {
        // CDP connections may not support close() - that's ok
      }

      this._connection = null;
      this._connectedPort = null;
      logger.info('[CDP] Disconnected from Chrome (browser still running, cookies saved)');
    }
  }

  /**
   * Save current cookies to disk (manual save).
   */
  async saveCookies(): Promise<void> {
    if (this.isConnected() && this._connectedPort) {
      await persistSessionCookies(this._connection!.context, this._connectedPort);
    }
  }

  /**
   * Get connection status info.
   */
  getStatus(): { connected: boolean; port: number | null; page_count: number; connected_at: string | null } {
    const connected = this.isConnected();
    return {
      connected,
      port: connected ? this._connectedPort : null,
      page_count: connected ? this._connection!.context.pages().length : 0,
      connected_at: connected ? this._connection!.connectedAt : null,
    };
  }
}

// Singleton instance
export const cdpManager = new CDPManager();
