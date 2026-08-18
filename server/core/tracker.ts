/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { PublishTracker, ScheduledChapter } from './models';
import logger from './logger';
import { WORKSPACE_ROOT } from './config';

const trackerQueues = new Map<string, { promise: Promise<void>; resolve: () => void }[]>();

// ponytail: synchronous per-slug critical-section guard so saveTrackerAtomic
// is serialized the same way as the async lock. Single-slot queue; writes are
// fast/sync so this won't stall. Bump to per-slug mutex with timeout if it ever does.
const syncLockQueues = new Map<string, Array<() => void>>();

function runWithSyncLock(slug: string, fn: () => void): void {
  const q = syncLockQueues.get(slug);
  if (q && q.length > 0) {
    q.push(() => {
      try { fn(); } finally { releaseSyncLock(slug); }
    });
    return;
  }
  syncLockQueues.set(slug, []);
  try { fn(); } finally { releaseSyncLock(slug); }
}

function releaseSyncLock(slug: string): void {
  const q = syncLockQueues.get(slug);
  if (!q) return;
  q.shift();
  if (q.length === 0) syncLockQueues.delete(slug);
  else q[0]();
}

async function withTrackerLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = trackerQueues.get(slug)?.at(-1)?.promise;
  let resolve!: (v: void) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<void>((r, rj) => { resolve = r; reject = rj; });
  const entry = { promise: p, resolve };
  const list = trackerQueues.get(slug) || [];
  list.push(entry);
  trackerQueues.set(slug, list);
  if (prev) await prev;
  try {
    return await fn();
  } catch (e) {
    reject(e);
    throw e;
  } finally {
    const remaining = (trackerQueues.get(slug) || []).filter(e => e.resolve !== resolve);
    if (remaining.length > 0) trackerQueues.set(slug, remaining);
    else trackerQueues.delete(slug);
    resolve();
  }
}

// ponytail: tolerate a UTF-8 BOM — some editors/tools prepend it and JSON.parse
// rejects it, which made every load fall back to a stale backup in a loop.
const stripBom = (s: string): string => s.replace(/^\uFEFF/, '');

export function mergeProtected(existing: number[] | undefined, fresh: number[] | undefined): number[] {
  return [...new Set([...(existing || []), ...(fresh || [])])].sort((a, b) => a - b);
}

export function getTrackerPath(novelSlug: string): string {
  // ponytail: use the same WORKSPACE_ROOT as config.ts so tracker + config + chapters
  // always live under one root (no silent state loss on Electron/custom deploys).
  return path.join(WORKSPACE_ROOT, novelSlug, 'logs', 'publish_tracker.json');
}

export function createDefaultTracker(): PublishTracker {
  return {
    webnovel_last: 0,
    patreon_last: 0,
    kofi_last: 0,
    patreon_published_count: 0,
    inkstone_scheduled_count: 0,
    patreon_scheduled_count: 0,
    next_schedule_date: null,
    execution_status: 'idle',
    last_scraped_at: null,
    last_run_logs: [],
    local_sequence: null,
    patreon_sequence: null,
    inkstone_sequence: null,
    inkstone_scheduled: [],
    patreon_scheduled: [],
    kofi_scheduled: [],
    progress: null,
    failed_publishes: [],
    inkstone_latest_scheduled: null,
    patreon_latest_scheduled: null,
    protected: [],
  };
}

