import { describe, it, expect } from 'vitest';
import {
  humanDelay,
  STEALTH_VIEWPORT,
  STEALTH_USER_AGENT,
  STEALTH_BROWSER_ARGS,
  applyStealthToContext,
  postNavigationDelay,
  betweenClicksDelay,
  postLoginDelay,
} from '../../server/core/stealth';

describe('humanDelay', () => {
  it('resolves within the specified range', async () => {
    const min = 50;
    const max = 150;
    const start = Date.now();
    await humanDelay(min, max);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(min - 10); // allow timer tolerance
    expect(elapsed).toBeLessThanOrEqual(max + 50);
  });

  it('resolves within default range (500-2000ms)', async () => {
    const start = Date.now();
    await humanDelay();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(490);
    expect(elapsed).toBeLessThanOrEqual(2100);
  });
});

describe('STEALTH_VIEWPORT', () => {
  it('is defined with width and height', () => {
    expect(STEALTH_VIEWPORT).toBeDefined();
    expect(STEALTH_VIEWPORT.width).toBe(1920);
    expect(STEALTH_VIEWPORT.height).toBe(1080);
  });
});

describe('STEALTH_USER_AGENT', () => {
  it('is a non-empty string containing Chrome', () => {
    expect(STEALTH_USER_AGENT).toBeDefined();
    expect(typeof STEALTH_USER_AGENT).toBe('string');
    expect(STEALTH_USER_AGENT.length).toBeGreaterThan(0);
    expect(STEALTH_USER_AGENT).toContain('Chrome');
  });
});

describe('STEALTH_BROWSER_ARGS', () => {
  it('is a non-empty array', () => {
    expect(STEALTH_BROWSER_ARGS).toBeDefined();
    expect(Array.isArray(STEALTH_BROWSER_ARGS)).toBe(true);
    expect(STEALTH_BROWSER_ARGS.length).toBeGreaterThan(0);
  });

  it('contains AutomationControlled disable flag', () => {
    expect(STEALTH_BROWSER_ARGS.some(arg => arg.includes('AutomationControlled'))).toBe(true);
  });
});

describe('applyStealthToContext', () => {
  it('is callable (async function)', () => {
    expect(typeof applyStealthToContext).toBe('function');
  });

  it('accepts a mock context with addInitScript', async () => {
    let scriptInjected = false;
    const mockContext = {
      addInitScript: async (_script: string) => {
        scriptInjected = true;
      },
    } as any;

    await applyStealthToContext(mockContext);
    expect(scriptInjected).toBe(true);
  });
});

describe('delay helpers', () => {
  it('postNavigationDelay resolves within 1500-3500 range', async () => {
    const start = Date.now();
    await postNavigationDelay();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(1490);
    expect(elapsed).toBeLessThanOrEqual(3600);
  });

  it('betweenClicksDelay resolves within 300-800 range', async () => {
    const start = Date.now();
    await betweenClicksDelay();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThanOrEqual(900);
  });

  it('postLoginDelay resolves within 2000-5000 range', async () => {
    const start = Date.now();
    await postLoginDelay();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(1990);
    expect(elapsed).toBeLessThanOrEqual(5100);
  });
});
