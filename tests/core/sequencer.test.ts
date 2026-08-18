import { describe, it, expect } from 'vitest';
import { auditSequence, deriveInkstoneAnchor, computeBackfillPlan } from '../../server/core/sequencer';
import { calculatePublishSchedules } from '../../server/core/scheduler';

// ponytail: dates are injected via scheduled rows only — deriveInkstoneAnchor reads them,
// and auditSequence reads `today` from the real clock. For a deterministic pure-future
// schedule anchored on today, that's fine: the audit must not flag a dense daily chain
// that starts today.

function patreonRows(from: number, to: number, startIso: string): { chapter_number: number; date: string }[] {
  const rows: { chapter_number: number; date: string }[] = [];
  const start = new Date(startIso);
  for (let n = from; n <= to; n++) {
    const d = new Date(start.getTime() + (n - from) * 86400000);
    rows.push({ chapter_number: n, date: d.toISOString().slice(0, 10) });
  }
  return rows;
}

// ponytail: auditSequence reads `today` from the real clock, so inject dates relative to it.
// Keeps the corrupt-row cascade case exercising the same rows regardless of when the suite runs.
function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('deriveInkstoneAnchor', () => {
  it('anchors a pure-future schedule at the first scheduled date minus 1 day', () => {
    const today = isoDaysFromNow(0);
    const rows = patreonRows(87, 219, today + 'T00:00:00.000Z');
    const { anchor } = deriveInkstoneAnchor(rows, today);
    expect(anchor).toBe(isoDaysFromNow(-1));
  });

  it('anchors a dated-past chain at the last published date', () => {
    const today = isoDaysFromNow(0);
    const rows = [
      { chapter_number: 66, date: isoDaysFromNow(-1) },
      { chapter_number: 67, date: today },
      { chapter_number: 68, date: isoDaysFromNow(1) },
    ];
    const { anchor } = deriveInkstoneAnchor(rows, today);
    expect(anchor).toBe(isoDaysFromNow(-1));
  });
});

describe('auditSequence pure-future dense chain', () => {
  it('passes a Patreon-style schedule that starts today', () => {
    const rows = patreonRows(87, 219, isoDaysFromNow(0) + 'T00:00:00.000Z');
    const audit = auditSequence('patreon', rows, 1, '12:00', '5.75');
    expect(audit.ok).toBe(true);
    expect(audit.mismatches).toHaveLength(0);
  });

  it('passes when the boundary chapter was published today and Ch 68+ continue daily', () => {
    // Tracker state after the boundary published: Ch 66-69 dated-past, Ch 70 dated today.
    // The chain must NOT shift Ch 70 forward.
    const rows = [
      { chapter_number: 66, date: isoDaysFromNow(-4) },
      { chapter_number: 67, date: isoDaysFromNow(-3) },
      { chapter_number: 68, date: isoDaysFromNow(-2) },
      { chapter_number: 69, date: isoDaysFromNow(-1) },
      { chapter_number: 70, date: isoDaysFromNow(0) },
    ];
    const audit = auditSequence('inkstone', rows, 1, '12:00', '5.75');
    expect(audit.ok).toBe(true);
    expect(audit.mismatches).toHaveLength(0);
  });

  it('flags one far-future corrupt row but does NOT cascade its date onto the correct tail', () => {
    // Run-2 bug: Ch 68 was corrupted to a far-future date; the correct tail 70-75 must
    // keep their own dates and only Ch 68 may be flagged.
    const rows = [
      { chapter_number: 68, date: isoDaysFromNow(200) },
      { chapter_number: 69, date: isoDaysFromNow(-1) },
      { chapter_number: 70, date: isoDaysFromNow(0) },
      { chapter_number: 71, date: isoDaysFromNow(1) },
      { chapter_number: 72, date: isoDaysFromNow(2) },
      { chapter_number: 73, date: isoDaysFromNow(3) },
      { chapter_number: 74, date: isoDaysFromNow(4) },
      { chapter_number: 75, date: isoDaysFromNow(5) },
    ];
    const audit = auditSequence('inkstone', rows, 1, '12:00', '5.75', isoDaysFromNow(-3));
    expect(audit.mismatches.map(m => m.chapter_number)).toEqual([68]);
    expect(audit.ok).toBe(false);
  });
});

