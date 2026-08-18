/**
 * License / premium entitlement check.
 *
 * A license is an Ed25519-signed token verified by the server.
 * The client calls POST /api/v1/license/verify instead of checking locally.
 */

import { useState, useEffect } from 'react';
import { apiFetch } from './apiKey';

const STORAGE_KEY = 'wn_license_token_v1';

export interface LicensePayload {
  sub: string;
  plan: 'premium' | 'pro';
  exp: number;
}

function readCached(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function writeCached(token: string | null): void {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

async function serverVerify(token: string): Promise<{ ok: boolean; plan?: string; reason?: string }> {
  try {
    const res = await apiFetch('/api/v1/license/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return await res.json();
  } catch {
    return { ok: false, reason: 'Network error.' };
  }
}

export async function activateLicense(token: string): Promise<{ ok: boolean; reason?: string }> {
  const result = await serverVerify(token);
  if (!result.ok) return { ok: false, reason: result.reason || 'Invalid or expired license.' };
  writeCached(token);
  return { ok: true };
}

export function clearLicense(): void {
  writeCached(null);
}

export function isPremium(p: LicensePayload | null): boolean {
  return !!p && (p.plan === 'premium' || p.plan === 'pro');
}

/** React hook: resolves premium status on mount (checks cached + verifies server-side). */
export function usePremium(): boolean {
  const [premium, setPremium] = useState<boolean>(false);
  useEffect(() => {
    let alive = true;
    const tok = readCached();
    if (!tok) { setPremium(false); return; }
    serverVerify(tok).then((r) => { if (alive) setPremium(r.ok); }).catch(() => { if (alive) setPremium(false); });
    return () => { alive = false; };
  }, []);
  return premium;
}
