/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { scanChaptersDirectory } from './parser';
import { computeSequence, fetchLatestPublishedPublishDate } from './webnovel_public';
import { loadTracker, saveTrackerAtomic, mergeTrackerStates, latestDateFromSchedule, computeLeadDays, mergeProtected } from './tracker';
import { loadNovelConfig, ensureWorkspaceDirectories, WORKSPACE_ROOT } from './config';
import { InkstoneScraper } from '../adapters/inkstone_scraper';
import { getCbid, apiFetchDraftCcids, renewInkstoneSession } from '../adapters/inkstone_api';
import { PatreonSync } from '../adapters/patreon_sync';
import { KofiSync } from '../adapters/kofi_sync';
import { lockFile, unlockFile } from './locking';
import { calculatePublishSchedules, computeNextSchedule, getTZOffset } from './scheduler';
import { auditSequence, findGapsToFill, computeBackfillPlan, computeExpectedSchedule, deriveInkstoneAnchor, inkstoneDateToIso, computeProtectedPrefix } from './sequencer';
import { PublishTracker, ProgressInfo } from './models';
import { logEventBus } from '../api/log_events';
import { classifyError } from './error_codes';
import { SessionLog } from './session_log';
import { notifyFromEnv } from './notifications';
import { platformConnector } from './platform_connector';
import { applyStealthToContext } from './stealth';
import { platformHasCookies } from './credential_manager';
import { SHARED_DIR } from './config';
import logger from './logger';
import * as path from 'path';
import * as fs from 'fs';

const MAX_AUTOMATION_TIMEOUT_MS = 180 * 60 * 1000; // ponytail: bulk backfill ~42s/delete for 192 chapters needs ~134 min, plus fill/publish

// ponytail: Ko-fi/Patreon schedule THIS many days EARLIER than the webnovel date of the SAME
// chapter. With the webnovel publishing ~1/day this also keeps the lead platform ~20 chapters
// ahead of the published webnovel. Fixed per product decision.
const KOFI_WN_LEAD_DAYS = -20;

/**
 * Lead platform (Ko-fi/Patreon) date for a chapter: anchor to the webnovel date of the SAME
 * chapter and publish KOFI_WN_LEAD_DAYS earlier (e.g. ko-fi ch 356 = webnovel ch 356 date
 * minus 20 days), so the platform runs 20 days ahead of the webnovel's own chapter date.
 * Fall back to the platform's own last date (and ultimately now) when webnovel has no date yet.
 * Returned as a full ISO datetime so base_publish_time + timezone math stays correct.
 */
/**
 * Apply basePublishTime (in the given timezone) to a calendar date, as a full ISO datetime.
 * Unlike calculatePublishSchedules this does NOT clamp in-the-past dates to "now" — the lead
 * anchor may point at today or a recent date and must be returned as-is.
 */
/**
 * Inkstone scheduling baseline, guaranteed to be at least tomorrow at base_publish_time.
 * Inkstone chapters are ONLY ever scheduled (never published live) — live-publishing past
 * the lead target broke the 20-chapter lead (run3 / the 100-109 accident).
 */
function inkstoneBaseline(
  tracker: PublishTracker,
  config: { chapters_per_day?: number; base_publish_time?: string; timezone?: string }
): string {
  const computed = computeNextSchedule(
    (tracker.inkstone_scheduled ?? []).map(s => inkstoneDateToIso(s.date)).filter((d): d is string => !!d),
    config.chapters_per_day ?? 1, config.base_publish_time, config.timezone
  );
  const tomorrow = atBasePublishTime(new Date(Date.now() + 86400000), config.base_publish_time || '12:00', config.timezone || 'UTC');
  if (!computed) return tomorrow;
  return new Date(computed).getTime() >= new Date(tomorrow).getTime() ? computed : tomorrow;
}

function atBasePublishTime(date: Date, basePublishTime: string, timezone: string): string {
  const d = new Date(date.getTime());
  const [hours, minutes] = basePublishTime.split(':').map(Number);
  const offsetMs = getTZOffset(d, timezone);
  const localMin = hours * 60 + minutes;
  const utcMin = localMin - offsetMs / 60000;
  const utcH = ((Math.floor(utcMin / 60)) % 24 + 24) % 24;
  const utcM = ((utcMin % 60) + 60) % 60;
  d.setUTCHours(utcH, utcM, 0, 0);
  return d.toISOString();
}

function leadPublishDate(
  tracker: PublishTracker,
  config: { chapters_per_day?: number; base_publish_time?: string; timezone?: string },
  chapterNumber: number,
  ownScheduled: { date?: string | null; chapter_number?: number }[]
): string {
  const ink = (tracker.inkstone_scheduled || []).find(s => s.chapter_number === chapterNumber);
  if (ink?.date) {
    const d = new Date(ink.date);
    if (!isNaN(d.getTime())) {
      d.setDate(d.getDate() + KOFI_WN_LEAD_DAYS);
      // ponytail: the 20-day lead may already have passed (inkstone scheduled the chapter
      // too close to today). Never schedule into the past — platforms reject past dates and
      // the audit skips past-due leads anyway. Fall through to the platform's own chain.
      if (d.toISOString().slice(0, 10) >= new Date().toISOString().slice(0, 10)) {
        return atBasePublishTime(d, config.base_publish_time || '12:00', config.timezone || 'UTC');
      }
    }
  }
  const nextDate = computeNextSchedule(ownScheduled.map(s => s.date).filter((d): d is string => !!d), config.chapters_per_day || 1, config.base_publish_time || '12:00', config.timezone || 'UTC');
  if (!nextDate) return new Date().toISOString();
  // ponytail: no inkstone reference yet (catch-up). Advance 1 day per chapter past the last
  // scheduled one so a catch-up batch spreads across days instead of piling onto one date.
  const lastSchedCh = Math.max(0, ...(ownScheduled.map(s => s.chapter_number).filter((n): n is number => typeof n === 'number')));
  const advanceDays = Math.max(0, chapterNumber - lastSchedCh - 1);
  const d = new Date(nextDate);
  d.setUTCDate(d.getUTCDate() + advanceDays);
  return d.toISOString();
}

/**
 * ponytail: audit each lead-platform (Patreon/Ko-fi) scheduled chapter against the webnovel
 * reference: this platform's ch C should equal inkstone ch C's date shifted KOFI_WN_LEAD_DAYS
 * earlier (20 days before the webnovel publishes that same chapter). The generic auditSequence
 * never flagged a stale-but-sequential block, so wrong dates stayed forever. Any disagreement
 * is a mismatch to fix.
 */
function auditLeadDates(
  platformScheduled: { chapter_number: number; date: string | null; edit_url?: string }[],
  inkstoneScheduled: { chapter_number: number; date: string | null }[],
  config: { chapters_per_day?: number; base_publish_time?: string; timezone?: string }
): { mismatches: { chapter_number: number; actual_date: string; expected_date: string }[] } {
  const inkByNum = new Map<number, string>();
  for (const s of inkstoneScheduled) {
    if (s.date) {
      const d = new Date(s.date);
      if (!isNaN(d.getTime())) inkByNum.set(s.chapter_number, d.toISOString().slice(0, 10));
    }
  }
  const mismatches: { chapter_number: number; actual_date: string; expected_date: string }[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const c of platformScheduled) {
    const ref = inkByNum.get(c.chapter_number);
    if (!ref || !c.date) continue;
    const refDate = new Date(ref);
    refDate.setDate(refDate.getDate() + KOFI_WN_LEAD_DAYS);
    const expectedStr = atBasePublishTime(refDate, config.base_publish_time || '12:00', config.timezone || 'UTC');
    const expDate = expectedStr.slice(0, 10);
    const actDate = String(c.date).slice(0, 10);
    if (actDate === expDate) continue;
    if (actDate <= today) continue; // don't reschedule already-published
    if (expDate < today) continue; // ponytail: correct lead date strictly in the past — can't fix, skip. "today" is still a valid target.
    mismatches.push({ chapter_number: c.chapter_number, actual_date: c.date || '', expected_date: expectedStr });
  }
  return { mismatches };
}

/** ponytail: Ko-fi replaces the default-platform lead logic when Patreon is disabled. */
function getLeadPlatforms(config: { patreon_enabled: boolean; kofi_enabled?: boolean }): ('patreon' | 'kofi')[] {
  if (config.patreon_enabled) return ['patreon', ...(config.kofi_enabled ? ['kofi' as const] : [])];
  if (config.kofi_enabled) return ['kofi'];
  return [];
}

/**
 * Inkstone fill target — mirror of the Patreon lead catch-up, inverted for the free platform.
 * The lead platform (patreon, or ko-fi as its substitute) runs `target_lead` chapters ahead of
 * inkstone, so inkstone's published position should be `leadLast - target_lead`. When inkstone is
 * behind that target (or its recorded position is stale above it — e.g. webnovel_last=244 while
 * 0 are actually published), the fill plan publishes the missing chapters LIVE to restore the lead.
 */
function computeInkFill(
  tracker: PublishTracker,
  config: { patreon_enabled: boolean; kofi_enabled?: boolean; target_lead?: number },
  leadPlatforms: ('patreon' | 'kofi')[]
): { fillTarget: number; boundary: number; needed: boolean } {
  const leadLast = leadPlatforms.includes('patreon')
    ? (tracker.patreon_last || 0)
    : leadPlatforms.includes('kofi') ? (tracker.kofi_last || 0) : 0;
  const fillTarget = Math.max(0, leadLast - (config.target_lead || 20));
  // webnovel_last counts toward the published boundary only when within the fill target; a value
  // above it is stale (inkstone can't be ahead of the lead model), so the fill starts from the
  // highest scheduled chapter at/below the target (or 0).
  const boundary = Math.max(
    0,
    ...(tracker.inkstone_scheduled ?? []).filter(s => s.chapter_number <= fillTarget).map(s => s.chapter_number),
    tracker.webnovel_last <= fillTarget ? tracker.webnovel_last : 0
  );
  return { fillTarget, boundary, needed: boundary < fillTarget };
}

/**
 * Computes what a Patreon lead catch-up is missing after re-scraping the platform.
 * `missing` = chapters in (prevLast, expectedEnd] that the platform reports as published but
 * are absent from `publishedNums`. `shortfall` = how many chapters short of expectedEnd.
 */
export function computeCatchUpGaps(
  prevLast: number,
  expectedEnd: number,
  actualLast: number,
  publishedNums: number[]
): { missing: number[]; shortfall: number } {
  const publishedSet = new Set(publishedNums);
  const missing: number[] = [];
  for (let n = prevLast + 1; n <= Math.min(expectedEnd, actualLast); n++) {
    if (!publishedSet.has(n)) missing.push(n);
  }
  return { missing, shortfall: Math.max(0, expectedEnd - actualLast) };
}

class RunnerInstance {
  activeRuns = new Map<string, string[]>();
  abortControllers = new Map<string, AbortController>();
  activeContexts = new Map<string, Set<any>>();
  activeProgress = new Map<string, ProgressInfo>();
  pendingDecision: { prompt: string; resolve: (choice: string) => void } | null = null;
  slug: string;

  constructor(slug: string) {
    this.slug = slug;
  }

  getLogs(): string[] {
    return [...(this.activeRuns.get(this.slug) || [])];
  }

  getProgress(): ProgressInfo | null {
    return this.activeProgress.get(this.slug) || null;
  }

  setProgress(current: number, total: number, label: string) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    this.activeProgress.set(this.slug, { current, total, percent: pct, label });
  }

  clearProgress() {
    this.activeProgress.delete(this.slug);
  }

  requestDecision(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.pendingDecision = { prompt, resolve };
      // ponytail: if nobody answers, default to limit-run after 10 minutes so a
      // headless run can't hang forever. Per-run or global timeout upgrade if needed.
      setTimeout(() => {
        if (this.pendingDecision) {
          const r = this.pendingDecision.resolve;
          this.pendingDecision = null;
          r('limit');
        }
      }, 10 * 60 * 1000);
    });
  }

  resolveDecision(choice: string): boolean {
    if (!this.pendingDecision) return false;
    const resolve = this.pendingDecision.resolve;
    this.pendingDecision = null;
    resolve(choice);
    return true;
  }

  getPendingDecision(): string | null {
    return this.pendingDecision?.prompt ?? null;
  }

  abort(): boolean {
    const controller = this.abortControllers.get(this.slug);
    let aborted = false;

    if (controller) {
      controller.abort();
      this.abortControllers.delete(this.slug);
      aborted = true;
    }

    const contexts = this.activeContexts.get(this.slug);
    if (contexts) {
      for (const ctx of contexts) {
        try { ctx.close?.(); } catch {}
      }
      this.activeContexts.delete(this.slug);
    }

    this.activeRuns.delete(this.slug);
    this.pendingDecision = null;
    try {
      const tracker = loadTracker(this.slug);
      if (tracker.execution_status === 'running') {
        tracker.execution_status = 'idle';
        tracker.last_run_logs = [
          ...(tracker.last_run_logs || []),
          `[${new Date().toISOString()}] Automation aborted by user.`,
        ].slice(0, 50);
        saveTrackerAtomic(this.slug, tracker);
      }
    } catch {}

    return aborted;
  }

  registerContext(context: any): void {
    if (!this.activeContexts.has(this.slug)) {
      this.activeContexts.set(this.slug, new Set());
    }
    this.activeContexts.get(this.slug)!.add(context);
  }

  unregisterContext(context: any): void {
    const contexts = this.activeContexts.get(this.slug);
    if (contexts) {
      contexts.delete(context);
      if (contexts.size === 0) this.activeContexts.delete(this.slug);
    }
  }
}

export class AutomationRunner {
  private static instances = new Map<string, RunnerInstance>();
  private static _activeContexts = new Map<string, Set<any>>(); // ponytail: for registerContext/unregisterContext from webnovel_sync

  private static forSlug(slug: string): RunnerInstance {
    if (!this.instances.has(slug)) {
      this.instances.set(slug, new RunnerInstance(slug));
    }
    return this.instances.get(slug)!;
  }

  static getLogs(slug: string): string[] {
    return this.forSlug(slug).getLogs();
  }

  static getProgress(slug: string): ProgressInfo | null {
    return this.forSlug(slug).getProgress();
  }

  static setProgress(slug: string, current: number, total: number, label: string) {
    this.forSlug(slug).setProgress(current, total, label);
  }

  static clearProgress(slug: string) {
    this.forSlug(slug).clearProgress();
  }

  static requestDecision(slug: string, prompt: string): Promise<string> {
    return this.forSlug(slug).requestDecision(prompt);
  }

  static resolveDecision(slug: string, choice: string): boolean {
    return this.forSlug(slug).resolveDecision(choice);
  }

  static getPendingDecision(slug: string): string | null {
    return this.forSlug(slug).getPendingDecision();
  }

  static abort(slug: string): boolean {
    return this.forSlug(slug).abort();
  }

  static resetStuckStatuses(): void {
    if (!fs.existsSync(WORKSPACE_ROOT)) return;

    const novels = fs.readdirSync(WORKSPACE_ROOT);
    for (const slug of novels) {
      try {
        const tracker = loadTracker(slug);
        if (tracker.execution_status === 'running') {
          tracker.execution_status = 'failed';
          tracker.auth_error = null;
          tracker.last_run_logs = [
            ...(tracker.last_run_logs || []),
            `[${new Date().toISOString()}] Status reset: process was killed while running.`,
          ];
          saveTrackerAtomic(slug, tracker);
          logger.info(`[Runner] Reset stuck 'running' status for: ${slug}`);
        }
      } catch {}
    }
  }

  static registerContext(slug: string, context: any): void {
    this._activeContexts.set(slug, (this._activeContexts.get(slug) || new Set()).add(context));
  }

