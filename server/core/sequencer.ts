import { ScheduledChapter, SequenceAudit } from './models';
import { calculatePublishSchedules, getTZOffset } from './scheduler';

export function inkstoneDateToIso(raw: string | null | undefined): string {  if (!raw) return '';
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  // Inkstone API format: "14:15 12 Dec 2026"
  const m = raw.match(/^(\d{1,2}):(\d{2})\s+(\d{1,2})\s+(\w{3})\s+(\d{4})$/);
  if (m) {
    const months: Record<string, string> = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
    const month = months[m[4]];
    if (month) return m[5] + '-' + month + '-' + m[3].padStart(2, '0');
  }
  // Ambiguous single-letter month (old truncated data): "11:15 24 J"
  const m2 = raw.match(/^(\d{1,2}):(\d{2})\s+(\d{1,2})\s+([a-z])$/i);
  if (m2) {
    const day = parseInt(m2[3], 10);
    const year = new Date().getFullYear();
    const letter = m2[4].toLowerCase();
    // ponytail: single-letter months are ambiguous, pick the month closest to now
    const singleToMonth: Record<string, number> = { f: 2, s: 9, o: 10, n: 11, d: 12 };
    if (singleToMonth[letter]) {
      return year + '-' + String(singleToMonth[letter]).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }
    const ambiguous: Record<string, number[]> = { j: [6, 7, 1], m: [3, 5], a: [4, 8] };
    const candidates = ambiguous[letter];
    if (candidates) {
      const now = new Date();
      let bestMonth = candidates[0];
      let bestDiff = Infinity;
      for (const m of candidates) {
        const d = new Date(year, m - 1, day);
        const diff = Math.abs(d.getTime() - now.getTime());
        if (diff < bestDiff) { bestDiff = diff; bestMonth = m; }
      }
      return year + '-' + String(bestMonth).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }
  }
  return '';
}

/**
 * Derive the "last published" boundary for the inkstone daily chain.
 *
 * Rules (from hard-won experience with publish-now cascades):
 *  - Chapters dated strictly BEFORE today are published → they anchor the chain.
 *  - Empty-date rows are published-now chapters (publish wipes the date).
 *  - A publish-now front that CONTIGUOUSLY follows the highest dated-past chapter
 *    advances the anchor to today (Ch 96-100 published-now after Ch 95 → next is
 *    tomorrow). But an isolated empty-date row above dated rows (Ch 106 published
 *    early while 101-105 are still queued) must NOT move the anchor — the remaining
 *    chain still continues from the last dated chapter (Ch 100 = 08-11).
 *  - Today-scheduled chapters (dated == today) are NOT published yet — never anchor.
 * @returns {anchor, boundary} anchor = YYYY-MM-DD, boundary = highest published chapter number
 */
export function deriveInkstoneAnchor(
  scheduled: ScheduledChapter[],
  today?: string
): { anchor: string; boundary: number; highestDated: number } {
  const todayIso = today ?? new Date().toISOString().slice(0, 10);
  const datedPast = [...scheduled]
    .filter(c => c.date && inkstoneDateToIso(c.date).slice(0, 10) < todayIso)
    .sort((a, b) => b.chapter_number - a.chapter_number);
  const emptyRows = scheduled.filter(c => !c.date);
  const boundary = Math.max(0, ...scheduled.map(c => c.chapter_number));
  const highestDated = datedPast[0]?.chapter_number ?? 0;
  const highestDatedRow = datedPast[0];
  if (!highestDatedRow) {
    // ponytail: no dated-past rows — a pure-future schedule (e.g. Patreon's). The chain
    // starts at the FIRST future-scheduled chapter, so anchor = first date - 1 day. Mirrors
    // the runner (executeResequence inkScheduleCb); without this, auditSequence baselines
    // at tomorrow and flags every future chapter as a +1-day mismatch.
    const futureDated = [...scheduled]
      .filter(c => c.date)
      .sort((a, b) => a.chapter_number - b.chapter_number);
    const firstDate = futureDated[0] ? inkstoneDateToIso(futureDated[0].date).slice(0, 10) : '';
    if (firstDate) {
      return {
        anchor: new Date(new Date(firstDate).getTime() - 86400000).toISOString().slice(0, 10),
        boundary,
        highestDated,
      };
    }
    // nothing published-with-a-date yet: treat empty (published-now) rows as today's
    return { anchor: emptyRows.length ? todayIso : todayIso, boundary, highestDated };
  }
  // does an empty-date run directly continue from the highest dated-past chapter?
  let n = highestDatedRow.chapter_number + 1;
  const emptySet = new Set(emptyRows.map(c => c.chapter_number));
  let advanced = false;
  while (emptySet.has(n)) { advanced = true; n++; }
  const anchor = advanced ? todayIso : inkstoneDateToIso(highestDatedRow.date).slice(0, 10);
  return { anchor, boundary, highestDated };
}

