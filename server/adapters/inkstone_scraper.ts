/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PublishingAdapter, ScrapeResult, PublishResult } from './base';
import { ScheduledChapter } from '../core/models';
import { classifyError, validateSession } from '../core/error_codes';
import { platformConnector } from '../core/platform_connector';
import { fetchPublicCatalog, parseLatestChapter, parseAllChapterNumbers, parseCatalogSequentialNumbers, computeSequence } from '../core/webnovel_public';
import { mdToHtml, applyAuthorNote } from '../core/parser';
import { loadNovelConfig } from '../core/config';
import { loadTracker } from '../core/tracker';
import { bringToFront } from '../core/platform_connector';
import { humanDelay, postNavigationDelay, applyStealthToContext, evalWithTimeout, injectForceVisible, waitForNavOrTimeout, waitForLocalStorageAuth } from '../core/stealth';
import { apiFetchDraftCcids, getCbid, renewInkstoneSession, apiDeleteDraftByCcid } from './inkstone_api';

import logger from '../core/logger';
import * as fs from 'fs';
import * as path from 'path';
import { SHARED_DIR } from '../core/config';

// ponytail: cache JWT and cookies from successful scrape for reschedule to reuse
let _cachedJwt = '';
let _cachedCookies: any[] | null = null;

/**
 * Set the date and time in the Inkstone publish modal's pickers via their clickable
 * panels (calendar cells + hour/minute lists). Keyboard input is ignored because the
 * inputs are readonly, which is why the old save-as-draft + API flow was unreliable.
 */
async function setInkstoneModalDateTime(page: any, targetPublishDate: string, tz: string): Promise<void> {
  const tzOffsetMs = (parseFloat(tz) || 5.75) * 3600000;
  const dp = new Date(new Date(targetPublishDate).getTime() + tzOffsetMs);
  const dateStr = `${dp.getUTCFullYear()}/${String(dp.getUTCMonth() + 1).padStart(2, '0')}/${String(dp.getUTCDate()).padStart(2, '0')}`;
  const timeStr = `${String(dp.getUTCHours()).padStart(2, '0')}:${String(dp.getUTCMinutes()).padStart(2, '0')}`;
  logger.info(`[InkstoneScraper] Scheduling to ${dateStr} ${timeStr} via modal`);

  const [yyyy, mm, dd] = dateStr.split('/');
  await page.evaluate(() => {
    const picks = Array.from(document.querySelectorAll('.ant-modal .ant-picker'));
    const datePicker = picks.find(p => p.querySelector('input')?.placeholder === 'Select date');
    if (datePicker) (datePicker as HTMLElement).click();
  });
  await page.waitForTimeout(1200);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (let i = 0; i < 24; i++) {
    const hdr = await page.evaluate(() => {
      const dropdowns = Array.from(document.querySelectorAll('.ant-picker-dropdown')).filter(el => (el as HTMLElement).getClientRects().length);
      const d = dropdowns[dropdowns.length - 1];
      if (!d) return { month: '', year: '' };
      return { month: d.querySelector('.ant-picker-month-btn')?.textContent?.trim() || '', year: d.querySelector('.ant-picker-year-btn')?.textContent?.trim() || '' };
    });
    if (hdr.year === yyyy && hdr.month === months[parseInt(mm, 10) - 1]) break;
    await page.evaluate(() => {
      const dropdowns = Array.from(document.querySelectorAll('.ant-picker-dropdown')).filter(el => (el as HTMLElement).getClientRects().length);
      const d = dropdowns[dropdowns.length - 1];
      const next = d?.querySelector('.ant-picker-header-next-btn');
      if (next) (next as HTMLElement).click();
    });
    await page.waitForTimeout(400);
  }
  const dayTitle = `${yyyy}-${mm}-${dd}`;
  const clickedDay = await page.evaluate((t: string) => {
    const cell = Array.from(document.querySelectorAll('.ant-picker-dropdown td')).find(td => td.getAttribute('title') === t && !td.classList.contains('ant-picker-cell-disabled'));
    if (cell) { (cell as HTMLElement).click(); return true; }
    return false;
  }, dayTitle);
  logger.info(`[InkstoneScraper] modal date cell ${dayTitle} clicked=${clickedDay}`);
  await page.waitForTimeout(1000);

  const [hh, mm2] = timeStr.split(':');
  await page.evaluate(() => {
    const picks = Array.from(document.querySelectorAll('.ant-modal .ant-picker'));
    const timePicker = picks.find(p => p.querySelector('input')?.placeholder === 'Select time');
    if (timePicker) (timePicker as HTMLElement).click();
  });
  await page.waitForTimeout(1200);
  await page.evaluate((h: string) => {
    const dropdowns = Array.from(document.querySelectorAll('.ant-picker-dropdown')).filter(el => (el as HTMLElement).getClientRects().length);
    const d = dropdowns[dropdowns.length - 1];
    const lis = Array.from(d?.querySelectorAll('li') || []);
    const hour = lis.find(li => li.textContent?.trim() === h);
    if (hour) (hour as HTMLElement).click();
  }, hh);
  await page.waitForTimeout(400);
  await page.evaluate((m: string) => {
    const dropdowns = Array.from(document.querySelectorAll('.ant-picker-dropdown')).filter(el => (el as HTMLElement).getClientRects().length);
    const d = dropdowns[dropdowns.length - 1];
    const lis = Array.from(d?.querySelectorAll('li') || []);
    const mins = lis.filter(li => li.textContent?.trim() === m);
    if (mins.length) (mins[mins.length - 1] as HTMLElement).click();
  }, mm2);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const dropdowns = Array.from(document.querySelectorAll('.ant-picker-dropdown')).filter(el => (el as HTMLElement).getClientRects().length);
    const d = dropdowns[dropdowns.length - 1];
    const ok = d && Array.from(d.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'OK');
    if (ok) (ok as HTMLElement).click();
  });
  await page.waitForTimeout(1000);
}

export class InkstoneScraper extends PublishingAdapter {
  readonly platformName = 'inkstone' as const;

