/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Webnovel state sync — reads Inkstone state, detects/deletes duplicates,
 * empties trash, updates tracker. Ported from Python webnovel_sync.py.
 */

import { chromium, BrowserContext, Page } from 'playwright';
import * as path from 'path';
import { SHARED_DIR } from './config';
import { platformConnector } from './platform_connector';
import { AutomationRunner } from './runner';
import { loadTracker, saveTrackerAtomic } from './tracker';
import { applyStealthToContext, humanDelay, postNavigationDelay, evalWithTimeout, injectForceVisible, STEALTH_VIEWPORT, STEALTH_USER_AGENT } from './stealth';
import { classifyError, validateSession } from './error_codes';
import { renewInkstoneSession } from '../adapters/inkstone_api';
import logger from './logger';

const BASE_PROFILE_DIR = path.join(SHARED_DIR, 'browser_profile');

function toPlaywrightCookies(rawCookies: any[]): any[] {
  return rawCookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expires || -1,
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: c.sameSite || 'Lax',
  }));
}

const EXTRACT_ITEMS_JS = `() => {
  const panel = document.querySelector('.ant-tabs-tabpane-active');
  if (!panel) return [];
  const items = panel.querySelectorAll('li.ant-list-item');
  return Array.from(items).map(li => {
    const titleEl = li.querySelector('[class*="title"]');
    const spans = li.querySelectorAll('span');
    const timeText = Array.from(spans).map(s => s.textContent.trim()).filter(t => /\\d/.test(t))[1] || '';
    return {
      title: titleEl ? titleEl.textContent.trim() : '',
      timeText: timeText,
    };
  });
}`;

const HAS_NEXT_PAGE_JS = `(pg) => {
  const panel = document.querySelector('.ant-tabs-tabpane-active');
  if (!panel) return false;
  return panel.querySelector('li.ant-pagination-item[title="' + pg + '"]') !== null;
}`;

const CLICK_NEXT_PAGE_JS = `(pg) => {
  const panel = document.querySelector('.ant-tabs-tabpane-active');
  if (!panel) return;
  const el = panel.querySelector('li.ant-pagination-item[title="' + pg + '"]');
  if (el) el.click();
}`;

