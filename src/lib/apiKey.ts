/**
 * Bootstraps the API key for the same-origin local SPA.
 *
 * The server requires X-API-Key on every request once a key is configured. The
 * SPA cannot know it ahead of time, so it fetches it once from the gated
 * /api/v1/auth/key endpoint (which only hands the key to loopback + same-origin
 * requests) and caches it in memory, then attaches it to every request via
 * apiFetch(). When no key is configured (dev mode) the endpoint returns 204 and
 * apiKeyHeaders() yields {}.
 */

let cachedKey: string | null | undefined;

export async function bootstrapApiKey(): Promise<string | null> {
  return bootstrap();
}

async function bootstrap(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey;
  try {
    const res = await fetch('/api/v1/auth/key');
    if (res.status === 204) {
      cachedKey = null;
      return null;
    }
    if (!res.ok) {
      cachedKey = null;
      return null;
    }
    const data = await res.json();
    cachedKey = typeof data.apiKey === 'string' && data.apiKey ? data.apiKey : null;
  } catch {
    cachedKey = null;
  }
  return cachedKey ?? null;
}

export function getApiKey(): string | null {
  return cachedKey === undefined ? null : cachedKey;
}

export function apiKeyHeaders(): Record<string, string> {
  return cachedKey ? { 'X-API-Key': cachedKey } : {};
}

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  await bootstrap();
  const headers = { ...apiKeyHeaders(), ...(options.headers || {}) };
  return fetch(url, { ...options, headers });
}
