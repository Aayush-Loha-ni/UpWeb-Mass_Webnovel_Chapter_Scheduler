import * as crypto from 'crypto';

const PUBLIC_KEY = (process.env.LICENSE_PUBLIC_KEY || process.env.VITE_LICENSE_PUBLIC_KEY || '').trim();

export interface LicensePayload {
  sub: string;
  plan: 'premium' | 'pro';
  exp: number;
}

function b64urlDecode(s: string): Buffer {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4 ? '='.repeat(4 - (b.length % 4)) : '';
  return Buffer.from(b + pad, 'base64');
}

export function verifyLicenseToken(token: string): LicensePayload | null {
  if (!PUBLIC_KEY) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  try {
    const sig = b64urlDecode(sigB64);
    const ok = crypto.verify(
      null,
      Buffer.from(payloadB64),
      PUBLIC_KEY,
      sig
    );
    if (!ok) return null;
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(b64urlDecode(payloadB64).toString()) as LicensePayload;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    if (payload.plan !== 'premium' && payload.plan !== 'pro') return null;
    return payload;
  } catch {
    return null;
  }
}