export function loadTracker(novelSlug: string): PublishTracker {
  const filePath = getTrackerPath(novelSlug);
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const defaultTracker = createDefaultTracker();
    saveTrackerAtomic(novelSlug, defaultTracker);
    return defaultTracker;
  }

  try {
    const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
    const parsed = JSON.parse(raw) as PublishTracker;
    const merged = { ...createDefaultTracker(), ...parsed };
    merged.inkstone_scheduled ??= [];
    merged.patreon_scheduled ??= [];
    merged.kofi_scheduled ??= [];
    merged.failed_publishes ??= [];
    merged.protected ??= [];
    return merged;
  } catch (error) {
    logger.error(`Failed to load tracker for ${novelSlug}, attempting restore from backup...`);
    const logDir = path.dirname(filePath);
    if (fs.existsSync(logDir)) {
      const files = fs.readdirSync(logDir);
      const bakFiles = files
        .filter((f) => f.startsWith('publish_tracker_') && f.endsWith('.bak'))
        .sort()
        .reverse();

      if (bakFiles.length > 0) {
        try {
          const bakPath = path.join(logDir, bakFiles[0]);
          const rawBak = stripBom(fs.readFileSync(bakPath, 'utf8'));
          const parsedBak = JSON.parse(rawBak) as PublishTracker;
          parsedBak.inkstone_scheduled ??= [];
          parsedBak.patreon_scheduled ??= [];
          parsedBak.kofi_scheduled ??= [];
          parsedBak.protected ??= [];
          logger.info(`Successfully restored tracker from backup: ${bakFiles[0]}`);
          return parsedBak;
        } catch (restoreError) {
          logger.error('Failed to restore from backup:', restoreError);
        }
      }
    }
    logger.error(`Tracker data for ${novelSlug} is corrupt and no valid backup found. Returning blank tracker.`);
    return createDefaultTracker();
  }
}

/**
 * Async version of loadTracker for use in async route handlers.
 */
export async function loadTrackerAsync(novelSlug: string): Promise<PublishTracker> {
  const filePath = getTrackerPath(novelSlug);
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const defaultTracker = createDefaultTracker();
    await saveTrackerAtomicAsync(novelSlug, defaultTracker);
    return defaultTracker;
  }

  try {
    const raw = stripBom(await fs.promises.readFile(filePath, 'utf8'));
    const parsed = JSON.parse(raw) as PublishTracker;
    const merged = { ...createDefaultTracker(), ...parsed };
    merged.inkstone_scheduled ??= [];
    merged.patreon_scheduled ??= [];
    merged.kofi_scheduled ??= [];
    merged.failed_publishes ??= [];
    merged.protected ??= [];
    return merged;
  } catch (error) {
    logger.error(`Failed to load tracker for ${novelSlug}, attempting restore from backup...`);
    const logDir = path.dirname(filePath);
    try {
      const files = await fs.promises.readdir(logDir);
      const bakFiles = files
        .filter((f) => f.startsWith('publish_tracker_') && f.endsWith('.bak'))
        .sort()
        .reverse();

      if (bakFiles.length > 0) {
        const rawBak = stripBom(await fs.promises.readFile(path.join(logDir, bakFiles[0]), 'utf8'));
        const parsedBak = JSON.parse(rawBak) as PublishTracker;
        parsedBak.inkstone_scheduled ??= [];
        parsedBak.patreon_scheduled ??= [];
        logger.info(`Restored tracker from backup: ${bakFiles[0]}`);
        return parsedBak;
      }
    } catch {}
    return createDefaultTracker();
  }
}

export function validateTracker(tracker: any): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof tracker !== 'object' || tracker === null) return { ok: false, errors: ['Tracker must be an object'] };
  if (tracker.webnovel_last !== undefined && (typeof tracker.webnovel_last !== 'number' || tracker.webnovel_last < 0)) errors.push('webnovel_last must be a non-negative number');
  if (tracker.patreon_last !== undefined && (typeof tracker.patreon_last !== 'number' || tracker.patreon_last < 0)) errors.push('patreon_last must be a non-negative number');
  if (tracker.inkstone_scheduled_count !== undefined && (typeof tracker.inkstone_scheduled_count !== 'number' || tracker.inkstone_scheduled_count < 0)) errors.push('inkstone_scheduled_count must be a non-negative number');
  if (tracker.patreon_scheduled_count !== undefined && (typeof tracker.patreon_scheduled_count !== 'number' || tracker.patreon_scheduled_count < 0)) errors.push('patreon_scheduled_count must be a non-negative number');
  if (tracker.execution_status !== undefined && !['idle', 'running', 'failed'].includes(tracker.execution_status)) errors.push('execution_status must be idle, running, or failed');
  if (tracker.inkstone_scheduled !== undefined && !Array.isArray(tracker.inkstone_scheduled)) errors.push('inkstone_scheduled must be an array');
  if (tracker.patreon_scheduled !== undefined && !Array.isArray(tracker.patreon_scheduled)) errors.push('patreon_scheduled must be an array');
  return { ok: errors.length === 0, errors };
}

