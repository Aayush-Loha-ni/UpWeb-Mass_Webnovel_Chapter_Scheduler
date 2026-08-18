import { platformConnector } from '../core/platform_connector';
import { applyStealthToContext, humanDelay, postNavigationDelay } from '../core/stealth';
import { loadNovelConfig } from '../core/config';
import logger from '../core/logger';

interface PostInfo { number: number; status: string; date: string; postId: string; title: string }

async function collectPosts(page: any, novelSlug: string): Promise<PostInfo[]> {
  const config = loadNovelConfig(novelSlug);
  const tierId = config.patreon_tier_id || '';
  const tag = config.patreon_tag || '';
  const targetUrl = tierId
    ? `https://www.patreon.com/library?tier=${tierId}&tags=${encodeURIComponent(tag)}`
    : 'https://www.patreon.com/library';

  const campaignIdPromise = new Promise<string>((resolve) => {
    const handler = (response: any) => {
      const m = response.url().match(/filter%5Bcampaign_id%5D=(\d+)/);
      if (m) resolve(m[1]);
    };
    page.on('response', handler);
  });

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);
  if (page.url().includes('/login')) throw new Error('Session expired');

  const campaignId = await Promise.race([
    campaignIdPromise,
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Campaign ID not found')), 15000)),
  ]);

  const all: PostInfo[] = [];
  let cursor = '';
  const seen = new Set<string>();

  while (true) {
    const params = new URLSearchParams({
      'fields[post]': 'title,published_at,scheduled_for,post_type',
      'filter[campaign_id]': campaignId,
      'filter[is_published_or_scheduled]': 'true',
      'filter[tag]': tag,
      'sort': '-published_at',
      'page[size]': '50',
      'page[cursor]': cursor,
      'json-api-version': '1.0',
    });

    const result = await page.evaluate(async (fetchUrl: string) => {
      try {
        const resp = await fetch(fetchUrl, { credentials: 'include' });
        if (resp.status !== 200) return { error: `HTTP ${resp.status}` };
        const json = await resp.json();
        return { data: json.data || [], next: json.links?.next || '' };
      } catch (e: any) {
        return { error: e.message };
      }
    }, `https://www.patreon.com/api/posts?${params.toString()}`);

    if (result.error) break;

    for (const post of result.data) {
      const title = post.attributes?.title || '';
      const id = post.id || '';
      if (seen.has(id)) continue;
      seen.add(id);
      const m = title.trim().match(/(?:chapter|ch\.?)\s*#?\s*(\d+)/i);
      if (!m) continue;
      const num = parseInt(m[1], 10);
      if (num >= 1000) continue;
      all.push({
        number: num,
        status: post.attributes?.scheduled_for ? 'SCHEDULED' : 'PUBLISHED',
        date: post.attributes?.published_at || post.attributes?.scheduled_for || '',
        postId: id,
        title: title.trim(),
      });
    }

    if (!result.next) break;
    const nextUrl = new URL(result.next);
    cursor = nextUrl.searchParams.get('page[cursor]') || '';
    if (!cursor) break;
  }

  return all.sort((a, b) => a.number - b.number);
}

async function deletePost(page: any, post: PostInfo): Promise<boolean> {
  const editUrl = `https://www.patreon.com/posts/${post.postId}/edit`;
  logger.info(`[PatreonCleanup] Deleting Ch ${post.number} (${post.postId})`);
  try {
    await humanDelay();
    await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await postNavigationDelay();
    try { await page.waitForLoadState('networkidle', { timeout: 30000 }); } catch {}
    if (page.url().includes('/login')) { logger.warn('[PatreonCleanup] Session expired'); return false; }

    let domOk = false;
    const moreBtn = page.getByRole('button', { name: 'More actions' }).first();
    if (await moreBtn.isVisible().catch(() => false)) {
      await moreBtn.click();
      await page.waitForTimeout(1500);
      const deleteItem = page.getByRole('menuitem', { name: 'Delete post' }).first();
      if (await deleteItem.isVisible().catch(() => false)) {
        await deleteItem.click();
        await page.waitForTimeout(3000);
        const confirmBtn = page.locator('[data-tag="dialog-container"] button:has-text("Delete"), [data-tag="dialog-container"] button:has-text("Confirm"), [data-tag="dialog-container"] button:has-text("Yes"), button:has-text("Delete"):visible, button:has-text("Confirm"):visible, button:has-text("Yes"):visible').first();
        if (await confirmBtn.isVisible().catch(() => false)) {
          await page.evaluate(() => {
            const btns = document.querySelectorAll('[data-tag="dialog-container"] button');
            for (const btn of btns) {
              const text = btn.textContent?.toLowerCase() || '';
              if (text.includes('delete') || text.includes('confirm') || text.includes('yes')) {
                (btn as HTMLButtonElement).click();
                return;
              }
            }
          });
          await page.waitForTimeout(3000);
          domOk = true;
        }
      }
    }
    if (domOk) { logger.info(`[PatreonCleanup] ✓ Deleted Ch ${post.number}`); return true; }
    logger.warn(`[PatreonCleanup] DOM delete failed for Ch ${post.number}`);
    return false;
  } catch (e: any) {
    logger.warn(`[PatreonCleanup] Failed to delete Ch ${post.number}: ${e.message}`);
    return false;
  }
}