export function computeExpectedSchedule(
  scheduled: { chapter_number: number; title?: string }[],
  baselineDate: string,
  chaptersPerDay: number,
  basePublishTime: string,
  timezone: string = 'UTC'
): { chapter_number: number; expected_date: string }[] {
  if (scheduled.length === 0) return [];
  const [hours, minutes] = basePublishTime.split(':').map(Number);
  const results: { chapter_number: number; expected_date: string }[] = [];
  let currentDate = new Date(baselineDate);
  // ponytail: never propose past dates — Inkstone rejects "please choose a new release
  // time". Mirrors calculatePublishSchedules' bump-to-now so audits don't loop on failures.
  const now = new Date();
  const dateOnly = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  if (currentDate.toISOString().slice(0, 10) < dateOnly.toISOString().slice(0, 10)) {
    currentDate = new Date(now);
  }
  const offsetMs = getTZOffset(currentDate, timezone);
  const localMin = hours * 60 + minutes;
  const utcMin = localMin - offsetMs / 60000;
  const utcH = ((Math.floor(utcMin / 60)) % 24 + 24) % 24;
  const utcM = ((utcMin % 60) + 60) % 60;
  currentDate.setUTCHours(utcH, utcM, 0, 0);
  let chaptersOnCurrentDay = 1;
  let lastChapterNum = scheduled[0].chapter_number;
  results.push({ chapter_number: lastChapterNum, expected_date: currentDate.toISOString() });

  for (let i = 1; i < scheduled.length; i++) {
    const ch = scheduled[i];
    const gap = ch.chapter_number - lastChapterNum - 1;

    for (let g = 0; g < gap; g++) {
      chaptersOnCurrentDay++;
      if (chaptersOnCurrentDay > chaptersPerDay) {
        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        chaptersOnCurrentDay = 1;
      }
    }

    chaptersOnCurrentDay++;
    if (chaptersOnCurrentDay > chaptersPerDay) {
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
      chaptersOnCurrentDay = 1;
    }

    results.push({ chapter_number: ch.chapter_number, expected_date: currentDate.toISOString() });
    lastChapterNum = ch.chapter_number;
  }
  return results;
}

