/**
 * Structured Error Classification System
 * Ported from Skyvern: docs/developers/going-to-production/error-handling.mdx
 *
 * Maps page states to error codes with specific retry policies.
 * Each error code has a recommended action, retryable flag, and backoff strategy.
 */

// ==========================================
// Error Code Definitions
// ==========================================

export type ScrapingErrorCode =
  | 'session_expired'
  | 'login_required'
  | 'captcha_required'
  | 'rate_limited'
  | 'access_denied'
  | 'page_not_found'
  | 'maintenance'
  | 'timeout'
  | 'connection_failed'
  | 'element_not_found'
  | 'cloudflare_blocked'
  | 'unknown';

export interface ErrorClassification {
  code: ScrapingErrorCode;
  message: string;
  retryable: boolean;
  retryDelayMs: number;
  maxRetries: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

// ==========================================
// Retry Policy Per Error Code
// ==========================================

const ERROR_POLICIES: Record<ScrapingErrorCode, Omit<ErrorClassification, 'code' | 'message'>> = {
  session_expired: {
    retryable: false, // Need re-auth, not just retry
    retryDelayMs: 0,
    maxRetries: 0,
    severity: 'high',
  },
  login_required: {
    retryable: false,
    retryDelayMs: 0,
    maxRetries: 0,
    severity: 'high',
  },
  captcha_required: {
    retryable: false, // Can't solve CAPTCHA programmatically
    retryDelayMs: 0,
    maxRetries: 0,
    severity: 'high',
  },
  rate_limited: {
    retryable: true,
    retryDelayMs: 30_000, // Wait 30s
    maxRetries: 3,
    severity: 'medium',
  },
  access_denied: {
    retryable: false,
    retryDelayMs: 0,
    maxRetries: 0,
    severity: 'high',
  },
  page_not_found: {
    retryable: false,
    retryDelayMs: 0,
    maxRetries: 0,
    severity: 'low',
  },
  maintenance: {
    retryable: true,
    retryDelayMs: 60_000, // Wait 1min
    maxRetries: 2,
    severity: 'medium',
  },
  timeout: {
    retryable: true,
    retryDelayMs: 5_000,
    maxRetries: 2,
    severity: 'medium',
  },
  connection_failed: {
    retryable: true,
    retryDelayMs: 10_000,
    maxRetries: 3,
    severity: 'high',
  },
  element_not_found: {
    retryable: true,
    retryDelayMs: 3_000,
    maxRetries: 2,
    severity: 'low',
  },
  cloudflare_blocked: {
    retryable: false, // Need CDP connection, not just retry
    retryDelayMs: 0,
    maxRetries: 0,
    severity: 'critical',
  },
  unknown: {
    retryable: true,
    retryDelayMs: 5_000,
    maxRetries: 1,
    severity: 'medium',
  },
};

// ==========================================
// Error Classification Functions
// ==========================================

/**
 * Classify an error based on its message and page state.
 * Returns a structured error classification with retry policy.
 */
export function classifyError(
  error: any,
  pageUrl?: string,
  pageTitle?: string
): ErrorClassification {
  const msg = String(error?.message || error || '').toLowerCase();
  const url = (pageUrl || '').toLowerCase();
  const title = (pageTitle || '').toLowerCase();

  let code: ScrapingErrorCode;
  let message: string;

  // Session / Auth errors
  if (msg.includes('session expired') || msg.includes('session_invalidated')) {
    code = 'session_expired';
    message = 'Session has expired. Please reconnect your profile.';
  } else if (url.includes('/login') || msg.includes('login required') || msg.includes('redirected to login')) {
    code = 'login_required';
    message = 'Login required. Profile is not authenticated.';
  } else if (msg.includes('captcha') || msg.includes('challenge') || title.includes('just a moment')) {
    code = 'captcha_required';
    message = 'CAPTCHA or challenge detected. Manual intervention required.';
  } else if (msg.includes('cloudflare') || msg.includes('cf-') || msg.includes('checking your browser')) {
    code = 'cloudflare_blocked';
    message = 'Cloudflare protection detected. Use CDP connection to real Chrome.';
  } else if (msg.includes('409') || msg.includes('conflict')) {
    code = 'session_expired';
    message = 'Session conflict detected. Please reconnect your profile.';
  } else if (msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit')) {
    code = 'rate_limited';
    message = 'Rate limited by server. Waiting before retry.';
  } else if (msg.includes('403') || msg.includes('forbidden') || msg.includes('access denied')) {
    code = 'access_denied';
    message = 'Access denied. Check account permissions.';
  } else if (msg.includes('404') || msg.includes('not found')) {
    code = 'page_not_found';
    message = 'Page or resource not found.';
  } else if (msg.includes('503') || msg.includes('maintenance') || msg.includes('unavailable')) {
    code = 'maintenance';
    message = 'Service temporarily unavailable. Will retry.';
  } else if (msg.includes('timeout') || msg.includes('timed out')) {
    code = 'timeout';
    message = 'Operation timed out.';
  } else if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('enotfound')) {
    code = 'connection_failed';
    message = 'Connection failed. Network issue.';
  } else if (msg.includes('element not found') || msg.includes('selector') || msg.includes('waiting for selector')) {
    code = 'element_not_found';
    message = 'Expected element not found on page.';
  } else {
    code = 'unknown';
    message = error?.message || 'An unknown error occurred.';
  }

