import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  loadNovelsRegistry,
  saveNovelsRegistry,
  loadNovelConfig,
  ensureWorkspaceDirectories,
  NOVELS_REGISTRY_FILE,
  WORKSPACE_ROOT,
} from '../../server/core/config';

const TEST_SLUG = '__test_novel_config__';

function cleanupTestDirs() {
  const testDir = path.join(WORKSPACE_ROOT, TEST_SLUG);
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

describe('loadNovelsRegistry', () => {
  it('returns an array', () => {
    const result = loadNovelsRegistry();
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns objects with slug and name', () => {
    const result = loadNovelsRegistry();
    for (const entry of result) {
      expect(typeof entry.slug).toBe('string');
      expect(typeof entry.name).toBe('string');
    }
  });
});

describe('saveNovelsRegistry and loadNovelsRegistry round-trip', () => {
  it('persists and retrieves novels correctly', () => {
    const testNovels = [
      { slug: 'test-novel-1', name: 'Test Novel 1' },
      { slug: 'test-novel-2', name: 'Test Novel 2' },
    ];

    saveNovelsRegistry(testNovels);
    const loaded = loadNovelsRegistry();

    const slugs = loaded.map((n) => n.slug);
    expect(slugs).toContain('test-novel-1');
    expect(slugs).toContain('test-novel-2');
  });

  it('overwrites previous registry', () => {
    saveNovelsRegistry([{ slug: 'overwrite-a', name: 'A' }]);
    saveNovelsRegistry([{ slug: 'overwrite-b', name: 'B' }]);
    const loaded = loadNovelsRegistry();

    const slugs = loaded.map((n) => n.slug);
    expect(slugs).toContain('overwrite-b');
    expect(slugs).not.toContain('overwrite-a');
  });
});

describe('loadNovelConfig', () => {
  beforeEach(() => {
    cleanupTestDirs();
  });

  afterEach(() => {
    cleanupTestDirs();
  });

  it('returns default config for a missing slug', () => {
    const config = loadNovelConfig(TEST_SLUG);
    expect(config.slug).toBe(TEST_SLUG);
    expect(config.target_lead).toBe(20);
    expect(config.chapters_per_day).toBe(1);
    expect(config.batch_limit).toBe(5);
    expect(config.inkstone_enabled).toBe(true);
    expect(config.patreon_enabled).toBe(true);
    expect(config.base_publish_time).toBe('12:00');
  });

  it('generates a readable name from the slug', () => {
    const config = loadNovelConfig('my-great-novel');
    expect(config.name).toBe('My Great Novel');
  });
});

describe('ensureWorkspaceDirectories', () => {
  beforeEach(() => {
    cleanupTestDirs();
  });

  afterEach(() => {
    cleanupTestDirs();
  });

  it('creates novelDir, chaptersDir, and logsDir', () => {
    const dirs = ensureWorkspaceDirectories(TEST_SLUG);
    expect(fs.existsSync(dirs.novelDir)).toBe(true);
    expect(fs.existsSync(dirs.chaptersDir)).toBe(true);
    expect(fs.existsSync(dirs.logsDir)).toBe(true);
  });

  it('returns paths ending with expected directory names', () => {
    const dirs = ensureWorkspaceDirectories(TEST_SLUG);
    expect(dirs.novelDir).toContain(TEST_SLUG);
    expect(dirs.chaptersDir).toContain('chapters');
    expect(dirs.logsDir).toContain('logs');
  });

  it('is idempotent (does not fail on second call)', () => {
    ensureWorkspaceDirectories(TEST_SLUG);
    expect(() => ensureWorkspaceDirectories(TEST_SLUG)).not.toThrow();
  });
});
