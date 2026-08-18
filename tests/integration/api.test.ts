/// <reference types="vitest/globals" />
// Disable API key auth before any imports (auth module reads env at init)
process.env.API_KEY = '';
// Prevent Vite HMR WebSocket port conflict when a dev server is already running
process.env.DISABLE_HMR = 'true';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { createApp } from '../../server';
import { NOVELS_REGISTRY_FILE } from '../../server/core/config';

let server: Server;
let baseUrl: string;
const NOVELS_YAML = NOVELS_REGISTRY_FILE;
let savedNovelsYaml: string;

beforeAll(async () => {
  // Backup live novels.yaml before tests mutate it
  savedNovelsYaml = fs.readFileSync(NOVELS_YAML, 'utf8');

  const { app } = await createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // Restore live novels.yaml after tests
  fs.writeFileSync(NOVELS_YAML, savedNovelsYaml, 'utf8');
});

describe('Health check', () => {
  it('GET /healthz returns 200 with status ok', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status', 'ok');
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('uptime');
    expect(body).toHaveProperty('checks');
    expect(body.checks).toHaveProperty('filesystem');
    expect(body.checks).toHaveProperty('inkstone');
    expect(body.checks).toHaveProperty('patreon');
  });
});

describe('Metrics', () => {
  it('GET /api/metrics returns 200 with required fields', async () => {
    const res = await fetch(`${baseUrl}/api/metrics`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('requests_total');
    expect(body).toHaveProperty('errors_total');
    expect(body).toHaveProperty('uptime_seconds');
    expect(body).toHaveProperty('websocket_connections');
    expect(body).toHaveProperty('memory_mb');
    expect(typeof body.requests_total).toBe('number');
    expect(typeof body.memory_mb).toBe('number');
  });
});

describe('Security headers', () => {
  it('returns X-Content-Type-Options on any response', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-xss-protection')).toBe('1; mode=block');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });
});

describe('Swagger docs', () => {
  it('GET /api/docs returns HTML', async () => {
    const res = await fetch(`${baseUrl}/api/docs`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('swagger');
  });
});

describe('API v1 novels endpoint', () => {
  it('GET /api/v1/novels returns array', async () => {
    const res = await fetch(`${baseUrl}/api/v1/novels`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

describe('Rate limiting', () => {
  it('sets X-RateLimit headers on POST requests', async () => {
    const res = await fetch(`${baseUrl}/api/v1/novels`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ name: 'test', path: 'test' }),
    });
    // May be 403 (CSRF) or 200/400 depending on content
    expect(res.headers.get('x-ratelimit-limit')).toBeTruthy();
    expect(res.headers.get('x-ratelimit-remaining')).toBeTruthy();
  });
});

describe('CSRF protection', () => {
  it('rejects POST without Origin or Referer', async () => {
    const res = await fetch(`${baseUrl}/api/v1/novels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('allows POST with valid Origin', async () => {
    const res = await fetch(`${baseUrl}/api/v1/novels`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ slug: 'test-novel', name: 'Test' }),
    });
    // Should not be CSRF 403 (may be 200 or validation error)
    expect(res.status).not.toBe(403);
  });
});

describe('Slug validation', () => {
  it('rejects invalid slug characters', async () => {
    const res = await fetch(`${baseUrl}/api/v1/novels/INVALID%21%40%24/config`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('slug');
  });

  it('accepts valid slug', async () => {
    const res = await fetch(`${baseUrl}/api/v1/novels/valid-slug/config`);
    // Should not be 400 for slug validation
    expect(res.status).not.toBe(400);
  });
});

describe('Non-existent routes', () => {
  it('returns a valid response for unknown API routes', async () => {
    const res = await fetch(`${baseUrl}/api/v1/nonexistent`);
    // In dev mode, Vite SPA catch-all returns 200 for unknown routes
    // In production, Express returns 404
    expect([200, 404]).toContain(res.status);
  });
});

describe('Rate limit exhaustion', () => {
  it('returns 429 after exceeding rate limit', async () => {
    // The rate-limit middleware runs before the route handler, so an invalid body
    // (fast 400, no disk writes) still counts toward the limit. This keeps the test
    // fast and avoids polluting the workspace with throwaway novels.
    // ponytail: retry with backoff to avoid ECONNRESET from rapid-fire connections
    let hit429 = false;
    const attempt = async (): Promise<void> => {
      for (let i = 0; i < 80; i++) {
        try {
          const res = await fetch(`${baseUrl}/api/v1/novels`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: 'http://localhost:3000',
            },
            body: JSON.stringify({}),
          });
          if (res.status === 429) {
            hit429 = true;
            const body = await res.json();
            expect(body.error).toBe('Too many requests.');
            return;
          }
        } catch {
          await new Promise(r => setTimeout(r, 200));
        }
      }
    };
    await attempt();
    expect(hit429).toBe(true);
  }, 30000);
});