export function saveTrackerAtomic(novelSlug: string, tracker: PublishTracker): void {
  runWithSyncLock(novelSlug, () => {
    const validation = validateTracker(tracker);
    if (!validation.ok) {
      logger.error(`[Tracker] Validation failed for ${novelSlug}: ${validation.errors.join('; ')}`);
      throw new Error(`Tracker validation failed: ${validation.errors.join('; ')}`);
    }
    const filePath = getTrackerPath(novelSlug);
    const logDir = path.dirname(filePath);

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    if (fs.existsSync(filePath)) {
      try {
        const timestamp = Date.now();
        const bakPath = path.join(logDir, `publish_tracker_${timestamp}.bak`);
        fs.copyFileSync(filePath, bakPath);

        const files = fs.readdirSync(logDir);
        const baks = files
          .filter((f) => f.startsWith('publish_tracker_') && f.endsWith('.bak'))
          .sort();

        while (baks.length > 5) {
          const oldest = baks.shift();
          if (oldest) fs.unlinkSync(path.join(logDir, oldest));
        }
      } catch (backupErr) {
        logger.error('Failed to create rolling backup:', backupErr);
      }
    }

    const tmpPath = `${filePath}.tmp`;
    try {
      const dataString = JSON.stringify(tracker, null, 2);
      fs.writeFileSync(tmpPath, dataString, 'utf8');
      const fd = fs.openSync(tmpPath, 'r+');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmpPath, filePath);
    } catch (writeError) {
      logger.error('Failed to write tracker atomically:', writeError);
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      throw writeError;
    }
  });
}

/**
 * Async atomic write with mutex protection.
 */
export async function saveTrackerAtomicAsync(novelSlug: string, tracker: PublishTracker): Promise<void> {
  return withTrackerLock(novelSlug, async () => {
    const filePath = getTrackerPath(novelSlug);
    const logDir = path.dirname(filePath);

    if (!fs.existsSync(logDir)) {
      await fs.promises.mkdir(logDir, { recursive: true });
    }

    if (fs.existsSync(filePath)) {
      try {
        const timestamp = Date.now();
        const bakPath = path.join(logDir, `publish_tracker_${timestamp}.bak`);
        await fs.promises.copyFile(filePath, bakPath);

        const files = await fs.promises.readdir(logDir);
        const baks = files
          .filter((f) => f.startsWith('publish_tracker_') && f.endsWith('.bak'))
          .sort();

        while (baks.length > 5) {
          const oldest = baks.shift();
          if (oldest) await fs.promises.unlink(path.join(logDir, oldest));
        }
      } catch (backupErr) {
        logger.error('Failed to create rolling backup:', backupErr);
      }
    }

    const tmpPath = `${filePath}.tmp`;
    try {
      const dataString = JSON.stringify(tracker, null, 2);
      await fs.promises.writeFile(tmpPath, dataString, 'utf8');
      const fd = await fs.promises.open(tmpPath, 'r+');
      await fd.sync();
      await fd.close();
      await fs.promises.rename(tmpPath, filePath);
    } catch (writeError) {
      logger.error('Failed to write tracker atomically:', writeError);
      try { await fs.promises.unlink(tmpPath); } catch {}
      throw writeError;
    }
  });
}

