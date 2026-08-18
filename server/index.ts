/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import './env';
import express from 'express';
import expressWs from 'express-ws';
import compression from 'compression';
import * as path from 'path';
import * as fs from 'fs';
import { createServer as createViteServer } from 'vite';

import { loadNovelsRegistry, saveNovelsRegistry, loadNovelConfig, saveNovelConfig, ensureWorkspaceDirectories, WORKSPACE_ROOT } from './core/config';
import { loadTracker, saveTrackerAtomic } from './core/tracker';
import { scanChaptersDirectory, parseChapterFile } from './core/parser';
import { unlockFile, lockFile } from './core/locking';
import { BrowserManager } from './core/browser';
import { AutomationRunner } from './core/runner';
import { platformConnector, killOrphanedProfileBrowsers } from './core/platform_connector';
import { createV1Router } from './api/v1';
import { setupWebSocket } from './api/websocket';
import { setupSwagger } from './api/swagger';
import { apiKeyAuth, getCurrentApiKey } from './core/auth';
import { logEventBus } from './api/log_events';
import logger from './core/logger';

function validateSlug(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const pruneInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(key);
  }
}, 5 * 60 * 1000);
pruneInterval.unref();

function rateLimit(key: string, maxRequests: number, windowMs: number): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    const resetAt = now + windowMs;
    rateLimitStore.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: maxRequests - 1, resetAt };
  }
  if (entry.count >= maxRequests) return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count, resetAt: entry.resetAt };
}

// Request metrics
const metrics = {
  requests: 0,
  errors: 0,
  startTime: Date.now(),
};

