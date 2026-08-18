import { PublishingAdapter, ScrapeResult, PublishResult } from './base';
import { ScheduledChapter } from '../core/models';
import { computeSequence } from '../core/webnovel_public';
import { mdToHtml, applyAuthorNote } from '../core/parser';
import { classifyError } from '../core/error_codes';
import { platformConnector } from '../core/platform_connector';
import { loadNovelConfig, saveNovelConfig } from '../core/config';
import { humanDelay, postNavigationDelay, applyStealthToContext } from '../core/stealth';
import logger from '../core/logger';

interface PostInfo { number: number; title: string; status: string; date: string; postId: string }

export class PatreonSync extends PublishingAdapter {
  readonly platformName = 'patreon' as const;

  private async _collectAllPostsViaAPI(page: any, tierId: string, tag: string): Promise<{ posts: PostInfo[]; nextScheduled: string | null; creator: string | null }> {
    const targetUrl = tierId
      ? `https://www.patreon.com/library?tier=${tierId}&tags=${encodeURIComponent(tag)}`
      : 'https://www.patreon.com/library';

    const campaignIdPromise = new Promise<string>((resolve) => {
      const handler = (response: any) => {
        const m = response.url().match(/filter%5Bcampaign_id%5D=(\d+)/);
        if (m) { resolve(m[1]); }
      };
      page.on('response', handler);
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);

    if (page.url().includes('/login')) {
      throw new Error('[SESSION_EXPIRED] Redirected to login page. Session expired.');
    }

    const campaignId = await Promise.race([
      campaignIdPromise,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Campaign ID not found')), 15000)),
    ]);


    const all = new Map<number, PostInfo>();
    let earliestScheduled: string | null = null;
    let cursor = '';
    let creator: string | null = null;
    // ponytail: config.patreon_tag is frequently a creator handle, not a real post tag.
    // Untagged posts match zero rows under filter[tag], so if the first (tagged) page
    // comes back empty, re-scope to the whole campaign. Post tags are the only reliable
    // series splitter; a handle value can't scope — flag that to the UI if it bites.
    let useTag = !!tag;

    while (true) {
      const params = new URLSearchParams({
        'fields[post]': 'title,published_at,scheduled_for,post_type',
        'filter[campaign_id]': campaignId,
        'filter[is_published_or_scheduled]': 'true',
        'sort': '-published_at',
        'page[size]': '50',
        'page[cursor]': cursor,
        'json-api-version': '1.0',
      });
      if (useTag) params.set('filter[tag]', tag);

      const url = `https://www.patreon.com/api/posts?${params.toString()}`;
      const result = await page.evaluate(async (fetchUrl: string) => {
        try {
          const resp = await fetch(fetchUrl, { credentials: 'include' });
          if (resp.status !== 200) return { error: `HTTP ${resp.status}` };
          const json = await resp.json();
          return {
            data: json.data || [],
            included: json.included || [],
            next: json.links?.next || '',
          };
        } catch (e: any) {
          return { error: e.message };
        }
      }, url);

      if (result.error) {
        logger.warn(`[PatreonSync] /api/posts fetch failed: ${result.error}`);
        break;
      }

      // Tag filter matched nothing at all — retry the first page scoped to the whole
      // campaign. Only trust the wipe once per scrape (avoids a retry loop when the
      // campaign genuinely has no posts).
      if (useTag && !cursor && result.data.length === 0) {
        useTag = false;
        logger.warn(`[PatreonSync] Tag filter "${tag}" matched 0 posts — scraping whole campaign.`);
        continue;
      }

      // Extract creator from campaign data in included array (first page only)
      if (!creator && result.included) {
        const campaign = result.included.find((item: any) => item.type === 'campaign');
        if (campaign?.attributes?.url) {
          const match = campaign.attributes.url.match(/patreon\.com\/([^/?]+)/);
          if (match) creator = match[1];
        }
      }

      for (const post of result.data) {
        const title = post.attributes?.title || '';
        const scheduledFor = post.attributes?.scheduled_for;
        const m = title.trim().match(/^Chapter\s+(\d+)/i);
        if (!m) continue;
        const num = parseInt(m[1], 10);
        if (num >= 1000) continue;

        const isFutureScheduled = scheduledFor && new Date(scheduledFor) > new Date();
        const status = isFutureScheduled ? 'SCHEDULED' : 'PUBLISHED';
        const dateStr = isFutureScheduled
          ? scheduledFor
          : this._formatDate(post.attributes?.published_at || scheduledFor);

        const postId = post.id || '';
        const existing = all.get(num);
        // ponytail: duplicate scheduled posts exist on the campaign (series post plus
        // a stray second set). Keep the earliest date, prefer SCHEDULED over PUBLISHED.
        if (existing) {
          if (status === 'SCHEDULED' || existing.status !== 'SCHEDULED') {
            const newT = scheduledFor ? Date.parse(scheduledFor) : NaN;
            const oldT = existing.date ? Date.parse(existing.date) : NaN;
            if (!isNaN(newT) && (isNaN(oldT) || newT < oldT)) {
              all.set(num, { number: num, title: '', status, date: dateStr || '', postId });
            }
          }
          continue;
        }

        if (status === 'SCHEDULED' && scheduledFor) {
          if (!earliestScheduled || scheduledFor > earliestScheduled) {
            earliestScheduled = scheduledFor;
          }
        }

        all.set(num, { number: num, title: '', status, date: dateStr || '', postId });
      }

      if (!result.next) break;
      const nextUrl = new URL(result.next);
      cursor = nextUrl.searchParams.get('page[cursor]') || '';
      if (!cursor) break;
    }

    return {
      posts: Array.from(all.values()).sort((a, b) => a.number - b.number),
      nextScheduled: earliestScheduled,
      creator,
    };
  }

  private _formatDate(iso: string | null): string {
    if (!iso) return '';
    const dt = new Date(iso);
    if (isNaN(dt.getTime())) return '';
    const y = dt.getFullYear();
    const mon = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${mon}-${day}`;
  }

  async scrapeState(novelSlug: string): Promise<ScrapeResult> {
    logger.info(`[PatreonSync] Scraping state for: ${novelSlug}`);

    const result = await platformConnector.getScrapingContext('patreon', novelSlug);
    if (!result) {
      throw new Error('[SESSION_EXPIRED] No scraping context available for Patreon.');
    }
    const { context, cleanup } = result;

    await applyStealthToContext(context);
    const page = await context.newPage();

    try {
      await humanDelay();
      const config = loadNovelConfig(novelSlug);
      const tierId = config.patreon_tier_id || '';
      const tag = config.patreon_tag || '';

      const { posts: unique, nextScheduled, creator } = await this._collectAllPostsViaAPI(page, tierId, tag);

      // ponytail: auto-detect patreon_creator from campaign data for tier fetch
      if (creator && config.patreon_creator !== creator) {
        config.patreon_creator = creator;
        try { saveNovelConfig(novelSlug, config); } catch {}
      }

      const published = unique.filter(p => p.status === 'PUBLISHED');
      const scheduled = unique.filter(p => p.status === 'SCHEDULED');

      const lastPublishedChapter = published.length > 0 ? published[published.length - 1].number : 0;
      const scheduledCount = scheduled.length;

      const scheduledChapters: ScheduledChapter[] = scheduled.map(p => ({
        chapter_number: p.number,
        date: p.date,
        platform_id: p.postId,
        edit_url: creator ? `https://www.patreon.com/posts/${p.postId}/edit` : undefined,
      }));

      logger.info(`[PatreonSync] Scraped: ${unique.length} total, LastPublished=${lastPublishedChapter}, Scheduled=${scheduledCount}`);

      return {
        last_published_chapter: lastPublishedChapter,
        published_count: published.length,
        scheduled_count: scheduledCount,
        latest_scheduled_date: nextScheduled,
        scraped_items: unique,
        sequence: computeSequence(unique.map(p => p.number)),
        scheduled_chapters: scheduledChapters,
      };
    } catch (err: any) {
      if (err.message?.includes('[SESSION_EXPIRED]') || err.message?.includes('[CAPTCHA]') || err.message?.includes('[CLOUDFLARE]')) {
        throw err;
      }
      const classified = classifyError(err, 'https://www.patreon.com/library');
      throw new Error(`[${classified.code}] ${classified.message}`);
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
    logger.info(`[PatreonSync] Publishing Ch ${chapter.chapter_number}: "${chapter.title}"`);

    const result = await platformConnector.getScrapingContext('patreon', novelSlug);
    if (!result) {
      return { success: false, chapter_number: chapter.chapter_number, error: 'Patreon profile not authenticated.' };
    }
    const { context, cleanup } = result;

    await applyStealthToContext(context);
    const page = await context.newPage();

    try {
      await humanDelay();
      await page.goto('https://www.patreon.com/posts/new', { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (page.url().includes('/login')) {
        return { success: false, chapter_number: chapter.chapter_number, error: '[SESSION_EXPIRED] Patreon session expired.' };
      }
      await postNavigationDelay();
      try { await page.waitForLoadState('networkidle', { timeout: 30000 }); } catch {}

      await page.waitForSelector('input[placeholder*="Title"], textarea[placeholder*="Title"]', { timeout: 30000 });
      await page.locator('input[placeholder*="Title"], textarea[placeholder*="Title"]').first().fill(chapter.title);
      await humanDelay();
      const ptConfig = loadNovelConfig(novelSlug);
      const ptOverride = chapter.frontmatter?.author_note_override;
      const ptPatreon = ptOverride ? (chapter.frontmatter?.author_note_patreon !== false) : (ptConfig.author_note_patreon !== false);
      const ptBody = ptPatreon ? applyAuthorNote(chapter.body, ptOverride ? (chapter.frontmatter?.author_note || '') : ptConfig.author_note, ptOverride ? (chapter.frontmatter?.author_note_position || 'bottom') : ptConfig.author_note_position) : chapter.body;
      const bodyHtml = mdToHtml(ptBody);
      const ce = page.locator('div[contenteditable="true"]');
      if (await ce.isVisible().catch(() => false)) {
        await page.evaluate((html: string) => {
          const el = document.querySelector('div[contenteditable="true"]');
          if (el) { el.innerHTML = html; el.dispatchEvent(new Event('input', { bubbles: true })); }
        }, bodyHtml);
      } else {
        await page.locator('textarea[placeholder*="story"]').first().fill(bodyHtml);
      }
      await humanDelay();

      // Per-chapter tier/tag from frontmatter, fallback to novel config
      const chFrontmatter = (chapter as any).frontmatter || {};
      const config = loadNovelConfig(novelSlug);
      const tierNames = chFrontmatter.patreon_tier_names || config.patreon_tier_names || [];
      const tag = chFrontmatter.patreon_tag || config.patreon_tag || '';

      // --- Tier selection via dropdown ---
      const selectTiers = page.getByLabel('Select tiers');
      if (await selectTiers.isVisible().catch(() => false)) {
        await selectTiers.click();
        await page.waitForTimeout(1500);
        // "Select all tiers" is checked by default — click to uncheck all
        const allTiers = page.locator('button[role="menuitemcheckbox"]:has-text("Select all tiers")');
        if (await allTiers.isVisible().catch(() => false)) {
          const checked = await allTiers.getAttribute('aria-checked');
          if (checked === 'true') await allTiers.click();
        }
        await page.waitForTimeout(500);
        if (tierNames.length > 0) {
          for (const name of tierNames) {
            const tierBtn = page.locator(`button[role="menuitemcheckbox"]:has-text("${name}")`).first();
            if (await tierBtn.isVisible().catch(() => false)) {
              const checked = await tierBtn.getAttribute('aria-checked');
              if (checked !== 'true') await tierBtn.click();
            }
          }
        }
        // Close dropdown by pressing Escape
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      } else {
        // Fallback: old checkbox-based tier selection
        const tierId = chFrontmatter.patreon_tier_id || config.patreon_tier_id || 'tier-early-access';
        await page.click(`input[type="checkbox"][value="${tierId}"], .tier-checkbox[data-tier="${tierId}"]`).catch(() => {});
      }
      await humanDelay();

      // --- Tag/collection selection ---
      if (tag) {
        const tagInput = page.locator('input[data-tag="tags-auto-complete"]');
        if (await tagInput.isVisible().catch(() => false)) {
          await tagInput.fill(tag);
          await page.waitForTimeout(2000);
          const suggestion = page.locator(`[role="listbox"] [role="option"], [role="listbox"] [role="menuitemcheckbox"]`).filter({ hasText: tag }).first();
          if (await suggestion.isVisible().catch(() => false)) {
            await suggestion.click();
            await page.waitForTimeout(1000);
          } else {
            await tagInput.press('Enter');
            await page.waitForTimeout(1000);
          }
        }
      }
      await humanDelay();

      if (targetPublishDate) {
        const hasDateInput = await page.evaluate(() => !!document.getElementById('date'));
        if (!hasDateInput) {
          await page.evaluate(() => { const t = document.getElementById('scheduled-for-toggle'); if (t) t.click(); });
          for (let i = 0; i < 20; i++) {
            await page.waitForTimeout(500);
            if (await page.locator('button:has-text("Schedule"):visible').first().isVisible().catch(() => false)) break;
          }
        }
        await humanDelay();
        const dp = new Date(targetPublishDate); const pad = (n: number) => n.toString().padStart(2, '0');
        const dateStr = `${dp.getFullYear()}-${pad(dp.getMonth()+1)}-${pad(dp.getDate())}`;
        const timeStr = `${pad(dp.getHours())}:${pad(dp.getMinutes())}`;
        await page.locator('#date').first().fill(dateStr);
        await page.waitForTimeout(500);
        // ponytail: read back date value to verify UI accepted it
        const readback = await page.evaluate(() => {
          const el = document.getElementById('date') as HTMLInputElement;
          return el?.value || '';
        });
        if (!readback.includes(dateStr) && !readback.includes(dateStr.replace(/-/g, ''))) {
          logger.error(`[PatreonSync] Date readback mismatch (got "${readback}", expected ${dateStr}). Aborting.`);
          return { success: false, chapter_number: chapter.chapter_number, error: `[DATE_VERIFICATION_FAILED] Picker showed "${readback}" instead of ${dateStr}` };
        }
        await page.locator('input[type="time"]').first().fill(timeStr);
        await humanDelay();
      }

      const submitBtn = targetPublishDate
        ? page.locator('button:has-text("Schedule"):visible').first()
        : page.locator('button:has-text("Publish"):visible, button:not(:has-text("Preview")):has-text("Post"):visible').first();
      await submitBtn.click();
      if (!targetPublishDate) {
        // ponytail: the *pr=true* redirect IS the success signal — no need to also
        // sleep the full 5s after it lands. Short settle for the toast/state sync.
        try { await page.waitForURL('**/*pr=true*', { timeout: 15000 }); } catch { /* ignore */ }
        await humanDelay(800, 1500);
      } else {
        // ponytail: scheduled posts give no nav signal — keep a bounded settle so the
        // error check below still sees server-side validation failures.
        await page.waitForTimeout(4000);
      }

      const patPubErr = await page.$('.error-message, [data-testid="error-message"], .form-error');
      if (patPubErr) {
        const t = await patPubErr.evaluate((el: any) => el.textContent || '');
        logger.error(`[PatreonSync] Publish error: ${t}`);
        return { success: false, chapter_number: chapter.chapter_number, error: t };
      }

      logger.info(`[PatreonSync] Ch ${chapter.chapter_number} published successfully.`);
      return {
        success: true,
        chapter_number: chapter.chapter_number,
        published_url: `https://patreon.com/posts/${novelSlug}-ch-${chapter.chapter_number}`,
      };
    } catch (err: any) {
      const classified = classifyError(err, 'https://patreon.com/posts/new');
      logger.error(`[PatreonSync] Publish failed: ${classified.code} - ${err.message}`);
      try { await page.screenshot({ path: `shared/debug/patreon_publish_fail_${Date.now()}.png` }); } catch {}
      return { success: false, chapter_number: chapter.chapter_number, error: `[${classified.code}] ${err.message}` };
    } finally {
      try { await page.close(); } catch {}
      await cleanup();
    }
  }

  async rescheduleChapter(chapterNumber: number, editUrl: string, newDate: string, novelSlug: string): Promise<boolean> {
    logger.info(`[PatreonSync] Rescheduling Ch ${chapterNumber} to ${newDate}`);
    const result = await platformConnector.getScrapingContext('patreon', novelSlug);
    if (!result) return false;
    const { context, cleanup } = result;
    await applyStealthToContext(context);
    const page = await context.newPage();
    try {
      await humanDelay();
      await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await postNavigationDelay();
      try { await page.waitForLoadState('networkidle', { timeout: 30000 }); } catch {}
      if (page.url().includes('/login')) return false;

      // Intercept the PATCH to rewrite scheduled_for — Patreon's own JS handles CSRF
      const scheduledFor = new Date(newDate).toISOString();
      let intercepted = false;
      page.route('**/api/posts/**', (route: any) => {
        if (route.request().method() === 'PATCH' && !intercepted) {
          intercepted = true;
          const body = route.request().postData();
          if (body) {
            try {
              const json = JSON.parse(body);
              if (json?.data?.attributes) {
                if (json.data.attributes.title && typeof json.data.attributes.title === 'string') {
                  json.data.attributes.title = json.data.attributes.title.trimEnd();
                }
                json.data.attributes.scheduled_for = scheduledFor;
              }
              route.continue({ postData: JSON.stringify(json), headers: route.request().headers() });
              return;
            } catch {}
          }
        }
        route.continue();
      });

      // Force a change so Save always triggers a PATCH
      const textInput = page.locator('input[type="text"]').first();
      let origTitle = '';
      if (await textInput.isVisible().catch(() => false)) {
        origTitle = await textInput.inputValue();
        await textInput.fill(origTitle + ' ');
      }

      // Step 1: Try clicking save — if page sends PATCH (even with wrong date), we fix it
      for (const sel of ['[data-tag="make-a-post-action-save_without_notifying"]', '[data-tag="make-a-post-action-publish"]', 'button[type="submit"]', '.publish-btn', '.post-publish-btn', '.save-schedule-btn', 'button:has-text("Save")', 'button:has-text("Publish")']) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) { await btn.click(); break; }
      }

      for (let i = 0; i < 10; i++) { await page.waitForTimeout(1000); if (intercepted) break; }

      // Restore original title if we modified it
      if (intercepted && origTitle && await textInput.isVisible().catch(() => false)) {
        await textInput.fill(origTitle);
      }

      // Step 2: If no PATCH was sent (page requires a change), find all date-like inputs and set them
      if (!intercepted) {
        logger.warn(`[PatreonSync] Ch ${chapterNumber}: save click didn't trigger PATCH, trying to set date on all inputs`);
        const dateStr = newDate;
        await page.evaluate((ds: string) => {
          for (const el of document.querySelectorAll('input')) {
            const inp = el as HTMLInputElement;
            const sig = [inp.name, inp.id, inp.placeholder, inp.className, inp.type, inp.getAttribute('aria-label') || ''].join('|').toLowerCase();
            if (/date|time|publish|schedule/.test(sig)) {
              const ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              if (ns) { ns.call(inp, ds); }
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        }, dateStr);

        await page.waitForTimeout(1000);
        for (const sel of ['[data-tag="make-a-post-action-save_without_notifying"]', '[data-tag="make-a-post-action-publish"]', 'button[type="submit"]', '.publish-btn', '.post-publish-btn', '.save-schedule-btn', 'button:has-text("Save")', 'button:has-text("Publish")']) {
          const btn = page.locator(sel).first();
          if (await btn.isVisible().catch(() => false)) { await btn.click(); break; }
        }

        for (let i = 0; i < 10; i++) { await page.waitForTimeout(1000); if (intercepted) break; }
      }

      if (!intercepted) { logger.error(`[PatreonSync] Ch ${chapterNumber}: page did not send PATCH after all attempts`); return false; }
      logger.info(`[PatreonSync] Ch ${chapterNumber} rescheduled to ${newDate} via Patreon API`);
      return true;
    } catch (err: any) {
      logger.error(`[PatreonSync] Reschedule Ch ${chapterNumber} failed: ${err.message}`);
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
    logger.info(`[PatreonSync] Updating Ch ${chapter.chapter_number}: "${chapter.title}"`);

    const result = await platformConnector.getScrapingContext('patreon', novelSlug);
    if (!result) {
      return { success: false, chapter_number: chapter.chapter_number, error: 'Patreon profile not authenticated.' };
    }
    const { context, cleanup } = result;

    await applyStealthToContext(context);
    const page = await context.newPage();

    try {
      await humanDelay();
      await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await postNavigationDelay();
      try { await page.waitForLoadState('networkidle', { timeout: 30000 }); } catch {}
      if (page.url().includes('/login')) {
        return { success: false, chapter_number: chapter.chapter_number, error: '[SESSION_EXPIRED] Patreon session expired.' };
      }

      const upConfig = loadNovelConfig(novelSlug);
      const upOverride = chapter.frontmatter?.author_note_override;
      const upPatreon = upOverride ? (chapter.frontmatter?.author_note_patreon !== false) : (upConfig.author_note_patreon !== false);
      const upBody = upPatreon ? applyAuthorNote(chapter.body, upOverride ? (chapter.frontmatter?.author_note || '') : upConfig.author_note, upOverride ? (chapter.frontmatter?.author_note_position || 'bottom') : upConfig.author_note_position) : chapter.body;
      const bodyHtml = mdToHtml(upBody);
      // Intercept PATCH to ensure scheduled_for stays unchanged
      let patched = false;
      page.route('**/api/posts/**', (route: any) => {
        if (route.request().method() === 'PATCH' && !patched) {
          patched = true;
          const body = route.request().postData();
          if (body) {
            try {
              const json = JSON.parse(body);
              if (json?.data?.attributes) {
                json.data.attributes.title = chapter.title;
                json.data.attributes.content = bodyHtml;
              }
              route.continue({ postData: JSON.stringify(json), headers: route.request().headers() });
              return;
            } catch {}
          }
        }
        route.continue();
      });

      await page.evaluate((c: { title: string; body: string }) => {
        const titleInput = document.querySelector<HTMLInputElement>('input[type="text"]');
        if (titleInput) {
          const ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (ns) { ns.call(titleInput, c.title); }
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
          titleInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const bodyInput = document.querySelector<HTMLElement>('div[contenteditable="true"]');
        if (bodyInput) {
          bodyInput.innerHTML = c.body;
          bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
          bodyInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, { title: chapter.title, body: bodyHtml });

      await humanDelay();

      for (const sel of ['[data-tag="make-a-post-action-save_without_notifying"]', '[data-tag="make-a-post-action-publish"]', 'button[type="submit"]', '.publish-btn', '.post-publish-btn', 'button:has-text("Save")']) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) { await btn.click(); break; }
      }

      for (let i = 0; i < 15; i++) { await page.waitForTimeout(1000); if (patched) break; }

      if (!patched) {
        logger.error(`[PatreonSync] Ch ${chapter.chapter_number}: page did not send PATCH after update`);
        return { success: false, chapter_number: chapter.chapter_number, error: 'No PATCH sent — content may not have been updated' };
      }

      logger.info(`[PatreonSync] Ch ${chapter.chapter_number} updated successfully.`);
      return { success: true, chapter_number: chapter.chapter_number };
    } catch (err: any) {
      const classified = classifyError(err, editUrl);
      logger.error(`[PatreonSync] Update Ch ${chapter.chapter_number} failed: ${classified.code} - ${err.message}`);
      try { await page.screenshot({ path: `shared/debug/patreon_update_fail_${Date.now()}.png` }); } catch {}
      return { success: false, chapter_number: chapter.chapter_number, error: `[${classified.code}] ${err.message}` };
    } finally {
      try { await page.close(); } catch {}
      await cleanup();
    }
  }

  async deleteChapter(chapterNumber: number, editUrl: string, novelSlug?: string): Promise<boolean> {
    logger.info(`[PatreonSync] Deleting Ch ${chapterNumber}`);
    const result = await platformConnector.getScrapingContext('patreon', novelSlug);
    if (!result) return false;
    const { context, cleanup } = result;
    await applyStealthToContext(context);
    const page = await context.newPage();
    try {
      await humanDelay();
      await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await postNavigationDelay();
      try { await page.waitForLoadState('networkidle', { timeout: 30000 }); } catch {}
      if (page.url().includes('/login')) return false;

      // DOM: More actions -> Delete post -> confirm
      let domOk = false;
      const moreBtn = page.getByRole('button', { name: 'More actions' }).first();
      if (await moreBtn.isVisible().catch(() => false)) {
        await moreBtn.click();
        await page.waitForTimeout(1500);
        const deleteItem = page.getByRole('menuitem', { name: 'Delete post' }).first();
        if (await deleteItem.isVisible().catch(() => false)) {
          await deleteItem.click();
          await page.waitForTimeout(3000);
          // ponytail: scope confirm to the dialog footer — the unqualified
          // `button:has-text("Delete")` also matched the hidden "Delete post"
          // menuitem behind the overlay, so the click landed on the overlay and timed out.
          const confirmBtn = page.locator('[data-tag="dialog-footer"] button:has-text("Delete"), [data-tag="dialog-footer"] button:has-text("Confirm"), [data-tag="dialog-footer"] button:has-text("Yes")').first();
          if (await confirmBtn.isVisible().catch(() => false)) {
            await confirmBtn.click();
            await page.waitForTimeout(3000);
            domOk = true;
          }
        }
      }
      if (domOk) { logger.info(`[PatreonSync] Ch ${chapterNumber} deleted`); return true; }
      logger.error(`[PatreonSync] DOM delete failed`);
      return false;
    } catch (err: any) {
      logger.error(`[PatreonSync] Delete Ch ${chapterNumber} failed: ${err.message}`);
      return false;
    } finally {
      try { await page.close(); } catch {}
      await cleanup();
    }
  }
}