export function auditSequence(
  platform: string,
  scheduled: ScheduledChapter[],
  chaptersPerDay?: number,
  basePublishTime?: string,
  timezone?: string,
  anchorDate?: string
): SequenceAudit {
  const audit: SequenceAudit = { ok: true, platform, mismatches: [], missing: [], duplicates: [] };

  const seen = new Set<number>();
  for (const ch of scheduled) {
    if (seen.has(ch.chapter_number)) audit.duplicates.push(ch.chapter_number);
    seen.add(ch.chapter_number);
  }

  // ponytail: audit by integer "base" (Math.floor) so chapters split into decimal
  // sub-parts (25.1, 25.2) count as "25 present" instead of showing as missing.
  const bases = new Set<number>();
  for (const n of seen) bases.add(Math.floor(n));
  const baseSorted = [...bases].sort((a, b) => a - b);
  if (baseSorted.length >= 2) {
    for (let i = baseSorted[0]; i < baseSorted[baseSorted.length - 1]; i++) {
      if (!bases.has(i)) audit.missing.push(i);
    }
  }

  // Date alignment check — only for future-scheduled chapters
  // ponytail: chapters dated today-or-later are still scheduled (not yet published) and
  // are audited against the daily chain, even when their number sits below the published
  // boundary — the platform publishes out of order (Ch 106 went live while 101-105 queued).
  // Published chapters carry no date (a "publish now" wipes it and the scraper merges them
  // as empty-date rows), so they drop out of the audit entirely — which also stops the
  // cascade where Ch N+1 kept getting re-flagged "due today" after Ch N was published now.
  const today = new Date().toISOString().slice(0, 10);
  const { anchor: derivedAnchor, highestDated } = deriveInkstoneAnchor(scheduled, today);
  // ponytail: audit chapters dated today-or-later — they are still scheduled. A chapter
  // dated today is the next one to publish; one dated later is queued. Published chapters
  // (empty date or date in the past) drop out, so the chain never re-targets them.
  const sorted = [...scheduled]
    .filter(c => c.date && inkstoneDateToIso(c.date).slice(0, 10) >= today)
    .sort((a, b) => a.chapter_number - b.chapter_number);
  // ponytail: normalize inkstone truncated dates to ISO before comparison
  const normalized = sorted.map(c => ({ ...c, date: inkstoneDateToIso(c.date || '') }));
  if (sorted.length >= 1 && chaptersPerDay && basePublishTime) {
    // ponytail: a far-future derived anchor is a red flag — it means the chain was built
    // off one corrupted row (e.g. Ch 68 = 2027-02-02) with no genuinely published
    // (dated-past) anchor to ground it. Never let that override a sane tracker-derived
    // anchorDate; the audit must flag the corrupt row itself, not cascade its date forward.
    const effectiveAnchor = highestDated > 0 && derivedAnchor && (!anchorDate || derivedAnchor > anchorDate)
      ? derivedAnchor
      : anchorDate;
    const baseline = effectiveAnchor
      ? new Date(new Date(effectiveAnchor).getTime() + 86400000).toISOString()
      : normalized[0].date;
    if (baseline) {
      // ponytail: a row dated beyond what a dense chain of the present rows could reach
      // from the baseline is corrupt (e.g. Ch 68 = 2027-02-02 amid an 08-17 chain). Exclude
      // it from the expected-chain so its phantom gap can't shift the correct tail (run-2
      // cascade), and flag it on its own.
      const maxNum = Math.max(...normalized.map(n => n.chapter_number));
      const minNum = Math.min(...normalized.map(n => n.chapter_number));
      const maxChainMs = new Date(baseline).getTime() + (maxNum - minNum) * 86400000;
      const outlierNums = new Set(normalized.filter(n => new Date(n.date).getTime() > maxChainMs).map(n => n.chapter_number));
      const chainRows = normalized.filter(n => !outlierNums.has(n.chapter_number));

      for (const o of normalized) {
        if (!outlierNums.has(o.chapter_number)) continue;
        audit.mismatches.push({ chapter_number: o.chapter_number, actual_date: o.date, expected_date: baseline });
      }

      if (chainRows.length >= 1) {
        const expected = computeExpectedSchedule(chainRows, baseline, chaptersPerDay, basePublishTime, timezone);
        const expectedMap = new Map(expected.map(e => [e.chapter_number, e.expected_date]));
        for (const ch of sorted) {
          if (outlierNums.has(ch.chapter_number)) continue;
          const nc = chainRows.find(n => n.chapter_number === ch.chapter_number);
          const exp = expectedMap.get(ch.chapter_number);
          const actualDate = nc?.date?.slice(0, 10);
          const expDate = exp?.slice(0, 10);
          if (!exp || actualDate === expDate) continue;
          // ponytail: skip already-published chapters (date <= today)
          if (nc?.date && nc.date.slice(0, 10) <= today) continue;
          audit.mismatches.push({ chapter_number: ch.chapter_number, actual_date: ch.date, expected_date: exp });
        }
      }
    }
  }

  audit.ok = audit.missing.length === 0 && audit.duplicates.length === 0 && audit.mismatches.length === 0;
  return audit;
}

/**
 * Identify gaps in chapter sequence and return chapters needed to fill them
 * @param publishedChapters Array of already published chapter numbers
 * @param localChapters Array of chapter numbers available in local storage
 * @param maxChapter The highest chapter number to check up to
 * @returns Array of chapter numbers that are missing from published but available locally
 */
export function findGapsToFill(
  publishedChapters: number[],
  localChapters: number[],
  maxChapter: number
): number[] {
  const publishedSet = new Set(publishedChapters);
  const localSet = new Set(localChapters);
  // ponytail: track by integer base so decimal sub-parts (25.1, 25.2) count as
  // "chapter 25 present" and don't generate spurious gaps.
  const publishedBase = new Set<number>();
  const localBase = new Set<number>();
  for (const n of publishedSet) publishedBase.add(Math.floor(n));
  for (const n of localSet) localBase.add(Math.floor(n));
  const gaps: number[] = [];

  // Check each chapter from 1 to maxChapter
  for (let ch = 1; ch <= maxChapter; ch++) {
    // Chapter is missing from published but exists locally
    if (!publishedBase.has(ch) && localBase.has(ch)) {
      gaps.push(ch);
    }
  }

  return gaps;
}

/**
 * Chapters verified sequential on a platform, starting from Ch 1.
 * A broken/partial scrape that misses early chapters yields [] (never wrongly
 * protects high chapters). Consumed by cleanup/backfill as the never-delete set.
 */
export function computeProtectedPrefix(numbers: number[]): number[] {
  const set = new Set(numbers);
  const prefix: number[] = [];
  for (let n = 1; set.has(n); n++) prefix.push(n);
  return prefix;
}