function _parseChapterNumber(title: string): number | null {
  const m = title.match(/(?:chapter|ch\.?)\s*#?\s*(\d+)/i);
  if (m) return parseInt(m[1]);
  const m2 = title.match(/(\d+)/);
  if (m2) return parseInt(m2[1]);
  return null;
}

async function _clickTab(page: Page, tabText: string): Promise<void> {
  const tab = page.locator('div.ant-tabs-tab', { hasText: tabText });
  if (await tab.count() > 0) {
    await tab.first().click();
    await page.waitForTimeout(3000);
  }
}

async function _readTab(page: Page, tabText: string): Promise<Record<number, string>> {
  await _clickTab(page, tabText);
  const result: Record<number, string> = {};

  for (let pg = 1; pg < 20; pg++) {
    const items = await evalWithTimeout(page, EXTRACT_ITEMS_JS);
    for (const item of items) {
      const num = _parseChapterNumber(item.title);
      if (num) {
        result[num] = result[num] || item.timeText;
      }
    }
    const hasNext = await evalWithTimeout(page, HAS_NEXT_PAGE_JS, pg + 1);
    if (!hasNext) break;
    await evalWithTimeout(page, CLICK_NEXT_PAGE_JS, pg + 1);
    await page.waitForTimeout(2000);
  }

  return result;
}

async function _getPageItems(page: Page): Promise<Array<{ text: string; hasDelete: boolean }>> {
  return evalWithTimeout(page, `() => {
    const panel = document.querySelector('.ant-tabs-tabpane-active');
    if (!panel) return [];
    return Array.from(panel.querySelectorAll('li.ant-list-item')).map(li => ({
      text: li.innerText.trim().substring(0, 80),
      hasDelete: !!li.querySelector('button.ant-btn-dangerous'),
    }));
  }`);
}

async function _deletePublishedItem(page: Page, idx: number): Promise<boolean> {
  return evalWithTimeout(page, (i: number) => {
    const panel = document.querySelector('.ant-tabs-tabpane-active');
    if (!panel) return false;
    const items = panel.querySelectorAll('li.ant-list-item');
    if (i >= items.length) return false;
    const btn = items[i].querySelector('button.ant-btn-dangerous');
    if (!btn) return false;
    items[i].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }, idx);
}

async function _confirmModal(page: Page): Promise<void> {
  await evalWithTimeout(page, `() => {
    const btns = document.querySelectorAll('.ant-modal-confirm-btns button');
    btns.forEach(b => {
      const t = b.textContent.trim().toLowerCase();
      if (t === 'yes' || t === 'ok' || b.classList.contains('ant-btn-primary')) {
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }
    });
  }`);
}

async function _clickNextPage(page: Page): Promise<string> {
  return evalWithTimeout(page, `() => {
    const nextBtn = document.querySelector('.ant-pagination-next');
    if (nextBtn && !nextBtn.classList.contains('ant-pagination-disabled')) {
      nextBtn.click();
      return 'next-btn-clicked';
    }
    const pageItems = document.querySelectorAll('.ant-pagination-item:not(.ant-pagination-item-active)');
    if (pageItems.length > 0) {
      const first = pageItems[0];
      const title = first.getAttribute('title');
      if (title) { first.click(); return 'clicked-page-' + title; }
    }
    return 'FAIL';
  }`);
}

async function _deleteDuplicatePublished(page: Page): Promise<number> {
  await _clickTab(page, 'published');
  await injectForceVisible(page);

  const allTitles: string[] = [];
  for (let pg = 1; pg < 20; pg++) {
    const items = await evalWithTimeout(page, EXTRACT_ITEMS_JS);
    for (const item of items) {
      allTitles.push(item.title);
    }
    const hasNext = await evalWithTimeout(page, HAS_NEXT_PAGE_JS, pg + 1);
    if (!hasNext) break;
    await evalWithTimeout(page, CLICK_NEXT_PAGE_JS, pg + 1);
    await page.waitForTimeout(2000);
  }

  const chNums: Record<number, string[]> = {};
  for (const title of allTitles) {
    const num = _parseChapterNumber(title);
    if (num) {
      if (!chNums[num]) chNums[num] = [];
      chNums[num].push(title);
    }
  }

  const duplicates: string[] = [];
  for (const titles of Object.values(chNums)) {
    if (titles.length > 1) {
      duplicates.push(...titles.slice(1));
    }
  }
  if (duplicates.length === 0) return 0;

  logger.info(`[WebnovelSync] Found ${duplicates.length} duplicate published chapters`);

  let totalDeleted = 0;
  for (const dupTitle of duplicates) {
    for (let _pg = 0; _pg < 200; _pg++) {
      const items = await _getPageItems(page);
      if (!items.length) break;
      let found = false;
      for (let idx = items.length - 1; idx >= 0; idx--) {
        if (items[idx].text.toLowerCase() === dupTitle.toLowerCase()) {
          if (!items[idx].hasDelete) break;
          if (await _deletePublishedItem(page, idx)) {
            await page.waitForTimeout(2000);
            await _confirmModal(page);
            await page.waitForTimeout(1500);
            totalDeleted++;
            logger.info(`[WebnovelSync] Deleted duplicate published: ${dupTitle}`);
            found = true;
            break;
          }
        }
      }
      if (found) break;
      const nav = await _clickNextPage(page);
      if (nav.startsWith('FAIL')) break;
    }
  }

  return totalDeleted;
}

async function _apiDeleteDraftByCcid(page: Page, cbid: string, ccid: string): Promise<boolean> {
  const url = 'https://inkstone.webnovel.com/tauthorweb/chapter/deleteChapter';
  const result = await evalWithTimeout(page, async ([fetchUrl, cbidVal, ccidVal]: [string, string, string]) => {
    try {
      const r = await fetch(fetchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ CBID: cbidVal, CCID: ccidVal }),
      });
      return JSON.stringify(await r.json());
    } catch (e: any) { return 'ERROR: ' + e.message; }
  }, [url, cbid, ccid] as any);
  return !!result && !result.startsWith('ERROR');
}

async function _apiFetchDraftCcids(page: Page, cbid: string): Promise<Array<{ ccid: string; title: string }>> {
  const baseUrl = 'https://inkstone.webnovel.com/tauthorweb/chapter/paginateDraftList';
  const results: Array<{ ccid: string; title: string }> = [];

  for (let pg = 1; pg < 50; pg++) {
    const raw = await evalWithTimeout(page, async ([url, cbidVal, pageNo]: [string, string, number]) => {
      try {
        const r = await fetch(`${url}?CBID=${cbidVal}&timezone=5.75&pageSize=200&pageNo=${pageNo}`);
        return JSON.stringify(await r.json());
      } catch { return 'ERROR'; }
    }, [baseUrl, cbid, pg] as any);
    if (raw === 'ERROR' || !raw) break;

    let data: any;
    try { data = JSON.parse(raw); } catch { break; }

    const records = data?.result?.records;
    if (!records) break;

    const pageItems: Array<{ ccid: string; title: string }> = [];
    for (const rec of records) {
      for (const vo of (rec.chapterInfoVos || [])) {
        const ccid = String(vo.ccid || vo.CCID || '');
        const title = vo.chapterName || vo.title || '';
        if (ccid) pageItems.push({ ccid, title });
      }
    }
    if (!pageItems.length) break;
    results.push(...pageItems);
  }

  return results;
}