  async listNovels(): Promise<{ slug: string; name: string; genre: string; chapters_count: number; status: string }[]> {
    const result = await platformConnector.getScrapingContext('inkstone');
    if (!result) {
      throw new Error('Inkstone profile is not authenticated. Please connect first.');
    }
    const { context, cleanup } = result;

    await applyStealthToContext(context);
    const page = await context.newPage();

    try {
      await humanDelay();
      await page.goto('https://inkstone.webnovel.com/novels', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await postNavigationDelay();

      if (page.url().includes('/login') || page.url().includes('/signin')) {
        const ok = await renewInkstoneSession(page, 'https://inkstone.webnovel.com/novels');
        if (!ok) throw new Error('Redirected to login. Session may have expired.');
      }

      const novels = await page.evaluate(() => {
        const items = document.querySelectorAll('.novel-item, .creation-item, [data-novel]');
        return Array.from(items).map((el) => {
          const nameEl = el.querySelector('.novel-title, .title, h3, h4');
          const linkEl = el.querySelector('a[href*="/novels/"]');
          const href = linkEl?.getAttribute('href') || '';
          const slugMatch = href.match(/\/novels\/([^/]+)/);
          return {
            slug: slugMatch?.[1] || '',
            name: nameEl?.textContent?.trim() || 'Unknown',
            genre: '',
            chapters_count: 0,
            status: 'active',
          };
        }).filter((n: { slug: string }) => n.slug);
      });

      return novels;
    } catch (err: any) {
      const classified = classifyError(err, 'https://inkstone.webnovel.com/novels');
      throw new Error(`[${classified.code}] ${classified.message}`);
    } finally {
      try { await page.close(); } catch {}
      await cleanup();
    }
  }


  async scrapeState(novelSlug: string, scheduleDrafts?: (page: any, cbid: string, allDrafts: Array<{ccid: string, chapter_number: number, date: string}>) => Promise<Map<number, string>>): Promise<ScrapeResult> {
    logger.info(`[InkstoneScraper] Scraping state for: ${novelSlug}`);

    const pub = await this._scrapePublished(novelSlug);
    const inkstoneSequence = computeSequence(pub.numbers);

    let scheduledCount = 0;
    let latestScheduledDate: string | null = null;
    let scheduledNumbers: number[] = [];
    let draftNumbers: number[] = [];
    let scheduledChapters: { num: number; date: string; editUrl: string; cvid?: string }[] = [];
    let diag: string[] = [];
    try {
      const ctx = await platformConnector.getScrapingContext('inkstone', novelSlug);
      if (!ctx) {
        diag.push('getScrapingContext returned null - no cookies or CDP');
      } else {
        diag.push('ctx obtained');
        const p = await ctx.context.newPage();
        try {
          await applyStealthToContext(ctx.context);
          diag.push('navigating...');
          await p.goto(`https://inkstone.webnovel.com/novels/view/${novelSlug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          diag.push(`url=${p.url()}`);
          // ponytail: wait for SPA to refresh localStorage JWT before API calls
          await p.waitForFunction(() => {
            try {
              const ks = Object.keys(localStorage);
              return ks.some(k => k.toLowerCase().includes('token') || k.toLowerCase().includes('jwt'));
            } catch { return false; }
          }, { timeout: 30000 }).catch(() => p.waitForTimeout(10000));
          const lsKeys = await p.evaluate(() => JSON.stringify(Object.keys(localStorage))).catch(() => 'err');
          if (lsKeys !== 'err') diag.push(`ls_keys=${lsKeys.slice(0,300)}`);
          const pageText = await p.evaluate(() => document.body?.innerText?.slice(0, 500) || 'no body');
          diag.push(`body_start=${pageText.slice(0,200).replace(/\n/g,' ')}`);

          if (!p.url().includes('/login') && !p.url().includes('/signin')) {
            diag.push('on_dashboard');
            let cbid = await getCbid(p, novelSlug);
            if (!cbid && /^\d{6,20}$/.test(novelSlug)) { cbid = novelSlug; diag.push('cbid_from_slug'); }
              if (!cbid) {
                diag.push('no_cbid');
              } else {
                diag.push(`cbid=${cbid}`);
                // Navigate to chapters page so the SPA initializes auth for tauthorweb API
                const chUrl2 = `https://inkstone.webnovel.com/novels/view/${cbid}`;
                if (!p.url().startsWith(chUrl2)) {
                  diag.push('goto_chapters_for_api');
                  await p.goto(chUrl2, { waitUntil: 'domcontentloaded', timeout: 30000 });
                } else { diag.push('already_on_chapters'); }
let apiDrafts = await apiFetchDraftCcids(p, cbid);
                diag.push(`api_drafts=${apiDrafts.length}`);
                if (apiDrafts.length > 0) {
                  try { const jd = await p.evaluate(() => { const ks = Object.keys(localStorage); const tk = ks.find(k => k.toLowerCase().includes('token')||k.toLowerCase().includes('jwt')); return {ks: ks.slice(0,8).join(','), tk: tk ? localStorage.getItem(tk)||'' : ''}; }); _cachedJwt = jd.tk; diag.push(`jwt_keys=[${jd.ks}] jwt_found=${!!_cachedJwt}`); } catch {}
                  const parsed = apiDrafts.map(d => {
                    const m = d.title.match(/(?:chapter|ch\.?)\s*#?\s*(\d+)/i) || d.title.match(/(\d+)/);
                    const num = m ? parseInt(m[1], 10) : 0;
                    return { num, cvid: d.cvid || '', date: d.date || '', editUrl: `https://inkstone.webnovel.com/novels/chapter/edit/${cbid}/${d.ccid}` };
                  }).filter(c => c.num > 0 && c.num < 1000);
                  if (parsed.length > 0) {
                    const pubSet = new Set(pub.numbers);
                    const newOnly = parsed.filter(c => !pubSet.has(c.num) && c.date);
                    if (newOnly.length > 0) {
                      scheduledCount = newOnly.length;
                      scheduledNumbers = newOnly.map(c => c.num).sort((a, b) => a - b);
                      scheduledChapters = newOnly;
                      diag.push(`api_got ${newOnly.length} scheduled drafts (${parsed.length - newOnly.length} drafts without dates)`);
                    } else { diag.push(`api_all_already_published (${parsed.length} total)`); }
                  } else { diag.push('api_parsed_zero'); }

                  if (scheduleDrafts && scheduledChapters && scheduledChapters.length > 0) {
                    diag.push('scheduling ' + scheduledChapters.length + ' new drafts...');
                    const newDates = await scheduleDrafts(p, cbid, scheduledChapters.map(c => ({ ccid: c.editUrl.split('/').pop() || '', chapter_number: c.num, date: c.date })));
                    if (newDates && newDates.size > 0) {
                      for (const sch of scheduledChapters) {
                        if (newDates.has(sch.num)) sch.date = newDates.get(sch.num)!;
                      }
                      diag.push('updated ' + newDates.size + ' chapter dates from callback');
                    }
                  }
                  try {
                    const ctxCookies = await p.context().cookies();
                    _cachedCookies = ctxCookies.filter((c: any) => c.name.includes('aegis') || c.name.includes('session') || c.name.includes('token'));
                    if (_cachedCookies && _cachedCookies.length > 0) diag.push(`cached ${_cachedCookies.length} cookies`);
                  } catch {} // ponytail: save cookies for rescheduleChapter reuse
                }
            }
          } else {
            diag.push('on login page');
            // ponytail: try SSO auto-re-login before blocking on manual login
            const ssoOk = await renewInkstoneSession(p, `https://inkstone.webnovel.com/novels/view/${novelSlug}`);
            diag.push(`sso_attempt=${ssoOk}`);
            if (!ssoOk) {
              logger.warn(`[InkstoneScraper] Session expired. Waiting up to 30 min for manual login in the browser window...`);
              bringToFront();
            }
            const loginDeadline = Date.now() + 30 * 60 * 1000;
            while (Date.now() < loginDeadline) {
              await p.waitForTimeout(3000);
              try {
                const cur = p.url();
                if (!cur.includes('/login') && !cur.includes('/signin')) {
                  logger.info(`[InkstoneScraper] Login detected, continuing scrape.`);
                  diag.push('after_login');
                  let cbid = await getCbid(p, novelSlug);
                  if (!cbid && /^\d{6,20}$/.test(novelSlug)) { cbid = novelSlug; diag.push('cbid_from_slug'); }
                  if (!cbid) {
                    diag.push('no_cbid');
                  } else {
                    diag.push(`cbid=${cbid}`);
              // Navigate to chapters page so the SPA initializes auth for tauthorweb API
              const chUrl3 = `https://inkstone.webnovel.com/novels/view/${cbid}`;
              if (!p.url().startsWith(chUrl3)) {
                diag.push('goto_chapters_for_api');
                await p.goto(chUrl3, { waitUntil: 'domcontentloaded', timeout: 30000 });
              } else { diag.push('already_on_chapters'); }
              let apiDrafts = await apiFetchDraftCcids(p, cbid, novelSlug);
                    diag.push(`api_drafts=${apiDrafts.length}`);
                    if (apiDrafts.length > 0) {
                      try { const jd = await p.evaluate(() => { const ks = Object.keys(localStorage); const tk = ks.find(k => k.toLowerCase().includes('token')||k.toLowerCase().includes('jwt')); return {ks: ks.slice(0,8).join(','), tk: tk ? localStorage.getItem(tk)||'' : ''}; }); _cachedJwt = jd.tk; diag.push(`jwt_keys=[${jd.ks}] jwt_found=${!!_cachedJwt}`); } catch {}
                      const parsed = apiDrafts.map(d => {
                        const m = d.title.match(/(?:chapter|ch\.?)\s*#?\s*(\d+)/i) || d.title.match(/(\d+)/);
                        const num = m ? parseInt(m[1], 10) : 0;
                        return { num, cvid: d.cvid || '', date: d.date || '', editUrl: `https://inkstone.webnovel.com/novels/chapter/edit/${cbid}/${d.ccid}` };
                      }).filter(c => c.num > 0 && c.num < 1000);
                      if (parsed.length > 0) {
                        const pubSet = new Set(pub.numbers);
                        const newOnly = parsed.filter(c => !pubSet.has(c.num) && c.date);
                        if (newOnly.length > 0) {
                          scheduledCount = newOnly.length;
                          scheduledNumbers = newOnly.map(c => c.num).sort((a, b) => a - b);
                          scheduledChapters = newOnly;
                          diag.push(`api_got ${newOnly.length} scheduled drafts (${parsed.length - newOnly.length} drafts without dates)`);
                        } else { diag.push('api_all_already_published'); }
                      } else { diag.push('api_parsed_zero'); }
                      if (scheduleDrafts && scheduledChapters && scheduledChapters.length > 0) {
                        diag.push('scheduling ' + scheduledChapters.length + ' new drafts...');
                        const newDates = await scheduleDrafts(p, cbid, scheduledChapters.map(c => ({ ccid: c.editUrl.split('/').pop() || '', chapter_number: c.num, date: c.date })));
                        if (newDates && newDates.size > 0 && scheduledChapters) {
                          for (const sch of scheduledChapters) {
                            if (newDates.has(sch.num)) sch.date = newDates.get(sch.num)!;
                          }
                          diag.push('updated ' + newDates.size + ' chapter dates from callback');
                        }
                      }
                      try {
                        const ctxCookies = await p.context().cookies();
                        _cachedCookies = ctxCookies.filter((c: any) => c.name.includes('aegis') || c.name.includes('session') || c.name.includes('token'));
                        if (_cachedCookies && _cachedCookies.length > 0) diag.push(`cached ${_cachedCookies.length} cookies`);
                      } catch {} // ponytail: save cookies for rescheduleChapter reuse
                    }
                    break;
                }
                }
              } catch { break; }
            }
          }
                // Merge published chapters from public catalog into the scheduled array
                // so the tracker has a complete picture for sequence auditing.
                // Published chapters get empty dates (they're in the past, not scheduled).
                draftNumbers = scheduledChapters.map(c => c.num);
                const draftNums = new Set(draftNumbers);
                for (const pn of pub.numbers) {
                  if (!draftNums.has(pn)) scheduledChapters.push({ num: pn, date: '', editUrl: '' });
                }
                scheduledChapters.sort((a, b) => b.num - a.num);
                scheduledNumbers = [...new Set([...scheduledNumbers, ...pub.numbers])].sort((a, b) => a - b);
        } catch (e) {
          diag.push(`scrape_error=${e}`);
          logger.warn(`[InkstoneScraper] Dashboard scrape failed: ${e}`);
        } finally { try { await p.close(); } catch {} }
        await ctx.cleanup();
      }
    } catch (e) { diag.push(`outer_error=${e}`); }

    const allNumbers = [...new Set([...pub.numbers, ...scheduledNumbers])].sort((a, b) => a - b);
    const inkstoneSeq = computeSequence(allNumbers);
    const inkstoneFullSequence = scheduledNumbers.length > 0 ? inkstoneSeq : inkstoneSequence;

    logger.info(`[InkstoneScraper] Scraped: Published=${pub.count}, Scheduled=${scheduledCount}`);
    logger.info(`[InkstoneScraper] DIAG: ${diag.join(' | ')}`);
    try { fs.writeFileSync(path.join(SHARED_DIR, 'debug', `diag_${Date.now()}.log`), diag.join('\n'), 'utf8'); } catch {}

    // ponytail: filter out draft/scheduled numbers from the catalog to get truly published chapters
    const draftSet = new Set(draftNumbers);
    const firstDatedNum = Math.min(Number.MAX_SAFE_INTEGER, ...scheduledChapters.filter(c => c.date).map(c => c.num));
    const publishedOnly = (draftSet.size > 0 && isFinite(firstDatedNum) && firstDatedNum !== Number.MAX_SAFE_INTEGER)
      ? pub.numbers.filter(n => n < firstDatedNum)
      : pub.numbers;
    return {
      last_published_chapter: publishedOnly.length > 0 ? Math.max(...publishedOnly) : 0,
      published_count: publishedOnly.length,
      scheduled_count: scheduledCount,
      latest_scheduled_date: latestScheduledDate,
      scraped_items: [],
      sequence: inkstoneFullSequence,
      scheduled_chapters: scheduledChapters.map(c => ({ chapter_number: c.num, date: c.date, edit_url: c.editUrl, cvid: c.cvid })),
      _diagnostic: diag.join(' | '),
    } as ScrapeResult;
  }

  private async _scrapePublished(novelSlug: string): Promise<{ count: number; numbers: number[] }> {
    try {
      const html = await fetchPublicCatalog(novelSlug);
      const numbers = parseCatalogSequentialNumbers(html);
      return { count: numbers.length, numbers };
    } catch (e) {
      logger.warn(`[InkstoneScraper] Public catalog failed: ${e}`);
    }
    return { count: 0, numbers: [] };
  }

  async publishChapter(
    novelSlug: string,
    chapter: { chapter_number: number; title: string; body: string; frontmatter?: Record<string, any> },
    targetPublishDate: string | null
  ): Promise<PublishResult> {
    logger.info(`[InkstoneScraper] Publishing Ch ${chapter.chapter_number}: "${chapter.title}"`);

    const result = await platformConnector.getScrapingContext('inkstone', novelSlug);
    if (!result) {
      return { success: false, chapter_number: chapter.chapter_number, error: 'Inkstone profile not authenticated.' };
    }
    const { context, cleanup } = result;

    await applyStealthToContext(context);
    const page = await context.newPage();

    try {
      await humanDelay();
      const createUrl = `https://inkstone.webnovel.com/novels/chapter/create/${novelSlug}`;
      await page.goto(createUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await postNavigationDelay();

      const sessionCheck = await validateSession(page, 'inkstone');
      if (!sessionCheck.valid) {
        const ok = await renewInkstoneSession(page, createUrl);
        if (!ok) {
          return { success: false, chapter_number: chapter.chapter_number, error: `[SESSION_EXPIRED] ${sessionCheck.reason}` };
        }
      }

      // Wait for title input to render on the create page
      const titleField = await page.waitForSelector('input[name="title"], #chapter-title, input.ant-input, input[placeholder*="title" i]', { timeout: 20000 }).catch(() => null);
      if (!titleField) {
        const curUrl = page.url();
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
        try { await page.screenshot({ path: path.join(SHARED_DIR, 'debug', `inkstone-no-title-${Date.now()}.png`), fullPage: true }); } catch {}
        logger.error(`[InkstoneScraper] Title input not found on create page. URL: ${curUrl}, body: ${bodyText.slice(0, 200)}`);
        // Fallback: try dashboard modal approach
        logger.warn('[InkstoneScraper] Falling back to dashboard modal approach');
        await page.goto(`https://inkstone.webnovel.com/novels/view/${novelSlug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await postNavigationDelay();
        const fbCreateBtn = await page.waitForSelector('button:has-text("CREATE CHAPTER")', { timeout: 15000 }).catch(() => null);
        if (!fbCreateBtn) {
          try { await page.screenshot({ path: path.join(SHARED_DIR, 'debug', `inkstone-fallback-fail-${Date.now()}.png`), fullPage: true }); } catch {}
          return { success: false, chapter_number: chapter.chapter_number, error: `[CREATE_PAGE_FAILED] URL: ${curUrl}` };
        }
        await fbCreateBtn.click();
        const fbModal = await page.waitForSelector('.ant-modal', { timeout: 15000 }).catch(() => null);
        if (!fbModal) return { success: false, chapter_number: chapter.chapter_number, error: '[FALLBACK_MODAL_NOT_FOUND]' };
        await page.waitForTimeout(1000);
      }
      await page.waitForTimeout(500);

      const inConfig = loadNovelConfig(novelSlug);
      if (!targetPublishDate) {
        // ponytail: defense-in-depth — block LIVE publishes when inkstone's published position is
        // already ahead of the lead fill target (lead_last - target_lead). Scheduling future-dated
        // is always allowed (it maintains the daily lead); only a live publish would shrink it.
        // Mirrors computeInkFill in runner.ts; the runner plan is the primary gate, this catches
        // direct/manual live calls too.
        const tracker = loadTracker(novelSlug);
        const leadLast = inConfig.patreon_enabled
          ? (tracker.patreon_last || 0)
          : inConfig.kofi_enabled ? (tracker.kofi_last || 0) : 0;
        const fillTarget = Math.max(0, leadLast - (inConfig.target_lead || 20));
        if ((tracker.webnovel_last || 0) > fillTarget) {
          logger.warn(`[InkstoneScraper] Blocked LIVE publish of Ch ${chapter.chapter_number}: inkstone published position (${tracker.webnovel_last}) is ahead of the lead fill target (${fillTarget}). Scheduling future-dated is allowed.`);
          return { success: false, chapter_number: chapter.chapter_number, error: '[LEAD_HOLD] Inkstone is ahead of the lead fill target; live publishing blocked, schedule a future date instead.' };
        }
      }
      const chOverride = chapter.frontmatter?.author_note_override;
      const inkstoneNote = chOverride ? (chapter.frontmatter?.author_note_inkstone !== false) : (inConfig.author_note_inkstone !== false);
      const bodyWithNote = inkstoneNote ? applyAuthorNote(chapter.body, chOverride ? (chapter.frontmatter?.author_note || '') : inConfig.author_note, chOverride ? (chapter.frontmatter?.author_note_position || 'bottom') : inConfig.author_note_position) : chapter.body;
      const bodyHtml = mdToHtml(bodyWithNote);
      await page.evaluate((c: { title: string; body: string }) => {
        const titleInput = document.querySelector('input[name="title"], #chapter-title, input.ant-input, input[placeholder*="title" i]') as HTMLInputElement;
        if (titleInput) {
          const ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (ns) ns.call(titleInput, c.title);
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
          titleInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Try TinyMCE first, then native textarea setter
        const win = window as any;
        if (win.tinymce && win.tinymce.activeEditor && !win.tinymce.activeEditor.isHidden()) {
          win.tinymce.activeEditor.setContent(c.body);
        } else {
          const bodyInput = document.querySelector('textarea[name="content"], #chapter-editor, textarea.ant-input, div[contenteditable="true"]') as HTMLTextAreaElement;
          if (bodyInput) {
            const ns = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (ns) ns.call(bodyInput, c.body);
            bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
            bodyInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }, { title: chapter.title, body: bodyHtml });
      await humanDelay();

      // ponytail: schedule directly via the publish modal — flip the "Publish Timer"
      // switch ON and set date/time through the clickable picker panels. No draft step,
      // no CCID/CVID lookup needed (the old API flow left chapters as drafts on failure).
      // Click "Publish" to open the publish modal, then Confirm to publish immediately
      const publishBtn = await page.waitForSelector('button:has-text("Publish")', { timeout: 15000 }).catch(() => null);
      if (!publishBtn) {
        try { await page.screenshot({ path: path.join(SHARED_DIR, 'debug', `inkstone-no-publish-btn-${Date.now()}.png`), fullPage: true }); } catch {}
        logger.error('[InkstoneScraper] Publish button not found');
        return { success: false, chapter_number: chapter.chapter_number, error: '[PUBLISH_BTN_NOT_FOUND]' };
      }
      await page.evaluate(() => { const btns = Array.from(document.querySelectorAll('button')); const b = btns.find(b => b.textContent?.includes('Publish')); if (b) b.click(); });
      await humanDelay();

      await page.waitForSelector('.ant-modal', { timeout: 15000 }).catch(() => null);
      await humanDelay();

      if (targetPublishDate) {
        // Flip the "Publish Timer" switch ON (enables the pickers)
        await page.evaluate(() => {
          const sw = document.querySelector('.ant-modal .ant-switch') as HTMLElement;
          if (sw) sw.click();
        });
        await humanDelay();
        await setInkstoneModalDateTime(page, targetPublishDate, inConfig?.timezone || '5.75');
      }

      await page.waitForSelector('button:has-text("Confirm"):visible, button:has-text("Schedule"):visible', { timeout: 15000 }).catch(() => null);
      await humanDelay();
      const confirmBtn = page.locator('button:has-text("Confirm"):visible, button:has-text("Schedule"):visible').first();
      if (await confirmBtn.isEnabled().catch(() => false)) {
        await confirmBtn.click();
      } else {
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const b = btns.find(b => /^(Confirm|Schedule)$/i.test((b.textContent || '').trim()));
          if (b) { (b as HTMLElement).click(); }
        });
      }
      // ponytail: publishing navigates to the chapter edit page — wait for that
      // instead of a fixed 8s. Falls back to a short settle on timeout so the
      // error-check below still runs.
      await waitForNavOrTimeout(page, /\/novels\/chapter\/edit\/\d{6,20}\/\d{6,20}/, 20000);

      const inkErr = await page.$('.ant-message-error, .ant-notification-notice-error');
      if (inkErr) {
        const t = await inkErr.evaluate((el: any) => el.textContent || '');
        logger.error(`[InkstoneScraper] Publish error: ${t}`);
        return { success: false, chapter_number: chapter.chapter_number, error: t };
      }

      // Success: extract edit URL from page after save (page may navigate to /edit/CBID/CCID)
      const afterUrl = page.url();
      const editMatch = afterUrl.match(/\/edit\/(\d{6,20})\/(\d{6,20})/);
      const editUrl = editMatch
        ? `https://inkstone.webnovel.com/novels/chapter/edit/${editMatch[1]}/${editMatch[2]}`
        : '';
      logger.info(`[InkstoneScraper] Ch ${chapter.chapter_number} published successfully. (${afterUrl}) editUrl=${editUrl || 'none'}`);
      return {
        success: true,
        chapter_number: chapter.chapter_number,
        published_url: editUrl || `https://webnovel.com/book/${novelSlug}/chapter-${chapter.chapter_number}`,
        edit_url: editUrl,
      };
    } catch (err: any) {
      const classified = classifyError(err, `https://inkstone.webnovel.com/novels/chapter/create/${novelSlug}`);
      logger.error(`[InkstoneScraper] Publish failed: ${classified.code} - ${err.message}`);
      try { await page.screenshot({ path: `shared/debug/inkstone_publish_fail_${Date.now()}.png` }); } catch {}
      return { success: false, chapter_number: chapter.chapter_number, error: `[${classified.code}] ${err.message}` };
    } finally {
      try { await page.close(); } catch {}
      await cleanup();
    }
  }

  async rescheduleChapter(chapterNumber: number, editUrl: string, newDate: string, novelSlug: string, cvid?: string): Promise<boolean> {
    logger.info(`[InkstoneScraper] Rescheduling Ch ${chapterNumber} to ${newDate}`);
    const result = await platformConnector.getScrapingContext('inkstone', novelSlug);
    if (!result) return false;
    const { context, cleanup } = result;
    const page = await context.newPage();
    try {
      // Extract CBID, CCID from editUrl
      const urlMatch = editUrl.match(/\/edit\/(\d{6,20})\/(\d{6,20})/);
      if (!urlMatch) { logger.error(`[InkstoneScraper] Could not parse editUrl: ${editUrl}`); return false; }
      const cbid = urlMatch[1];
      const ccid = urlMatch[2];

      // ponytail: establish SPA auth by navigating dashboard first (not edit page)
      const novelUrl = `https://inkstone.webnovel.com/novels/view/${cbid}`;
      
      // Capture the Authorization header from page's own API calls
      let authHeader = '';
      page.on('request', (req: any) => {
        if (!authHeader && req.url().includes('tauthorweb')) {
          const h = req.headers()['authorization'];
          if (h) authHeader = h;
        }
      });
      
      await page.goto(novelUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // ponytail: SPA auth — wait for the localStorage JWT instead of a fixed 10s.
      await waitForLocalStorageAuth(page, 25000);

      if (page.url().includes('/login') || page.url().includes('/signin')) {
        const ok = await renewInkstoneSession(page, novelUrl);
        if (!ok) {
          logger.error(`[InkstoneScraper] Session expired for Ch ${chapterNumber} reschedule`);
          return false;
        }
      }

      // ponytail: prefer passed cvid; fall back to paginateDraftList, then editChapter API
      let cvidToUse = cvid || '';
      if (!cvidToUse) {
        const novelCBID = novelSlug || cbid;
        const drafts = await apiFetchDraftCcids(page, novelCBID, novelSlug);
        const match = drafts.find(d => d.ccid === ccid);
        if (match) {
          cvidToUse = match.cvid;
          logger.info(`[InkstoneScraper] Got CVID from draft list for Ch ${chapterNumber}: ${cvidToUse}`);
        }
      } else {
        logger.info(`[InkstoneScraper] Using cached CVID for Ch ${chapterNumber}: ${cvidToUse}`);
      }
      // ponytail: fallback — editChapter API may return CVID even for scheduled chapters
      if (!cvidToUse) {
        logger.warn(`[InkstoneScraper] CCID ${ccid} not in draft list for Ch ${chapterNumber}, trying editChapter API...`);
        try {
          const editResult = await page.evaluate(async ({ cbidVal, ccidVal, auth }: { cbidVal: string; ccidVal: string; auth: string }) => {
            const r = await fetch(`https://inkstone.webnovel.com/tauthorweb/chapter/editChapter?CBID=${cbidVal}&CCID=${ccidVal}`, {
              headers: auth ? { Authorization: auth } : {}
            });
            return r.json();
          }, { cbidVal: cbid, ccidVal: ccid, auth: authHeader });
          if (editResult.returnCode === 200) {
            cvidToUse = editResult.result?.selectedCVID || editResult.result?.cvid || editResult.result?.CVID || editResult.result?.chapterInfoVo?.cvid || '';
            if (cvidToUse) logger.info(`[InkstoneScraper] Got CVID from editChapter API for Ch ${chapterNumber}: ${cvidToUse}`);
          } else {
            logger.warn(`[InkstoneScraper] editChapter API returned ${editResult.returnCode} for Ch ${chapterNumber}: ${editResult.returnMsg}`);
          }
        } catch (err: any) {
          logger.warn(`[InkstoneScraper] editChapter API threw for Ch ${chapterNumber}: ${err.message}`);
        }
      }
      if (!cvidToUse) {
        logger.error(`[InkstoneScraper] Could not obtain CVID for Ch ${chapterNumber} (CCID=${ccid})`);
        return false;
      }

      // Call publishChapter API directly (use evaluate for SPA auth)
      // newDate is an ISO string in UTC; convert to novel's configured timezone for Inkstone API
      const dt = new Date(newDate);
      const rsConfig = loadNovelConfig(novelSlug);
      const tzOffset = parseFloat(rsConfig.timezone || '5.75') * 60 * 60 * 1000;
      let inkDate = new Date(dt.getTime() + tzOffset);
      // ponytail: the platform rejects past publish times. A chain anchored to "now"
      // can target today's slot only if that time is still in the future; when targeting
      // today and the configured time has already passed, clamp to the next full hour
      // (platform wants round slots, e.g. 12:00) with margin so the chapter can still
      // release today instead of the whole pass failing on it.
      const localNow = new Date(Date.now() + tzOffset);
      if (inkDate.toISOString().slice(0, 10) === localNow.toISOString().slice(0, 10) && inkDate.getTime() <= localNow.getTime()) {
        const bumped = new Date(localNow.getTime() + 30 * 60 * 1000);
        bumped.setUTCHours(bumped.getUTCHours() + 1, 0, 0, 0);
        logger.warn(`[InkstoneScraper] Clamping Ch ${chapterNumber} publish time to next hour (target ${inkDate.toISOString()} is in the past)`);
        inkDate = bumped;
      }
      const dateStr = `${inkDate.getUTCFullYear()}/${String(inkDate.getUTCMonth()+1).padStart(2,'0')}/${String(inkDate.getUTCDate()).padStart(2,'0')}`;
      const timeStr = `${String(inkDate.getUTCHours()).padStart(2,'0')}:${String(inkDate.getUTCMinutes()).padStart(2,'0')}`;
      const tzParam = rsConfig.timezone || '5.75';

      // ponytail: a chapter slated for today cannot be timer-scheduled (platform rejects
      // same-day). It's the next sequential chapter after the last published one, so publish
      // it immediately (hasTimer: 0) instead of failing the pass on it.
      const publishNow = inkDate.toISOString().slice(0, 10) === localNow.toISOString().slice(0, 10);

      logger.info(`[InkstoneScraper] Reschedule API call: CBID=${cbid}, CCID=${ccid}, CVID=${cvidToUse}, date=${dateStr}, time=${timeStr}, tz=${tzParam}, publishNow=${publishNow}`);
      const pubData = await page.evaluate(async ({cbid, ccid, cvid: cvidVal, dateStr, timeStr, tzParam, auth, publishNowVal}: {cbid: string, ccid: string, cvid: string, dateStr: string, timeStr: string, tzParam: string, auth: string, publishNowVal: boolean}) => {
        const body = publishNowVal
          ? JSON.stringify({ CVID: cvidVal, CCID: ccid, CBID: cbid, hasTimer: 0, isTestRepeatability: 1, timezone: parseFloat(tzParam) })
          : JSON.stringify({ CVID: cvidVal, CCID: ccid, CBID: cbid, hasTimer: 1, date: dateStr, time: timeStr, isTestRepeatability: 1, timezone: parseFloat(tzParam) });
        const r = await fetch('https://inkstone.webnovel.com/tauthorweb/chapter/publishChapter', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body });
        return r.json();
      }, {cbid, ccid, cvid: cvidToUse!, dateStr, timeStr, tzParam, auth: authHeader, publishNowVal: publishNow});
      logger.info(`[InkstoneScraper] Reschedule API response: ${JSON.stringify(pubData).slice(0, 500)}`);
      if (pubData.returnCode !== 200 || pubData.result?.flag !== true) {
        const detail = pubData.returnMsg || pubData.result?.msg || JSON.stringify(pubData).slice(0, 500);
        logger.error(`[InkstoneScraper] publishChapter failed for Ch ${chapterNumber}: ${detail}`);
        return false;
      }
      logger.info(`[InkstoneScraper] Ch ${chapterNumber} ${publishNow ? 'published now' : `rescheduled to ${newDate}`} (API)`);
      return true;
    } catch (err: any) {
      logger.error(`[InkstoneScraper] Reschedule Ch ${chapterNumber} failed: ${err.message}`);
      return false;
    } finally {
      try { await page.close(); } catch {}
      await cleanup();
    }
  }

  async updateChapter(
    novelSlug: string,
    chapter: { chapter_number: number; title: string; body: string; frontmatter?: Record<string, any> },
    editUrl: string
  ): Promise<PublishResult> {
    logger.info(`[InkstoneScraper] Updating Ch ${chapter.chapter_number}: "${chapter.title}"`);

    const result = await platformConnector.getScrapingContext('inkstone', novelSlug);
    if (!result) {
      return { success: false, chapter_number: chapter.chapter_number, error: 'Inkstone profile not authenticated.' };
    }
    const { context, cleanup } = result;

    await applyStealthToContext(context);
    const page = await context.newPage();

    try {
      await humanDelay();
      await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await postNavigationDelay();
      if (page.url().includes('/login')) {
        const ok = await renewInkstoneSession(page, editUrl);
        if (!ok) {
          return { success: false, chapter_number: chapter.chapter_number, error: '[SESSION_EXPIRED] Session expired.' };
        }
        await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await postNavigationDelay();
      }

      const upConfig = loadNovelConfig(novelSlug);
      const upOverride = chapter.frontmatter?.author_note_override;
      const upInkstone = upOverride ? (chapter.frontmatter?.author_note_inkstone !== false) : (upConfig.author_note_inkstone !== false);
      const upBodyWithNote = upInkstone ? applyAuthorNote(chapter.body, upOverride ? (chapter.frontmatter?.author_note || '') : upConfig.author_note, upOverride ? (chapter.frontmatter?.author_note_position || 'bottom') : upConfig.author_note_position) : chapter.body;
      await page.evaluate((c: { title: string; body: string }) => {
        const titleInput = document.querySelector('input[name="title"], #chapter-title') as HTMLInputElement;
        if (titleInput) {
          const ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (ns) { ns.call(titleInput, c.title); }
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
          titleInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const bodyInput = document.querySelector('textarea[name="content"], #chapter-editor') as HTMLTextAreaElement;
        if (bodyInput) {
          const ns = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (ns) { ns.call(bodyInput, c.body); }
          bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
          bodyInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, { title: chapter.title, body: upBodyWithNote });

      await humanDelay();
      await page.click('button[type="submit"], .btn-save, .save-btn');
      await page.waitForTimeout(5000);

      const inkErr = await page.$('.ant-message-error, .ant-notification-notice-error');
      if (inkErr) {
        const t = await inkErr.evaluate((el: any) => el.textContent || '');
        logger.error(`[InkstoneScraper] Update error: ${t}`);
        return { success: false, chapter_number: chapter.chapter_number, error: t };
      }

      logger.info(`[InkstoneScraper] Ch ${chapter.chapter_number} updated successfully.`);
      return { success: true, chapter_number: chapter.chapter_number };
    } catch (err: any) {
      const classified = classifyError(err, editUrl);
      logger.error(`[InkstoneScraper] Update Ch ${chapter.chapter_number} failed: ${classified.code} - ${err.message}`);
      return { success: false, chapter_number: chapter.chapter_number, error: `[${classified.code}] ${err.message}` };
    } finally {
      try { await page.close(); } catch {}
      await cleanup();
    }
  }

  async deleteChapter(chapterNumber: number, editUrl: string, novelSlug?: string): Promise<boolean> {
    logger.info(`[InkstoneScraper] Deleting Ch ${chapterNumber}`);
    const result = await platformConnector.getScrapingContext('inkstone', novelSlug);
    if (!result) return false;
    const { context, cleanup } = result;
    await applyStealthToContext(context);
    const page = await context.newPage();
    try {
      // Primary path: delete draft by CCID via API (proven to work for scheduled drafts)
      const urlMatch = editUrl.match(/\/chapter\/edit\/(\d+)\/(\d+)/);
      if (urlMatch) {
        const cbid = urlMatch[1];
        const ccid = urlMatch[2];
        await humanDelay();
        await page.goto(`https://inkstone.webnovel.com/novels/view/${cbid}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await postNavigationDelay();
        if (page.url().includes('/login')) {
          const ok = await renewInkstoneSession(page, `https://inkstone.webnovel.com/novels/view/${cbid}`);
          if (!ok) return false;
        }
        const apiOk = await apiDeleteDraftByCcid(page, cbid, ccid);
        if (apiOk) {
          logger.info(`[InkstoneScraper] Ch ${chapterNumber} deleted via API`);
          await page.waitForTimeout(2000);
          return true;
        }
        logger.warn(`[InkstoneScraper] API delete failed for Ch ${chapterNumber}, falling back to edit page DOM`);
      }

      await humanDelay();
      await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await postNavigationDelay();
      if (page.url().includes('/login')) {
        const ok = await renewInkstoneSession(page, editUrl);
        if (!ok) return false;
      }

      await injectForceVisible(page);
      const deleted = await evalWithTimeout<string>(page, `() => {
        try {
          const trySelectors = ['.ant-btn-dangerous', 'button[data-action="delete"]'];
          let btn = null;
          for (const sel of trySelectors) {
            btn = document.querySelector(sel);
            if (btn && btn.offsetParent !== null) break;
          }
          if (!btn) {
            const allBtns = document.querySelectorAll('button, a');
            for (const b of allBtns) {
              const t = (b.textContent || '').trim().toLowerCase();
              if ((t === 'delete' || t === 'trash') && b.offsetParent !== null) { btn = b; break; }
            }
          }
          if (!btn) return 'no_delete_btn';

          btn.click();

          setTimeout(() => {
            document.querySelectorAll('.ant-modal-confirm-btns button, .ant-modal-footer button, .ant-btn-primary').forEach((b) => {
              const t = (b.textContent || '').trim().toLowerCase();
              if (t === 'yes' || t === 'ok' || t === 'delete' || t === 'confirm') { (b).click(); }
            });
          }, 500);

          return 'deleted';
        } catch (e) { return 'error:' + e.message; }
      }`);

      if (deleted === 'no_delete_btn') {
        logger.warn(`[InkstoneScraper] No delete button on edit page for Ch ${chapterNumber}, trying dashboard and API...`);
        const slugMatch = editUrl.match(/novels\/(?:view\/)?([^/?#]+)/);
        if (!slugMatch) { logger.error(`[InkstoneScraper] Could not extract slug from editUrl: ${editUrl}`); return false; }
        const slug = slugMatch[1];

        // Try direct API delete from authenticated page context
        try {
          const apiResult = await evalWithTimeout<string>(page, `async () => {
            try {
              const params = new URLSearchParams(window.location.search);
              const getParam = (name) => {
                const el = document.querySelector('meta[name="' + name + '"], input[name="' + name + '"]');
                return el ? (el.getAttribute('content') || el.getAttribute('value')) : null;
              };
              const cbid = getParam('CBID') || params.get('CBID');
              const ccid = getParam('CCID') || params.get('CCID');
              if (!cbid || !ccid) return 'no_api_params';
              const res = await fetch('/tauthorweb/chapter/deleteChapter', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ CBID: cbid, CCID: ccid, 'chapterIds[' + ${chapterNumber} + ']': ${chapterNumber} })
              });
              return res.ok ? 'api_deleted' : 'api_failed:' + res.status;
            } catch (e) { return 'api_error:' + e.message; }
          }`);
          if (apiResult === 'api_deleted') {
            logger.info(`[InkstoneScraper] Ch ${chapterNumber} deleted via API`);
            await page.waitForTimeout(2000);
            return true;
          }
          logger.warn(`[InkstoneScraper] API delete failed (${apiResult}), falling back to dashboard DOM`);
        } catch { /* fall through to dashboard DOM */ }

        await page.goto(`https://inkstone.webnovel.com/novels/view/${slug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        if (page.url().includes('/login')) {
          const ok = await renewInkstoneSession(page, `https://inkstone.webnovel.com/novels/view/${slug}`);
          if (!ok) return false;
        }

        await injectForceVisible(page);
        const dashDeleted = await evalWithTimeout<string>(page, `(chNum) => {
          const items = document.querySelectorAll('li.ant-list-item');
          for (let i = 0; i < items.length; i++) {
            const text = items[i].textContent || '';
            if (text.includes('Chapter ' + chNum) || text.includes('Ch. ' + chNum) || text.includes('Ch ' + chNum) || text.includes('#' + chNum)) {
              items[i].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }));
              const btn = items[i].querySelector('.ant-btn-dangerous');
              if (btn) { btn.click(); return 'clicked'; }
              return 'no_danger_btn';
            }
          }
          return 'not_found';
        }`, chapterNumber);

        if (dashDeleted === 'not_found' || dashDeleted === 'no_danger_btn') { logger.error(`[InkstoneScraper] Chapter ${chapterNumber} not found or no delete button on dashboard`); return false; }
        await page.waitForTimeout(2000);
        await evalWithTimeout(page, `() => { document.querySelectorAll('.ant-modal-confirm-btns .ant-btn-primary').forEach(b => (b).click()); }`);
      }

      if (typeof deleted === 'string' && deleted.startsWith('error:')) { logger.error(`[InkstoneScraper] Delete Ch ${chapterNumber} evaluate error: ${deleted}`); return false; }

      await page.waitForTimeout(3000);
      logger.info(`[InkstoneScraper] Ch ${chapterNumber} deleted`);
      return true;
    } catch (err: any) {
      logger.error(`[InkstoneScraper] Delete Ch ${chapterNumber} failed: ${err.message}`);
      return false;
    } finally {
      try { await page.close(); } catch {}
      await cleanup();
    }
  }




}