function parseChNum(title: string): number | null {
  const m = title.match(/(?:chapter|ch\.?)\s*#?\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function strategyTitleRegex(items: PostInfo[], pattern: string): PostInfo[] {
  const re = new RegExp(pattern, 'i');
  return items.filter(i => re.test(i.title));
}

function strategyOutliers(items: PostInfo[], minNum: number, maxNum: number): PostInfo[] {
  return items.filter(i => i.number < minNum || i.number > maxNum);
}

function strategyBadSequence(items: PostInfo[], minRun: number): PostInfo[] {
  const numbered = items.filter(i => i.number > 0);
  if (numbered.length < minRun) return [];
  const sorted = [...numbered].sort((a, b) => b.number - a.number);
  const runs: PostInfo[][] = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].number - sorted[i].number === 1) {
      current.push(sorted[i]);
    } else {
      runs.push(current);
      current = [sorted[i]];
    }
  }
  runs.push(current);
  runs.sort((a, b) => b.length - a.length);
  const longest = runs[0];
  if (longest.length < minRun) return [];
  const keep = new Set(longest.map(i => i.number));
  return items.filter(i => i.number > 0 && !keep.has(i.number));
}

function strategyDupNum(items: PostInfo[]): PostInfo[] {
  const byNum = new Map<number, PostInfo[]>();
  for (const item of items) {
    if (!byNum.has(item.number)) byNum.set(item.number, []);
    byNum.get(item.number)!.push(item);
  }
  const dups: PostInfo[] = [];
  for (const [, posts] of byNum) {
    if (posts.length <= 1) continue;
    posts.sort((a, b) => {
      if (a.status === 'PUBLISHED' && b.status !== 'PUBLISHED') return -1;
      if (b.status === 'PUBLISHED' && a.status !== 'PUBLISHED') return 1;
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    });
    dups.push(...posts.slice(1));
  }
  return dups;
}

function strategyEmptyTitle(items: PostInfo[]): PostInfo[] {
  return items.filter(i => !i.title.trim());
}

function strategyWrongTitleFormat(items: PostInfo[]): PostInfo[] {
  return items.filter(i => i.title.trim() && !/^Chapter \d+/i.test(i.title));
}

function strategyOutOfOrderPublished(items: PostInfo[]): PostInfo[] {
  const sorted = items.filter(i => i.status === 'PUBLISHED').sort((a, b) => a.number - b.number);
  let lastGood = 0;
  for (const p of sorted) {
    if (p.number !== lastGood + 1) break;
    lastGood = p.number;
  }
  return sorted.filter(p => p.number > lastGood);
}

function strategyUnscheduled(items: PostInfo[]): PostInfo[] {
  return items.filter(i => i.status !== 'SCHEDULED' && !i.date);
}