export function latestDateFromSchedule(scheduled: ScheduledChapter[] | undefined): string | null {
  const dates = (scheduled ?? []).map(c => c.date).filter((d): d is string => !!d).sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

export function computeLeadDays(tracker: PublishTracker, config?: { patreon_enabled: boolean; kofi_enabled?: boolean }): number {
  // ponytail: When Patreon is disabled, use Ko-fi as the lead platform.
  // The lead is measured in CHAPTERS, not days: target_lead (default 20) = the number of
  // chapters the lead platform runs ahead of the webnovel. Don't compute a date diff — that
  // double counted the -20 published-date offset and inflated the lead. Use only the PUBLISHED
  // position (_last), never scheduled-ahead chapters: those future posts are the replenishing
  // buffer and counting them makes the lead look like it exceeds target when it doesn't.
  const usePatreon = !config || config.patreon_enabled;
  const useKofi = config?.kofi_enabled && !config?.patreon_enabled;

  const leadLast = usePatreon ? (tracker.patreon_last || 0) : (useKofi ? (tracker.kofi_last || 0) : 0);
  if (leadLast > 0 && tracker.webnovel_last > 0) {
    return Math.max(0, leadLast - tracker.webnovel_last);
  }
  return 0;
}

function loadLatestBackup(slug: string): PublishTracker | null {
  const logDir = path.join(WORKSPACE_ROOT, slug, 'logs');
  if (!fs.existsSync(logDir)) return null;
  try {
    const files = fs.readdirSync(logDir)
      .filter(f => f.startsWith('publish_tracker_') && f.endsWith('.bak'))
      .sort()
      .reverse();
    for (const f of files) {
      try {
        const data = JSON.parse(stripBom(fs.readFileSync(path.join(logDir, f), 'utf8')));
        if (data && typeof data.inkstone_scheduled_count === 'number') return data as PublishTracker;
      } catch {}
    }
  } catch {}
  return null;
}

// ponytail: accept a live-scraped _last even when it is LOWER than the current value.
// The old merge only ever took the max, so a tracker inflated by manual edits or a
// legacy count bug could never be corrected back down by a fresh scrape (Assassin Pathway
// was stuck at lead 165 for exactly this reason). Guards: a 0/empty scrape (session
// expired, page failed to load) never zeroes a real count, and a downward correction
// requires the scrape to have actually enumerated published items (published_count > 0).
function mergeLiveLast(incoming: number | undefined, current: number, publishedCount?: number): number {
  if (incoming === undefined) return current;
  if (incoming === 0) return current > 0 ? current : 0;
  if (incoming >= current) return incoming;
  return publishedCount && publishedCount > 0 ? incoming : current;
}

export function mergeTrackerStates(
  novelSlug: string,
  liveScrapedState: Partial<PublishTracker> & {
    webnovel_published_count?: number;
    kofi_published_count?: number;
  }
): PublishTracker {
  const current = loadTracker(novelSlug);

  // ponytail: detect if inkstone API failed (0 count + all-scheduled-items-from-catalog)
  // or session expiry (0 count + empty array when tracker has existing scheduled chapters)
  const newScheduledCount = liveScrapedState.inkstone_scheduled_count;
  const incScheduled = liveScrapedState.inkstone_scheduled ?? [];
  const apiLikelyFailed = newScheduledCount === 0 &&
    (incScheduled.length > 0 && incScheduled.every(c => !c.date && !c.edit_url) ||
     incScheduled.length === 0 && current.inkstone_scheduled_count > 0);

  const newPatScheduledCount = liveScrapedState.patreon_scheduled_count;
  const patScheduled = liveScrapedState.patreon_scheduled ?? [];
  const patApiLikelyFailed = newPatScheduledCount === 0 &&
    patScheduled.length === 0 && current.patreon_scheduled_count > 0;

  const merged: PublishTracker = {
    ...current,
    ...liveScrapedState,
    webnovel_last: mergeLiveLast(liveScrapedState.webnovel_last, current.webnovel_last, liveScrapedState.webnovel_published_count),
    patreon_last: mergeLiveLast(liveScrapedState.patreon_last, current.patreon_last, liveScrapedState.patreon_published_count),
    kofi_last: mergeLiveLast(liveScrapedState.kofi_last, current.kofi_last ?? 0, liveScrapedState.kofi_published_count),
    patreon_published_count: liveScrapedState.patreon_published_count ?? current.patreon_published_count,
    inkstone_scheduled_count: newScheduledCount !== undefined
      ? (newScheduledCount === 0
        ? (current.inkstone_scheduled_count > 0
          ? current.inkstone_scheduled_count
          : (apiLikelyFailed ? (loadLatestBackup(novelSlug)?.inkstone_scheduled_count ?? 0) : 0))
        : newScheduledCount)
      : current.inkstone_scheduled_count,
    patreon_scheduled_count: newPatScheduledCount !== undefined
      ? (newPatScheduledCount === 0
        ? (current.patreon_scheduled_count > 0
          ? current.patreon_scheduled_count
          : (patApiLikelyFailed ? (loadLatestBackup(novelSlug)?.patreon_scheduled_count ?? 0) : 0))
        : newPatScheduledCount)
      : current.patreon_scheduled_count,
    inkstone_latest_scheduled: null,
    patreon_latest_scheduled: null,
    next_schedule_date: liveScrapedState.next_schedule_date ?? current.next_schedule_date,
    last_scraped_at: liveScrapedState.last_scraped_at || current.last_scraped_at,
    inkstone_scheduled: liveScrapedState.inkstone_scheduled !== undefined
      ? (apiLikelyFailed
        ? current.inkstone_scheduled ?? []
        : liveScrapedState.inkstone_scheduled.map(newCh => {
            const existingCh = current.inkstone_scheduled?.find(c => c.chapter_number === newCh.chapter_number);
            return existingCh && (!newCh.date || newCh.date === '') ? existingCh : newCh;
          }))
      : current.inkstone_scheduled ?? [],
    patreon_scheduled: liveScrapedState.patreon_scheduled !== undefined
      ? (patApiLikelyFailed
        ? current.patreon_scheduled ?? []
        : liveScrapedState.patreon_scheduled.map(newCh => {
            const existingCh = current.patreon_scheduled?.find(c => c.chapter_number === newCh.chapter_number);
            return existingCh && (!newCh.date || newCh.date === '') ? existingCh : newCh;
          }))
      : current.patreon_scheduled ?? [],
    // ponytail: Ko-fi schedule API can return a partial window — UNION with the cached
    // schedule instead of replacing, so previously-known scheduled chapters are never dropped.
    kofi_scheduled: liveScrapedState.kofi_scheduled !== undefined
      ? (() => {
          const map = new Map<number, ScheduledChapter>();
          for (const c of (current.kofi_scheduled ?? [])) map.set(c.chapter_number, c);
          for (const c of liveScrapedState.kofi_scheduled ?? []) map.set(c.chapter_number, c);
          return [...map.values()].sort((a, b) => a.chapter_number - b.chapter_number);
        })()
      : current.kofi_scheduled ?? [],
  };

  const staleWarnings: string[] = [];
  const warnOnLast = (label: string, incoming: number | undefined, current: number, effective: number) => {
    if (incoming === undefined || incoming >= current || incoming === effective) return;
    staleWarnings.push(`${label} scraper reported ${incoming} but tracker has ${current}. Kept tracker value.`);
  };
  warnOnLast('Patreon', liveScrapedState.patreon_last, current.patreon_last, merged.patreon_last);
  warnOnLast('Webnovel', liveScrapedState.webnovel_last, current.webnovel_last, merged.webnovel_last);
  warnOnLast('Ko-fi', liveScrapedState.kofi_last, current.kofi_last ?? 0, merged.kofi_last ?? 0);
  const allLogs: string[] = staleWarnings.length > 0
    ? [`[${new Date().toISOString()}] ${staleWarnings.join('; ')}`, ...merged.last_run_logs]
    : [`[${new Date().toISOString()}] State sync completed. Webnovel: ${current.webnovel_last} -> ${merged.webnovel_last}, Patreon: ${current.patreon_last} -> ${merged.patreon_last}`, ...merged.last_run_logs];
  merged.last_run_logs = allLogs.slice(0, 50);

  saveTrackerAtomic(novelSlug, merged);
  return merged;
}
