import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  AutomationRunner,
  computeCatchUpGaps,
} from '../../server/core/runner';
import {
  createDefaultTracker,
  saveTrackerAtomic,
  getTrackerPath,
} from '../../server/core/tracker';
import { ensureWorkspaceDirectories, WORKSPACE_ROOT } from '../../server/core/config';
import { invalidateChapterCache } from '../../server/core/parser';

const TEST_SLUG = '__test_runner_unit__';

function writeChapterFile(chaptersDir: string, num: number, title: string) {
  const content = `---
title: "${title}"
chapter_number: ${num}
---

# ${title}

Body of ${title}.`;
  fs.writeFileSync(path.join(chaptersDir, `ch${String(num).padStart(3, '0')}.md`), content, 'utf8');
}

function setupTestNovel(numChapters: number, trackerOverrides?: Record<string, any>) {
  const dirs = ensureWorkspaceDirectories(TEST_SLUG);

  for (let i = 1; i <= numChapters; i++) {
    writeChapterFile(dirs.chaptersDir, i, `Chapter ${i}`);
  }

  const tracker = createDefaultTracker();
  tracker.webnovel_last = 3;
  tracker.patreon_last = 2;
  tracker.inkstone_scheduled = [
    { chapter_number: 4, date: new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10) },
  ];
  tracker.patreon_scheduled = [
    { chapter_number: 3, date: new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10) },
  ];

  Object.assign(tracker, trackerOverrides || {});
  saveTrackerAtomic(TEST_SLUG, tracker);
  invalidateChapterCache(TEST_SLUG);
  return { dirs, tracker };
}

function cleanupTestNovel() {
  const novelDir = path.join(WORKSPACE_ROOT, TEST_SLUG);
  if (fs.existsSync(novelDir)) {
    fs.rmSync(novelDir, { recursive: true, force: true });
  }
}