  const policy = ERROR_POLICIES[code];

  return {
    code,
    message,
    ...policy,
  };
}

/**
 * Retry executor driven by classifyError's per-code policy.
 * Retries only errors the policy marks retryable, using its base delay with
 * exponential backoff, capped by the policy's maxRetries. This is the executor
 * for the previously dead retry-policy data.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxRetries?: number; onRetry?: (attempt: number, delayMs: number, err: any) => void }
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const c = classifyError(err);
      const ceiling = opts?.maxRetries !== undefined ? Math.min(opts.maxRetries, c.maxRetries) : c.maxRetries;
      if (!c.retryable || attempt >= ceiling) throw err;
      const delayMs = c.retryDelayMs * Math.pow(2, attempt);
      opts?.onRetry?.(attempt + 1, delayMs, err);
      await new Promise((r) => setTimeout(r, delayMs));
      attempt++;
    }
  }
}

/**
 * Validate that a page session is actually authenticated.
 * Checks for common signs of being logged in vs. redirected/error state.
 * Ported from Skyvern: post-login validation pattern.
 */
export async function validateSession(
  page: { url(): string; title(): Promise<string>; content(): Promise<string>; evaluate?: (fn: Function) => Promise<any> },
  platform: 'inkstone' | 'patreon'
): Promise<{ valid: boolean; reason: string }> {
  const url = page.url();
  const title = await page.title();
  const bodyText = page.evaluate ? await page.evaluate(() => (document.body?.innerText || '')).catch(() => '') : await page.content().catch(() => '');

  // Common invalid states
  if (url.includes('/login') || url.includes('/signin')) {
    return { valid: false, reason: 'Redirected to login page' };
  }
  if (title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('checking')) {
    return { valid: false, reason: 'Cloudflare challenge detected' };
  }
  if (bodyText.includes('captcha') || bodyText.includes('CAPTCHA')) {
    return { valid: false, reason: 'CAPTCHA detected on page' };
  }
  if (bodyText.includes('Access Denied') || bodyText.includes('403') || bodyText.includes('access denied')) {
    return { valid: false, reason: 'Access denied' };
  }

  // Platform-specific valid state checks
  if (platform === 'inkstone') {
    // Valid: on an inkstone page not showing login
    if (url.includes('inkstone.webnovel.com') && !url.includes('/login')) {
      return { valid: true, reason: 'Inkstone session valid' };
    }
  } else if (platform === 'patreon') {
    // Valid: not on login page
    if (url.includes('patreon.com') && !url.includes('/login')) {
      return { valid: true, reason: 'Patreon session valid' };
    }
  }

  return { valid: true, reason: 'Session appears valid (no negative indicators)' };
}
