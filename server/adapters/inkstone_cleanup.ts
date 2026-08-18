import { injectForceVisible, applyStealthToContext } from '../core/stealth';
import { clickTab, renewInkstoneSession } from './inkstone_api';
import { platformConnector } from '../core/platform_connector';
import logger from '../core/logger';

const DASHBOARD_URL = 'https://inkstone.webnovel.com/novels/view';

/** Navigate to dashboard and verify the session is still alive. Attempts SSO re-login if redirected to login. */
async function ensureDashboard(page: any, novelSlug: string): Promise<boolean> {
  try {
    await page.goto(`${DASHBOARD_URL}/${novelSlug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(8000);
    if (page.url().includes('/login')) {
      const ok = await renewInkstoneSession(page, `${DASHBOARD_URL}/${novelSlug}`);
      if (!ok) return false;
      await page.waitForTimeout(3000);
    }
    await injectForceVisible(page);
    return true;
  } catch {
    return false;
  }
}

export async function emptyTrash(page: any): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < 200; pass++) {
    await clickTab(page, 'TRASH');
    const count = await page.evaluate(() => {
      const panel = document.querySelector('.ant-tabs-tabpane-active');
      return panel ? panel.querySelectorAll('button.ant-btn-dangerous').length : 0;
    });
    if (count === 0) break;
    for (let i = 0; i < count; i++) {
      const clicked = await page.evaluate((idx: number) => {
        const panel = document.querySelector('.ant-tabs-tabpane-active');
        const btns = panel?.querySelectorAll('button.ant-btn-dangerous');
        if (btns && btns[idx]) {
          btns[idx].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        }
        return false;
      }, i);
      if (!clicked) break;
      try {
        await page.waitForSelector('.ant-modal-confirm-btns', { timeout: 5000 });
        await page.click('.ant-modal-confirm-btns button.ant-btn-dangerous', { timeout: 3000 });
        total++;
        logger.info(`[InkstoneScraper] Deleted trash item ${total}`);
      } catch {
        continue;
      }
      await page.waitForTimeout(500);
    }
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(6000);
  }
  logger.info(`[InkstoneScraper] EmptyTrash done: ${total} items`);
  return total;
}

async function scanPublishedItems(page: any): Promise<{ num: number; title: string; hasDelete: boolean }[]> {
  const all: { num: number; title: string; hasDelete: boolean }[] = [];
  await clickTab(page, 'published');
  // ponytail: the dashboard caches the last-viewed page in localStorage; after deletions a
  // stale page (e.g. page 18 of a now-10-page list) renders empty, so the scan bails with 0
  // items and never sees duplicates. Reset to page 1 before scanning.
  await page.evaluate(() => localStorage.removeItem('novels_view_page_info'));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  await clickTab(page, 'published');
  await injectForceVisible(page);
  for (let pg = 1; pg < 200; pg++) {
    const res = await page.evaluate(() => {
      const panel = document.querySelector('.ant-tabs-tabpane-active');
      if (!panel) return { items: [], hasNext: false };
      const lis = panel.querySelectorAll('li.ant-list-item');
      const items: { num: number; title: string; hasDelete: boolean }[] = [];
      for (const li of lis) {
        // ponytail: only rows with a real delete button are deletable. Volume/header
        // rows (no title link, no dangerous button) can never be deleted via the
        // row-delete flow, so skipping them here keeps them out of the plan and
        // stops deleteMatchingRow from paging through every page looking for one.
        if (!li.querySelector('button.ant-btn-dangerous')) continue;
        const link = li.querySelector('a[class*="title"]');
        const text = link?.textContent?.trim() || '';
        const m = text.match(/(?:chapter|ch\.?)\s*#?\s*(\d+)/i);
        const num = m ? parseInt(m[1], 10) : 0;
        items.push({ num, title: text, hasDelete: true });
      }
      const nextBtn = panel.querySelector('.ant-pagination-next');
      return { items, hasNext: !!nextBtn && !nextBtn.classList.contains('ant-pagination-disabled') };
    });
    if (!res.items.length) break;
    all.push(...res.items);
    if (!res.hasNext) break;
    await page.evaluate(() => {
      const panel = document.querySelector('.ant-tabs-tabpane-active');
      const next = panel?.querySelector('.ant-pagination-next') as HTMLElement | null;
      if (next && !next.classList.contains('ant-pagination-disabled')) next.click();
    });
    await page.waitForTimeout(2000);
  }
  return all;
}

/** Scan draft tab pages, return all items with chapter number, title, and whether they have a pub_time */
async function scanDraftItems(page: any): Promise<{ num: number; title: string; hasPubTime: boolean }[]> {
  const all: { num: number; title: string; hasPubTime: boolean }[] = [];
  await clickTab(page, 'draft');
  await page.evaluate(() => localStorage.removeItem('novels_view_page_info'));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  await clickTab(page, 'draft');
  await injectForceVisible(page);
  for (let pg = 1; pg < 200; pg++) {
    const res = await page.evaluate(() => {
      const panel = document.querySelector('.ant-tabs-tabpane-active');
      if (!panel) return { items: [], hasNext: false };
      const lis = panel.querySelectorAll('li.ant-list-item');
      const items: { num: number; title: string; hasPubTime: boolean }[] = [];
      for (const li of lis) {
        // ponytail: skip rows with no delete button (volume/header rows) — they can
        // never be deleted via deleteMatchingRow, so including them just makes the
        // plan build items that will be searched forever.
        if (!li.querySelector('button.ant-btn-dangerous')) continue;
        const link = li.querySelector('a[class*="title"]');
        const text = link?.textContent?.trim() || '';
        const m = text.match(/(?:chapter|ch\.?)\s*#?\s*(\d+)/i);
        const num = m ? parseInt(m[1], 10) : 0;
        items.push({ num, title: text, hasPubTime: !!li.querySelector('.pub_time--k-Zaq') });
      }
      const nextBtn = panel.querySelector('.ant-pagination-next');
      return { items, hasNext: !!nextBtn && !nextBtn.classList.contains('ant-pagination-disabled') };
    });
    if (!res.items.length) break;
    all.push(...res.items);
    if (!res.hasNext) break;
    await page.evaluate(() => {
      const panel = document.querySelector('.ant-tabs-tabpane-active');
      const next = panel?.querySelector('.ant-pagination-next') as HTMLElement | null;
      if (next && !next.classList.contains('ant-pagination-disabled')) next.click();
    });
    await page.waitForTimeout(2000);
  }
  return all;
}

type PlanItem = { number: number; title: string; id: string };
type PlanStrategy = { strategy: string; items: PlanItem[] };

/**
 * Delete EXACTLY the items the preview plan listed. Each item is re-located on
 * its tab by chapter number + title and only its own row's delete button is
 * clicked. Never derives its own target list from a gap/sort heuristic, so it
 * can never delete more than what the user was shown.
 *
 * ponytail: mirrors the per-chapter publish pattern — one fresh browser context
 * per delete, opened and closed for each row. A single long-lived page drifts
 * (stale pagination cache, session leaks) across a 95-delete run; per-item
 * contexts keep each delete as clean as a standalone publishChapter call.
 */
async function executePlan(
  novelSlug: string,
  plan: PlanStrategy[],
  exclude: Set<number>,
): Promise<{ published: number; drafts: number; outOfOrder: number; unscheduled: number }> {
  const deleted = { published: 0, drafts: 0, outOfOrder: 0, unscheduled: 0 };
  for (const strat of plan) {
    const isDraft = /(drafts)|unscheduled/i.test(strat.strategy);
    for (const item of strat.items) {
      // ponytail: duplicates match the exact extra row by title, so protecting by chapter
      // number would skip them all (the duplicate shares the number of a legit chapter).
      // Only number-protect the bulk strategies (out-of-order, bad-sequence, etc.).
      const isDup = /duplicates/i.test(strat.strategy);
      if (!isDup && item.number > 0 && exclude.has(item.number)) continue;
      if (await deleteMatchingRow(novelSlug, isDraft ? 'draft' : 'published', item.number, item.title)) {
        logger.info(`[InkstoneCleanup] Deleted Ch ${item.number} (${strat.strategy})`);
        if (strat.strategy === 'out-of-order') deleted.outOfOrder++;
        else if (strat.strategy === 'unscheduled drafts') deleted.unscheduled++;
        else if (isDraft) deleted.drafts++;
        else deleted.published++;
      }
    }
  }
  return deleted;
}

/** Open a fresh context + page for a single delete, close both after. */
async function withFreshPage<T>(novelSlug: string, fn: (page: any) => Promise<T>, fallback: T): Promise<T> {
  const ctx = await platformConnector.getScrapingContext('inkstone', novelSlug);
  if (!ctx) return fallback;
  const p = await ctx.context.newPage();
  try {
    await applyStealthToContext(ctx.context);
    if (!await ensureDashboard(p, novelSlug)) return fallback;
    return await fn(p);
  } finally {
    try { await p.close(); } catch {}
    await ctx.cleanup();
  }
}

/** Find a row on a tab matching number+title and delete that exact row. Runs in its own fresh context. */
async function deleteMatchingRow(novelSlug: string, tab: string, wantNum: number, wantTitle: string): Promise<boolean> {
  return withFreshPage(novelSlug, async (page) => {
    await clickTab(page, tab);
    // ponytail: same stale-page fix as scanPublishedItems — re-clicking the tab restores the
    // cached last-viewed page (often a now-empty page), so force page 1 before searching.
    await page.evaluate(() => localStorage.removeItem('novels_view_page_info'));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    await clickTab(page, tab);
    await injectForceVisible(page);
    for (let pass = 0; pass < 3; pass++) {
      for (let pg = 1; pg < 200; pg++) {
        const idx = await page.evaluate(({ n, t }: { n: number; t: string }) => {
          const panel = document.querySelector('.ant-tabs-tabpane-active');
          if (!panel) return -1;
          const lis = panel.querySelectorAll('li.ant-list-item');
          let last = -1;
          for (let i = 0; i < lis.length; i++) {
            const link = lis[i].querySelector('a[class*="title"]');
            const text = link?.textContent?.trim() || '';
            const m = text.match(/(?:chapter|ch\.?)\s*#?\s*(\d+)/i);
            const num = m ? parseInt(m[1], 10) : 0;
            const numOk = n > 0 ? num === n : true;
            const titleOk = t ? text === t : (n === 0 ? text.trim() === '' : true);
            if (numOk && titleOk && lis[i].querySelector('button.ant-btn-dangerous')) last = i;
          }
          return last;
        }, { n: wantNum, t: wantTitle });
        if (idx >= 0) {
          await page.evaluate((i: number) => {
            const panel = document.querySelector('.ant-tabs-tabpane-active');
            const btn = panel?.querySelectorAll('li.ant-list-item')[i]?.querySelector('button.ant-btn-dangerous');
            if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          }, idx);
          try {
            await page.waitForSelector('.ant-modal-confirm-btns', { timeout: 5000 });
            await page.click('.ant-modal-confirm-btns button.ant-btn-dangerous', { timeout: 3000 });
            return true;
          } catch {
            return false;
          }
        }
        const next = await page.evaluate(() => {
          const panel = document.querySelector('.ant-tabs-tabpane-active');
          const nextBtn = panel?.querySelector('.ant-pagination-next') as HTMLElement | null;
          if (nextBtn && !nextBtn.classList.contains('ant-pagination-disabled')) { nextBtn.click(); return 'next'; }
          return 'FAIL';
        });
        if (next === 'FAIL') break;
        await page.waitForTimeout(2000);
      }
    }
    return false;
  }, false);
}


export async function cleanupInkstone(
  novelSlug: string,
  options?: { dryRun?: boolean; exclude?: number[]; pattern?: string; min?: number; max?: number; minRun?: number }
): Promise<{ deletedPublished: number; deletedDrafts: number; emptiedTrash: number; deletedOutOfOrder: number; deletedUnscheduledDrafts: number; dryRun?: boolean; plan?: { strategy: string; items: { number: number; title: string; id: string }[] }[] }> {
  const dryRun = options?.dryRun ?? false;
  logger.info(`[InkstoneCleanup] Called${dryRun ? ' (DRY-RUN)' : ''} slug=${novelSlug}`);
  const { loadTracker } = await import('../core/tracker');
  // ponytail: verified-sequential chapters are NEVER deletable, regardless of strategy.
  const protectedSet = new Set<number>(loadTracker(novelSlug).protected || []);

  let plan: { strategy: string; items: { number: number; title: string; id: string }[] }[] = [];
  let published = 0, drafts = 0, emptiedTrash = 0, deletedOutOfOrder = 0, deletedUnscheduledDrafts = 0;

  // Phase 1 — scan the dashboard once (single page), build the delete plan, then close.
  const scanOk = await withFreshPage(novelSlug, async (p) => {
    if (!await ensureDashboard(p, novelSlug)) return false;

    // Always scan to build plan (dry-run or not)
    const pubItems = await scanPublishedItems(p);
    const draftItems = await scanDraftItems(p);

    const badId = (title: string) => `badfmt-${title.slice(0, 20).replace(/\W/g, '_')}`;
    const emptyId = (title: string) => `empty-${title.slice(0, 10).replace(/\W/g, '_') || 'untitled'}`;

    // Wrong title format (published) — items where title doesn't match "Chapter N:",
    // tolerating the zero-padded index prefix the live dashboard shows ("0087 Chapter 239: ...")
    const badFormatPublished: { number: number; title: string; id: string }[] = [];
    for (const it of pubItems) {
      if (it.title.trim() && !/^(?:\d+\s+)?Chapter\s+\d+/i.test(it.title)) {
        badFormatPublished.push({ number: it.num, title: it.title, id: it.num > 0 ? `badfmt-${it.num}` : badId(it.title) });
      }
    }

    // Empty title (published + draft) — items with blank/whitespace-only title
    const emptyTitlePublished: { number: number; title: string; id: string }[] = [];
    const emptyTitleDraft: { number: number; title: string; id: string }[] = [];
    for (const it of pubItems) { if (!it.title.trim()) emptyTitlePublished.push({ number: 0, title: '', id: `empty-pub-${emptyTitlePublished.length}` }); }
    for (const it of draftItems) { if (!it.title.trim()) emptyTitleDraft.push({ number: 0, title: '', id: `empty-draft-${emptyTitleDraft.length}` }); }

    // Duplicates (published) — numbers appearing more than once, keep first, mark extras
    const pubNumCount = new Map<number, { title: string }[]>();
    for (const it of pubItems) {
      if (it.num === 0) continue;
      if (!pubNumCount.has(it.num)) pubNumCount.set(it.num, []);
      pubNumCount.get(it.num)!.push({ title: it.title });
    }
    const dupPublished: { number: number; title: string; id: string }[] = [];
    for (const [num, entries] of pubNumCount) {
      if (entries.length > 1) {
        for (let i = 1; i < entries.length; i++) {
          dupPublished.push({ number: num, title: entries[i].title, id: `pub-${num}-${i}` });
        }
      }
    }

    // Duplicates (drafts)
    const draftNumCount = new Map<number, { title: string }[]>();
    for (const it of draftItems) {
      if (it.num === 0) continue;
      if (!draftNumCount.has(it.num)) draftNumCount.set(it.num, []);
      draftNumCount.get(it.num)!.push({ title: it.title });
    }
    const dupDrafts: { number: number; title: string; id: string }[] = [];
    for (const [num, entries] of draftNumCount) {
      if (entries.length > 1) {
        for (let i = 1; i < entries.length; i++) {
          dupDrafts.push({ number: num, title: entries[i].title, id: `draft-${num}-${i}` });
        }
      }
    }

    // Out-of-order (published) — find gap, everything after is ooo
    const pubNums = [...new Set(pubItems.filter(it => it.num > 0).map(it => it.num))].sort((a, b) => a - b);
    const oooItems: { number: number; title: string; id: string }[] = [];
    if (pubNums.length > 1) {
      let lastGood = 0;
      for (const n of pubNums) {
        if (n !== lastGood + 1) break;
        lastGood = n;
      }
      const oooNums = new Set(pubNums.filter(n => n > lastGood));
      if (oooNums.size > 0) {
        const seen = new Set<number>();
        for (const it of pubItems) {
          if (oooNums.has(it.num) && !seen.has(it.num)) {
            seen.add(it.num);
            oooItems.push({ number: it.num, title: it.title, id: `ooo-${it.num}` });
          }
        }
      }
    }

    // Unscheduled drafts — items without pub_time
    const unschedItems: { number: number; title: string; id: string }[] = [];
    const seenUnsched = new Set<number>();
    for (const it of draftItems) {
      if (!it.hasPubTime && it.num > 0 && !seenUnsched.has(it.num)) {
        seenUnsched.add(it.num);
        unschedItems.push({ number: it.num, title: it.title, id: `unsched-${it.num}` });
      }
    }

    // Wrong title format (drafts)
    const badFormatDrafts: { number: number; title: string; id: string }[] = [];
    for (const it of draftItems) {
      if (it.title.trim() && !/^(?:\d+\s+)?Chapter\s+\d+/i.test(it.title)) {
        badFormatDrafts.push({ number: it.num, title: it.title, id: it.num > 0 ? `badfmt-${it.num}` : badId(it.title) });
      }
    }

    // title-regex — filter published items whose title matches pattern
    const pattern = options?.pattern || '';
    const titleRegexPub: { number: number; title: string; id: string }[] = [];
    const titleRegexDraft: { number: number; title: string; id: string }[] = [];
    if (pattern) {
      const re = new RegExp(pattern, 'i');
      for (const it of pubItems) { if (re.test(it.title)) titleRegexPub.push({ number: it.num || 0, title: it.title, id: `re-pub-${it.num}` }); }
      for (const it of draftItems) { if (re.test(it.title)) titleRegexDraft.push({ number: it.num || 0, title: it.title, id: `re-draft-${it.num}` }); }
    }

    // outliers — items outside chapter range
    const minNum = options?.min ?? 1;
    const maxNum = options?.max ?? 9999;
    const outliersPub: { number: number; title: string; id: string }[] = [];
    const outliersDraft: { number: number; title: string; id: string }[] = [];
    for (const it of pubItems) { if (it.num > 0 && (it.num < minNum || it.num > maxNum)) outliersPub.push({ number: it.num, title: it.title, id: `out-pub-${it.num}` }); }
    for (const it of draftItems) { if (it.num > 0 && (it.num < minNum || it.num > maxNum)) outliersDraft.push({ number: it.num, title: it.title, id: `out-draft-${it.num}` }); }

    // bad-sequence — keep the ascending prefix from ch 1 while gaps are <=2 missing;
    // a gap of 3+ consecutive missing chapters breaks the sequence, so everything above it is bad.
    const minRun = options?.minRun ?? 5;
    const badSeqPub: { number: number; title: string; id: string }[] = [];
    const badSeqDraft: { number: number; title: string; id: string }[] = [];
    for (const [label, items] of [['published', pubItems] as const, ['draft', draftItems] as const]) {
      const numbered = items.filter(i => i.num > 0);
      const asc = [...new Set(numbered.map(i => i.num))].sort((a, b) => a - b);
      const keep = new Set<number>();
      let last = 0;
      for (const n of asc) {
        if (n - last - 1 >= 3) break;
        keep.add(n);
        last = n;
      }
      if (asc.length >= minRun) {
        for (const it of numbered) {
          if (!keep.has(it.num) && !protectedSet.has(it.num)) {
            const target = label === 'published' ? badSeqPub : badSeqDraft;
            target.push({ number: it.num, title: it.title, id: `badseq-${label}-${it.num}` });
          }
        }
      }
    }

    if (badFormatPublished.length) plan.push({ strategy: 'wrong title format (published)', items: badFormatPublished });
    if (badFormatDrafts.length) plan.push({ strategy: 'wrong title format (drafts)', items: badFormatDrafts });
    if (emptyTitlePublished.length) plan.push({ strategy: 'empty title (published)', items: emptyTitlePublished });
    if (emptyTitleDraft.length) plan.push({ strategy: 'empty title (drafts)', items: emptyTitleDraft });
    if (dupPublished.length) plan.push({ strategy: 'duplicates (published)', items: dupPublished });
    if (dupDrafts.length) plan.push({ strategy: 'duplicates (drafts)', items: dupDrafts });
    if (oooItems.length) plan.push({ strategy: 'out-of-order', items: oooItems });
    if (unschedItems.length) plan.push({ strategy: 'unscheduled drafts', items: unschedItems });
    if (titleRegexPub.length) plan.push({ strategy: 'title-regex (published)', items: titleRegexPub });
    if (titleRegexDraft.length) plan.push({ strategy: 'title-regex (drafts)', items: titleRegexDraft });
    if (outliersPub.length) plan.push({ strategy: 'outliers (published)', items: outliersPub });
    if (outliersDraft.length) plan.push({ strategy: 'outliers (drafts)', items: outliersDraft });
    if (badSeqPub.length) plan.push({ strategy: 'bad-sequence (published)', items: badSeqPub });
    if (badSeqDraft.length) plan.push({ strategy: 'bad-sequence (drafts)', items: badSeqDraft });

    // Deduplicate: each item appears in only the first strategy that matches
    {
      const seen = new Set<string>();
      for (let i = 0; i < plan.length; i++) {
        plan[i].items = plan[i].items.filter(item => {
          // Key by title when present so the same row (e.g. "0010 Chapter 244" caught
          // by both bad-format and out-of-order) is only deleted once.
          const key = item.title ? `t:${item.title}` : `id:${item.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (!plan[i].items.length) { plan.splice(i, 1); i--; }
      }
    }

    return true;
  }, false);
  if (!scanOk) return { deletedPublished: 0, deletedDrafts: 0, emptiedTrash: 0, deletedOutOfOrder: 0, deletedUnscheduledDrafts: 0, dryRun, plan: [] };

  // Only execute deletions when NOT dry-run
  if (!dryRun) {
    const exclude = new Set([...(options?.exclude || []), ...protectedSet]);
    const runStep = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await fn();
        } catch (e: any) {
          logger.warn(`[InkstoneScraper] ${name} failed (attempt ${attempt + 1}): ${e.message}`);
        }
      }
      return fallback;
    };
    const res = await runStep('executePlan', () => executePlan(novelSlug, plan, exclude), { published: 0, drafts: 0, outOfOrder: 0, unscheduled: 0 });
    published = res.published;
    drafts = res.drafts;
    deletedOutOfOrder = res.outOfOrder;
    deletedUnscheduledDrafts = res.unscheduled;
    emptiedTrash = await runStep('emptyTrash', () => withFreshPage(novelSlug, async (p) => {
      await ensureDashboard(p, novelSlug);
      return emptyTrash(p);
    }, 0), 0);
  }

  logger.info(`[InkstoneScraper] Cleanup${dryRun ? ' (dry-run)' : ''}: del ${published}pub dup, ${drafts}draft dup, ${emptiedTrash}trash, ${deletedOutOfOrder}out-of-order, ${deletedUnscheduledDrafts}unsched`);
  return { deletedPublished: published, deletedDrafts: drafts, emptiedTrash, deletedOutOfOrder, deletedUnscheduledDrafts, dryRun, plan };
}