  static unregisterContext(slug: string, context: any): void {
    const contexts = this._activeContexts.get(slug);
    if (contexts) {
      contexts.delete(context);
      if (contexts.size === 0) this._activeContexts.delete(slug);
    }
  }

  static async executeScrape(slug: string): Promise<PublishTracker> {
    const inst = this.forSlug(slug);
    const tracker = loadTracker(slug);
    // ponytail: drop any stale session-error from a previous run so a fresh scrape
    // isn't auto-aborted on the first log poll. A platform that genuinely fails
    // during THIS run re-asserts tracker.auth_error in its catch block below.
    tracker.auth_error = null;
    const config = loadNovelConfig(slug);

    tracker.execution_status = 'running';
    tracker.last_run_logs = [`[${new Date().toISOString()}] Started platform scrapers...`];
    inst.activeRuns.set(slug, tracker.last_run_logs);
    saveTrackerAtomic(slug, tracker);

    const abortController = new AbortController();
    inst.abortControllers.set(slug, abortController);

    const sessionLog = new SessionLog(path.join(WORKSPACE_ROOT, slug, '_logs'));

    const addLog = (msg: string) => {
      const logs = inst.activeRuns.get(slug) || [];
      const stamped = `[${new Date().toISOString()}] ${msg}`;
      logs.unshift(stamped);
      inst.activeRuns.set(slug, logs.slice(0, 50));
      logEventBus.emitLog(slug, msg);
      sessionLog.record('log', { message: msg }, msg.includes('[ERROR') || msg.includes('[CRITICAL') ? 'error' : 'info');
    };

    // Timeout guard
    const timeout = setTimeout(() => {
      addLog('[TIMEOUT] Automation exceeded maximum timeout. Aborting.');
      this.abort(slug);
    }, MAX_AUTOMATION_TIMEOUT_MS);

    try {
      sessionLog.record('scrape_started', { slug });
      let inkstoneResult: any = { last_published_chapter: undefined, scheduled_count: 0, latest_scheduled_date: null as string | null, scheduled_chapters: [] };
      let patreonResult: any = { last_published_chapter: undefined, scheduled_count: 0, latest_scheduled_date: null as string | null, scheduled_chapters: [] };
      let inkstoneScrapedOk = false;
      let patreonScrapedOk = false;
      // Tracks a session/login failure actually asserted THIS run; anything stale
      // from a prior run must be cleared so it doesn't abort the new scrape.
      let runAuthError: { platform: string; code: string; message: string; timestamp: string } | null = null;

      const totalPhases = 6;
      let phase = 0;

      phase++;
      this.setProgress(slug, phase, totalPhases, 'Launching browser contexts...');

       if (config.inkstone_enabled) {
         const profileDir = path.join(SHARED_DIR, 'browser_profile', slug);
         if (!platformHasCookies('inkstone', profileDir)) {
           addLog('Inkstone is not connected (no cookies). Skipping Inkstone scraping.');
         } else {
           addLog('Launching Headless Playwright Context for Webnovel/Inkstone...');
           try {
             const scraper = new InkstoneScraper();
             const res = await scraper.scrapeState(slug);
inkstoneResult = {
                last_published_chapter: res.last_published_chapter,
                published_count: res.published_count,
                scheduled_count: res.scheduled_count,
               latest_scheduled_date: res.latest_scheduled_date,
               scheduled_chapters: res.scheduled_chapters || [],
             };
             addLog(`Inkstone Scraper finished. Latest Published: Ch ${res.last_published_chapter}, Scheduled: ${res.scheduled_count}${(res as any)._diagnostic ? ' | ' + (res as any)._diagnostic : ''}`);
             inkstoneScrapedOk = true;
           } catch (err: any) {
             const classified = classifyError(err, `https://inkstone.webnovel.com/novels/${slug}`);
             addLog(`[ERROR:${classified.code}] Inkstone scraping failed: ${classified.message}`);
             addLog(`Retry policy: ${classified.retryable ? 'retryable' : 'non-retryable'}`);
              if (classified.code === 'session_expired' || classified.code === 'login_required') {
                tracker.auth_error = { platform: 'inkstone', code: classified.code, message: classified.message, timestamp: new Date().toISOString() };
                runAuthError = tracker.auth_error;
                saveTrackerAtomic(slug, tracker);
              }
           }
         }
       } else {
         addLog('Inkstone is disabled in config. Skipping Inkstone scraping.');
       }
      phase++;
      this.setProgress(slug, phase, totalPhases, 'Scraping Inkstone...');

        if (config.patreon_enabled) {
           const profileDir = path.join(SHARED_DIR, 'browser_profile', slug);
           if (!platformHasCookies('patreon', profileDir)) {
             addLog('Patreon is not connected (no cookies). Skipping Patreon scraping.');
           } else {
           addLog('Launching Sandboxed Playwright Context for Patreon...');
           try {
             const sync = new PatreonSync();
             const res = await sync.scrapeState(slug);
patreonResult = {
                last_published_chapter: res.last_published_chapter,
                published_count: res.published_count,
                scheduled_count: res.scheduled_count,
               latest_scheduled_date: res.latest_scheduled_date,
               scheduled_chapters: res.scheduled_chapters || [],
             };
             addLog(`Patreon Sync finished. Latest Published: Ch ${res.last_published_chapter}, Scheduled: ${res.scheduled_count}`);
             patreonScrapedOk = true;
           } catch (err: any) {
             const classified = classifyError(err, 'https://patreon.com/dashboard');
             addLog(`[ERROR:${classified.code}] Patreon scraping failed: ${classified.message}`);
              if (classified.code === 'session_expired' || classified.code === 'login_required') {
                tracker.auth_error = { platform: 'patreon', code: classified.code, message: classified.message, timestamp: new Date().toISOString() };
                runAuthError = tracker.auth_error;
                saveTrackerAtomic(slug, tracker);
              }
           }
         }
       } else {
         addLog('Patreon is disabled in config. Skipping Patreon scraping.');
       }
      phase++;
      this.setProgress(slug, phase, totalPhases, 'Scraping Patreon...');

      let kofiResult: any = { last_published_chapter: undefined, scheduled_count: 0, latest_scheduled_date: null as string | null, scheduled_chapters: [] };
           if (config.kofi_enabled) {
              const profileDir = path.join(SHARED_DIR, 'browser_profile', slug);
           if (!platformHasCookies('kofi', profileDir)) {
             addLog('Ko-fi is not connected (no cookies). Skipping Ko-fi scraping.');
           } else {
           addLog('Launching Scraping Context for Ko-fi...');
           try {
             const kofiScraper = new KofiSync();
             const res = await kofiScraper.scrapeState(slug);
kofiResult = {
                last_published_chapter: res.last_published_chapter,
                published_count: res.published_count,
                scheduled_count: res.scheduled_count,
               latest_scheduled_date: res.latest_scheduled_date,
               scheduled_chapters: res.scheduled_chapters || [],
             };
             addLog(`Ko-fi Scraper finished. Latest Published: Ch ${res.last_published_chapter}, Scheduled: ${res.scheduled_count}`);
           } catch (err: any) {
             const classified = classifyError(err, 'https://ko-fi.com/manage/posts');
             addLog(`[ERROR:${classified.code}] Ko-fi scraping failed: ${classified.message}`);
              if (classified.code === 'session_expired' || classified.code === 'login_required') {
                tracker.auth_error = { platform: 'kofi', code: classified.code, message: classified.message, timestamp: new Date().toISOString() };
                runAuthError = tracker.auth_error;
                saveTrackerAtomic(slug, tracker);
              }
           }
         }
       } else {
         addLog('Ko-fi is disabled in config. Skipping Ko-fi scraping.');
       }
      phase++;
      this.setProgress(slug, phase, totalPhases, 'Scraping Ko-fi...');

      const nextScheduleDate = [inkstoneResult.latest_scheduled_date, patreonResult.latest_scheduled_date, kofiResult.latest_scheduled_date]
        .filter((d): d is string => !!d)
        .sort()
        .pop() || null;

      // Compute local sequence from disk
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const localChapters = scanChaptersDirectory(chaptersDir, slug);
      const localSequence = computeSequence(localChapters.map(c => c.chapter_number));
      phase++;
      this.setProgress(slug, phase, totalPhases, 'Computing sequences...');

      const merged = mergeTrackerStates(slug, {
        webnovel_last: inkstoneResult.last_published_chapter,
        webnovel_published_count: inkstoneResult.published_count,
        patreon_last: patreonResult.last_published_chapter,
        patreon_published_count: patreonResult.published_count,
        kofi_last: kofiResult.last_published_chapter,
        kofi_published_count: kofiResult.published_count,
        inkstone_scheduled_count: inkstoneResult.scheduled_count,
        patreon_scheduled_count: patreonResult.scheduled_count,
        next_schedule_date: nextScheduleDate,
        local_sequence: localSequence,
        inkstone_sequence: inkstoneResult.sequence || null,
        patreon_sequence: patreonResult.sequence || null,
        last_scraped_at: new Date().toISOString(),
        execution_status: 'idle',
        inkstone_scheduled: inkstoneResult.scheduled_chapters,
        patreon_scheduled: patreonResult.scheduled_chapters,
        kofi_scheduled: kofiResult.scheduled_chapters,
      });

      addLog('Scraping metrics merged and atomic state commit completed.');
      // ponytail: clear stale auth_error from a previous run unless THIS run re-asserted
      // a real session/login failure. A platform that is disabled, not connected
      // (no cookies), or scraped successfully must not leave an old reconnect
      // alert dangling — and a stale error here is what auto-aborting scrapes.
      merged.auth_error = runAuthError || null;
      merged.last_run_logs = inst.activeRuns.get(slug) || [];

      // Grow the protected set from every successful scrape: verified-sequential
      // prefix from Ch 1, merged monotonically (never dropped). Cleanup/backfill
      // use it as the never-delete list on both platforms.
      merged.protected = mergeProtected(
        merged.protected,
        computeProtectedPrefix([
          ...(inkstoneResult.scheduled_chapters || []).map((c: any) => c.chapter_number),
          ...(patreonResult.scheduled_chapters || []).map((c: any) => c.chapter_number),
        ])
      );
      saveTrackerAtomic(slug, merged);
      phase++;
      this.setProgress(slug, phase, totalPhases, 'Merging platform state...');

      // Auto-lock published and scheduled chapters.
      // Only lock chapters whose published/scheduled status is CONFIRMED by a
      // successful scrape — a failed scrape must not freeze unscraped chapters.
      const inkstoneUpTo = inkstoneScrapedOk ? (merged.webnovel_last + (merged.inkstone_scheduled_count || 0)) : tracker.webnovel_last;
      const patreonUpTo = patreonScrapedOk ? (merged.patreon_last + (merged.patreon_scheduled_count || 0)) : tracker.patreon_last;
       const kofiUpTo = merged.kofi_last || 0;
      const protectedSet = new Set(merged.protected || []);
      let lockedCount = 0;
      for (const ch of localChapters) {
        const lockForInkstone = inkstoneScrapedOk && ch.chapter_number <= inkstoneUpTo;
        const lockForPatreon = patreonScrapedOk && ch.chapter_number <= patreonUpTo;
        const lockForKofi = config.kofi_enabled && ch.chapter_number <= kofiUpTo;
        if (lockForInkstone || lockForPatreon || lockForKofi || protectedSet.has(ch.chapter_number)) {
          if (!ch.is_locked) { lockFile(ch.file_path); lockedCount++; }
        }
      }
      if (lockedCount > 0) addLog(`Locked ${lockedCount} published/scheduled chapter(s).`);
      phase++;
      this.setProgress(slug, phase, totalPhases, 'Locking published files...');

      sessionLog.record('scrape_completed', { slug, inkstone: inkstoneResult, patreon: patreonResult }, 'success');
      sessionLog.save();

      // ponytail: auto-resequence after scrape removed — it re-anchored the schedule
      // on whatever dated draft it found first (Ch84=2027-06-06), re-poisoning Ch85+.
      // Resequencing is manual-only now; see inkScheduleCb / auditSequence anchor logic.

      inst.clearProgress();
      inst.activeRuns.delete(slug);
      inst.abortControllers.delete(slug);
      clearTimeout(timeout);

      return merged;
    } catch (error: any) {
      addLog(`[CRITICAL ERROR] Scraping workflow failed: ${error.message || error}`);
      notifyFromEnv(`Scrape Failed: ${slug}`, { slug, error: error.message, phase: 'scrape' });
      const fresh = loadTracker(slug);
      fresh.execution_status = 'failed';
      fresh.last_run_logs = inst.activeRuns.get(slug) || [];
      saveTrackerAtomic(slug, fresh);
      sessionLog.record('scrape_failed', { slug, error: error.message }, 'error');
      sessionLog.save();
      inst.clearProgress();
      inst.activeRuns.delete(slug);
      inst.abortControllers.delete(slug);
      clearTimeout(timeout);
      throw error;
    }
  }