export async function cleanupPatreon(
  novelSlug: string,
  options?: { strategies?: string[]; pattern?: string; min?: number; max?: number; minRun?: number; dryRun?: boolean; exclude?: number[] }
): Promise<{ deletedDuplicates: number; emptiedTrash: number; deletedOutOfOrder: number; deletedUnscheduled: number; deletedTitleRegex: number; deletedOutliers: number; deletedBadSequence: number; deletedEmptyTitle: number; deletedWrongTitleFormat: number; dryRun?: boolean; plan?: { strategy: string; items: { number: number; title: string; id: string }[] }[] }> {
  const dryRun = options?.dryRun ?? false;
  const ctx = await platformConnector.getScrapingContext('patreon', novelSlug);
  if (!ctx) return { deletedDuplicates: 0, emptiedTrash: 0, deletedOutOfOrder: 0, deletedUnscheduled: 0, deletedTitleRegex: 0, deletedOutliers: 0, deletedBadSequence: 0, deletedEmptyTitle: 0, deletedWrongTitleFormat: 0, dryRun, plan: [] };
  const p = await ctx.context.newPage();
  try {
    await applyStealthToContext(ctx.context);
    const items = await collectPosts(p, novelSlug);
    logger.info(`[PatreonCleanup] Found ${items.length} posts`);

    const allStrategies = options?.strategies || ['duplicates', 'out-of-order', 'title-regex', 'outliers', 'bad-sequence', 'empty-title', 'unscheduled', 'wrong-title-format'];
    const pattern = options?.pattern || '';
    const minNum = options?.min ?? 1;
    const maxNum = options?.max ?? 9999;
    const minRun = options?.minRun ?? 5;
    const { loadTracker } = await import('../core/tracker');
    // ponytail: verified-sequential chapters are NEVER deletable on either platform.
    const exclude = new Set([...(options?.exclude || []), ...(loadTracker(novelSlug).protected || [])]);
    const plan: { strategy: string; items: { number: number; title: string; id: string }[] }[] = [];
    const seen = new Set<number>();

    let delDups = 0, delOOO = 0, delUnsched = 0;
    let delTitleRegex = 0, delOutliers = 0, delBadSeq = 0, delEmptyTitle = 0, delWrongTitleFormat = 0;

    for (const s of allStrategies) {
      let targets: PostInfo[] = [];
      switch (s) {
        case 'duplicates': targets = strategyDupNum(items); break;
        case 'out-of-order': targets = strategyOutOfOrderPublished(items); break;
        case 'title-regex':
          if (!pattern) { logger.warn('[PatreonCleanup] title-regex requires --pattern, skipping'); continue; }
          targets = strategyTitleRegex(items, pattern); break;
        case 'outliers': targets = strategyOutliers(items, minNum, maxNum); break;
        case 'bad-sequence': targets = strategyBadSequence(items, minRun); break;
        case 'empty-title': targets = strategyEmptyTitle(items); break;
        case 'unscheduled': targets = strategyUnscheduled(items); break;
        case 'wrong-title-format': targets = strategyWrongTitleFormat(items); break;
        default: logger.warn(`[PatreonCleanup] Unknown strategy: ${s}`); continue;
      }
      targets = targets.filter(t => !exclude.has(t.number) && !seen.has(t.number));
      if (!targets.length) { logger.info(`[PatreonCleanup] ${s}: nothing to delete`); continue; }
      for (const t of targets) seen.add(t.number);
      logger.info(`[PatreonCleanup] ${s}: ${targets.length} items to delete`);
      plan.push({ strategy: s, items: targets.map(t => ({ number: t.number, title: t.title, id: t.postId })) });
      if (dryRun) continue;
      for (const t of targets) {
        if (await deletePost(p, t)) {
          if (s === 'duplicates') delDups++;
          else if (s === 'out-of-order') delOOO++;
          else if (s === 'title-regex') delTitleRegex++;
          else if (s === 'outliers') delOutliers++;
          else if (s === 'bad-sequence') delBadSeq++;
          else if (s === 'empty-title') delEmptyTitle++;
          else if (s === 'unscheduled') delUnsched++;
          else if (s === 'wrong-title-format') delWrongTitleFormat++;
        }
      }
    }

    if (dryRun) logger.info(`[PatreonCleanup] Dry-run: ${plan.reduce((a, p) => a + p.items.length, 0)} items would be deleted`);
    else logger.info(`[PatreonCleanup] Done: dups=${delDups} ooo=${delOOO} title-regex=${delTitleRegex} outliers=${delOutliers} bad-seq=${delBadSeq} empty-title=${delEmptyTitle} unsched=${delUnsched} wrong-title-format=${delWrongTitleFormat}`);
    return {
      deletedDuplicates: delDups, emptiedTrash: 0, deletedOutOfOrder: delOOO, deletedUnscheduled: delUnsched,
      deletedTitleRegex: delTitleRegex, deletedOutliers: delOutliers, deletedBadSequence: delBadSeq, deletedEmptyTitle: delEmptyTitle, deletedWrongTitleFormat: delWrongTitleFormat,
      dryRun, plan,
    };
  } catch (e: any) {
    logger.warn(`[PatreonCleanup] Failed: ${e.message}`);
    return { deletedDuplicates: 0, emptiedTrash: 0, deletedOutOfOrder: 0, deletedUnscheduled: 0, deletedTitleRegex: 0, deletedOutliers: 0, deletedBadSequence: 0, deletedEmptyTitle: 0, deletedWrongTitleFormat: 0, dryRun, plan: [] };
  } finally {
    try { await p.close(); } catch {}
    await ctx.cleanup();
  }
}