/**
 * Detect gaps in a schedule and compute a backfill plan.
 * Returns which existing scheduled chapters need to be deleted,
 * and what the new complete schedule should look like.
 * @param lastPublished - the last published chapter number on this platform
 */
export function computeBackfillPlan(
  existingScheduled: { chapter_number: number; date: string | null; edit_url?: string }[],
  newChapters: { chapter_number: number; title: string }[],
  chaptersPerDay: number,
  basePublishTime: string,
  lastPublished: number = 0,
  timezone: string = 'UTC',
  protectedSet?: Set<number>
): {
  needsBackfill: boolean;
  chaptersToDelete: { chapter_number: number; edit_url?: string }[];
  newSchedule: { chapter_number: number; title: string; scheduled_date: string }[];
  deletedDates: string[];
} {
  const chaptersToDelete: { chapter_number: number; edit_url?: string }[] = [];
  const deletedDates: string[] = [];
  const newSchedule: { chapter_number: number; title: string; scheduled_date: string }[] = [];

  const existingSorted = [...existingScheduled].filter(c => c.date).sort((a, b) => a.chapter_number - b.chapter_number);
  const newSet = new Set(newChapters.map(c => c.chapter_number));
  const deletedSet = new Set<number>();

  if (existingSorted.length === 0) return { needsBackfill: false, chaptersToDelete, newSchedule, deletedDates };

  // Check 1: gap between lastPublished and the first scheduled chapter
  // If published up to Ch 10 and first scheduled is Ch 15, there's a gap at 11-14
  const firstScheduled = existingSorted[0].chapter_number;
  // ponytail: with lastPublished=0 the baseline is unknown (Patreon scraper never reports
  // published), so mass-deleting the whole schedule based on it is reckless. Interior gaps
  // are still caught by Check 2.
  if (lastPublished > 0 && firstScheduled > lastPublished + 1) {
    let found = false;
    for (let cn = lastPublished + 1; cn < firstScheduled; cn++) {
      if (newSet.has(cn)) { found = true; break; }
    }
    if (found) {
      // All current scheduled chapters need to be moved to make room for the gap fillers.
      // ponytail: never delete verified-sequential (protected) chapters.
      for (const d of existingSorted) {
        if (deletedSet.has(d.chapter_number)) continue;
        if (protectedSet?.has(d.chapter_number)) continue;
        if (d.date) deletedDates.push(d.date);
        chaptersToDelete.push({ chapter_number: d.chapter_number, edit_url: d.edit_url });
        deletedSet.add(d.chapter_number);
      }
    }
  }

  // Check 2: gap BETWEEN consecutive scheduled chapters (only if Check 1 didn't already trigger)
  if (chaptersToDelete.length === 0) {
    for (let i = 0; i < existingSorted.length - 1; i++) {
      const current = existingSorted[i];
      const next = existingSorted[i + 1];
      if (next.chapter_number - current.chapter_number > 1) {
        let found = false;
        for (let cn = current.chapter_number + 1; cn < next.chapter_number; cn++) {
          if (newSet.has(cn)) { found = true; break; }
        }
        if (found) {
          const toDelete = existingSorted.filter(c => c.chapter_number >= next.chapter_number);
          for (const d of toDelete) {
            if (deletedSet.has(d.chapter_number)) continue;
            if (protectedSet?.has(d.chapter_number)) continue;
            if (d.date) deletedDates.push(d.date);
            chaptersToDelete.push({ chapter_number: d.chapter_number, edit_url: d.edit_url });
            deletedSet.add(d.chapter_number);
          }
          break; // only handle the earliest gap
        }
      }
    }
  }

  if (chaptersToDelete.length === 0) return { needsBackfill: false, chaptersToDelete, newSchedule, deletedDates };

  // Build new schedule: all chapters in correct order, starting from the earliest date
  const baselineDate = existingSorted[0].date!;

  // Collect all chapters that need scheduling (new + existing that weren't deleted)
  const deletedNums = new Set(chaptersToDelete.map(c => c.chapter_number));
  const allToSchedule = [
    ...existingSorted.filter(c => !deletedNums.has(c.chapter_number)).map(c => ({ chapter_number: c.chapter_number, title: `Chapter ${c.chapter_number}` })),
    ...newChapters
  ].sort((a, b) => a.chapter_number - b.chapter_number);

  const computed = calculatePublishSchedules(allToSchedule, baselineDate, chaptersPerDay, basePublishTime, timezone);
  for (const s of computed) {
    newSchedule.push({ chapter_number: s.chapter_number, title: s.title, scheduled_date: s.publish_date });
  }

  return {
    needsBackfill: chaptersToDelete.length > 0,
    chaptersToDelete,
    newSchedule,
    deletedDates,
  };
}
