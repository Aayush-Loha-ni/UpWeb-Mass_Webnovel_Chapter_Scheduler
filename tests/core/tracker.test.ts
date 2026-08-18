import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  loadTracker,
  saveTrackerAtomic,
  createDefaultTracker,
  getTrackerPath,
} from '../../server/core/tracker';
import { WORKSPACE_ROOT } from '../../server/core/config';

const TEST_SLUG = '__test_tracker__';

function cleanupTestDirs() {
  const trackerDir = path.dirname(getTrackerPath(TEST_SLUG));
  if (fs.existsSync(trackerDir)) {
    fs.rmSync(trackerDir, { recursive: true, force: true });
  }
}

describe('createDefaultTracker', () => {
  it('returns a tracker with expected fields', () => {
    const tracker = createDefaultTracker();
    expect(tracker.webnovel_last).toBe(0);
    expect(tracker.patreon_last).toBe(0);
    expect(tracker.patreon_published_count).toBe(0);
    expect(tracker.execution_status).toBe('idle');
    expect(tracker.last_run_logs).toEqual([]);
    expect(tracker.inkstone_latest_scheduled).toBeNull();
    expect(tracker.patreon_latest_scheduled).toBeNull();
    expect(tracker.next_schedule_date).toBeNull();
  });
});

describe('loadTracker', () => {
  beforeEach(() => {
    cleanupTestDirs();
  });

  afterEach(() => {
    cleanupTestDirs();
  });

  it('returns default tracker for non-existent file', () => {
    const tracker = loadTracker(TEST_SLUG);
    expect(tracker.webnovel_last).toBe(0);
    expect(tracker.execution_status).toBe('idle');
    expect(Array.isArray(tracker.last_run_logs)).toBe(true);
  });

  it('creates the tracker file on disk', () => {
    loadTracker(TEST_SLUG);
    const filePath = getTrackerPath(TEST_SLUG);
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

describe('saveTrackerAtomic and loadTracker round-trip', () => {
  beforeEach(() => {
    cleanupTestDirs();
  });

  afterEach(() => {
    cleanupTestDirs();
  });

  it('persists and retrieves tracker state', () => {
    const tracker = createDefaultTracker();
    tracker.webnovel_last = 42;
    tracker.patreon_last = 37;
    tracker.execution_status = 'running';

    saveTrackerAtomic(TEST_SLUG, tracker);
    const loaded = loadTracker(TEST_SLUG);

    expect(loaded.webnovel_last).toBe(42);
    expect(loaded.patreon_last).toBe(37);
    expect(loaded.execution_status).toBe('running');
  });

  it('creates a backup file before overwriting', () => {
    const tracker1 = createDefaultTracker();
    tracker1.webnovel_last = 10;
    saveTrackerAtomic(TEST_SLUG, tracker1);

    const tracker2 = createDefaultTracker();
    tracker2.webnovel_last = 20;
    saveTrackerAtomic(TEST_SLUG, tracker2);

    const logDir = path.dirname(getTrackerPath(TEST_SLUG));
    const files = fs.readdirSync(logDir);
    const bakFiles = files.filter((f) => f.endsWith('.bak'));
    expect(bakFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('preserves non-default fields through round-trip', () => {
    const tracker = createDefaultTracker();
    tracker.inkstone_scheduled_count = 5;
    tracker.patreon_scheduled_count = 3;
    tracker.inkstone_latest_scheduled = '2025-01-15T12:00:00Z';
    tracker.patreon_latest_scheduled = '2025-01-16T12:00:00Z';
    tracker.next_schedule_date = '2025-01-17';
    tracker.last_scraped_at = '2025-01-14T08:00:00Z';
    tracker.last_run_logs = ['log entry 1', 'log entry 2'];

    saveTrackerAtomic(TEST_SLUG, tracker);
    const loaded = loadTracker(TEST_SLUG);

    expect(loaded.inkstone_scheduled_count).toBe(5);
    expect(loaded.patreon_scheduled_count).toBe(3);
    expect(loaded.inkstone_latest_scheduled).toBe('2025-01-15T12:00:00Z');
    expect(loaded.patreon_latest_scheduled).toBe('2025-01-16T12:00:00Z');
    expect(loaded.next_schedule_date).toBe('2025-01-17');
    expect(loaded.last_scraped_at).toBe('2025-01-14T08:00:00Z');
    expect(loaded.last_run_logs).toEqual(['log entry 1', 'log entry 2']);
  });
});