  /**
   * Compute a publish plan without executing anything.
   * Returns structured data for the UI preview popup.
   */
  static computePublishPlan(slug: string, chapterNumber?: number): {
    ok: boolean;
    plan: {
      platform: string;
      chapters: { chapter_number: number; title: string; scheduled_date: string }[];
    }[];
    gaps: { platform: string; missing: number[] }[];
    conflicts: { type: string; detail: string }[];
    warnings: string[];
    lead: { current: number; target: number };
    backfill?: {
      platform: string;
      chaptersToDelete: number[];
      rescheduledChapters: { chapter_number: number; title: string; scheduled_date: string }[];
    }[];
    tracker_stuck: boolean;
  } {
    const tracker = loadTracker(slug);
    const config = loadNovelConfig(slug);
    const { chaptersDir } = ensureWorkspaceDirectories(slug);
    const localChapters = scanChaptersDirectory(chaptersDir, slug);

    const lastPatScheduled = Math.max(
      tracker.patreon_last,
      ...(tracker.patreon_scheduled?.map(s => s.chapter_number) || [])
    );
    const lastInkScheduled = Math.max(
      tracker.webnovel_last,
      ...(tracker.inkstone_scheduled?.map(s => s.chapter_number) || [])
    );

    const limit = config.batch_limit || 5;
    const currentLead = computeLeadDays(tracker, config);

    const plans: { platform: string; chapters: { chapter_number: number; title: string; scheduled_date: string }[] }[] = [];
    const gaps: { platform: string; missing: number[] }[] = [];
    const conflicts: { type: string; detail: string }[] = [];
    const warnings: string[] = [];

    // Pre-compute lead platform plans (Patreon / Ko-fi as Patreon substitute)
    const todayStr = new Date().toISOString().slice(0, 10);
    const leadPlatforms = getLeadPlatforms(config);
    const lastKofiScheduled = Math.max(
      tracker.kofi_last || 0,
      ...(tracker.kofi_scheduled?.map(s => s.chapter_number) || [])
    );
    const allPatKoChapters: number[] = [];
    for (const lPlatform of leadPlatforms) {
      const isPatreon = lPlatform === 'patreon';
      const lastSched = isPatreon ? lastPatScheduled : lastKofiScheduled;
      const scheduled = isPatreon ? (tracker.patreon_scheduled ?? []) : (tracker.kofi_scheduled ?? []);
      const lastPub = isPatreon ? tracker.patreon_last : (tracker.kofi_last || 0);

      // ponytail: lead-first scheduling — the catch-up gap (last scheduled → lead target) is
      // published LIVE in one run to restore the lead; chapters beyond the target are
      // scheduled future-dated to maintain it.
      const leadTarget = tracker.webnovel_last + config.target_lead;
      const leadCatchUp = lastSched < leadTarget;
      const chs: { chapter_number: number; title: string }[] = [];
      if (chapterNumber) {
        const ch = localChapters.find(c => c.chapter_number === chapterNumber);
        const already = lastSched >= chapterNumber;
        if (ch && !already) chs.push({ chapter_number: chapterNumber, title: ch.title });
      } else {
        const catchUpEnd = Math.max(lastSched + limit, leadTarget);
        for (let cn = lastSched + 1; cn <= catchUpEnd; cn++) {
          const ch = localChapters.find(c => c.chapter_number === cn);
          if (ch) chs.push({ chapter_number: cn, title: ch.title });
        }
      }
      allPatKoChapters.push(...chs.map(c => c.chapter_number));

      // Catch-up gap is published LIVE today (restores the lead in one run); only chapters
      // beyond the lead target are scheduled future-dated.
      const liveChs = leadCatchUp
        ? chs.filter(c => c.chapter_number <= leadTarget)
        : chs.filter(c => c.chapter_number <= Math.max(lastSched, leadTarget));
      const aheadChs = leadCatchUp
        ? chs.filter(c => c.chapter_number > leadTarget)
        : chs.filter(c => c.chapter_number > Math.max(lastSched, leadTarget));
      const livePlan = liveChs.map(c => ({ chapter_number: c.chapter_number, title: c.title, scheduled_date: todayStr }));
const aheadPlan = aheadChs.map((c, i) => {
        // ponytail: both lead platforms (Patreon & Ko-fi) anchor ahead chapters to the web
        // (inkstone) date of the SAME chapter minus the lead offset, so they publish early.
        return { chapter_number: c.chapter_number, title: c.title, scheduled_date: leadPublishDate(tracker, config, c.chapter_number, scheduled) };
      });
      plans.push({ platform: lPlatform, chapters: [...livePlan, ...aheadPlan] });
    }

    // Pre-compute Inkstone plan
    const inkFill = computeInkFill(tracker, config, leadPlatforms);
    const inkstoneChapters: { chapter_number: number; title: string }[] = [];
    if (chapterNumber) {
      const ch = localChapters.find(c => c.chapter_number === chapterNumber);
      const already = lastInkScheduled >= chapterNumber;
      if (ch && !already) inkstoneChapters.push({ chapter_number: chapterNumber, title: ch.title });
    } else if (inkFill.needed) {
      // ponytail: inkstone is behind the lead model (patreon_last - target_lead). Fill all
      // missing chapters in ONE plan, LIVE, instead of waiting out the +limit window.
      for (let cn = inkFill.boundary + 1; cn <= inkFill.fillTarget; cn++) {
        const ch = localChapters.find(c => c.chapter_number === cn);
        if (ch) inkstoneChapters.push({ chapter_number: cn, title: ch.title });
      }
    } else if (tracker.webnovel_last > inkFill.fillTarget) {
      // ponytail: inkstone's published position is AHEAD of the lead target (lead_last -
      // target_lead), e.g. after an accidental over-publish. Scheduling must NOT be blocked:
      // future-dated chapters never shrink the published lead (webnovel_last only moves on
      // LIVE publishes), and a daily scheduled runway is exactly what maintains the lead.
      for (let cn = lastInkScheduled + 1; cn <= lastInkScheduled + limit; cn++) {
        const ch = localChapters.find(c => c.chapter_number === cn);
        if (ch) inkstoneChapters.push({ chapter_number: cn, title: ch.title });
      }
    } else {
      for (let cn = lastInkScheduled + 1; cn <= lastInkScheduled + limit; cn++) {
        const ch = localChapters.find(c => c.chapter_number === cn);
        if (ch) inkstoneChapters.push({ chapter_number: cn, title: ch.title });
      }
    }
    const inkBaseline = inkstoneBaseline(tracker, config);
    const inkSchedules = inkstoneChapters.length > 0
      ? calculatePublishSchedules(inkstoneChapters, inkBaseline, config.chapters_per_day, config.base_publish_time, config.timezone)
      : [];
    plans.push({ platform: 'inkstone', chapters: inkSchedules.map(s => ({ chapter_number: s.chapter_number, title: s.title, scheduled_date: s.publish_date })) });

    // Pre-compute Ko-fi plan (only when Ko-fi is NOT acting as the lead Patreon substitute)
    const kofiChapters: { chapter_number: number; title: string }[] = [];
    if (config.kofi_enabled && !leadPlatforms.includes('kofi')) {
      if (chapterNumber) {
        const ch = localChapters.find(c => c.chapter_number === chapterNumber);
        const already = lastKofiScheduled >= chapterNumber;
        if (ch && !already) kofiChapters.push({ chapter_number: chapterNumber, title: ch.title });
      } else {
        for (let cn = lastKofiScheduled + 1; cn <= lastKofiScheduled + limit; cn++) {
          const ch = localChapters.find(c => c.chapter_number === cn);
          if (ch) kofiChapters.push({ chapter_number: cn, title: ch.title });
        }
      }
      const kofiSchedules = kofiChapters.length > 0
        ? kofiChapters.map(c => ({ chapter_number: c.chapter_number, title: c.title, publish_date: leadPublishDate(tracker, config, c.chapter_number, tracker.kofi_scheduled ?? []) }))
        : [];
      plans.push({ platform: 'kofi', chapters: kofiSchedules.map(s => ({ chapter_number: s.chapter_number, title: s.title, scheduled_date: s.publish_date })) });
    }

    // Check for gaps in local chapters
    const localNums = localChapters.map(c => c.chapter_number).sort((a, b) => a - b);
    const allPlannedNums = [...new Set([...allPatKoChapters, ...inkstoneChapters.map(c => c.chapter_number), ...kofiChapters.map(c => c.chapter_number)])].sort((a, b) => a - b);
    if (allPlannedNums.length > 0) {
      const min = allPlannedNums[0];
      const max = allPlannedNums[allPlannedNums.length - 1];
      const expected = new Set(localNums.filter(n => n >= min && n <= max));
      const planned = new Set(allPlannedNums);
      const missing = [...expected].filter(n => !planned.has(n));
      if (missing.length > 0) {
        gaps.push({ platform: 'local', missing });
      }
      // Check if any chapter is missing from the local files altogether
      const localSet = new Set(localNums);
      const missingLocal = allPlannedNums.filter(n => !localSet.has(n));
      if (missingLocal.length > 0) {
        warnings.push(`Chapters ${missingLocal.join(', ')} have no local file and will be skipped.`);
      }
    }

    // Lead check — informational only. Scheduling future-dated chapters never shrinks the
    // published lead (webnovel_last only moves on LIVE publishes), so an over-target lead
    // must not block scheduling. The executor's own HOLD branch already stops LIVE publishes
    // that would overshoot the fill target; this was blocking every future-dated schedule too.
    if (currentLead > config.target_lead && config.inkstone_enabled && !inkFill.needed) {
      warnings.push(`Patreon lead (${currentLead}) exceeds target (${config.target_lead}). Future-dated scheduling continues; LIVE publishes are guarded by the fill target.`);
    }

    // Future-date check
    const today = new Date().toISOString().slice(0, 10);
    for (const plan of plans) {
      const futureChs = plan.chapters.filter(c => c.scheduled_date.slice(0, 10) > today);
      if (futureChs.length > 0) {
        warnings.push(`${plan.platform}: ${futureChs.length} chapter(s) scheduled for future dates (e.g. Ch ${futureChs[0].chapter_number} on ${futureChs[0].scheduled_date.slice(0, 10)}). They won't be published until their date.`);
      }
    }

    // Compute backfill plans
    const backfillPlans: {
      platform: string;
      chaptersToDelete: number[];
      rescheduledChapters: { chapter_number: number; title: string; scheduled_date: string }[];
    }[] = [];

    // ponytail: backfill (gap-delete + reschedule chain) applies ONLY to inkstone — the true
    // sequential chain. Lead platforms (patreon/kofi) are web-anchored: a gap between last
    // published and first scheduled is NORMAL (the schedule is a lead-ahead curtain, not a
    // contiguous daily chain), so mass-deleting 339..35x and rebuilding +1/day dates is wrong.
    for (const platform of ['inkstone'] as const) {
      const existing = platform === 'inkstone' ? tracker.inkstone_scheduled : platform === 'patreon' ? tracker.patreon_scheduled : (tracker.kofi_scheduled ?? []);
      const newChs = platform === 'inkstone' ? inkstoneChapters : [];
      const lastPub = platform === 'inkstone'
        ? (inkFill.needed ? inkFill.fillTarget : tracker.webnovel_last)
        : platform === 'patreon' ? tracker.patreon_last : (tracker.kofi_last || 0);
      const gapFillCandidates = localChapters
        .filter(c => c.chapter_number > lastPub)
        .map(c => ({ chapter_number: c.chapter_number, title: c.title }));
      const chsForBackfill = [...newChs, ...gapFillCandidates.filter(c => !newChs.find(n => n.chapter_number === c.chapter_number))];
      if (existing.length > 0) {
        const bf = computeBackfillPlan(existing, chsForBackfill, config.chapters_per_day, config.base_publish_time, lastPub, config.timezone, new Set(tracker.protected || []));
        if (bf.needsBackfill) {
          backfillPlans.push({
            platform,
            chaptersToDelete: bf.chaptersToDelete.map(c => c.chapter_number),
            // ponytail: bf.newSchedule is the theoretical 1/day rebuild from the backfill
            // baseline, but during a fill the chapters go LIVE today instead. Show the real
            // plan so the preview doesn't contradict the inkstone plan (display-only; the
            // executor never uses bf.newSchedule).
            rescheduledChapters: (inkFill?.needed
              ? inkstoneChapters.map(c => ({ chapter_number: c.chapter_number, title: c.title, scheduled_date: todayStr }))
              : bf.newSchedule),
          });
        }
      }
    }

    return {
      ok: conflicts.length === 0,
      plan: plans,
      gaps,
      conflicts,
      warnings,
      lead: { current: currentLead, target: config.target_lead },
      backfill: backfillPlans.length > 0 ? backfillPlans : undefined,
      tracker_stuck: tracker.execution_status === 'running',
    };
  }

  /**
   * After a one-shot Patreon lead catch-up, re-scrape Patreon and confirm chapters landed.
   * Mismatches are flagged in logs + failed_publishes + a notification for user follow-up.
   */
  private static async verifyPatreonCatchUp(
    slug: string,
    addLog: (msg: string) => void,
    tracker: PublishTracker,
    expectedEnd: number,
    prevLast: number
  ): Promise<void> {
    const sync = new PatreonSync();
    let state: any;
    try {
      state = await sync.scrapeState(slug);
    } catch (err: any) {
      addLog(`[VERIFY] Patreon re-scrape failed: ${err?.message || err}. Lead catch-up could not be confirmed.`);
      notifyFromEnv(`Publish Verify Failed: ${slug}`, { slug, error: err?.message || 're-scrape failed' });
      return;
    }
    const actualLast = state.last_published_chapter ?? 0;
    const publishedNums = (state.scraped_items ?? [])
      .filter((p: any) => p.status === 'PUBLISHED')
      .map((p: any) => Number(p.number))
      .sort((a: number, b: number) => a - b);
    const { missing, shortfall } = computeCatchUpGaps(prevLast, expectedEnd, actualLast, publishedNums);

    if (missing.length === 0 && shortfall === 0) {
      addLog(`[VERIFY] Patreon lead catch-up confirmed: Ch ${prevLast + 1}-${expectedEnd} published (latest Ch ${actualLast}).`);
      return;
    }
    if (shortfall > 0) addLog(`[VERIFY] Lead catch-up INCOMPLETE: expected through Ch ${expectedEnd}, Patreon shows latest Ch ${actualLast} (${shortfall} chapter(s) short).`);
    if (missing.length > 0) addLog(`[VERIFY] Missing on Patreon within the catch-up range: Ch ${missing.join(', ')}.`);
    if (!tracker.failed_publishes) tracker.failed_publishes = [];
    for (const n of missing) {
      tracker.failed_publishes.push({ chapter_number: n, platform: 'patreon', error: '[VERIFY] Chapter missing on Patreon after lead catch-up', timestamp: new Date().toISOString() });
    }
    saveTrackerAtomic(slug, tracker);
    notifyFromEnv(`Publish Verification Failed: ${slug}`, { slug, expected_last: expectedEnd, actual_last: actualLast, missing, shortfall });
  }