async function _getCbid(page: Page, novelSlug: string): Promise<string> {
  const url = `https://inkstone.webnovel.com/novels/view/${novelSlug}`;
  let match = page.url().match(/\/(\d{6,20})(?:\?|\/|$)/);
  if (match) return match[1];

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);

  match = page.url().match(/\/(\d{6,20})(?:\?|\/|$)/);
  if (match) return match[1];

  match = url.match(/\/(\d{6,20})(?:\?|\/|$)/);
  if (match) return match[1];

  throw new Error('Could not extract CBID from URL');
}

async function _deleteDuplicateDrafts(page: Page, novelSlug: string): Promise<number> {
  const titles = await _getAllTitles(page, 'draft');
  const chNums: Record<number, string[]> = {};
  for (const title of titles) {
    const num = _parseChapterNumber(title);
    if (num) {
      if (!chNums[num]) chNums[num] = [];
      chNums[num].push(title);
    }
  }

  const duplicates: string[] = [];
  for (const numTitles of Object.values(chNums)) {
    if (numTitles.length > 1) {
      duplicates.push(...numTitles.slice(1));
    }
  }
  if (duplicates.length === 0) return 0;

  const cbid = await _getCbid(page, novelSlug);
  const allDrafts = await _apiFetchDraftCcids(page, cbid);

  let deleted = 0;
  for (const dupTitle of duplicates) {
    for (const d of allDrafts) {
      if (d.title.trim().toLowerCase() === dupTitle.trim().toLowerCase()) {
        if (await _apiDeleteDraftByCcid(page, cbid, d.ccid)) {
          deleted++;
          logger.info(`[WebnovelSync] Deleted duplicate draft: ${dupTitle}`);
        }
        break;
      }
    }
  }
  return deleted;
}

async function _getAllTitles(page: Page, tabText: string): Promise<string[]> {
  await _clickTab(page, tabText);
  const titles: string[] = [];

  for (let pg = 1; pg < 20; pg++) {
    const items = await evalWithTimeout(page, EXTRACT_ITEMS_JS);
    for (const item of items) {
      titles.push(item.title);
    }
    const hasNext = await evalWithTimeout(page, HAS_NEXT_PAGE_JS, pg + 1);
    if (!hasNext) break;
    await evalWithTimeout(page, CLICK_NEXT_PAGE_JS, pg + 1);
    await page.waitForTimeout(2000);
  }

  return titles;
}

async function _emptyTrash(page: Page): Promise<number> {
  await _clickTab(page, 'TRASH');
  let total = 0;

  for (let i = 0; i < 50; i++) {
    const count = await evalWithTimeout(page, `() => {
      const panel = document.querySelector('.ant-tabs-tabpane-active');
      return panel ? panel.querySelectorAll('li.ant-list-item').length : 0;
    }`);
    if (count === 0) break;

    await evalWithTimeout(page, `() => {
      const panel = document.querySelector('.ant-tabs-tabpane-active');
      if (!panel) return;
      panel.querySelectorAll('li.ant-list-item button').forEach(btn => {
        const t = (btn.innerText || '').trim().toLowerCase();
        if (t === 'delete' || t === 'trash' || t === 'remove') btn.click();
      });
    }`);
    await page.waitForTimeout(2000);

    await evalWithTimeout(page, `() => {
      document.querySelectorAll('.ant-modal-confirm .ant-btn-primary').forEach(b => b.click());
    }`);
    await page.waitForTimeout(2000);

    total += count;

    const hasNext = await evalWithTimeout(page, `() => {
      const items = document.querySelectorAll('.ant-pagination-item');
      if (!items.length) return false;
      let max = 0, cur = 0;
      items.forEach(li => {
        const t = parseInt(li.getAttribute('title'));
        if (!isNaN(t) && t > max) max = t;
      });
      const active = document.querySelector('.ant-pagination-item-active');
      if (active) cur = parseInt(active.getAttribute('title')) || 0;
      return cur > 0 && cur < max;
    }`);
    if (!hasNext) break;

    await evalWithTimeout(page, `() => {
      const active = document.querySelector('.ant-pagination-item-active');
      if (!active) return;
      const cur = parseInt(active.getAttribute('title'));
      const next = document.querySelector('.ant-pagination-item[title="' + (cur + 1) + '"]');
      if (next) next.click();
    }`);
    await page.waitForTimeout(3000);
  }

  return total;
}