export async function createApp() {
  const app = express();
  const wsInstance = expressWs(app);

  app.set('trust proxy', false);
  app.use(express.json({ limit: '512kb' }));
  app.use(compression());

  // API key auth (skips healthz and docs)
  app.use(apiKeyAuth);

  // Request logging + metrics
  app.use((req, res, next) => {
    metrics.requests++;
    const start = Date.now();
    const originalEnd = res.end;
    res.end = function(this: any, ...args: Parameters<typeof originalEnd>) {
      const duration = Date.now() - start;
      const status = res.statusCode;
      if (status >= 500) metrics.errors++;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      logger[level](`${req.method} ${req.url} ${status} ${duration}ms`);
      return originalEnd.apply(this, args);
    } as any;
    next();
  });

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Dev (Vite middleware) injects an inline React-refresh preamble script, so script-src
    // must allow 'unsafe-inline' there; production serves the static build with strict script-src.
    const scriptSrc = process.env.NODE_ENV !== 'production' ? "'self' 'unsafe-inline'" : "'self'";
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:`);
    next();
  });

  // Rate limiting (API routes only — static/Vite assets bypass, mirroring apiKeyAuth)
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const isMutating = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
    const isHealth = req.path === '/healthz';
    const key = `rate:${req.socket.remoteAddress || 'unknown'}:${isHealth ? 'health' : isMutating ? 'mutate' : 'read'}`;
    const maxReqs = isHealth ? 10 : isMutating ? 60 : 120;
    const windowMs = 60_000;
    const result = rateLimit(key, maxReqs, windowMs);
    res.setHeader('X-RateLimit-Limit', String(maxReqs));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    if (!result.allowed) {
      res.status(429).json({ error: 'Too many requests.' });
      return;
    }
    next();
  });

  // CSRF
  app.use((req, res, next) => {
    const isMutating = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
    if (!isMutating) return next();
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    if (!origin && !referer) {
      res.status(403).json({ error: 'Forbidden', message: 'Missing Origin and Referer headers.' });
      return;
    }
    const whitelistedHosts = new Set(['127.0.0.1:3000', 'localhost:3000', '127.0.0.1:8080', 'localhost:8080']);
    const appUrl = process.env.APP_URL;
    if (appUrl) {
      try { whitelistedHosts.add(new URL(appUrl).host); } catch {}
    }
    const checkHost = (urlStr: string | undefined): boolean => {
      if (!urlStr) return false;
      if (urlStr.includes('@')) return false;
      try {
        const host = urlStr.startsWith('http') ? new URL(urlStr).host : urlStr;
        return whitelistedHosts.has(host.replace(/\/$/, ''));
      } catch { return false; }
    }
    if (!checkHost(origin) && !checkHost(referer)) {
      res.status(403).json({ error: 'Forbidden', message: 'Request origin not in whitelist.' });
      return;
    }
    next();
  });

  // Slug validation
  app.use((req, res, next) => {
    const slugMatch = req.path.match(/\/api\/(?:v1\/)?novels\/([^/]+)/);
    if (slugMatch && !validateSlug(slugMatch[1])) {
      res.status(400).json({ error: 'Invalid novel slug.' });
      return;
    }
    next();
  });

  // ==========================================
  // Health check (deep)
  // ==========================================
  app.get('/healthz', async (_req, res) => {
    const checks: Record<string, string> = { status: 'ok' };

    // Filesystem writability
    try {
      const testFile = path.join(WORKSPACE_ROOT, '.healthz_test');
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
      checks.filesystem = 'ok';
    } catch {
      checks.filesystem = 'error';
      checks.status = 'degraded';
    }

    // CDP connection
    try {
      const { cdpManager } = await import('./core/cdp_manager');
      const cdpStatus = cdpManager.getStatus();
      checks.cdp = cdpStatus.connected ? 'connected' : 'disconnected';
    } catch {
      checks.cdp = 'error';
    }

    // Browser status
    checks.inkstone = BrowserManager.getStatus('inkstone').authenticated ? 'authenticated' : 'unauthenticated';
    checks.patreon = BrowserManager.getStatus('patreon').authenticated ? 'authenticated' : 'unauthenticated';

    const httpStatus = checks.status === 'ok' ? 200 : 503;
    res.status(httpStatus).json({
      status: checks.status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks,
    });
  });

  // ==========================================
  // Metrics endpoint
  // ==========================================
  app.get('/api/metrics', (_req, res) => {
    res.json({
      requests_total: metrics.requests,
      errors_total: metrics.errors,
      uptime_seconds: Math.round((Date.now() - metrics.startTime) / 1000),
      websocket_connections: logEventBus.getConnectionCount(),
      memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
  });

  // ==========================================
  // Mount v1 API, WebSocket, Swagger
  // ==========================================
  app.use('/api/v1', createV1Router(() => gracefulShutdown('browser_close').then(() => process.exit(0))));
  setupWebSocket(app, wsInstance);
  setupSwagger(app);

  // ==========================================
  // Vite / static
  // ==========================================
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, watch: { ignored: ['**/data/**', '**/shared/browser_profile/**', '**/legacy/**', '**/node_modules/**'] } },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.env.DIST_DIR || process.cwd(), 'dist');
    // ponytail: never serve source maps or dotfiles from the built bundle
    app.use((req, res, next) => {
      if (req.path.endsWith('.map') || req.path.split('/').some(p => p.startsWith('.'))) { res.status(404).end(); return; }
      next();
    });
    app.use(express.static(distPath, { dotfiles: 'ignore' }));
    app.get('*all', (_req, res) => { res.sendFile(path.join(distPath, 'index.html')); });
  }

  // ==========================================
  // Startup: Reset stuck execution statuses
  // ==========================================
  AutomationRunner.resetStuckStatuses();

  // ponytail: sweep orphaned browser processes holding browser_profile locks so a
  // killed previous run can't hang every scrape (SingletonLock). win32-only.
  try {
    const killed = killOrphanedProfileBrowsers();
    if (killed > 0) logger.warn(`Startup: killed ${killed} orphaned browser process(es) holding profile locks.`);
  } catch { /* best effort */ }

  // ponytail: auto-scrape on launch disabled — scrape is manual-only now.
  // (Kept available via POST /api/v1/novels/:slug/scrape.)

  return { app, wsInstance };
}

let activeServer: any = null;
let activeWsInstance: any = null;

/**
 * Tears down HTTP server, WebSockets, notifications, running automations,
 * and CDP. Exported so Electron's main process can call it on `before-quit`.
 * Does NOT call process.exit — the caller decides how to terminate.
 */
export async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`[${signal}] Graceful shutdown initiated...`);

  if (activeServer) {
    activeServer.close(() => logger.info('HTTP server closed.'));
  }

  // Close all active WebSocket connections
  try {
    const wss = (activeWsInstance as any)?.getWss?.();
    if (wss) {
      for (const client of wss.clients || []) {
        try { client.close(1001, 'Server shutting down'); } catch {}
      }
    }
  } catch {}

  // Close notification clients
  try {
    const { closeAllNotifications, buildNotificationClients, loadNotificationConfigFromEnv } = await import('./core/notifications');
    const config = loadNotificationConfigFromEnv();
    const clients = buildNotificationClients(config, logger);
    await closeAllNotifications(clients);
  } catch {}

  // Abort all running automations
  try {
    if (fs.existsSync(WORKSPACE_ROOT)) {
      const slugs = fs.readdirSync(WORKSPACE_ROOT);
      for (const slug of slugs) {
        AutomationRunner.abort(slug);
      }
    }
  } catch {}

  // Disconnect CDP
  try {
    const { cdpManager } = await import('./core/cdp_manager');
    await cdpManager.disconnect();
  } catch {}

  // Close shared read-only headless browser (patreon-info / public catalog)
  try {
    const { closeReaderBrowser } = await import('./core/platform_connector');
    await closeReaderBrowser();
  } catch {}

  // Clear rate limit prune interval
  clearInterval(pruneInterval);

  logger.info('Cleanup complete.');
}

// ponytail: background auto-publisher removed — publish is manual-only.
// User triggers via POST /api/v1/novels/:slug/publish or the UI button.

async function startServer() {
  const basePort = parseInt(process.env.PORT || '3000', 10);
  if (isNaN(basePort) || basePort < 1 || basePort > 65535) {
    logger.error(`Invalid PORT: ${process.env.PORT}`);
    process.exit(1);
  }
  if (process.env.APP_URL) {
    try { new URL(process.env.APP_URL); } catch {
      logger.error(`Invalid APP_URL: ${process.env.APP_URL}`);
      process.exit(1);
    }
  }

  const { app, wsInstance } = await createApp();
  const bindHost = process.env.BIND_HOST || '127.0.0.1';
  const isLoopbackBind = ['127.0.0.1', '::1', 'localhost'].includes(bindHost);
  if (!isLoopbackBind && !(process.env.API_KEY && process.env.API_KEY.length > 0) && !process.env.TLS_CERT) {
    logger.error(`[SECURITY] Binding to non-loopback host "${bindHost}" without an API_KEY and without TLS. The API key and all traffic will be exposed in cleartext. Set API_KEY and terminate TLS (or bind to 127.0.0.1).`);
  }

  let PORT = basePort;
  // ponytail: port fallback, max 10 attempts. Remove if fixed-port requirement exists.
  for (let attempt = 0; attempt < 10; attempt++) {
    PORT = basePort + attempt;
    try {
      await new Promise<void>((resolve, reject) => {
        const server = app.listen(PORT, bindHost);
        server.on('listening', () => {
          const apiKey = getCurrentApiKey();
          if (attempt > 0) logger.info(`Port ${basePort} was in use, bound to ${PORT} instead.`);
          logger.info(`Server running at http://${bindHost}:${PORT}`);
          logger.info(`Health check: http://${bindHost}:${PORT}/healthz`);
          logger.info(`API v1: http://${bindHost}:${PORT}/api/v1`);
          logger.info(`Swagger docs: http://${bindHost}:${PORT}/api/docs`);
          logger.info(`WebSocket logs: ws://${bindHost}:${PORT}/api/v1/ws/logs`);
          if (apiKey) {
            logger.info(`API key required. Set the X-API-Key header.`);
          } else {
            logger.warn(`No API key configured. All endpoints are open.`);
          }
          activeServer = server;
          activeWsInstance = wsInstance;
          resolve();
        });
        server.on('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            server.close();
            reject(err);
          } else {
            logger.error(`Server error: ${err.message}`);
            reject(err);
          }
        });
      });
      break;
    } catch (err: any) {
      if (err.code !== 'EADDRINUSE') throw err;
      if (attempt === 9) {
        logger.error(`Ports ${basePort}-${basePort + 9} all in use. Cannot start server.`);
        process.exit(1);
      }
    }
  }

  // ==========================================
  // Graceful shutdown
  // ==========================================
  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM').then(() => process.exit(0)); });
  process.on('SIGINT', () => { void gracefulShutdown('SIGINT').then(() => process.exit(0)); });
}

// Electron imports createApp() directly and runs its own listen loop, so skip
// the auto-start here when running inside the desktop shell or vitest.
if (process.env.ELECTRON_RUN !== '1' && !process.env.VITEST) {
  startServer();
}