  static async executePublish(
    slug: string,
    mode: 'single' | 'all',
    isDryRun: boolean = false,
    chapterNumber?: number
  ): Promise<PublishTracker> {
    const inst = this.forSlug(slug);
    let tracker = loadTracker(slug);
    const config = loadNovelConfig(slug);
    const { chaptersDir } = ensureWorkspaceDirectories(slug);

    tracker.execution_status = 'running';
    tracker.last_run_logs = [
      `[${new Date().toISOString()}] Starting publishing execution in ${isDryRun ? 'DRY-RUN' : 'LIVE'} mode...`,
    ];
    inst.activeRuns.set(slug, tracker.last_run_logs);
    saveTrackerAtomic(slug, tracker);

    const abortController = new AbortController();
    inst.abortControllers.set(slug, abortController);

    const sessionLog = new SessionLog(path.join(WORKSPACE_ROOT, slug, '_logs'));

    const addLog = (msg: string) => {
      const logs = inst.activeRuns.get(slug) || [];
      const stamped = `[${new Date().toISOString()}] ${msg}`;
      logs.unshift(stamped);
      inst.activeRuns.set(slug, logs.slice(0, 100));
      logEventBus.emitLog(slug, msg);
      sessionLog.record('log', { message: msg }, msg.includes('[ERROR') || msg.includes('[CRITICAL') || msg.includes('[FAILED') ? 'error' : 'info');
    };

    const timeout = setTimeout(() => {
      addLog('[TIMEOUT] Publish automation exceeded maximum timeout. Aborting.');
      this.abort(slug);
    }, MAX_AUTOMATION_TIMEOUT_MS);

    try {
      addLog(`Scanning local chapter workspace at ${chaptersDir}...`);
      const localChapters = scanChaptersDirectory(chaptersDir, slug);
      addLog(`Found ${localChapters.length} valid local chapter files.`);

      if (localChapters.length === 0) {
        addLog('No local chapters found to publish. Operational sequence completed.');
        tracker.execution_status = 'idle';
        tracker.last_run_logs = inst.activeRuns.get(slug) || [];
        saveTrackerAtomic(slug, tracker);
        inst.activeRuns.delete(slug);
        inst.abortControllers.delete(slug);
        clearTimeout(timeout);
        return tracker;
      }

      const limit = mode === 'single' ? 1 : config.batch_limit;
      addLog(`Publishing mode: ${mode.toUpperCase()} (Batch Limit: ${limit})`);
      this.setProgress(slug, 1, limit + 3, 'Scanning and verifying chapters...');

      // Resequence: verify and fix scheduled dates before pre-computing.
      // ponytail: disabled in the publish flow — resequence's gap-fill live-publishes the
      // first existing chapter whenever chapter numbers are missing on the platform (the
      // ch-103/ch-108 accidents). Backfill + fill below already repair gaps and dates, so
      // resequence here is redundant AND dangerous. Run it manually when needed.
      // if (!isDryRun) await this.executeResequence(slug, addLog, config, localChapters);
      this.setProgress(slug, 2, limit + 3, 'Pre-computing schedules...');

      // Re-load tracker after resequence
      tracker = loadTracker(slug);

      // Backfill: detect and fix schedule gaps before pre-computing new schedule
      let hadFailure = false;
      // ponytail: backfill deletes conflicting scheduled chapters (gap/wrong-date) but the
      // executor never re-created them — bf.newSchedule is display-only. Capture what was
      // deleted so Phase 1 re-schedules the full runway instead of losing it.
      const inkBackfillDeleted: number[] = [];
      const backfillPlatforms: { name: string; enabled: boolean; existing: any[]; lastPub: number; adapter: any; setScheduled: (s: any[]) => void }[] = [
        ...(config.inkstone_enabled ? [{ name: 'inkstone', enabled: true, existing: tracker.inkstone_scheduled, lastPub: tracker.webnovel_last, adapter: new InkstoneScraper(), setScheduled: (s: any[]) => { tracker.inkstone_scheduled = s; } }] : []),
        ...getLeadPlatforms(config).map(lp => ({
          name: lp,
          enabled: true,
          existing: lp === 'patreon' ? tracker.patreon_scheduled : (tracker.kofi_scheduled ?? []),
          lastPub: lp === 'patreon' ? tracker.patreon_last : (tracker.kofi_last || 0),
          adapter: lp === 'patreon' ? new PatreonSync() : new KofiSync(),
          setScheduled: (s: any[]) => { if (lp === 'patreon') tracker.patreon_scheduled = s; else tracker.kofi_scheduled = s; },
        })),
      ];
      // ponytail: backfill deletes live chapters (wrong-date / gap conflicts). Dry-run must
      // not mutate platforms, so the whole backfill pass runs only in live mode.
      for (const plat of (isDryRun ? [] : backfillPlatforms)) {
        if (!plat.enabled) continue;

        // ponytail: scrape the platform to get the ACTUAL scheduled chapters — the
        // tracker can be out of sync (e.g., chapters scheduled on the platform but
        // not recorded in the tracker). Use the union of tracker + scraped state.
        let existing = plat.existing;
        try {
          const scraped = await plat.adapter.scrapeState(slug);
          const scrapedChapters = (scraped.scheduled_chapters || []).map((c: any) => ({
            chapter_number: c.chapter_number,
            date: c.date || null,
            edit_url: c.edit_url,
          }));
          // Merge: scraped entries win over tracker (scrape is fresher), legacy tracker
          // entries fill gaps not covered by scrape.
          const merged = [...scrapedChapters];
          for (const entry of existing) {
            if (!merged.some(e => e.chapter_number === entry.chapter_number)) {
              merged.push(entry);
            }
          }
          // ponytail: deduplicate by chapter number — keep the entry with the latest date
          // (or the one with an edit_url if dates are equal). Old publishes sometimes create
          // duplicate entries that confuse the backfill.
          const dedupedMap = new Map<number, any>();
          for (const entry of merged) {
            const existing = dedupedMap.get(entry.chapter_number);
            if (!existing || (entry.date && !existing.date) || (entry.date && existing.date && entry.date > existing.date) || (entry.date === existing.date && entry.edit_url && !existing.edit_url)) {
              dedupedMap.set(entry.chapter_number, entry);
            }
          }
          const deduped = Array.from(dedupedMap.values());
          existing = deduped;
          if (scrapedChapters.length > 0) {
            plat.setScheduled(deduped);
          }
          // ponytail: sync webnovel_last with actual published count — old code bumped
          // it for scheduled (not published) chapters, causing desync. Use scraped value.
          if (plat.name === 'inkstone' && scraped.last_published_chapter !== undefined) {
            const scrapedLastPub = scraped.last_published_chapter;
            if (tracker.webnovel_last !== scrapedLastPub) {
              addLog(`[BACKFILL] inkstone: correcting webnovel_last ${tracker.webnovel_last} -> ${scrapedLastPub} (from scrape)`);
              tracker.webnovel_last = scrapedLastPub;
              plat.lastPub = scrapedLastPub;
            }
          }
        } catch (err: any) {
          addLog(`[BACKFILL] ${plat.name}: scrape failed (${err.message}), using tracker state only.`);
        }

        if (!existing?.length) continue;

        // ponytail: detect chapters with wrong dates (e.g., multiple chapters on the
        // same day when chaptersPerDay=1). These need deletion + rescheduling.
        // Use a Map to catch non-adjacent same-date entries the old consecutive-only counter missed.
        const sortedExisting = [...existing].filter(c => c.date).sort((a, b) => a.chapter_number - b.chapter_number);
        const wrongDateChapters: { chapter_number: number; edit_url?: string }[] = [];
        const dateCounts = new Map<string, { count: number; chapters: { chapter_number: number; edit_url?: string }[] }>();
        for (const curr of sortedExisting) {
          const dateStr = curr.date!.slice(0, 10);
          const entry = dateCounts.get(dateStr) || { count: 0, chapters: [] };
          entry.count++;
          entry.chapters.push({ chapter_number: curr.chapter_number, edit_url: curr.edit_url });
          dateCounts.set(dateStr, entry);
        }
        for (const [, entry] of dateCounts) {
          if (entry.count > (config.chapters_per_day || 1)) {
            for (let i = config.chapters_per_day || 1; i < entry.chapters.length; i++) {
              wrongDateChapters.push(entry.chapters[i]);
            }
          }
        }
        if (wrongDateChapters.length > 0) {
          addLog(`[BACKFILL] ${plat.name}: ${wrongDateChapters.length} chapter(s) have wrong dates (same day as previous), deleting for reschedule.`);
          for (const ch of wrongDateChapters) {
            if (abortController.signal.aborted) break;
            if (!ch.edit_url) {
              addLog(`[BACKFILL] ${plat.name}: Ch ${ch.chapter_number} has no edit URL, skipping.`);
              continue;
            }
            try {
              const ok = await plat.adapter.deleteChapter(ch.chapter_number, ch.edit_url, slug);
              if (ok) {
                addLog(`[BACKFILL] ${plat.name}: Deleted Ch ${ch.chapter_number} (wrong date, will reschedule).`);
                existing = existing.filter(e => e.chapter_number !== ch.chapter_number);
                plat.setScheduled(existing);
              } else {
                addLog(`[BACKFILL] ${plat.name}: Failed to delete Ch ${ch.chapter_number}.`);
              }
            } catch (err: any) {
              addLog(`[BACKFILL] ${plat.name}: Error deleting Ch ${ch.chapter_number}: ${err.message}.`);
            }
          }
        }

        if (!existing?.length) continue;

        // Gather new chapters to schedule for this platform
        const lastScheduled = Math.max(
          plat.lastPub,
          ...(existing.map(s => s.chapter_number) || [])
        );
        const upcomingCount = limit;
        const upcoming: { chapter_number: number; title: string }[] = [];
        for (let cn = lastScheduled + 1; cn <= lastScheduled + upcomingCount; cn++) {
          const ch = localChapters.find(c => c.chapter_number === cn);
          if (ch) upcoming.push({ chapter_number: cn, title: ch.title });
        }
        const gapFillCandidates = localChapters
          .filter(c => c.chapter_number > plat.lastPub)
          .map(c => ({ chapter_number: c.chapter_number, title: c.title }));
        const chsForBackfill = [...upcoming, ...gapFillCandidates.filter(c => !upcoming.find(n => n.chapter_number === c.chapter_number))];
        if (!chsForBackfill.length) continue;

        // ponytail: when inkstone is behind its fill target (patreon_last - target_lead), the
        // just-corrected webnovel_last (=0) disables computeBackfillPlan's lastPublished>0 guard,
        // so mis-anchored scheduled chapters above the target (e.g. 145-239) would survive.
        // Pass the fill target as lastPublished so Check 1 fires and deletes & rebuilds them.
        const inkFill = plat.name === 'inkstone' ? computeInkFill(tracker, config, getLeadPlatforms(config)) : null;
        const bf = plat.name === 'inkstone'
          ? computeBackfillPlan(existing, chsForBackfill, config.chapters_per_day, config.base_publish_time, (inkFill?.needed ? inkFill.fillTarget : plat.lastPub), config.timezone, new Set(tracker.protected || []))
          : null;
        if (bf && bf.needsBackfill) {
          addLog(`[BACKFILL] ${plat.name}: ${bf.chaptersToDelete.length} conflicting chapter(s) need deletion for gap fill.`);
          let deletedOk = 0;
          let deleteFailed = false;
          for (const ch of bf.chaptersToDelete) {
            if (abortController.signal.aborted) { addLog('[BACKFILL] Aborted by user.'); break; }
            const existingCh = existing.find(c => c.chapter_number === ch.chapter_number);
            if (!existingCh?.edit_url) {
              addLog(`[BACKFILL] ${plat.name}: Ch ${ch.chapter_number} has no edit URL, skipping deletion.`);
              continue;
            }
            // ponytail: skip chapters already published (appear in last_batch_published) —
            // deleting a published chapter is impossible and aborts the entire run
            if (tracker.last_batch_published?.some(p => p.chapter_number === ch.chapter_number && p.platform === plat.name)) {
              addLog(`[BACKFILL] ${plat.name}: Ch ${ch.chapter_number} already published, skipping deletion.`);
              continue;
            }
            try {
              const ok = await plat.adapter.deleteChapter(ch.chapter_number, existingCh.edit_url, slug);
              if (ok) {
                deletedOk++;
                addLog(`[BACKFILL] ${plat.name}: Deleted Ch ${ch.chapter_number} (will be rescheduled).`);
              } else {
                addLog(`[BACKFILL] ${plat.name}: Failed to delete Ch ${ch.chapter_number}. Aborting run.`);
                deleteFailed = true;
                break;
              }
            } catch (err: any) {
              addLog(`[BACKFILL] ${plat.name}: Error deleting Ch ${ch.chapter_number}: ${err.message}. Aborting run.`);
              deleteFailed = true;
              break;
            }
          }
          if (deleteFailed) {
            hadFailure = true;
            addLog(`[BACKFILL] ${plat.name}: Backfill failed — aborting publish. Fresh scrape will re-check on next run.`);
            break;
          }
          if (deletedOk > 0) {
            addLog(`[BACKFILL] ${plat.name}: Deleted ${deletedOk}/${bf.chaptersToDelete.length} chapters. Re-schedule will fill gaps.`);
            // ponytail: remember inkstone chapters removed by backfill so Phase 1 re-creates
            // them (root cause of the Ch 109-299 loss: backfill deleted, executor dropped them).
            if (plat.name === 'inkstone') {
              for (const ch of bf.chaptersToDelete) {
                if (!inkBackfillDeleted.includes(ch.chapter_number)) inkBackfillDeleted.push(ch.chapter_number);
              }
            }
            // Scrape to refresh tracker state after deletions
            try {
              const res = await plat.adapter.scrapeState(slug);
              plat.setScheduled(res.scheduled_chapters?.map((c: any) => ({ chapter_number: c.chapter_number, date: c.date, edit_url: c.edit_url })) || []);
            } catch (err: any) {
              addLog(`[BACKFILL] ${plat.name}: Re-scrape failed (${err.message}). Removing deleted chapters from in-memory tracker.`);
              const deletedNums = new Set(bf.chaptersToDelete.map(c => c.chapter_number));
              plat.setScheduled((existing || []).filter(c => !deletedNums.has(c.chapter_number)));
            }
          }
        }
        if (hadFailure) break;
      }
      saveTrackerAtomic(slug, tracker);
      if (hadFailure) {
        addLog('[BACKFILL] Aborting publish run due to backfill failure.');
        tracker.execution_status = 'failed';
        tracker.last_run_logs = inst.activeRuns.get(slug) || [];
        saveTrackerAtomic(slug, tracker);
        inst.clearProgress();
        inst.activeRuns.delete(slug);
        inst.abortControllers.delete(slug);
        clearTimeout(timeout);
        return tracker;
      }

      tracker.last_batch_published = [];
      let publishedCount = 0;
      const todayStr = new Date().toISOString().slice(0, 10);

      // ============================================================
      // Phase 1: Publish all Inkstone chapters (with schedule dates)
      // ============================================================
      if (config.inkstone_enabled) {
        const lastInk = Math.max(
          tracker.webnovel_last,
          ...(tracker.inkstone_scheduled?.map(s => s.chapter_number) || [])
        );
        const inkFill = computeInkFill(tracker, config, getLeadPlatforms(config));
        const inkChapters: { chapter_number: number; title: string }[] = [];
        if (chapterNumber) {
          const ch = localChapters.find(c => c.chapter_number === chapterNumber);
          const already = tracker.webnovel_last >= chapterNumber || tracker.inkstone_scheduled?.some(s => s.chapter_number === chapterNumber);
          if (ch && !already) inkChapters.push({ chapter_number: chapterNumber, title: ch.title });
          else if (ch && already) addLog(`[SKIP] Inkstone Ch ${chapterNumber} already published/scheduled.`);
          else if (!ch) addLog(`[SKIP] Inkstone Ch ${chapterNumber} not found locally.`);
        } else if (inkFill.needed) {
          // ponytail: bulk LIVE fill to the lead model target (patreon_last - target_lead).
          for (let cn = inkFill.boundary + 1; cn <= inkFill.fillTarget; cn++) {
            const ch = localChapters.find(c => c.chapter_number === cn);
            if (ch) inkChapters.push({ chapter_number: cn, title: ch.title });
          }
        } else if (tracker.webnovel_last > inkFill.fillTarget) {
          // ponytail: inkstone's published position is AHEAD of the lead target (lead_last -
          // target_lead). Scheduling must NOT be blocked — future-dated chapters never shrink
          // the published lead (webnovel_last only moves on LIVE publishes), and the daily
          // scheduled runway is what maintains the lead. Only LIVE publishing past the fill
          // target is prevented (it never happens here: inkBaseline schedules >= tomorrow).
          addLog(`[HOLD] Inkstone published position (${tracker.webnovel_last}) is ahead of the lead target (${inkFill.fillTarget}). Still scheduling future-dated; LIVE publishes stay guarded.`);
          for (let cn = lastInk + 1; cn <= lastInk + limit; cn++) {
            const ch = localChapters.find(c => c.chapter_number === cn);
            if (ch) inkChapters.push({ chapter_number: cn, title: ch.title });
          }
        } else {
          // ponytail: schedule the next batch ahead (future-dated) even when at the fill target,
          // matching computePublishPlan. run3's "inverted lead" came from LIVE-publishing past the
          // target, not from scheduling ahead — future-dated schedules keep the 20-chapter lead.
          for (let cn = lastInk + 1; cn <= lastInk + limit; cn++) {
            const ch = localChapters.find(c => c.chapter_number === cn);
            if (ch) inkChapters.push({ chapter_number: cn, title: ch.title });
          }
        }
        // ponytail: re-create what backfill deleted this run (e.g. Ch 109-299 after a gap
        // above the fill target). Without this, deletion is permanent — bf.newSchedule is only
        // a preview. Cover the whole range up to the max deleted chapter so gap fillers that
        // never existed on the platform (e.g. 104-108) are scheduled too.
        if (inkBackfillDeleted.length > 0) {
          const maxDeleted = Math.max(...inkBackfillDeleted);
          const highestPlanned = Math.max(0, ...inkChapters.map(c => c.chapter_number));
          for (let cn = highestPlanned + 1; cn <= maxDeleted; cn++) {
            const alreadyScheduled = tracker.inkstone_scheduled?.some(s => s.chapter_number === cn);
            if (alreadyScheduled) continue;
            const ch = localChapters.find(c => c.chapter_number === cn);
            if (ch) inkChapters.push({ chapter_number: cn, title: ch.title });
          }
        }
        if (inkChapters.length > 0) {
          const inkBase = inkstoneBaseline(tracker, config);
          const inkSchedules = calculatePublishSchedules(inkChapters, inkBase, config.chapters_per_day, config.base_publish_time, config.timezone);
          for (const sch of inkSchedules) {
            if (tracker.inkstone_scheduled?.some(s => s.chapter_number === sch.chapter_number)) continue;
            const ch = localChapters.find(c => c.chapter_number === sch.chapter_number);
            if (!ch) {
              addLog(`[SEQUENCE_GAP_ERROR] Inkstone Ch ${sch.chapter_number} not found locally. Halting publish process to prevent non-sequential publishing.`);
              hadFailure = true;
              break;
            }
            this.setProgress(slug, publishedCount + 1, limit * 2, `Publishing Ch ${sch.chapter_number} to Inkstone...`);
            if (isDryRun) {
              addLog(`[DRY-RUN] Would publish Ch ${sch.chapter_number} to Inkstone (${sch.publish_date.slice(0, 10)})`);
              // ponytail: dry-run must not persist tracker mutations (webnovel_last,
              // next_schedule_date, patreon_last) or the simulation leaks into the real run.
            } else {
              unlockFile(ch.file_path);
              try {
                const scraper = new InkstoneScraper();
                const res = await scraper.publishChapter(slug, ch, sch.publish_date);
                if (res.success) {
                  const n = new Date(sch.publish_date); n.setDate(n.getDate() + 1); tracker.next_schedule_date = n.toISOString();
                  if (!tracker.inkstone_scheduled) tracker.inkstone_scheduled = [];
                  tracker.inkstone_scheduled.push({ chapter_number: sch.chapter_number, date: sch.publish_date.slice(0, 10), edit_url: res.edit_url || '' });
                  tracker.last_batch_published!.push({ chapter_number: sch.chapter_number, platform: 'inkstone', edit_url: res.published_url || '' });
                  if (sch.publish_date.slice(0, 10) <= todayStr && sch.chapter_number > tracker.webnovel_last) {
                    // ponytail: only count chapters already live (publish date passed/today) in
                    // webnovel_last — scheduling spoils the live count, which inflates the lead
                    // target and makes Ko-fi/lead live-publish a huge burst instead of scheduling.
                    tracker.webnovel_last = sch.chapter_number;
                  }
                  addLog(`[Inkstone] Ch ${sch.chapter_number} published (${sch.publish_date.slice(0, 10)}).`);
                  publishedCount++;
                } else {
                  addLog(`[FAILED] Inkstone Ch ${sch.chapter_number}: ${res.error}`);
                  if (!tracker.failed_publishes) tracker.failed_publishes = [];
                  tracker.failed_publishes.push({ chapter_number: sch.chapter_number, platform: 'inkstone', error: res.error || 'Unknown', timestamp: new Date().toISOString() });
                }
              } catch (err: any) {
                addLog(`[ERROR] Inkstone Ch ${sch.chapter_number}: ${err.message}`);
              } finally { try { lockFile(ch.file_path); } catch {} }
            }
            saveTrackerAtomic(slug, tracker);
          }
        } else {
          addLog('Inkstone: No pending chapters.');
        }
      }

      // ============================================================
      // Phase 2: Publish to lead platforms (Patreon / Ko-fi as substitute)
      // ============================================================
      for (const lPlatform of getLeadPlatforms(config)) {
        if (hadFailure) break;
        const isPatreon = lPlatform === 'patreon';
        const lastPub = isPatreon ? tracker.patreon_last : (tracker.kofi_last || 0);
        // ponytail: the backfill step above already merged the LIVE platform scrape into the
        // tracker (de-duped, edit_urls attached). Do NOT clear it here — wiping it makes
        // lastSched fall back to the published count, so the run re-proposes chapters already
        // scheduled on the platform, creates duplicates, and never schedules past existing posts.
        const scheduled = isPatreon ? (tracker.patreon_scheduled ?? []) : (tracker.kofi_scheduled ?? []);
        const SyncClass = isPatreon ? PatreonSync : KofiSync;

        const lastSched = Math.max(lastPub, ...(scheduled.map(s => s.chapter_number) || []));
        const targetLive = tracker.webnovel_last + config.target_lead;
        const leadCatchUp = lastSched < targetLive;
        const ndStr = tracker.next_schedule_date;

        const chs: { chapter_number: number; title: string }[] = [];
        if (chapterNumber) {
          const ch = localChapters.find(c => c.chapter_number === chapterNumber);
          const already = lastPub >= chapterNumber || scheduled.some(s => s.chapter_number === chapterNumber);
          if (ch && !already) chs.push({ chapter_number: chapterNumber, title: ch.title });
          else if (ch && already) addLog(`[SKIP] ${lPlatform} Ch ${chapterNumber} already published/scheduled.`);
          else if (!ch) addLog(`[SKIP] ${lPlatform} Ch ${chapterNumber} not found locally.`);
        } else {
          // ponytail: when already ahead (lastSched >= targetLive) the old Math.min capped
          // catchUpEnd at targetLive, so a lead platform whose queue already exceeded the
          // target scheduled NOTHING — its runway froze while inkstone advanced, collapsing
          // the lead. Always extend the runway by a full batch, matching buildPublishPlan.
          let catchUpEnd = Math.max(lastSched + limit, targetLive);
          // ponytail: a bulk catch-up (queue far behind targetLive) publishes a large batch
          // live in one run. Surface it to the user mid-run and let them choose bulk vs limit.
          // Defaults to limit after 10 min.
          if (leadCatchUp && !isDryRun && !chapterNumber && catchUpEnd - lastSched > limit) {
            addLog(`[DECISION] ${lPlatform} queue (${lastSched}) is ${catchUpEnd - lastSched} chapters behind target (${targetLive}). Publish them all live now, or just the next ${limit}?`);
            const choice = await AutomationRunner.requestDecision(slug, `${lPlatform} is behind its lead target. Publish ${catchUpEnd - lastSched} chapters live now (bulk) or just the next ${limit} (limit)?`);
            if (choice !== 'bulk') catchUpEnd = lastSched + limit;
            addLog(`[DECISION] ${lPlatform} catch-up mode: ${choice}. Publishing live up to Ch ${catchUpEnd}.`);
          }
          for (let cn = lastSched + 1; cn <= catchUpEnd; cn++) {
            const ch = localChapters.find(c => c.chapter_number === cn);
            if (ch) chs.push({ chapter_number: cn, title: ch.title });
          }
        }

        // ponytail: during a lead catch-up the gap (lastSched+1..targetLive) is published LIVE in
        // one run to restore the lead — chapters already scheduled on the platform (<= lastSched)
        // are never in chs, so no out-of-order with the queue. Beyond targetLive, the runway is
        // scheduled future-dated. In steady state, only chapters newer than the platform's own
        // queue max qualify for a live publish (option-a: no delete/re-create).
        const queueMax = Math.max(0, ...(scheduled.map(s => s.chapter_number) || []));
        const liveChs = leadCatchUp
          ? chs.filter(c => c.chapter_number <= targetLive)
          : chs.filter(c => c.chapter_number > queueMax && c.chapter_number <= Math.max(lastSched, targetLive));
        const aheadChs = leadCatchUp
          ? chs.filter(c => c.chapter_number > targetLive)
          : chs.filter(c => c.chapter_number <= queueMax || c.chapter_number > Math.max(lastSched, targetLive));

        for (const ch of liveChs) {
          if (scheduled.some(s => s.chapter_number === ch.chapter_number)) continue;
          const localCh = localChapters.find(c => c.chapter_number === ch.chapter_number);
          if (!localCh) { addLog(`[SEQUENCE_GAP_ERROR] ${lPlatform} Ch ${ch.chapter_number} not found locally. Halting.`); hadFailure = true; break; }
          this.setProgress(slug, publishedCount + 1, limit * 2, `Publishing Ch ${ch.chapter_number} to ${lPlatform} (LIVE)...`);
          if (isDryRun) {
            addLog(`[DRY-RUN] Would publish Ch ${ch.chapter_number} to ${lPlatform} immediately.`);
          } else {
            unlockFile(localCh.file_path);
            try {
              const sync = new SyncClass();
              const res = await sync.publishChapter(slug, localCh, null);
              if (res.success) {
                if (isPatreon) { tracker.patreon_last = ch.chapter_number; tracker.patreon_published_count += 1; if (!tracker.patreon_scheduled) tracker.patreon_scheduled = []; tracker.patreon_scheduled.push({ chapter_number: ch.chapter_number, date: todayStr, edit_url: '' }); }
                else { tracker.kofi_last = ch.chapter_number; if (!tracker.kofi_scheduled) tracker.kofi_scheduled = []; tracker.kofi_scheduled.push({ chapter_number: ch.chapter_number, date: todayStr, edit_url: '' }); }
                tracker.last_batch_published!.push({ chapter_number: ch.chapter_number, platform: lPlatform, edit_url: res.published_url || '' });
                addLog(`[${lPlatform} LIVE] Ch ${ch.chapter_number} published.`);
                publishedCount++;
              } else {
                addLog(`[FAILED] ${lPlatform} Ch ${ch.chapter_number}: ${res.error}`);
                if (!tracker.failed_publishes) tracker.failed_publishes = [];
                tracker.failed_publishes.push({ chapter_number: ch.chapter_number, platform: lPlatform, error: res.error || 'Unknown', timestamp: new Date().toISOString() });
              }
            } catch (err: any) { addLog(`[ERROR] ${lPlatform} Ch ${ch.chapter_number}: ${err.message}`); }
            finally { try { lockFile(localCh.file_path); } catch {} }
          }
          saveTrackerAtomic(slug, tracker);
        }

        if (aheadChs.length > 0) {
          addLog(`Scheduling ${aheadChs.length} ${lPlatform} chapter(s) ahead with ${config.target_lead}-day lead.`);
          for (let i = 0; i < aheadChs.length; i++) {
            const ch = aheadChs[i];
            if (scheduled.some(s => s.chapter_number === ch.chapter_number)) continue;
            const localCh = localChapters.find(c => c.chapter_number === ch.chapter_number);
            if (!localCh) { addLog(`[SEQUENCE_GAP_ERROR] ${lPlatform} Ch ${ch.chapter_number} not found locally. Halting.`); hadFailure = true; break; }

            const publishDate = leadPublishDate(tracker, config, ch.chapter_number, scheduled);

            this.setProgress(slug, publishedCount + 1, limit * 2, `Scheduling Ch ${ch.chapter_number} on ${lPlatform}...`);
            if (isDryRun) {
              addLog(`[DRY-RUN] Would schedule Ch ${ch.chapter_number} on ${lPlatform} (${publishDate.slice(0, 10)})`);
            } else {
              unlockFile(localCh.file_path);
              try {
                const sync = new SyncClass();
                const res = await sync.publishChapter(slug, localCh, publishDate);
                if (res.success) {
                  // ponytail: don't bump the published counter for SCHEDULED (future-dated)
                  // chapters — only live publishes count toward the published lead. Bumping
                  // patreon_last here inflated fillTarget (patreon_last - target_lead) and made
                  // inkstone bulk-fill chapters live to "catch up" to a lead that didn't exist.
                  if (publishDate.slice(0, 10) <= todayStr) {
                    if (isPatreon) { tracker.patreon_last = ch.chapter_number; tracker.patreon_published_count += 1; }
                    else { tracker.kofi_last = ch.chapter_number; }
                  }
                  if (!tracker.patreon_scheduled) tracker.patreon_scheduled = [];
                  if (!tracker.kofi_scheduled) tracker.kofi_scheduled = [];
                  (isPatreon ? tracker.patreon_scheduled : tracker.kofi_scheduled).push({ chapter_number: ch.chapter_number, date: publishDate.slice(0, 10), edit_url: '' });
                  tracker.last_batch_published!.push({ chapter_number: ch.chapter_number, platform: lPlatform, edit_url: res.published_url || '' });
                  addLog(`[${lPlatform} Scheduled] Ch ${ch.chapter_number} for ${publishDate.slice(0, 10)}.`);
                  publishedCount++;
                } else {
                  addLog(`[FAILED] ${lPlatform} Ch ${ch.chapter_number}: ${res.error}`);
                  if (!tracker.failed_publishes) tracker.failed_publishes = [];
                  tracker.failed_publishes.push({ chapter_number: ch.chapter_number, platform: lPlatform, error: res.error || 'Unknown', timestamp: new Date().toISOString() });
                }
              } catch (err: any) { addLog(`[ERROR] ${lPlatform} Ch ${ch.chapter_number}: ${err.message}`); }
              finally { try { lockFile(localCh.file_path); } catch {} }
            }
            saveTrackerAtomic(slug, tracker);
          }
        } else if (liveChs.length === 0) {
          addLog(`${lPlatform}: No pending chapters.`);
        }

        if (leadCatchUp && !isDryRun && !chapterNumber && liveChs.length > 0 && isPatreon) {
          await this.verifyPatreonCatchUp(slug, addLog, tracker, targetLive, lastSched);
        }
      }

      // ============================================================
      // Phase 3: Publish to Ko-fi (simple schedule, only when NOT acting as lead)
      // ============================================================
      if (config.kofi_enabled && !getLeadPlatforms(config).includes('kofi') && !hadFailure) {
        const lastKofi = Math.max(
          tracker.kofi_last || 0,
          ...(tracker.kofi_scheduled?.map(s => s.chapter_number) || [])
        );
        const kofiChapters: { chapter_number: number; title: string }[] = [];
        if (chapterNumber) {
          const ch = localChapters.find(c => c.chapter_number === chapterNumber);
          const already = (tracker.kofi_last || 0) >= chapterNumber || tracker.kofi_scheduled?.some(s => s.chapter_number === chapterNumber);
          if (ch && !already) kofiChapters.push({ chapter_number: chapterNumber, title: ch.title });
          else if (ch && already) addLog(`[SKIP] Ko-fi Ch ${chapterNumber} already published/scheduled.`);
          else if (!ch) addLog(`[SEQUENCE_GAP_ERROR] Ko-fi Ch ${chapterNumber} not found locally. Halting.`);
          else if (!ch) hadFailure = true;
        } else {
          for (let cn = lastKofi + 1; cn <= lastKofi + limit; cn++) {
            const ch = localChapters.find(c => c.chapter_number === cn);
            if (ch) kofiChapters.push({ chapter_number: cn, title: ch.title });
          }
        }
        if (kofiChapters.length > 0) {
          const kofiSchedules = kofiChapters.map(ch => ({
            chapter_number: ch.chapter_number,
            title: ch.title,
            publish_date: leadPublishDate(tracker, config, ch.chapter_number, tracker.kofi_scheduled ?? []),
          }));
          for (const sch of kofiSchedules) {
            if (tracker.kofi_scheduled?.some(s => s.chapter_number === sch.chapter_number)) continue;
            if (hadFailure) break;
            const ch = localChapters.find(c => c.chapter_number === sch.chapter_number);
            if (!ch) {
              addLog(`[SEQUENCE_GAP_ERROR] Ko-fi Ch ${sch.chapter_number} not found locally. Halting.`);
              hadFailure = true;
              break;
            }
            this.setProgress(slug, publishedCount + 1, limit * 3, `Publishing Ch ${sch.chapter_number} to Ko-fi...`);
            if (isDryRun) {
              addLog(`[DRY-RUN] Would publish Ch ${sch.chapter_number} to Ko-fi (${sch.publish_date.slice(0, 10)})`);
            } else {
              unlockFile(ch.file_path);
              try {
                const sync = new KofiSync();
                const res = await sync.publishChapter(slug, ch, sch.publish_date);
                if (res.success) {
                  tracker.kofi_last = sch.chapter_number;
                  if (!tracker.kofi_scheduled) tracker.kofi_scheduled = [];
                  tracker.kofi_scheduled.push({ chapter_number: sch.chapter_number, date: sch.publish_date.slice(0, 10), edit_url: '' });
                  tracker.last_batch_published!.push({ chapter_number: sch.chapter_number, platform: 'kofi', edit_url: res.published_url || '' });
                  addLog(`[Ko-fi] Ch ${sch.chapter_number} published (${sch.publish_date.slice(0, 10)}).`);
                  publishedCount++;
                } else {
                  addLog(`[FAILED] Ko-fi Ch ${sch.chapter_number}: ${res.error}`);
                  if (!tracker.failed_publishes) tracker.failed_publishes = [];
                  tracker.failed_publishes.push({ chapter_number: sch.chapter_number, platform: 'kofi', error: res.error || 'Unknown', timestamp: new Date().toISOString() });
                }
              } catch (err: any) {
                addLog(`[ERROR] Ko-fi Ch ${sch.chapter_number}: ${err.message}`);
              } finally { try { lockFile(ch.file_path); } catch {} }
            }
            saveTrackerAtomic(slug, tracker);
          }
        } else {
          addLog('Ko-fi: No pending chapters.');
        }
      }

      tracker.execution_status = hadFailure ? 'failed' : 'idle';
      if (hadFailure) {
        addLog(`[FAILED] Publish cycle aborted due to failure. Published ${publishedCount} chapters before error.`);
        notifyFromEnv(`Publish Failed: ${slug}`, { slug, mode, dry_run: isDryRun, published_count: publishedCount, error: 'See logs for details' });
      }
      else addLog(`Publish cycle completed. Staged/Published ${publishedCount} chapter operations.`);

      tracker.last_run_logs = inst.activeRuns.get(slug) || [];
      saveTrackerAtomic(slug, tracker);
      sessionLog.record('publish_completed', { slug, mode, dry_run: isDryRun, published_count: publishedCount }, 'success');
      sessionLog.save();
      this.setProgress(slug, limit + 3, limit + 3, 'Finalizing...');
      inst.clearProgress();
      inst.activeRuns.delete(slug);
      inst.abortControllers.delete(slug);
      clearTimeout(timeout);

      return tracker;
    } catch (error: any) {
      addLog(`[CRITICAL ERROR] Publishing workflow failed: ${error.message || error}`);
      notifyFromEnv(`Publish Failed: ${slug}`, { slug, error: error.message, phase: 'publish' });
      tracker.execution_status = 'failed';
      tracker.last_run_logs = inst.activeRuns.get(slug) || [];
      saveTrackerAtomic(slug, tracker);
      sessionLog.record('publish_failed', { slug, error: error.message }, 'error');
      sessionLog.save();
      inst.clearProgress();
      inst.activeRuns.delete(slug);
      inst.abortControllers.delete(slug);
      clearTimeout(timeout);
      throw error;
    }
  }