// ponytail regression: the Ch 109-299 incident — backfill deleted the tail above a gap
// (104-108) but the executor only re-scheduled boundary+1..fillTarget + next batch, so
// the deleted runway was lost. The executor's re-create pass (runner.ts Phase 1) must
// schedule every chapter from the highest planned up to the max backfill-deleted chapter.
function runExecutorPhase1(existingScheduled: { chapter_number: number; date: string; edit_url?: string }[], localChapters: { chapter_number: number; title: string }[], webnovelLast: number, patreonLast: number, config: { target_lead: number; chapters_per_day: number; base_publish_time: string; timezone: string }, limit: number): { chapters: number[]; bf: ReturnType<typeof computeBackfillPlan> } {
  const fillTarget = Math.max(0, patreonLast - config.target_lead);
  const lastScheduled = Math.max(webnovelLast, ...existingScheduled.map(s => s.chapter_number));
  const upcoming: { chapter_number: number; title: string }[] = [];
  for (let cn = lastScheduled + 1; cn <= lastScheduled + limit; cn++) {
    const ch = localChapters.find(c => c.chapter_number === cn);
    if (ch) upcoming.push(ch);
  }
  const gapFillCandidates = localChapters.filter(c => c.chapter_number > webnovelLast);
  const chsForBackfill = [...upcoming, ...gapFillCandidates.filter(c => !upcoming.find(n => n.chapter_number === c.chapter_number))];

  const boundary = Math.max(0, ...existingScheduled.filter(s => s.chapter_number <= fillTarget).map(s => s.chapter_number), webnovelLast <= fillTarget ? webnovelLast : 0);
  const fillNeeded = boundary < fillTarget;
  const bf = computeBackfillPlan(existingScheduled, chsForBackfill, config.chapters_per_day, config.base_publish_time, fillNeeded ? fillTarget : webnovelLast, config.timezone, new Set());

  const deletedNums = new Set(bf.chaptersToDelete.map(c => c.chapter_number));
  const trackerScheduled = existingScheduled.filter(c => !deletedNums.has(c.chapter_number));

  const lastInk = Math.max(webnovelLast, ...trackerScheduled.map(s => s.chapter_number));
  const inkChapters: { chapter_number: number; title: string }[] = [];
  if (fillNeeded) {
    for (let cn = boundary + 1; cn <= fillTarget; cn++) {
      const ch = localChapters.find(c => c.chapter_number === cn);
      if (ch) inkChapters.push(ch);
    }
  } else {
    for (let cn = lastInk + 1; cn <= lastInk + limit; cn++) {
      const ch = localChapters.find(c => c.chapter_number === cn);
      if (ch) inkChapters.push(ch);
    }
  }
  // executor re-create pass (runner.ts)
  const inkBackfillDeleted = bf.chaptersToDelete.map(c => c.chapter_number);
  const maxDeleted = inkBackfillDeleted.length > 0 ? Math.max(...inkBackfillDeleted) : 0;
  const highestPlanned = Math.max(0, ...inkChapters.map(c => c.chapter_number));
  for (let cn = highestPlanned + 1; cn <= maxDeleted; cn++) {
    const alreadyScheduled = trackerScheduled.some(s => s.chapter_number === cn);
    if (alreadyScheduled) continue;
    const ch = localChapters.find(c => c.chapter_number === cn);
    if (ch) inkChapters.push(ch);
  }

  return { chapters: inkChapters.map(c => c.chapter_number), bf };
}

describe('backfill deletion is fully re-created by the executor', () => {
  const config = { target_lead: 20, chapters_per_day: 1, base_publish_time: '12:00', timezone: '5.75' };
  const localChapters = Array.from({ length: 359 }, (_, i) => ({ chapter_number: i + 1, title: `Chapter ${i + 1}` }));

  it('re-creates every deleted chapter above the fill target (Ch 109-299 incident)', () => {
    // pre-incident: webnovel_last=96, patreon_last=123 (fillTarget=103),
    // scheduled = Ch 97-103 + Ch 109-299 (gap at 104-108)
    const existingScheduled = [
      ...Array.from({ length: 7 }, (_, i) => ({ chapter_number: 97 + i, date: '2026-08-18T12:00:00', edit_url: 'url' })),
      ...Array.from({ length: 191 }, (_, i) => ({ chapter_number: 109 + i, date: '2026-08-18T12:00:00', edit_url: 'url' })),
    ];
    const { chapters, bf } = runExecutorPhase1(existingScheduled, localChapters, 96, 123, config, 10);
    expect(bf.needsBackfill).toBe(true);
    expect(bf.chaptersToDelete).toHaveLength(191);
    const nums = new Set(chapters);
    for (let n = 104; n <= 299; n++) expect(nums.has(n)).toBe(true);
  });

  it('re-creates gap fillers too when the fill path is active', () => {
    // only Ch 109-299 scheduled, webnovel_last=96: fill publishes 97-103, gap 104-108
    // was never on the platform, deleted tail is 109-299 — all of 97-299 must be scheduled
    const existingScheduled = Array.from({ length: 191 }, (_, i) => ({ chapter_number: 109 + i, date: '2026-08-18T12:00:00', edit_url: 'url' }));
    const { chapters, bf } = runExecutorPhase1(existingScheduled, localChapters, 96, 123, config, 10);
    expect(bf.needsBackfill).toBe(true);
    const nums = new Set(chapters);
    for (let n = 97; n <= 299; n++) expect(nums.has(n)).toBe(true);
  });
});
