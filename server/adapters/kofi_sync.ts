/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PublishingAdapter, ScrapeResult, PublishResult } from './base';
import { ScheduledChapter } from '../core/models';
import { computeSequence } from '../core/webnovel_public';
import { mdToHtml, applyAuthorNote } from '../core/parser';
import { classifyError } from '../core/error_codes';
import { platformConnector } from '../core/platform_connector';
import { platformHasCookies } from '../core/credential_manager';
import { loadNovelConfig, SHARED_DIR } from '../core/config';
import { humanDelay, postNavigationDelay, applyStealthToContext } from '../core/stealth';
import logger from '../core/logger';
import * as path from 'path';

export class KofiSync extends PublishingAdapter {
  readonly platformName = 'kofi' as const;

  async scrapeState(novelSlug: string): Promise<ScrapeResult> {
    logger.info(`[KofiSync] Scraping state for: ${novelSlug}`);
    const result = await platformConnector.getScrapingContext('kofi', novelSlug);
    if (!result) {
      throw new Error('Ko-fi profile not authenticated.');
    }
    const { context, cleanup } = result;
    await applyStealthToContext(context);
    const page = await context.newPage();

     try {
       const config = loadNovelConfig(novelSlug);
       // ponytail: navigate to the public posts page — /manage/posts redirects to the
       // dashboard which shows only recent posts. The public URL lists all posts.
       const targetUrl = config.kofi_url || `https://ko-fi.com/${novelSlug}/posts`;
       logger.info(`[KofiSync] Navigating to ${targetUrl}`);
       await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
       await postNavigationDelay();
       // ponytail: wait for posts to render (they load via JS after page load)
       await page.waitForSelector('a.content-text-post-header', { timeout: 15000 }).catch(() => {});

       if (page.url().includes('/account/login')) {
         throw new Error('[SESSION_EXPIRED] Redirected to login page.');
       }

          const posts = await page.evaluate((): { number: number; title: string; status: string; date: string; postId: string }[] => {
            const months: Record<string, string> = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
            const items: { number: number; title: string; status: string; date: string; postId: string }[] = [];
            // ponytail: scheduled posts have a 📝 icon in div.kfds-srf-empty-state-post.
            // Track which sections each chapter appears in, plus whether it has the draft icon.
            const postSections = new Map<number, { inRecent: boolean; inFeed: boolean; hasDraftIcon: boolean; el: HTMLElement | null; recentEl: HTMLElement | null }>();
            document.querySelectorAll<HTMLElement>('div.recent-posts-title a[href*="/post/"]').forEach((a: HTMLElement) => {
              const text = a.innerText || '';
              const chMatch = text.match(/(?:Ch(?:apter)?\s*|#\s*)(\d+)/i);
              if (!chMatch) return;
              const num = parseInt(chMatch[1], 10);
              if (!postSections.has(num)) postSections.set(num, { inRecent: false, inFeed: false, hasDraftIcon: false, el: null, recentEl: null });
              postSections.get(num)!.inRecent = true;
              postSections.get(num)!.recentEl = a;
              if (!postSections.get(num)!.el) postSections.get(num)!.el = a;
              // Check for 📝 icon (scheduled/draft indicator)
              const row = a.closest('.row');
              if (row && row.querySelector('[class*="empty-state-post"]')) {
                postSections.get(num)!.hasDraftIcon = true;
              }
            });
            document.querySelectorAll<HTMLElement>('div.feeditem-unit a.content-text-post-header').forEach((a: HTMLElement) => {
              const text = a.innerText || '';
              const chMatch = text.match(/(?:Ch(?:apter)?\s*|#\s*)(\d+)/i);
              if (!chMatch) return;
              const num = parseInt(chMatch[1], 10);
              if (!postSections.has(num)) postSections.set(num, { inRecent: false, inFeed: false, hasDraftIcon: false, el: null, recentEl: null });
              postSections.get(num)!.inFeed = true;
              postSections.get(num)!.el = a;
            });
            // ponytail: distinguish scheduled vs published by date. Scheduled posts have
            // today's date or future dates; published posts have past dates.
            const todayStr = new Date().toISOString().slice(0, 10);
            postSections.forEach((info, num) => {
              // Parse the date from the post - use recent element if available (has date in expected format)
              const anchor = (info.recentEl || info.el) as HTMLAnchorElement;
              const href = anchor.href || '';
              let date = '';
              const parent = anchor.closest('.recent-posts-title') || anchor.closest('.feeditem-unit') || anchor.parentElement;
              const parentText = (parent as HTMLElement)?.innerText || '';
              const iso = parentText.match(/(\d{4}-\d{2}-\d{2})/);
              if (iso) {
                date = iso[1];
              } else {
                const short = parentText.match(/(\d{1,2})\s+([A-Z][a-z]{2})/);
                if (short && months[short[2]]) {
                  date = new Date().getFullYear() + '-' + months[short[2]] + '-' + String(parseInt(short[1], 10)).padStart(2,'0');
                }
              }
              // Scheduled if date is today or later
              const isScheduled = date >= todayStr;
              items.push({
                number: num,
                title: `Chapter ${num}`,
                status: isScheduled ? 'scheduled' : 'published',
                date: date,
                postId: href.split('/').pop() || ''
              });
            });
if (items.length === 0) {
         const body = document.body ? (document.body.innerText || '') : '';
         const re = /(?:Ch(?:apter)?\s*|#\s*)(\d+)/gi;
         let match: RegExpExecArray | null;
         while ((match = re.exec(body)) !== null) {
           const num = parseInt(match[1], 10);
           if (!items.some((i) => i.number === num)) {
             items.push({ number: num, title: match[0], status: 'published', date: '', postId: '' });
           }
         }
       }
       return items;
     });

       const published = posts.filter((p: { number: number; title: string; status: string; date: string; postId: string }) => p.status === 'published');
      const pubNumbers = published.map((p: { number: number }) => p.number);
      const lastPub = pubNumbers.length ? Math.max(...pubNumbers) : 0;

      // ponytail: scheduled posts are only exposed to the authenticated creator via this API —
      // the public feed (LoadPageFeed) shows only published posts. Fetch it while on ko-fi.com.
      let scheduled: { number: number; title: string; date: string; postId: string; editUrl?: string }[] = [];
      try {
        scheduled = await page.evaluate(async () => {
          const r = await fetch('/api/schedule/drafts-and-schedule?probablecountrycode=null', {
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
          });
          if (!r.ok) return [];
          const json = await r.json();
          const items = Array.isArray(json.Items) ? json.Items : [];
          const out: { number: number; title: string; date: string; postId: string; editUrl?: string }[] = [];
          for (const it of items) {
            const m = /(?:Chapter|Ch|#)\s*(\d+)/i.exec(it.Title || '');
            if (!m || !it.IsScheduled || !it.DateTimeScheduled) continue;
            out.push({
              number: parseInt(m[1], 10),
              title: it.Title,
              date: String(it.DateTimeScheduled).slice(0, 10),
              postId: (it.UrlEdit || '').split('/').pop() || '',
              editUrl: it.UrlEdit || '',
            });
          }
          return out;
        });
      } catch (err: any) {
        logger.warn(`[KofiSync] Drafts/schedule API fetch failed: ${err.message}`);
      }
      logger.info(`[KofiSync] Schedule API returned ${scheduled.length} scheduled posts for ${novelSlug}.`);

      const scheduledChapters: ScheduledChapter[] = scheduled.map((s: { number: number; date: string; postId: string; editUrl?: string }) => ({
        chapter_number: s.number,
        date: s.date,
        edit_url: s.editUrl || (s.postId ? `https://ko-fi.com/blog/editor/${s.postId}?mode=edit` : undefined)
      }));
      const sequence = computeSequence(pubNumbers);

      logger.info(`[KofiSync] Scraped ${published.length} published (latest Ch ${lastPub}), ${scheduled.length} scheduled.`);
      return {
        last_published_chapter: lastPub,
        published_count: published.length,
        scheduled_count: scheduled.length,
        latest_scheduled_date: scheduled.reduce((m, s) => (s.date > m ? s.date : m), '') || null,
        scraped_items: posts,
        sequence,
        scheduled_chapters: scheduledChapters
      };
    } finally {
      try { await page.close(); } catch {}
      await cleanup();
    }
  }

  async publishChapter(
    novelSlug: string,
    chapter: { chapter_number: number; title: string; body: string; frontmatter?: Record<string, any> },
    targetPublishDate: string | null
  ): Promise<PublishResult> {
    logger.info(`[KofiSync] Publishing Ch ${chapter.chapter_number}: "${chapter.title}"`);
    const result = await platformConnector.getScrapingContext('kofi', novelSlug);
    if (!result) {
      return { success: false, chapter_number: chapter.chapter_number, error: 'Ko-fi profile not authenticated.' };
    }
    const { context, cleanup } = result;
    await applyStealthToContext(context);
    const page = await context.newPage();

    try {
      await page.goto('https://ko-fi.com/blog/editor?back=true', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await postNavigationDelay();

      if (page.url().includes('/account/login') || page.url().includes('/auth')) {
        return { success: false, chapter_number: chapter.chapter_number, error: '[SESSION_EXPIRED] Ko-fi login required.' };
      }

      // Ponytail: session expired screenshot for debugging
      const urlAfterNav = page.url();
      if (!urlAfterNav.includes('/blog/editor')) {
        try { await page.screenshot({ path: `shared/debug/kofi_session_fail_${Date.now()}.png` }); } catch {}
        return { success: false, chapter_number: chapter.chapter_number, error: `[SESSION_EXPIRED] Redirected to "${urlAfterNav}" instead of editor.` };
      }

      const config = loadNovelConfig(novelSlug);
      const chOverride = chapter.frontmatter?.author_note_override;
      const kofiNote = chOverride ? (chapter.frontmatter?.author_note_kofi !== false) : (config.author_note_kofi !== false);
      const bodyWithNote = kofiNote ? applyAuthorNote(chapter.body, chOverride ? (chapter.frontmatter?.author_note || '') : config.author_note, chOverride ? (chapter.frontmatter?.author_note_position || 'bottom') : config.author_note_position) : chapter.body;
      const bodyHtml = mdToHtml(bodyWithNote);

      const postTitle = `Chapter ${chapter.chapter_number}: ${chapter.title}`;

      const filled = await page.evaluate(({ title, body }: { title: string; body: string }) => {
        const titleInput = document.querySelector('#blogPostTitle') as HTMLInputElement;
        if (titleInput) {
          titleInput.value = title;
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const editor = document.querySelector('[contenteditable="true"]') as HTMLElement;
        if (editor) {
          editor.innerHTML = body;
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        return false;
      }, { title: postTitle, body: bodyHtml });

      if (!filled) {
        logger.error('[KofiSync] Editor elements not found');
        return { success: false, chapter_number: chapter.chapter_number, error: '[EDITOR_FILL_FAILED] Ko-fi editor elements not found.' };
      }

      // Set audience tier if configured — match by value or by visible label text
      const kofiTierId = config.kofi_tier_id || chapter.frontmatter?.kofi_tier_id || '';
      if (kofiTierId) {
        await page.evaluate((tierVal: string) => {
          const sel = document.querySelector('select[name="postAudience"]') as HTMLSelectElement;
          if (sel) {
            for (const opt of sel.options) {
              if (opt.value === tierVal || opt.text === tierVal) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); break; }
            }
          }
        }, kofiTierId);
      }

      await humanDelay();

      if (targetPublishDate) {
        const d = new Date(targetPublishDate);
        const dateStr = d.toISOString().slice(0, 10);
        const timeStr = config.base_publish_time || '12:00';
        await page.evaluate(({ dateStr, timeStr }: { dateStr: string; timeStr: string }) => {
          const form = document.getElementById('submitform') as HTMLFormElement;
          if (!form) return;
          const schedDate = form.querySelector('input[name="scheduledDate"]') as HTMLInputElement;
          const schedTime = form.querySelector('input[name="scheduledTime"]') as HTMLInputElement;
          if (schedDate) { schedDate.value = dateStr; }
          if (schedTime) { schedTime.value = timeStr; }
        }, { dateStr, timeStr });

        // ponytail: read back date value to verify UI accepted it
        const readback = await page.evaluate(() => {
          const el = document.querySelector('input[name="scheduledDate"]') as HTMLInputElement;
          return el?.value || '';
        });
        if (!readback.includes(dateStr) && !readback.includes(dateStr.replace(/-/g, ''))) {
          logger.error(`[KofiSync] Date picker readback mismatch (got "${readback}", expected ${dateStr}). Aborting.`);
          return { success: false, chapter_number: chapter.chapter_number, error: `[DATE_VERIFICATION_FAILED] Picker showed "${readback}" instead of ${dateStr}` };
        }

        await page.evaluate(({ dateStr, timeStr }: { dateStr: string; timeStr: string }) => {
          const form = document.getElementById('submitform') as HTMLFormElement;
          if (!form) return;
          const existing = form.querySelector('input[name="submit"]');
          if (existing) existing.remove();
          const si = document.createElement('input');
          si.type = 'hidden'; si.name = 'submit'; si.value = 'schedule';
          form.appendChild(si);
          HTMLFormElement.prototype.submit.call(form);
        }, { dateStr, timeStr });

        // Wait for redirect away from editor (success) or stay (error)
        try {
          await page.waitForFunction(() => !window.location.href.includes('/blog/editor'), { timeout: 15000 });
        } catch {
          const errMsg = await page.evaluate(() => {
            const errEl = document.querySelector('.error-message, [class*="error"], .validation-summary-errors, .field-validation-error');
            return errEl ? (errEl as HTMLElement).innerText.trim() : null;
          });
          if (errMsg) {
            logger.error(`[KofiSync] Submit error: ${errMsg}`);
            return { success: false, chapter_number: chapter.chapter_number, error: `[SUBMIT_ERROR] ${errMsg}` };
          }
          await page.waitForTimeout(5000);
        }
      } else {
        await page.evaluate(() => {
          const form = document.getElementById('submitform') as HTMLFormElement;
          if (!form) return;
          const existing = form.querySelector('input[name="submit"]');
          if (existing) existing.remove();
          const si = document.createElement('input');
          si.type = 'hidden'; si.name = 'submit'; si.value = 'publish';
          form.appendChild(si);
          HTMLFormElement.prototype.submit.call(form);
        });
      }

      await page.waitForTimeout(8000);
      logger.info(`[KofiSync] Ch ${chapter.chapter_number} published/scheduled.`);
      return {
        success: true,
        chapter_number: chapter.chapter_number,
        published_url: `https://ko-fi.com/post/ch-${chapter.chapter_number}`
      };
    } catch (err: any) {
      const classified = classifyError(err, 'https://ko-fi.com/blog/editor');
      logger.error(`[KofiSync] Publish failed: ${classified.code} - ${err.message}`);
      try { await page.screenshot({ path: `shared/debug/kofi_publish_fail_${Date.now()}.png` }); } catch {}
      return { success: false, chapter_number: chapter.chapter_number, error: `[${classified.code}] ${err.message}` };
    } finally {
      try { await page.close(); } catch {}
      await cleanup();
    }
  }

  async rescheduleChapter(chapterNumber: number, editUrl: string, newDate: string, novelSlug: string): Promise<boolean> {
    logger.info(`[KofiSync] Rescheduling Ch ${chapterNumber} to ${newDate}`);
    try {
      const result = await platformConnector.getScrapingContext('kofi', novelSlug);
      if (!result) return false;
      const { context, cleanup } = result;
      const page = await context.newPage();
      try {
        // ponytail: the editor exposes a schedule API (SetSchedule) that the DOM form mirrors;
        // the form fields are unreliable, the API is not. Find the item by its edit URL, then
        // set only the date (keep the existing time) using the browser's real timezone offset.
        await page.goto('https://ko-fi.com/blog/editor', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2500);
const dateStr = newDate.slice(0, 10);
        const done = await page.evaluate(async ({ editUrl, dateStr }: { editUrl: string; dateStr: string }) => {
          // ponytail: keep every helper a hoisted `function` — esbuild __name-mangles named
          // const-arrow closures and they break inside the browser evaluate context.
          const token = (document.querySelector('input[name="AntiforgeryToken"]') as HTMLInputElement)?.value || '';
          const list = await (await fetch('/api/schedule/drafts-and-schedule?probablecountrycode=null', { credentials: 'include' })).json();
          const items = Array.isArray(list.Items) ? list.Items : [];
          const item = items.find((i: any) => norm(i.UrlEdit) === norm(editUrl));
          if (!item) return false;
          const timeStr = String(item.DateTimeScheduled || 'T12:00:00').slice(11, 16) || '12:00';
          const b = new URLSearchParams();
          b.append('ItemType', 'post');
          b.append('ItemId', String(item.Id));
          b.append('Input.DateLocal', dateStr);
          b.append('Input.TimeLocal', timeStr);
          b.append('TimeZoneOffsetMins', String(-new Date().getTimezoneOffset()));
          b.append('AntiforgeryToken', token);
          const r = await fetch('/Schedule/SetSchedule', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
            body: b.toString()
          });
          return r.status === 200;

          function norm(u: string): string { return String(u || '').replace(/^https?:\/\/ko-fi\.com/i, '').split('?')[0]; }
        }, { editUrl, dateStr });
        await page.waitForTimeout(1500);
        return done;
      } finally {
        try { await page.close(); } catch {}
        await cleanup();
      }
    } catch (err: any) { logger.warn(`[KofiSync] Reschedule threw: ${err.message}`); return false; }
  }

  async deleteChapter(chapterNumber: number, editUrl: string, novelSlug?: string): Promise<boolean> {
    logger.info(`[KofiSync] Deleting Ch ${chapterNumber}`);
    try {
      const result = await platformConnector.getScrapingContext('kofi', novelSlug);
      if (!result) return false;
      const { context, cleanup } = result;
      const page = await context.newPage();
      try {
        const postId = (editUrl.split('/').pop() || '').split('?')[0];
        await page.goto('https://ko-fi.com/manage/posts', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        const token = await page.evaluate(() => {
          const input = document.querySelector('input[name="AntiforgeryToken"]') as HTMLInputElement;
          return input?.value || null;
        });
        if (!token) { logger.warn('[KofiSync] No antiforgery token found'); return false; }
        const ok = await page.evaluate(async ({ postId, token }: { postId: string; token: string }) => {
          const body = new URLSearchParams();
          body.append('AntiforgeryToken', token);
          body.append('postAlias', postId);
          const r = await fetch('/Blog/DeletePostByAlias', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
            body: body.toString()
          });
          return r.ok;
        }, { postId, token });
        return ok;
      } finally {
        try { await page.close(); } catch {}
        await cleanup();
      }
    } catch { return false; }
  }

  async updateChapter(
    novelSlug: string,
    chapter: { chapter_number: number; title: string; body: string; frontmatter?: Record<string, any> },
    editUrl: string
  ): Promise<PublishResult> {
    logger.info(`[KofiSync] Updating Ch ${chapter.chapter_number}: "${chapter.title}"`);
    const result = await platformConnector.getScrapingContext('kofi', novelSlug);
    if (!result) {
      return { success: false, chapter_number: chapter.chapter_number, error: 'Ko-fi profile not authenticated.' };
    }
    const { context, cleanup } = result;
    await applyStealthToContext(context);
    const page = await context.newPage();

    try {
      await page.goto(editUrl || 'https://ko-fi.com/blog/editor?back=true', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await postNavigationDelay();

      if (page.url().includes('/account/login') || page.url().includes('/auth')) {
        return { success: false, chapter_number: chapter.chapter_number, error: '[SESSION_EXPIRED] Ko-fi login required.' };
      }

      const urlAfterNav = page.url();
      if (!urlAfterNav.includes('/blog/editor')) {
        try { await page.screenshot({ path: `shared/debug/kofi_update_fail_${Date.now()}.png` }); } catch {}
        return { success: false, chapter_number: chapter.chapter_number, error: `[SESSION_EXPIRED] Redirected to "${urlAfterNav}" instead of editor.` };
      }

      const config = loadNovelConfig(novelSlug);
      const chOverride = chapter.frontmatter?.author_note_override;
      const kofiNote = chOverride ? (chapter.frontmatter?.author_note_kofi !== false) : (config.author_note_kofi !== false);
      const bodyWithNote = kofiNote ? applyAuthorNote(chapter.body, chOverride ? (chapter.frontmatter?.author_note || '') : config.author_note, chOverride ? (chapter.frontmatter?.author_note_position || 'bottom') : config.author_note_position) : chapter.body;
      const bodyHtml = mdToHtml(bodyWithNote);

      const postTitle = `Chapter ${chapter.chapter_number}: ${chapter.title}`;

      const filled = await page.evaluate(({ title, body }: { title: string; body: string }) => {
        const titleInput = document.querySelector('#blogPostTitle') as HTMLInputElement;
        if (titleInput) {
          titleInput.value = title;
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const editor = document.querySelector('[contenteditable="true"]') as HTMLElement;
        if (editor) {
          editor.innerHTML = body;
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        return false;
      }, { title: postTitle, body: bodyHtml });

      if (!filled) {
        logger.error('[KofiSync] Update editor elements not found');
        return { success: false, chapter_number: chapter.chapter_number, error: '[EDITOR_FILL_FAILED] Ko-fi editor elements not found.' };
      }

      // Set audience tier if configured — match by value or by visible label text
      const kofiTierId = config.kofi_tier_id || chapter.frontmatter?.kofi_tier_id || '';
      if (kofiTierId) {
        await page.evaluate((tierVal: string) => {
          const sel = document.querySelector('select[name="postAudience"]') as HTMLSelectElement;
          if (sel) {
            for (const opt of sel.options) {
              if (opt.value === tierVal || opt.text === tierVal) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); break; }
            }
          }
        }, kofiTierId);
      }

      await humanDelay();

      // Save without changing the schedule: submit the form (existing schedule preserved)
      await page.evaluate(() => {
        const form = document.getElementById('submitform') as HTMLFormElement;
        if (!form) return;
        const existing = form.querySelector('input[name="submit"]');
        if (existing) existing.remove();
        const si = document.createElement('input');
        si.type = 'hidden'; si.name = 'submit'; si.value = 'save';
        form.appendChild(si);
        HTMLFormElement.prototype.submit.call(form);
      });

      await page.waitForTimeout(8000);
      logger.info(`[KofiSync] Ch ${chapter.chapter_number} updated successfully.`);
      return { success: true, chapter_number: chapter.chapter_number, published_url: editUrl };
    } catch (err: any) {
      const classified = classifyError(err, 'https://ko-fi.com/blog/editor');
      logger.error(`[KofiSync] Update failed: ${classified.code} - ${err.message}`);
      try { await page.screenshot({ path: `shared/debug/kofi_update_fail_${Date.now()}.png` }); } catch {}
      return { success: false, chapter_number: chapter.chapter_number, error: `[${classified.code}] ${err.message}` };
    } finally {
      try { await page.close(); } catch {}
      await cleanup();
    }
  }
}