export class WebnovelSync {
  private async _acquireContext(novelSlug: string): Promise<{ context: BrowserContext; ownsBrowser: boolean }> {
    const liveCtx = platformConnector.getLiveContext('inkstone', novelSlug);
    if (liveCtx) {
      logger.info('[WebnovelSync] Using live browser context from platformConnector');
      return { context: liveCtx, ownsBrowser: false };
    }

    throw new Error(
      'Inkstone browser is not connected. Please reconnect your Inkstone profile before syncing. ' +
      'The login browser must stay open during syncing (Cloudflare requires the same browser session).'
    );
  }

  private async _releaseContext(slug: string, context: BrowserContext, ownsBrowser: boolean): Promise<void> {
    AutomationRunner.unregisterContext(slug, context);
    if (ownsBrowser) {
      const browser = context.browser();
      await context.close();
      if (browser) await browser.close();
    }
  }

  /**
   * Full Webnovel sync: detect/delete duplicates, empty trash, read state, update tracker.
   * Ported from Python: sync_webnovel()
   */
  async syncWebnovel(novelSlug: string): Promise<{
    published: Record<number, string>;
    drafts: Record<number, string>;
    deletedPublished: number;
    deletedDrafts: number;
    trashed: number;
  }> {
    logger.info(`[WebnovelSync] [${new Date().toISOString()}] Starting Webnovel sync for ${novelSlug}`);
    AutomationRunner.setProgress(novelSlug, 1, 5, 'Launching browser...');

    const { context, ownsBrowser } = await this._acquireContext(novelSlug);
    AutomationRunner.registerContext(novelSlug, context);

    // Apply anti-detection stealth
    await applyStealthToContext(context);

    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    try {
      const dashboardUrl = `https://inkstone.webnovel.com/novels/view/${novelSlug}`;
      await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Human-like delay after navigation
      await postNavigationDelay();

      // Validate session
      let sessionCheck = await validateSession(page, 'inkstone');
      if (!sessionCheck.valid) {
        const ok = await renewInkstoneSession(page, dashboardUrl);
        if (ok) {
          await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await postNavigationDelay();
          sessionCheck = await validateSession(page, 'inkstone');
        }
        if (!sessionCheck.valid) {
          throw new Error(`[${classifyError(new Error(sessionCheck.reason), page.url()).code}] ${sessionCheck.reason}`);
        }
      }

      // Check if redirected to login
      if (page.url().includes('/login')) {
        throw new Error('[session_expired] Inkstone session expired. Please reconnect your profile.');
      }

      // Step 1: Delete duplicate published chapters
      AutomationRunner.setProgress(novelSlug, 2, 5, 'Deleting duplicate published chapters...');
      const dupPub = await _deleteDuplicatePublished(page);
      if (dupPub > 0) {
        logger.info(`[WebnovelSync] Deleted ${dupPub} duplicate published chapters`);
      }

      // Step 2: Delete duplicate drafts
      AutomationRunner.setProgress(novelSlug, 3, 5, 'Deleting duplicate drafts...');
      const dupDraft = await _deleteDuplicateDrafts(page, novelSlug);
      if (dupDraft > 0) {
        logger.info(`[WebnovelSync] Deleted ${dupDraft} duplicate drafts`);
      }

      // Step 3: Empty trash
      AutomationRunner.setProgress(novelSlug, 4, 5, 'Emptying trash...');
      const trashCount = await _emptyTrash(page);
      if (trashCount > 0) {
        logger.info(`[WebnovelSync] Emptied ${trashCount} items from trash`);
      }

      // Step 4: Read actual state
      AutomationRunner.setProgress(novelSlug, 5, 5, 'Reading and syncing state...');
      await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);

      const published = await _readTab(page, 'published');
      const drafts = await _readTab(page, 'draft');

      logger.info(`[WebnovelSync] Published on Webnovel: ${Object.keys(published).length} chapters`);
      logger.info(`[WebnovelSync] Drafts on Webnovel: ${Object.keys(drafts).length} chapters`);

      // Update tracker
      const tracker = loadTracker(novelSlug);
      const allPresent = [...new Set([...Object.keys(published).map(Number), ...Object.keys(drafts).map(Number)])].sort((a, b) => a - b);

      let wnLast = 0;
      if (allPresent.length > 0 && allPresent[0] === 1) {
        for (let i = 0; i < allPresent.length; i++) {
          if (allPresent[i] === i + 1) {
            wnLast = allPresent[i];
          } else {
            break;
          }
        }
      }

      tracker.webnovel_last = wnLast;
      saveTrackerAtomic(novelSlug, tracker);
      logger.info(`[WebnovelSync] Updated tracker: webnovel_last=${wnLast}`);

      return {
        published,
        drafts,
        deletedPublished: dupPub,
        deletedDrafts: dupDraft,
        trashed: trashCount,
      };
    } finally {
      await page.close().catch(() => {});
      await this._releaseContext(novelSlug, context, ownsBrowser);
    }
  }
}
