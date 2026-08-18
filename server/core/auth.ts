/**
 * API Key Authentication Middleware
 * Validates the X-API-Key header against the configured key.
 */

import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import logger from './logger';
import { SHARED_DIR } from './config';

const API_KEY_FILE = path.join(SHARED_DIR, '.api_key');

let configuredKey: string | null = null;

function getApiKey(): string | null {
  if (configuredKey) return configuredKey;

  // 1. Environment variable (empty string = no auth)
  if (process.env.API_KEY !== undefined) {
    configuredKey = process.env.API_KEY || null;
    return configuredKey;
  }

  // 2. File-based key
  try {
    if (fs.existsSync(API_KEY_FILE)) {
      configuredKey = fs.readFileSync(API_KEY_FILE, 'utf8').trim();
      return configuredKey;
    }
  } catch {}

  // 3. Generate a new key and save it
  const newKey = 'wn_' + crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(path.dirname(API_KEY_FILE), { recursive: true });
    fs.writeFileSync(API_KEY_FILE, newKey, { mode: 0o600 });
    logger.info(`[Auth] Generated new API key. Stored at: ${API_KEY_FILE}`);
    logger.info(`[Auth] Set API_KEY env var or pass this key in X-API-Key header.`);
    configuredKey = newKey;
    return configuredKey;
  } catch (err) {
    logger.error('[Auth] Failed to generate API key file:', err);
    return null;
  }
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Express middleware that enforces API key authentication.
 * Skipped for health check and docs endpoints.
 */
const API_KEY_ROUTE = '/api/v1/auth/key';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  // The SPA document and static assets are NOT API routes — never require a key
  // for them. Only /api/* endpoints are gated. This lets the browser load the app
  // (and bootstrap its key via /api/v1/auth/key) before any authenticated call.
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }

  // Skip auth for the health check always, and Swagger docs only outside production.
  if (req.path === '/healthz') {
    next();
    return;
  }
  if (req.path.startsWith('/api/docs') && process.env.NODE_ENV !== 'production') {
    next();
    return;
  }

  // The key-dispensing endpoint is the bootstrap: the SAME-ORIGIN local SPA uses it
  // to obtain the key it must send on every other request. It performs its own
  // loopback + same-origin + not-proxied gating, so it is reachable WITHOUT a key.
  // No other path is exempt — see server/api/v1.ts router.get('/auth/key').
  if (req.path === API_KEY_ROUTE) {
    next();
    return;
  }

  // SECURITY: when an API key is configured it is ALWAYS required — including for
  // loopback peers and regardless of Sec-Fetch-Site. The only unauthenticated path
  // is when no key is configured at all (dev mode, see below), and even then proxied
  // requests are rejected.
  // ponytail: IP-based bypass keeps local-dev UX only when no key is set; real per-user login is the next step for public multi-user.
  const key = getApiKey();
  if (!key) {
    // No API key configured at all — preserve dev "open" behavior. The loopback
    // bypass now lives here ONLY, and still refuses proxied requests.
    if (isLoopbackAndNotProxied(req)) {
      logger.warn('[Auth] No API key configured — allowing loopback request without auth (dev mode).');
      next();
      return;
    }
    res.status(503).json({ error: 'Server auth is not configured. Set API_KEY.' });
    return;
  }

  // A key IS configured: never bypass it, regardless of origin/proxy/Sec-Fetch.
  const provided = req.headers['x-api-key'] as string;
  if (!provided) {
    res.status(401).json({ error: 'Missing API key. Provide via X-API-Key header.' });
    return;
  }

  if (!constantTimeCompare(provided, key)) {
    res.status(403).json({ error: 'Invalid API key.' });
    return;
  }

  next();
}

/**
 * Get the current API key (for displaying in logs/startup).
 */
export function getCurrentApiKey(): string | null {
  return getApiKey();
}

/**
 * Authorization check reusable outside the Express middleware chain (e.g. the
 * WebSocket upgrade, which does not pass through app.use middleware).
 * Applies the same loopback/proxy and API-key rules as apiKeyAuth.
 */
function isLoopbackAndNotProxied(req: Request): boolean {
  const peer = req.socket.remoteAddress || '';
  const isLoopbackPeer = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const wasProxied = !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['forwarded']);
  return isLoopbackPeer && !wasProxied;
}

/**
 * Gate for the key-dispensing endpoint. This is a LOCAL single-user tool: the
 * key only ever lives in a local file, so we dispense it to any loopback peer
 * that is NOT reached through a proxy. We deliberately do NOT require a matching
 * Origin — browsers loading the SPA via localhost / 127.0.0.1 / file:// or an
 * Electron shell would otherwise be locked out, and the key is unreadable
 * remotely anyway. Proxied requests are still refused so a fronting proxy can't
 * relay the key off-box.
 */
export function isLocalTrustedRequest(req: Request): boolean {
  return isLoopbackAndNotProxied(req);
}

/**
 * Authorization check reusable outside the Express middleware chain (e.g. the
 * WebSocket upgrade, which does not pass through app.use middleware).
 * Applies the same loopback/proxy and API-key rules as apiKeyAuth.
 *
 * `providedKey` lets callers (the WebSocket upgrade) supply the key from a
 * query param, since browsers cannot set custom headers on a WebSocket handshake.
 */
export function isRequestAuthorized(req: Request, providedKey?: string): boolean {
  const key = getApiKey();
  if (!key) {
    // No API key configured — dev "open" behavior. Loopback bypass only here,
    // and still reject proxied requests.
    return isLoopbackAndNotProxied(req);
  }

  // A key IS configured: always validate it, regardless of origin.
  const provided = providedKey ?? (req.headers['x-api-key'] as string);
  if (!provided) return false;
  return constantTimeCompare(provided, key);
}
