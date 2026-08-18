import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  classifyError,
  type ScrapingErrorCode,
  type ErrorClassification,
} from '../../server/core/error_codes';

describe('classifyError', () => {
  it('classifies session expired errors', () => {
    const result = classifyError({ message: 'session expired' });
    expect(result.code).toBe('session_expired');
    expect(result.retryable).toBe(false);
    expect(result.severity).toBe('high');
  });

  it('classifies session_invalidated as session_expired', () => {
    const result = classifyError({ message: 'session_invalidated' });
    expect(result.code).toBe('session_expired');
    expect(result.retryable).toBe(false);
  });

  it('classifies login required from URL', () => {
    const result = classifyError({ message: 'some error' }, 'https://example.com/login');
    expect(result.code).toBe('login_required');
    expect(result.retryable).toBe(false);
  });

  it('classifies login required from message', () => {
    const result = classifyError({ message: 'login required to continue' });
    expect(result.code).toBe('login_required');
    expect(result.retryable).toBe(false);
  });

  it('classifies captcha from message', () => {
    const result = classifyError({ message: 'captcha detected on page' });
    expect(result.code).toBe('captcha_required');
    expect(result.retryable).toBe(false);
    expect(result.severity).toBe('high');
  });

  it('classifies captcha from page title', () => {
    const result = classifyError({ message: '' }, undefined, 'Just a moment...');
    expect(result.code).toBe('captcha_required');
    expect(result.retryable).toBe(false);
  });

  it('classifies cloudflare blocked', () => {
    const result = classifyError({ message: 'checking your browser' });
    expect(result.code).toBe('cloudflare_blocked');
    expect(result.retryable).toBe(false);
    expect(result.severity).toBe('critical');
  });

  it('classifies rate limited (429)', () => {
    const result = classifyError({ message: '429 too many requests' });
    expect(result.code).toBe('rate_limited');
    expect(result.retryable).toBe(true);
    expect(result.maxRetries).toBe(3);
  });

  it('classifies rate limited (rate limit text)', () => {
    const result = classifyError({ message: 'rate limit exceeded' });
    expect(result.code).toBe('rate_limited');
    expect(result.retryable).toBe(true);
  });

  it('classifies timeout errors', () => {
    const result = classifyError({ message: 'operation timed out' });
    expect(result.code).toBe('timeout');
    expect(result.retryable).toBe(true);
    expect(result.maxRetries).toBe(2);
  });

  it('classifies unknown errors', () => {
    const result = classifyError({ message: 'something weird happened' });
    expect(result.code).toBe('unknown');
    expect(result.retryable).toBe(true);
    expect(result.maxRetries).toBe(1);
  });

  it('handles error without message property', () => {
    const result = classifyError('raw string error');
    expect(result.code).toBeDefined();
    expect(result.message).toBeDefined();
  });

  it('handles null/undefined error gracefully', () => {
    const result = classifyError(null);
    expect(result.code).toBe('unknown');
    expect(result.retryable).toBe(true);
  });
});
