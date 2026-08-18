/**
 * WebSocket endpoint for real-time log streaming.
 * Clients connect to /api/v1/ws/logs/:slug to receive live log updates.
 * Includes backpressure handling and connection limits.
 */

import type { Express } from 'express';
import expressWs from 'express-ws';
import type WebSocket from 'ws';
import { logEventBus } from './log_events';
import { isRequestAuthorized } from '../core/auth';
import logger from '../core/logger';

const MAX_WS_CLIENTS = 50;
const MAX_WS_PER_IP = 3;
const SEND_BUFFER_HIGH_WATER = 1024 * 1024; // 1MB

const ALLOWED_WS_ORIGINS = new Set(['127.0.0.1:3000', 'localhost:3000', '127.0.0.1:8080', 'localhost:8080']);

const wsConnectionsPerIp = new Map<string, number>();

function getClientIp(req: any): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function checkWsOrigin(req: any): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const host = origin.startsWith('http') ? new URL(origin).host : origin;
    return ALLOWED_WS_ORIGINS.has(host.replace(/\/$/, ''));
  } catch {
    return false;
  }
}

// Browsers cannot set custom headers on a WebSocket handshake, so the SPA passes
// the key as a query param (apiKey=...). Read it from req.url if present.
function wsProvidedKey(req: any): string | undefined {
  try {
    const url = new URL(req.url, 'http://localhost');
    const k = url.searchParams.get('apiKey');
    return k || undefined;
  } catch {
    return undefined;
  }
}

function safeSend(ws: WebSocket, data: string): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  // Backpressure: check buffered amount
  if ((ws as any).bufferedAmount > SEND_BUFFER_HIGH_WATER) {
    logger.warn('[WS] Client buffer full, dropping message');
    return false;
  }
  try {
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}

export function setupWebSocket(app: Express, wsInstance: ReturnType<typeof expressWs>): void {
  // Global log stream (all slugs)
  (app as any).ws('/api/v1/ws/logs', (ws: WebSocket, req: any) => {
    const ip = getClientIp(req);
    if ((wsConnectionsPerIp.get(ip) || 0) >= MAX_WS_PER_IP) {
      ws.close(1013, 'Too many connections from this IP');
      return;
    }
    if (!checkWsOrigin(req)) {
      ws.close(1008, 'Origin not allowed');
      return;
    }
    if (!isRequestAuthorized(req, wsProvidedKey(req))) {
      ws.close(1008, 'Unauthorized');
      return;
    }
    if (logEventBus.getConnectionCount() >= MAX_WS_CLIENTS) {
      ws.close(1013, 'Too many connections');
      return;
    }

    wsConnectionsPerIp.set(ip, (wsConnectionsPerIp.get(ip) || 0) + 1);
    logger.info('[WS] Client connected to global log stream');

    const unsubscribe = logEventBus.onAnyLog((event) => {
      safeSend(ws, JSON.stringify(event));
    });

    ws.on('close', () => {
      const c = wsConnectionsPerIp.get(ip) || 1;
      if (c <= 1) wsConnectionsPerIp.delete(ip); else wsConnectionsPerIp.set(ip, c - 1);
      logger.info('[WS] Client disconnected from global log stream');
      unsubscribe();
    });

    ws.on('error', (err) => {
      const c = wsConnectionsPerIp.get(ip) || 1;
      if (c <= 1) wsConnectionsPerIp.delete(ip); else wsConnectionsPerIp.set(ip, c - 1);
      logger.error('[WS] Global log stream error:', err);
      unsubscribe();
    });

    safeSend(ws, JSON.stringify({ type: 'connected', stream: 'global' }));
  });

  // Per-novel log stream
  (app as any).ws('/api/v1/ws/logs/:slug', (ws: WebSocket, req: any) => {
    const ip = getClientIp(req);
    if ((wsConnectionsPerIp.get(ip) || 0) >= MAX_WS_PER_IP) {
      ws.close(1013, 'Too many connections from this IP');
      return;
    }
    if (!checkWsOrigin(req)) {
      ws.close(1008, 'Origin not allowed');
      return;
    }
    if (!isRequestAuthorized(req, wsProvidedKey(req))) {
      ws.close(1008, 'Unauthorized');
      return;
    }
    if (logEventBus.getConnectionCount() >= MAX_WS_CLIENTS) {
      ws.close(1013, 'Too many connections');
      return;
    }

    wsConnectionsPerIp.set(ip, (wsConnectionsPerIp.get(ip) || 0) + 1);
    const { slug } = req.params;
    logger.info(`[WS] Client connected to log stream for ${slug}`);

    const unsubscribe = logEventBus.onLog(slug, (event) => {
      safeSend(ws, JSON.stringify(event));
    });

    ws.on('close', () => {
      const c = wsConnectionsPerIp.get(ip) || 1;
      if (c <= 1) wsConnectionsPerIp.delete(ip); else wsConnectionsPerIp.set(ip, c - 1);
      logger.info(`[WS] Client disconnected from log stream for ${slug}`);
      unsubscribe();
    });

    ws.on('error', (err) => {
      const c = wsConnectionsPerIp.get(ip) || 1;
      if (c <= 1) wsConnectionsPerIp.delete(ip); else wsConnectionsPerIp.set(ip, c - 1);
      logger.error(`[WS] Log stream error for ${slug}:`, err);
      unsubscribe();
    });

    safeSend(ws, JSON.stringify({ type: 'connected', stream: slug }));
  });
}