  /**
   * Reschedule drafts that are stuck on Inkstone (published but saved as draft instead of scheduled).
   * These chapters exist on Inkstone but aren't in the scheduled_chapters array.
   */
  private static async _rescheduleDrafts(
    slug: string,
    addLog: (msg: string) => void,
    config: any,
    localChapters: any[]
  ): Promise<number> {
    const tracker = loadTracker(slug);
    const scheduledNums = new Set(
      (tracker.inkstone_scheduled || []).map((c: any) => c.chapter_number)
    );
    // Chapters between webnovel_last+1 and max scheduled that aren't scheduled = drafts
    const maxScheduled = Math.max(
      tracker.webnovel_last || 0,
      ...(tracker.inkstone_scheduled || []).map((c: any) => c.chapter_number)
    );
    const draftNums: number[] = [];
    for (let n = (tracker.webnovel_last || 0) + 1; n <= maxScheduled; n++) {
      if (!scheduledNums.has(n)) draftNums.push(n);
    }
    if (draftNums.length === 0) return 0;

    addLog(`[DRAFT RESCHEDULE] Found ${draftNums.length} unscheduled draft(s): ${draftNums.join(', ')}`);

    const scraper = new InkstoneScraper();
    const result = await platformConnector.getScrapingContext('inkstone', slug);
    if (!result) {
      addLog('[DRAFT RESCHEDULE] No Inkstone session available.');
      return 0;
    }
    const { context, cleanup } = result;

    try {
      await applyStealthToContext(context);
      const page = await context.newPage();
      try {
        // Capture auth header from SPA's own network traffic
        let authHeader = '';
        page.on('request', (req: any) => {
          if (!authHeader && req.url().includes('tauthorweb')) {
            const h = req.headers()['authorization'];
            if (h) authHeader = h;
          }
        });

        // Navigate to establish auth context
        await page.goto(`https://inkstone.webnovel.com/novels/view/${slug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForFunction(() => {
          try { return Object.keys(localStorage).some(k => k.toLowerCase().includes('token') || k.toLowerCase().includes('jwt')); }
          catch { return false; }
        }, { timeout: 30000 }).catch(() => page.waitForTimeout(10000));

        if (page.url().includes('/login')) {
          addLog('[DRAFT RESCHEDULE] Session expired, attempting SSO re-login...');
          const ok = await renewInkstoneSession(page, `https://inkstone.webnovel.com/novels/view/${slug}`);
          if (!ok) {
            addLog('[DRAFT RESCHEDULE] SSO re-login failed, skipping.');
            return 0;
          }
        }

        let cbid = await getCbid(page, slug);
        if (!cbid && /^\d{6,20}$/.test(slug)) cbid = slug;
        if (!cbid) {
          addLog('[DRAFT RESCHEDULE] Could not extract CBID.');
          return 0;
        }

        // Fetch all drafts from Inkstone
        const apiDrafts = await apiFetchDraftCcids(page, cbid, slug);
        addLog(`[DRAFT RESCHEDULE] Inkstone has ${apiDrafts.length} draft(s) total.`);

        // Match draft CCIDs to our draft chapter numbers
        const draftMap = new Map<number, { ccid: string; cvid?: string }>();
        for (const d of apiDrafts) {
          const m = d.title.match(/(?:chapter|ch\.?)\s*#?\s*(\d+)/i) || d.title.match(/(\d+)/);
          if (m) {
            const num = parseInt(m[1], 10);
            if (draftNums.includes(num)) {
              draftMap.set(num, { ccid: d.ccid, cvid: d.cvid });
            }
          }
        }

        if (draftMap.size === 0) {
          addLog('[DRAFT RESCHEDULE] No matching drafts found on Inkstone for unscheduled chapters.');
          return 0;
        }

        // Compute correct dates using the same schedule logic
        const inkBaseline = inkstoneBaseline(tracker, config);

        const draftChapters = [...draftMap.keys()]
          .sort((a, b) => a - b)
          .map(n => ({ chapter_number: n, title: '' }));
        const schedules = calculatePublishSchedules(
          draftChapters, inkBaseline, config.chapters_per_day, config.base_publish_time, config.timezone
        );

        let fixedCount = 0;
        for (const sch of schedules) {
          const draftInfo = draftMap.get(sch.chapter_number);
          if (!draftInfo) continue;

          // Convert ISO date to Inkstone format (date + time separately)
          const tzOffsetMs = getTZOffset(new Date(), config.timezone || '5.75');
          const inkDate = new Date(new Date(sch.publish_date).getTime() + tzOffsetMs);
          const dateStr = `${inkDate.getUTCFullYear()}/${String(inkDate.getUTCMonth() + 1).padStart(2, '0')}/${String(inkDate.getUTCDate()).padStart(2, '0')}`;
          const timeStr = `${String(inkDate.getUTCHours()).padStart(2, '0')}:${String(inkDate.getUTCMinutes()).padStart(2, '0')}`;

          try {
            // Get CVID if not cached
            let cvid = draftInfo.cvid;
            if (!cvid) {
              const editData = await page.evaluate(async ({ cbid, ccid, auth }: { cbid: string; ccid: string; auth: string }) => {
                const r = await fetch(`https://inkstone.webnovel.com/tauthorweb/chapter/editChapter?CBID=${cbid}&CCID=${ccid}`, {
                  headers: auth ? { Authorization: auth } : {}
                });
                return r.json();
              }, { cbid, ccid: draftInfo.ccid, auth: authHeader });
              if (editData.returnCode !== 200) {
                addLog(`[DRAFT RESCHEDULE] Ch ${sch.chapter_number}: editChapter failed: ${editData.returnMsg}`);
                continue;
              }
              cvid = editData.result?.cvid || editData.result?.CVID || editData?.result?.chapterInfoVo?.cvid || '';
            }
            if (!cvid) {
              addLog(`[DRAFT RESCHEDULE] Ch ${sch.chapter_number}: No CVID found.`);
              continue;
            }

            // Schedule via API
            const pubData = await page.evaluate(async ({ cbid, ccid, cvid, dateStr, timeStr, tzParam, auth }: any) => {
              const body = JSON.stringify({ CVID: cvid, CCID: ccid, CBID: cbid, hasTimer: 1, date: dateStr, time: timeStr, isTestRepeatability: 1, timezone: parseFloat(tzParam) });
              const r = await fetch('https://inkstone.webnovel.com/tauthorweb/chapter/publishChapter', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body });
              return r.json();
            }, { cbid, ccid: draftInfo.ccid, cvid, dateStr, timeStr, tzParam: config.timezone || '5.75', auth: authHeader });

            if (pubData.returnCode === 200) {
              addLog(`[DRAFT RESCHEDULE] Ch ${sch.chapter_number} scheduled for ${dateStr}`);
              fixedCount++;
              // Update tracker
              if (!tracker.inkstone_scheduled) tracker.inkstone_scheduled = [];
              tracker.inkstone_scheduled.push({
                chapter_number: sch.chapter_number,
                date: dateStr.replace(/\//g, '-'),
                edit_url: `https://inkstone.webnovel.com/novels/chapter/edit/${cbid}/${draftInfo.ccid}`,
                cvid,
              });
            } else {
              addLog(`[DRAFT RESCHEDULE] Ch ${sch.chapter_number}: publishChapter failed: ${pubData.returnMsg || ''}`);
            }
          } catch (err: any) {
            addLog(`[DRAFT RESCHEDULE] Ch ${sch.chapter_number}: ${err.message}`);
          }
          await new Promise(r => setTimeout(r, 1500));
        }

        if (fixedCount > 0) saveTrackerAtomic(slug, tracker);
        return fixedCount;
      } finally {
        try { await page.close(); } catch {}
      }
    } finally {
      await cleanup();
    }
  }

  static async executeResequence(
    slug: string,
    addLog: (msg: string) => void,
    config: any,
    localChapters: any[]
  ): Promise<void> {
    const inst = this.forSlug(slug);
    addLog('Running sequence verification...');
    const MAX_RESCHEDULE_ATTEMPTS = 20;

    // ponytail: the published boundary comes from the schedule itself, not from
    // webnovel_last or the live catalog — both can misread future-scheduled drafts as
    // "latest published" (webnovel_last was once bumped to 106 while the site actually
    // has 96) and warp the whole chain. Any chapter dated today-or-earlier is published;
    // the chain continues from that chapter's date (Ch 95 = 08-10 -> Ch 96 = 08-11).
    // ponytail: the published boundary comes from the schedule itself, not from
    // webnovel_last or the live catalog — both can misread future-scheduled drafts as
    // "latest published" (webnovel_last was once bumped to 106 while the site actually
    // has 96) and warp the whole chain. Any chapter dated today-or-earlier is published;
    // the chain continues from that chapter's date (Ch 95 = 08-10 -> Ch 96 = 08-11).
    // A chapter "published now" loses its date (scraper merges published chapters as
    // empty-date rows), so include empty-date rows too or the next run re-anchors one
    // day too early and re-targets Ch+1 at "today".
    const anchorTracker = loadTracker(slug);
    const today = new Date().toISOString().slice(0, 10);
    const chainRows = (anchorTracker.inkstone_scheduled || [])
      .filter((s: any) => !s.date || inkstoneDateToIso(s.date).slice(0, 10) <= today)
      .sort((a: any, b: any) => b.chapter_number - a.chapter_number);
    // ponytail: mutable — a publishNow advances the boundary so the next pass doesn't
    // re-target the next chapter at "today" and cascade-publish the whole tail.
    // Anchor on the highest chapter with a KNOWN date (a published-now chapter has an
    // empty date — anchoring there on "today" shifts the whole chain ~5 days early).
    const { anchor: derivedAnchor, highestDated } = deriveInkstoneAnchor(anchorTracker.inkstone_scheduled || [], today);
    let lastPub = chainRows[0]?.chapter_number ?? 0;
    let inkAnchor = derivedAnchor;
    let inkChainBase = highestDated;

    // Register abort controller if none exists (e.g. called standalone from API)
    if (!inst.abortControllers.has(slug)) {
      inst.abortControllers.set(slug, new AbortController());
    }
    const abortCtrl = inst.abortControllers.get(slug);
    const sessionLog = new SessionLog(path.join(WORKSPACE_ROOT, slug, '_logs'));
    const sessionLogForErrors = new SessionLog(path.join(WORKSPACE_ROOT, slug, '_logs'));

    const markFailed = (msg: string) => {
      addLog(`[CRITICAL ERROR] ${msg}`);
      const tracker = loadTracker(slug);
      tracker.execution_status = 'failed';
      tracker.last_run_logs = inst.activeRuns.get(slug) || tracker.last_run_logs;
      saveTrackerAtomic(slug, tracker);
      sessionLogForErrors.record('resequence_failed', { slug, error: msg }, 'error');
      sessionLogForErrors.save();
    };

     const scrapePlatform = async (platform: string, scheduleUnscheduled?: (page: any, cbid: string, allDrafts: Array<{ccid: string, chapter_number: number, date: string}>) => Promise<Map<number, string>>) => {
       const isEnabled = platform === 'inkstone' ? config.inkstone_enabled : platform === 'kofi' ? (config.kofi_enabled ?? false) : config.patreon_enabled;
       if (!isEnabled) return null;
        const profileDir = path.join(SHARED_DIR, 'browser_profile', slug);
        if (!platformHasCookies(platform, profileDir)) {
         addLog(`[SEQUENCE] ${platform} is not connected (no cookies) — skipping scrape.`);
         return null;
       }
       try {
         const scraper = platform === 'inkstone' ? new InkstoneScraper() : platform === 'kofi' ? new KofiSync() : new PatreonSync();
        const res = await scraper.scrapeState(slug, scheduleUnscheduled as any);
        return { scheduled_chapters: res.scheduled_chapters || [], result: res };
      } catch (err: any) {
        addLog(`[SEQUENCE] ${platform} scrape failed: ${err.message}`);
        return null;
      }
    };

    // Compute schedule for all inkstone drafts inline while browser page is open
    const inkScheduleCb = async (page: any, cbid: string, allDrafts: Array<{ccid: string, chapter_number: number, date: string}>) => {
      // ponytail: anchor = live publish date of the latest published chapter (Ch lastPub).
      let anchor = inkAnchor;
      // ponytail: a chapter can't be published in the future. Never anchor on a future
      // date — the schedule would shift forward and wipe already-scheduled chapters.
      if (anchor && anchor > new Date().toISOString().slice(0, 10)) {
        addLog(`[SEQUENCE] Anchor ${anchor} is in the future — ignoring (treating as unpublished).`);
        anchor = '';
      }
      if (!anchor) {
        const firstDate = inkstoneDateToIso([...allDrafts].filter(d => d.date && d.chapter_number > lastPub).sort((a, b) => a.chapter_number - b.chapter_number)[0]?.date || '');
        if (firstDate) anchor = new Date(new Date(firstDate).getTime() - 86400000).toISOString().slice(0, 10);
      }
      if (!anchor) anchor = new Date(Date.now()).toISOString().slice(0, 10);
      addLog(`[SEQUENCE] Inkstone anchor: Ch ${lastPub} published ${anchor}; next chapter = +1 day.`);
      // ponytail: chain over ALL dated drafts from the chain base onward, not just those
      // above lastPub — otherwise 101-105 (already-queued future chapters) get skipped and
      // 107+ restart from the anchor, assigning dates ~5 days too early. Published chapters
      // carry no date so they drop out; the apply loop below still skips <= lastPub.
      // ponytail: the chain is built from the TRACKER, not the live allDrafts — the live
      // scraper drops just-published chapters entirely (newOnly = drafts with a date), so a
      // chapter published today vanishes from allDrafts and the baseline shifts every later
      // chapter -1 day. The tracker keeps the boundary chapter dated today, exactly like the
      // audit that verified it. Expected dates are computed from the tracker; the apply loop
      // below still walks live allDrafts (skipping <= lastPub) so nothing published is touched.
      const sorted = (anchorTracker.inkstone_scheduled || [])
        .filter(c => c.date && inkstoneDateToIso(c.date).slice(0, 10) >= today)
        .sort((a, b) => a.chapter_number - b.chapter_number);
      // ponytail: gap-aware schedule (106 published-now leaves its slot empty, so 107 lands
      // one day later than a naive +1-per-item walk). Baseline = anchor + 1 day.
      const baseline = new Date(new Date(anchor).getTime() + 86400000).toISOString();
      const expected = computeExpectedSchedule(
        sorted.map(d => ({ chapter_number: d.chapter_number })),
        baseline, config.chapters_per_day, config.base_publish_time, config.timezone
      );
      // Normalize expected dates to Inkstone format (YYYY/MM/DD)
      const inkExpected = new Map<number, string>();
      const tzOffsetMs = getTZOffset(new Date(), config.timezone || '5.75');
      for (const es of expected) {
        const dt = new Date(es.expected_date);
        const inkDate = new Date(dt.getTime() + tzOffsetMs);
        inkExpected.set(es.chapter_number,
          `${inkDate.getUTCFullYear()}/${String(inkDate.getUTCMonth()+1).padStart(2,'0')}/${String(inkDate.getUTCDate()).padStart(2,'0')}`
        );
      }
      // ponytail: only report dates that were actually applied to Inkstone — otherwise
      // scrapeState overwrites live dates with expected ones and the audit lies, leaving
      // the real site corrupt while the run reports "all in order".
      const applied = new Map<number, string>();
      for (const draft of allDrafts) {
        // ponytail: never reschedule published chapters
        if (draft.chapter_number <= lastPub) continue;
        const expectedDate = inkExpected.get(draft.chapter_number);
        if (!expectedDate) { addLog(`[SEQUENCE] No expected date for Ch ${draft.chapter_number}`); continue; }
        // ponytail: skip chapters already set to the correct date (compare normalized YYYY-MM-DD)
        const draftIso = inkstoneDateToIso(draft.date || '');
        if (draftIso === expectedDate.replace(/\//g, '-')) { addLog(`[SEQUENCE] Ch ${draft.chapter_number} already at ${expectedDate}`); continue; }
        const ccid = draft.ccid;
        try {
          addLog(`[SEQUENCE] Scheduling Ch ${draft.chapter_number}: ${draft.date || 'none'} → ${expectedDate}`);
          const editData = await page.evaluate(async ({cbid, ccid}: {cbid: string, ccid: string}) => {
            const r = await fetch(`https://inkstone.webnovel.com/tauthorweb/chapter/editChapter?CBID=${cbid}&CCID=${ccid}`);
            return r.json();
          }, {cbid, ccid});
          if (draft.chapter_number === 299) addLog(`[SEQUENCE] DEBUG editChapter response: ${JSON.stringify(editData).slice(0, 500)}`);
          if (editData.returnCode !== 200) { addLog(`[SEQUENCE] inline editChapter failed for Ch ${draft.chapter_number}: ${editData.returnMsg}`); continue; }
          const cvid = editData.result?.cvid || editData.result?.CVID || editData?.result?.chapterInfoVo?.cvid || '';
          if (!cvid) { addLog(`[SEQUENCE] No CVID for Ch ${draft.chapter_number}`); continue; }
          const pubIsoc = expected.find(e => e.chapter_number === draft.chapter_number);
          const pubDt = pubIsoc ? new Date(pubIsoc.expected_date) : new Date();
          const timeStr = `${String(pubDt.getUTCHours()).padStart(2, '0')}:${String(pubDt.getUTCMinutes()).padStart(2, '0')}`;
          const pubData = await page.evaluate(async ({cbid, ccid, cvid, expectedDate, timeStr, tzParam}: {cbid: string, ccid: string, cvid: string, expectedDate: string, timeStr: string, tzParam: string}) => {
            const body = JSON.stringify({ CVID: cvid, CCID: ccid, CBID: cbid, hasTimer: 1, date: expectedDate, time: timeStr, isTestRepeatability: 1, timezone: parseFloat(tzParam) });
            const r = await fetch('https://inkstone.webnovel.com/tauthorweb/chapter/publishChapter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
            return r.json();
          }, {cbid, ccid, cvid, expectedDate, timeStr, tzParam: config.timezone || '5.75'});
          if (pubData.returnCode === 200 && pubData.result?.flag === true) {
            addLog(`[SEQUENCE] Scheduled Ch ${draft.chapter_number} at ${expectedDate}`);
            applied.set(draft.chapter_number, expectedDate);
          }
          else { addLog(`[SEQUENCE] publishChapter failed for Ch ${draft.chapter_number}: ${pubData.result?.msg || pubData.returnMsg || ''}`); }
        } catch (err: any) { addLog(`[SEQUENCE] inline schedule Ch ${draft.chapter_number} threw: ${err.message}`); }
        await new Promise(r => setTimeout(r, 1000));
      }
      return applied;
    };
let inkstonePlatformResult = await scrapePlatform('inkstone', inkScheduleCb);
    let inkstoneData = inkstonePlatformResult?.scheduled_chapters ? inkstonePlatformResult : null;
    let patreonData = await scrapePlatform('patreon');
    let kofiData = await scrapePlatform('kofi');

    // ponytail: merge tracker dates into scrape data (scheduled tab may be empty due to expired JWT)
    const tracker = loadTracker(slug);
    // ponytail: fall back to tracker cache when scrape returns nothing
    if ((!inkstonePlatformResult?.scheduled_chapters?.length) && tracker.inkstone_scheduled?.length) {
      addLog(`[SEQUENCE] Inkstone scrape returned 0 scheduled chapters — using tracker cache (${tracker.inkstone_scheduled.length} chapters)`);
      inkstonePlatformResult = { scheduled_chapters: tracker.inkstone_scheduled, result: null as any };
      inkstoneData = inkstonePlatformResult;
    }
    if ((!patreonData?.scheduled_chapters?.length) && tracker.patreon_scheduled?.length) {
      addLog(`[SEQUENCE] Patreon scrape returned 0 scheduled chapters — using tracker cache (${tracker.patreon_scheduled.length} chapters)`);
      patreonData = { scheduled_chapters: tracker.patreon_scheduled, result: null as any };
    }
    if ((!kofiData?.scheduled_chapters?.length) && tracker.kofi_scheduled?.length) {
      addLog(`[SEQUENCE] Ko-fi scrape returned 0 scheduled chapters — using tracker cache (${tracker.kofi_scheduled.length} chapters)`);
      kofiData = { scheduled_chapters: tracker.kofi_scheduled, result: null as any };
    }
    if (inkstoneData?.scheduled_chapters) {
      const trackerDates = new Map(
        (tracker.inkstone_scheduled || []).filter(c => c.date).map(c => [c.chapter_number, c.date])
      );
      for (const ch of inkstoneData.scheduled_chapters) {
        if (!ch.date && trackerDates.has(ch.chapter_number)) {
          ch.date = trackerDates.get(ch.chapter_number) ?? null;
        }
      }
    }
    if (patreonData?.scheduled_chapters) {
      const trackerDates = new Map(
        (tracker.patreon_scheduled || []).filter(c => c.date).map(c => [c.chapter_number, c.date])
      );
      for (const ch of patreonData.scheduled_chapters) {
        if (!ch.date && trackerDates.has(ch.chapter_number)) {
          ch.date = trackerDates.get(ch.chapter_number) ?? null;
        }
      }
    }
    if (kofiData?.scheduled_chapters) {
      const trackerDates = new Map(
        (tracker.kofi_scheduled || []).filter(c => c.date).map(c => [c.chapter_number, c.date])
      );
      for (const ch of kofiData.scheduled_chapters) {
        if (!ch.date && trackerDates.has(ch.chapter_number)) {
          ch.date = trackerDates.get(ch.chapter_number) ?? null;
        }
      }
    }

    // ponytail: persist fresh platform schedules so the publish phases see real platform
    // state even if a prior empty scrape wiped the tracker cache (the scrape result already
    // carries inline-reschedule-corrected dates).
    if (inkstoneData?.scheduled_chapters?.length) {
      tracker.inkstone_scheduled = inkstoneData.scheduled_chapters.map((c: any) => ({ chapter_number: c.chapter_number, date: c.date || '', edit_url: c.edit_url || '', cvid: c.cvid || '' }));
      // ponytail: the scraper merges published chapters (empty dates) into the array for
      // sequence audit; only dated entries are actually scheduled, so count those.
      tracker.inkstone_scheduled_count = tracker.inkstone_scheduled.filter((c: any) => c.date).length;
    }
    if (patreonData?.scheduled_chapters?.length) {
      tracker.patreon_scheduled = patreonData.scheduled_chapters.map((c: any) => ({ chapter_number: c.chapter_number, date: c.date || '', edit_url: c.edit_url || '' }));
      tracker.patreon_scheduled_count = tracker.patreon_scheduled.filter((c: any) => c.date).length;
    }
    if (kofiData?.scheduled_chapters?.length) {
      // ponytail: MERGE, not replace — the Ko-fi schedule API can return a partial window,
      // and replacing wiped previously-known scheduled chapters (e.g. 337-355) on every run.
      const cached = new Map((tracker.kofi_scheduled || []).map((c: any) => [c.chapter_number, c]));
      for (const c of kofiData.scheduled_chapters) {
        const existing = cached.get(c.chapter_number);
        cached.set(c.chapter_number, { chapter_number: c.chapter_number, date: c.date || existing?.date || '', edit_url: c.edit_url || existing?.edit_url || '' });
      }
      tracker.kofi_scheduled = [...cached.values()].sort((a: any, b: any) => a.chapter_number - b.chapter_number);
    }
    saveTrackerAtomic(slug, tracker);

    // Pre-compute total mismatches for progress tracking
    let inkAudit = inkstoneData?.scheduled_chapters.length ? auditSequence('inkstone', inkstoneData.scheduled_chapters, config.chapters_per_day, config.base_publish_time, config.timezone, inkAnchor || undefined) : null;
    // ponytail: lead platforms (Patreon & Ko-fi) are anchored to web dates - target_lead, not to
    // their own sequential chain — use the dedicated reference audit so stale-but-sequential dates
    // get corrected. Only run when Patreon is actually the lead.
    let patAudit = patreonData?.scheduled_chapters.length
      ? (() => {
          const base = auditSequence('patreon', patreonData.scheduled_chapters, config.chapters_per_day, config.base_publish_time, config.timezone);
          const ref = auditLeadDates(patreonData.scheduled_chapters, (tracker.inkstone_scheduled || []), config);
          const mergedMismatches = [...(base.mismatches || []).map(m => ({ ...m, actual_date: m.actual_date || '' })), ...(ref.mismatches || []).map(m => ({ ...m, actual_date: m.actual_date || '' }))];
          return { ...base, ...ref, mismatches: mergedMismatches, ok: base.missing.length === 0 && base.duplicates.length === 0 && base.mismatches.length === 0 && ref.mismatches.length === 0 };
        })()
      : null;
    let kofAudit: { ok: boolean; platform: string; mismatches: { chapter_number: number; actual_date: string; expected_date: string }[]; missing: number[]; duplicates: number[] } | null = kofiData?.scheduled_chapters.length
      ? (() => {
          const base = auditSequence('kofi', kofiData.scheduled_chapters, config.chapters_per_day, config.base_publish_time, config.timezone);
          const ref = auditLeadDates(kofiData.scheduled_chapters, (tracker.inkstone_scheduled || []), config);
          const mergedMismatches = [...(base.mismatches || []).map(m => ({ ...m, actual_date: m.actual_date || '' })), ...(ref.mismatches || []).map(m => ({ ...m, actual_date: m.actual_date || '' }))];
          return { ...base, ...ref, mismatches: mergedMismatches, ok: base.missing.length === 0 && base.duplicates.length === 0 && base.mismatches.length === 0 && ref.mismatches.length === 0 };
        })()
      : null;
    const totalMismatches = (inkAudit?.mismatches.length || 0) + (patAudit?.mismatches.length || 0) + (kofAudit?.mismatches.length || 0);
    let fixedCount = 0;
    let failureCount = 0;

    // ponytail: smart retry — up to 5 passes, re-audits after each fix pass
    const MAX_RETRY_PASSES = 5;
    for (let retryPass = 1; retryPass <= MAX_RETRY_PASSES; retryPass++) {
      // ponytail: reset per-pass reschedule budget. Previous code initialized resolvedCount
      // once outside the loop, so after pass 1 spent the 20-attempt budget, every later pass
      // hit the cap on the first mismatch and abandoned the remaining dates/dups permanently.
      let resolvedCount = 0;
      const rescheduledChs = new Set<number>();
      let passFixed = 0;
      let passDeletedDups = 0;

      for (const [audit, platform, data] of [
        [inkAudit, 'inkstone' as const, inkstoneData],
        [patAudit, 'patreon' as const, patreonData],
        [kofAudit, 'kofi' as const, kofiData],
      ] as const) {
        if (!audit || !data) continue;

        if (audit.ok) {
          addLog(`[SEQUENCE] ${platform}: All ${data.scheduled_chapters.length} chapters are in sequential order.`);
          continue;
        }

        if (audit.missing.length > 0) {
          addLog(`[SEQUENCE] ${platform}: Missing chapter numbers: ${audit.missing.join(', ')}`);
        }
        if (audit.duplicates.length > 0) {
          addLog(`[SEQUENCE] ${platform}: Duplicate chapter numbers: ${audit.duplicates.join(', ')}`);
        }

        // GAP FILLING: Auto-fill missing chapters if enabled and available locally.
        // ponytail: when a bulk inkstone fill is pending (inkFill.needed), Phase 1 owns
        // boundary+1..fillTarget (published live) and backfill deletes the mis-anchored
        // chain above it. Gap-fill would steal those chapters and schedule them onto the
        // future chain instead (run2: Ch 9/19-41 → 09/30, 10/01...). Skip it for inkstone.
        const inkFillPending = platform === 'inkstone' && computeInkFill(loadTracker(slug), config, getLeadPlatforms(config)).needed;
        if (config.auto_fill_gaps !== false && !inkFillPending) {
          const localChapterNumbers = localChapters.map(c => c.chapter_number);
          const gapFillTracker = loadTracker(slug);
          const maxScheduled = (data.scheduled_chapters || []).reduce((m: number, c: any) => Math.max(m, c.chapter_number), 0);
          // ponytail: derive the published boundary from the schedule itself, never from
          // tracker.webnovel_last — that field has gone stale (was once bumped to 106 while
          // the site had 96) and silently disabled gap-fill for every chapter below it.
          // deriveInkstoneAnchor gives the true last-published chapter from dated rows.
          const publishedBoundary = platform === 'inkstone'
            ? deriveInkstoneAnchor(data.scheduled_chapters as any, today).highestDated
            : platform === 'kofi' ? (gapFillTracker.kofi_last ?? 0) : gapFillTracker.patreon_last;
          const gapsToFill = findGapsToFill(
            data.scheduled_chapters.map((c: any) => c.chapter_number),
            localChapterNumbers,
            Math.max(...data.scheduled_chapters.map((c: any) => c.chapter_number), ...localChapterNumbers)
          )
            .filter(ch => ch > publishedBoundary)
            // ponytail: only fill interior gaps (chapters already scheduled around the gap).
            // New uploads past the platform's max scheduled chapter are handled by Phase 1/2.
            .filter(ch => ch <= maxScheduled);

          if (gapsToFill.length > 0) {
            addLog(`[GAP FILL] ${platform}: Found ${gapsToFill.length} fillable gaps: ${gapsToFill.join(', ')}`);
            const adapter = platform === 'inkstone' ? new InkstoneScraper() : platform === 'kofi' ? new KofiSync() : new PatreonSync();
            const gapTracker = loadTracker(slug);

            for (const gapCh of gapsToFill) {
              if (abortCtrl?.signal.aborted) { addLog('[GAP FILL] Aborted by user.'); break; }
              const localChap = localChapters.find(c => c.chapter_number === gapCh);
              if (!localChap) continue;

              // ponytail: use only dated (scheduled) chapters as the sequence anchor. The old
              // code built allWithGap from every scheduled chapter and grabbed `.find(c => c.date)`
              // off the desc-ordered scrape — the newest (2027-01-22) became the baseline, and
              // published chapters shifted the position math, producing future-dated gaps.
              const datedChs = (data.scheduled_chapters || []).filter((c: any) => c.date).sort((a: any, b: any) => a.chapter_number - b.chapter_number);
              // ponytail: sequence-first — anchor the gap chain to the last published chapter and
              // walk anchor+1 forward with ALL fillable gaps included, so each gap gets its own
              // sequential slot (Ch 97 = day after Ch 96). The old code baselined on the FIRST dated
              // chapter (07-30), which calculatePublishSchedules clamps up to "now", shifting every
              // slot by the first-dated distance (Ch 97 → 08-25) and colliding gaps onto the same day.
              let allWithGap: { chapter_number: number; title: string }[];
              let baseline: string;
              if (platform === 'inkstone') {
                const { anchor, highestDated } = deriveInkstoneAnchor(data.scheduled_chapters as any, today);
                const chainNum = new Set([...datedChs.map((c: any) => c.chapter_number), ...gapsToFill]);
                allWithGap = [...chainNum].filter(n => n > highestDated).sort((a, b) => a - b)
                  .map(n => ({ chapter_number: n, title: `Chapter ${n}` }));
                baseline = new Date(new Date(anchor).getTime() + 86400000).toISOString();
              } else {
                const firstDated = datedChs[0];
                allWithGap = [...datedChs.map((c: any) => ({ chapter_number: c.chapter_number, title: `Chapter ${c.chapter_number}` })), { chapter_number: gapCh, title: localChap.title }].sort((a, b) => a.chapter_number - b.chapter_number);
                baseline = firstDated?.date || new Date(Date.now() + 86400000).toISOString();
              }
              const expectedSchedules = calculatePublishSchedules(allWithGap, baseline, config.chapters_per_day, config.base_publish_time, config.timezone);
              const gapExpected = expectedSchedules.find(s => s.chapter_number === gapCh);
              const publishTime = gapExpected?.publish_date || new Date(Date.now() + 86400000).toISOString();
              // ponytail: the lead guard only holds LIVE fills (dated today). Scheduling a missing
              // chapter future-dated (Ch 166 → 10/01) restores the sequence without moving the
              // published lead, so it must NOT be held when the lead is already at target — that
              // previously left interior patreon gaps (e.g. Ch 166) permanently unfilled. A live
              // fill today would inflate the published lead past target, so those stay guarded.
              const isLiveFill = publishTime.slice(0, 10) <= today;
              if ((platform === 'patreon' || platform === 'kofi') && config.inkstone_enabled && isLiveFill && computeLeadDays(gapTracker, config) >= config.target_lead) {
                addLog(`[GAP FILL] skipped Ch ${gapCh} to avoid lead violation`);
                continue;
              }

              try {
                addLog(`[GAP FILL] ${platform}: Publishing missing Ch ${gapCh}...`);
                unlockFile(localChap.file_path);
                const res = await adapter.publishChapter(slug, localChap, publishTime);
                if (res.success) {
                  addLog(`[GAP FILL] ${platform}: Successfully filled gap at Ch ${gapCh}`);
                  lockFile(localChap.file_path);
                  if (platform === 'patreon') {
                    gapTracker.patreon_last = Math.max(gapTracker.patreon_last, gapCh);
                  } else if (platform === 'kofi') {
                    gapTracker.kofi_last = Math.max(gapTracker.kofi_last ?? 0, gapCh);
                  }
                } else {
                  addLog(`[GAP FILL] ${platform}: Failed to fill gap at Ch ${gapCh}: ${res.error}`);
                }
              } catch (err: any) {
                addLog(`[GAP FILL] ${platform}: Error filling gap at Ch ${gapCh}: ${err.message}`);
                try { lockFile(localChap.file_path); } catch {}
              }
            }
          }
        }

        const adapter = platform === 'inkstone' ? (new InkstoneScraper() as InkstoneScraper | PatreonSync | KofiSync) : platform === 'kofi' ? (new KofiSync() as InkstoneScraper | PatreonSync | KofiSync) : (new PatreonSync() as InkstoneScraper | PatreonSync | KofiSync);

        // ponytail: delete duplicate scheduled posts before rescheduling. Duplicate posts
        // (same chapter number scheduled on multiple posts) each get their own mismatch and
        // exhaust the reschedule cap. Keep one survivor per chapter — prefer the one already
        // on the expected date — and delete the rest.
        const dupNums = [...new Set(audit.duplicates || [])];
        for (const dupCh of dupNums) {
          if (abortCtrl?.signal.aborted) break;
          const entries = (data.scheduled_chapters || []).filter((c: any) => c.chapter_number === dupCh);
          if (entries.length < 2) continue;
          const expected = audit.mismatches?.find(m => m.chapter_number === dupCh)?.expected_date?.slice(0, 10);
          const survivor = entries.find((c: any) => expected && c.date?.slice(0, 10) === expected) || entries[0];
          for (const dup of entries) {
            if (dup === survivor) continue;
            if (!dup.edit_url) { addLog(`[SEQUENCE] ${platform}: Dup Ch ${dupCh} has no edit URL, skipping.`); continue; }
            addLog(`[SEQUENCE] ${platform}: Deleting duplicate post Ch ${dupCh}...`);
            try {
              const ok = await adapter.deleteChapter(dupCh, dup.edit_url, slug);
              if (ok) { passDeletedDups++; addLog(`[SEQUENCE] ${platform}: Deleted dup Ch ${dupCh}.`); }
              else { addLog(`[SEQUENCE] ${platform}: Failed to delete dup Ch ${dupCh}.`); }
            } catch (err: any) {
              addLog(`[SEQUENCE] ${platform}: Error deleting dup Ch ${dupCh}: ${err.message}`);
            }
            await new Promise(r => setTimeout(r, 1200));
          }
          // keep only the survivor in memory so the mismatch loop reschedules it, not a ghost
          data.scheduled_chapters = (data.scheduled_chapters || []).filter((c: any) => c.chapter_number !== dupCh || c === survivor);
        }

        const handledMismatchChs = new Set<number>();
        for (const mm of audit.mismatches) {
          if (abortCtrl?.signal.aborted) { addLog('[SEQUENCE] Aborted by user.'); break; }
          if (handledMismatchChs.has(mm.chapter_number)) continue; // duplicate posts already collapsed to one survivor
          handledMismatchChs.add(mm.chapter_number);
          if (failureCount >= 3) {
            markFailed(`Too many reschedule failures (${failureCount}). Stopping.`);
            inst.clearProgress();
            throw new Error(`Too many reschedule failures (${failureCount}). Stopping.`);
          }
          if (resolvedCount >= MAX_RESCHEDULE_ATTEMPTS) {
            addLog(`[SEQUENCE] Reached max reschedule attempts (${MAX_RESCHEDULE_ATTEMPTS}). Stopping.`);
            break;
          }
          resolvedCount++;
          this.setProgress(slug, resolvedCount, totalMismatches, `Rescheduling ${platform} Ch ${mm.chapter_number}...`);
          const ch = data.scheduled_chapters.find((c: any) => c.chapter_number === mm.chapter_number);
          if (!ch || !ch.edit_url) {
            addLog(`[SEQUENCE] ${platform}: Ch ${mm.chapter_number} needs reschedule but no edit URL found. Skipping.`);
            continue;
          }
          // ponytail: never send strictly-past dates to reschedule — platforms reject them and
          // the loop would burn the retry cap. Guard here so stale audits can't do it either.
          // "today" is still a valid target (publish now).
          if (mm.expected_date.slice(0, 10) < new Date().toISOString().slice(0, 10)) {
            addLog(`[SEQUENCE] ${platform}: Ch ${mm.chapter_number} correct date ${mm.expected_date.slice(0, 10)} already passed — skipping.`);
            continue;
          }
          addLog(`[SEQUENCE] ${platform}: Rescheduling Ch ${mm.chapter_number} (${mm.actual_date} → ${mm.expected_date})...`);
          try {
            let ok = false;
            if (platform === 'inkstone') {
              ok = await (adapter as InkstoneScraper).rescheduleChapter(mm.chapter_number, ch.edit_url, mm.expected_date, slug, ch.cvid);
            } else if (platform === 'kofi') {
              ok = await (adapter as KofiSync).rescheduleChapter(mm.chapter_number, ch.edit_url, mm.expected_date, slug);
            } else {
              ok = await (adapter as PatreonSync).rescheduleChapter(mm.chapter_number, ch.edit_url, mm.expected_date, slug);
            }
            if (ok) { passFixed++; rescheduledChs.add(mm.chapter_number); } else {
              addLog(`[SEQUENCE] ${platform}: Reschedule Ch ${mm.chapter_number} failed — skipping`);
              failureCount++;
            }
            // ponytail: a publishNow consumes today's slot — advance the chain boundary so
            // the next pass anchors Ch+1 at tomorrow instead of re-targeting today and
            // cascade-publishing the whole tail.
            if (ok && platform === 'inkstone' && mm.expected_date.slice(0, 10) === today) {
              lastPub = Math.max(lastPub, mm.chapter_number);
              inkAnchor = today;
              addLog(`[SEQUENCE] ${platform}: Ch ${mm.chapter_number} published now — advancing boundary to ${lastPub}/${inkAnchor}.`);
            }
          } catch (err: any) {
            addLog(`[SEQUENCE] ${platform}: Reschedule Ch ${mm.chapter_number} threw (${err.message}) — skipping`);
            failureCount++;
          }
          await new Promise(r => setTimeout(r, 1500));
        }
        if (abortCtrl?.signal.aborted) break;
      }

      if (abortCtrl?.signal.aborted) { inst.clearProgress(); return; }

      fixedCount += passFixed;

      if (passFixed > 0 || passDeletedDups > 0) {
        addLog(`[SEQUENCE] Pass ${retryPass}: Rescheduled ${passFixed}, deleted ${passDeletedDups} dup(s). Updating tracker dates...`);
        const now = new Date().toISOString();
        const reTracker = loadTracker(slug);
        for (const ch of (reTracker.inkstone_scheduled || [])) {
          if (rescheduledChs.has(ch.chapter_number)) {
            const expected = inkAudit?.mismatches?.find(m => m.chapter_number === ch.chapter_number)?.expected_date;
            if (expected) { ch.date = expected; }
          }
        }
        reTracker.last_scraped_at = now;
        reTracker.execution_status = 'running';
        saveTrackerAtomic(slug, reTracker);
        addLog(`[SEQUENCE] Pass ${retryPass}: Tracker updated. Re-auditing all platforms...`);

        // Re-scrape to verify fixes
        const reInkResult = await scrapePlatform('inkstone', inkScheduleCb);
        const rePatData = await scrapePlatform('patreon');
        const reKofData = await scrapePlatform('kofi');
        const reInkData = reInkResult?.scheduled_chapters ? reInkResult : null;
        inkAudit = reInkData?.scheduled_chapters.length ? auditSequence('inkstone', reInkData.scheduled_chapters, config.chapters_per_day, config.base_publish_time, config.timezone, inkAnchor || undefined) : null;
        patAudit = rePatData?.scheduled_chapters.length
          ? (() => {
              const base = auditSequence('patreon', rePatData.scheduled_chapters, config.chapters_per_day, config.base_publish_time, config.timezone);
              const ref = auditLeadDates(rePatData.scheduled_chapters, (loadTracker(slug).inkstone_scheduled || []), config);
              const mergedMismatches = [...(base.mismatches || []).map(m => ({ ...m, actual_date: m.actual_date || '' })), ...(ref.mismatches || []).map(m => ({ ...m, actual_date: m.actual_date || '' }))];
              return { ...base, ...ref, mismatches: mergedMismatches, ok: base.missing.length === 0 && base.duplicates.length === 0 && base.mismatches.length === 0 && ref.mismatches.length === 0 };
            })()
          : null;
        kofAudit = reKofData?.scheduled_chapters.length
          ? (() => {
              const base = auditSequence('kofi', reKofData.scheduled_chapters, config.chapters_per_day, config.base_publish_time, config.timezone);
              const ref = auditLeadDates(reKofData.scheduled_chapters, (loadTracker(slug).inkstone_scheduled || []), config);
              const mergedMismatches = [...(base.mismatches || []).map(m => ({ ...m, actual_date: m.actual_date || '' })), ...(ref.mismatches || []).map(m => ({ ...m, actual_date: m.actual_date || '' }))];
              return { ...base, ...ref, mismatches: mergedMismatches, ok: base.missing.length === 0 && base.duplicates.length === 0 && base.mismatches.length === 0 && ref.mismatches.length === 0 };
            })()
          : null;

        const remaining = (inkAudit?.mismatches.length || 0) + (patAudit?.mismatches.length || 0) + (kofAudit?.mismatches.length || 0);
        if (remaining === 0) {
          addLog(`[SEQUENCE] All chapters in sequential order after pass ${retryPass}.`);
          break;
        }
        if (retryPass < MAX_RETRY_PASSES) {
          addLog(`[SEQUENCE] ${remaining} mismatches remain — retry pass ${retryPass + 1}/${MAX_RETRY_PASSES}.`);
        } else {
          addLog(`[SEQUENCE] ${remaining} mismatches remain after ${MAX_RETRY_PASSES} passes — giving up.`);
        }
      } else if (retryPass === 1 && !inkstoneData?.scheduled_chapters.length && !patreonData?.scheduled_chapters.length && !kofiData?.scheduled_chapters.length) {
        addLog('[SEQUENCE] No scheduled chapters to verify.');
      } else if (retryPass === 1) {
        addLog('[SEQUENCE] All chapters already in sequential order.');
        break;
      } else {
        break;
      }
    }

    // ponytail: reschedule drafts that are stuck on Inkstone (not in scheduled array)
    // These chapters were published but saved as drafts instead of scheduled
    if (config.inkstone_enabled) {
      try {
        const draftRes = await this._rescheduleDrafts(slug, addLog, config, localChapters);
        if (draftRes > 0) addLog(`[DRAFT RESCHEDULE] Fixed ${draftRes} draft chapter(s).`);
      } catch (e: any) {
        addLog(`[DRAFT RESCHEDULE] Failed: ${e.message}`);
      }
    }

    const finalTracker = loadTracker(slug);
    if (finalTracker.execution_status === 'running') {
      finalTracker.execution_status = 'idle';
      saveTrackerAtomic(slug, finalTracker);
    }
    sessionLog.save();
    inst.clearProgress();
  }
}