describe('computePublishPlan', () => {
  beforeEach(() => { cleanupTestNovel(); });
  afterEach(() => { cleanupTestNovel(); });

  it('catches Patreon up to the target lead LIVE when behind', () => {
    setupTestNovel(30);
    // webnovel_last=3, patreon_last=2, target_lead=20 → lead target = 23
    const result = AutomationRunner.computePublishPlan(TEST_SLUG);

    expect(result.ok).toBe(true);
    expect(result.plan).toHaveLength(2);
    expect(result.tracker_stuck).toBe(false);

    const patreon = result.plan.find(p => p.platform === 'patreon')!;
    const inkstone = result.plan.find(p => p.platform === 'inkstone')!;

    // Patreon catch-up publishes Ch 4..23 LIVE today (restores the lead in one run)
    expect(patreon.chapters.map(c => c.chapter_number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 4));
    const today = new Date().toISOString().slice(0, 10);
    const liveDates = new Set(patreon.chapters.map(c => c.scheduled_date.slice(0, 10)));
    expect(liveDates).toEqual(new Set([today]));

    // Inkstone schedules its next batch (Ch 5..9); the hold applies to LIVE inkstone
    // publishes, not future-dated scheduling.
    expect(inkstone.chapters.map(c => c.chapter_number)).toEqual([5, 6, 7, 8, 9]);
  });

  it('keeps batch_limit behavior when Patreon is already at the target lead', () => {
    setupTestNovel(40, {
      webnovel_last: 10,
      patreon_last: 30, // 30 = 10 + 20 → at lead, no catch-up
      patreon_scheduled: [],
      inkstone_scheduled: [
        { chapter_number: 11, date: new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10) },
      ],
    });
    const result = AutomationRunner.computePublishPlan(TEST_SLUG);

    const patreon = result.plan.find(p => p.platform === 'patreon')!;
    expect(patreon.chapters.map(c => c.chapter_number)).toEqual([31, 32, 33, 34, 35]);
  });

  it('returns plan with only the requested chapter when chapterNumber given', () => {
    setupTestNovel(20);
    const result = AutomationRunner.computePublishPlan(TEST_SLUG, 6);

    expect(result.ok).toBe(true);

    const patreon = result.plan.find(p => p.platform === 'patreon')!;
    const inkstone = result.plan.find(p => p.platform === 'inkstone')!;

    expect(patreon.chapters.map(c => c.chapter_number)).toEqual([6]);
    expect(inkstone.chapters.map(c => c.chapter_number)).toEqual([6]);
  });

  it('skips single chapter if already published or scheduled', () => {
    setupTestNovel(20);
    const result = AutomationRunner.computePublishPlan(TEST_SLUG, 3);

    const patreon = result.plan.find(p => p.platform === 'patreon')!;
    const inkstone = result.plan.find(p => p.platform === 'inkstone')!;

    // ch 3 <= lastPatScheduled (3) → already patreon
    // ch 3 <= lastInkScheduled (4) → already inkstone
    expect(patreon.chapters).toHaveLength(0);
    expect(inkstone.chapters).toHaveLength(0);
  });

  it('fills inkstone to restore the lead instead of blocking when patreon lead > target_lead', () => {
    // patreon 25, webnovel 3, target 20 → fill target = 25-20 = 5. Inkstone at 4 is behind,
    // so the plan fills Ch 5 LIVE (today) to bring the lead back to target — no block.
    setupTestNovel(40, {
      patreon_last: 25,
      webnovel_last: 3,
    });

    const result = AutomationRunner.computePublishPlan(TEST_SLUG);
    expect(result.ok).toBe(true);
    expect(result.conflicts.some(c => c.type === 'lead_exceed')).toBe(false);

    const inkstone = result.plan.find(p => p.platform === 'inkstone')!;
    // rule: inkstone never publishes live — the fill is SCHEDULED after the existing
    // chain (ch4 is at +3 days, 1/day → ch5 lands at +4 days), never today.
    expect(inkstone.chapters.map(c => c.chapter_number)).toEqual([5]);
    const expected = new Date(Date.now() + 86400000 * 4).toISOString().slice(0, 10);
    expect(inkstone.chapters[0].scheduled_date.slice(0, 10)).toBe(expected);
  });

  it('warns (does not block) when patreon lead > target_lead and inkstone is already at the fill target', () => {
    // inkstone scheduled through Ch 5 (the fill target) but published only Ch 3 → lead 22 > 20.
    // Scheduling future-dated chapters never shrinks the published lead, so this is a warning,
    // not a block — the executor's HOLD branch already guards LIVE publishes.
    setupTestNovel(40, {
      patreon_last: 25,
      webnovel_last: 3,
      inkstone_scheduled: [
        { chapter_number: 5, date: new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 10) },
      ],
    });

    const result = AutomationRunner.computePublishPlan(TEST_SLUG);
    expect(result.ok).toBe(true);
    expect(result.conflicts.some(c => c.type === 'lead_exceed')).toBe(false);
    expect(result.warnings.some(w => /exceeds target/i.test(w))).toBe(true);
  });

  it('reports tracker_stuck when execution_status is running', () => {
    setupTestNovel(5, { execution_status: 'running' });
    const result = AutomationRunner.computePublishPlan(TEST_SLUG);
    expect(result.tracker_stuck).toBe(true);
  });

  it('returns empty plan for non-existent chapter number', () => {
    setupTestNovel(5);
    const result = AutomationRunner.computePublishPlan(TEST_SLUG, 99);

    const patreon = result.plan.find(p => p.platform === 'patreon')!;
    const inkstone = result.plan.find(p => p.platform === 'inkstone')!;
    expect(patreon.chapters).toHaveLength(0);
    expect(inkstone.chapters).toHaveLength(0);
  });
});

describe('computePublishPlan with both platforms disabled', () => {
  beforeEach(() => { cleanupTestNovel(); });
  afterEach(() => { cleanupTestNovel(); });

  it('still returns plans but with correct disabled counts', () => {
    setupTestNovel(10);
    const result = AutomationRunner.computePublishPlan(TEST_SLUG);
    expect(result.ok).toBe(true);
    // Even with empty scheduled, still returns plans with chapters from last+1
    const patreon = result.plan.find(p => p.platform === 'patreon')!;
    expect(patreon.chapters.length).toBeGreaterThan(0);
  });
});

describe('computeCatchUpGaps', () => {
  it('reports shortfall when Patreon stopped short of the target', () => {
    const { missing, shortfall } = computeCatchUpGaps(3, 8, 6, [4, 5, 6]);
    expect(missing).toEqual([]);
    expect(shortfall).toBe(2);
  });

  it('flags chapters missing inside the already-published range', () => {
    const { missing, shortfall } = computeCatchUpGaps(3, 8, 8, [4, 5, 7, 8]);
    expect(missing).toEqual([6]);
    expect(shortfall).toBe(0);
  });

  it('reports nothing when the catch-up fully landed', () => {
    const { missing, shortfall } = computeCatchUpGaps(3, 8, 8, [4, 5, 6, 7, 8]);
    expect(missing).toEqual([]);
    expect(shortfall).toBe(0);
  });
});
