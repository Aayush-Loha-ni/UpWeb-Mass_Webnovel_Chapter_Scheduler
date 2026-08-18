import { platformConnector } from '../core/platform_connector';
import { applyStealthToContext } from '../core/stealth';
import { loadNovelConfig } from '../core/config';
import logger from '../core/logger';

interface PostInfo { number: number; status: string; date: string; postId: string; title: string }

async function collectPublishedPosts(page: any, novelSlug: string): Promise<PostInfo[]> {
  const config = loadNovelConfig(novelSlug);
  const targetUrl = config.kofi_url || 'https://ko-fi.com/manage/posts';

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  if (page.url().includes('/account/login')) throw new Error('Session expired');

    const fromCards = await page.evaluate((): { number: number; status: string; date: string; postId: string; title: string }[] => {
      const months: Record<string, string> = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
      const items: { number: number; status: string; date: string; postId: string; title: string }[] = [];
      const seen = new Set<number>();
      const postContainers = document.querySelectorAll<HTMLElement>('.row.feeditem-unit, .recent-posts-title, .content-text-post-header, .content-link-text');
      postContainers.forEach((el: HTMLElement) => {
        const text = el.innerText || '';
        const m = text.match(/(?:Ch(?:apter)?\.?\s*|#\s*)(\d+)/i);
        if (!m) return;
        const num = parseInt(m[1], 10);
        if (seen.has(num)) return;
        seen.add(num);
        const linkEl = el.querySelector<HTMLAnchorElement>('a[href*="/post/"]') || el.closest('.row')?.querySelector('a[href*="/post/"]');
        const href = linkEl ? linkEl.getAttribute('href') || '' : '';
        let date = '';
        const iso = text.match(/(\d{4}-\d{2}-\d{2})/);
        if (iso) { date = iso[1]; }
        else {
          const short = text.match(/(\d{1,2})\s+([A-Z][a-z]{2})/);
          if (short && months[short[2]]) { date = new Date().getFullYear() + '-' + months[short[2]] + '-' + String(parseInt(short[1], 10)).padStart(2, '0'); }
        }
        items.push({ number: num, status: 'PUBLISHED', date: date, postId: href.split('/').pop() || '', title: m[0] });
      });
    return items;
  });

  if (fromCards.length > 0) return fromCards;

  const fromBody = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    const items: { number: number; status: string; date: string; postId: string; title: string }[] = [];
    const re = /(?:Ch(?:apter)?\.?\s*|#\s*)(\d+)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
      const num = parseInt(match[1], 10);
      if (!items.some(i => i.number === num)) items.push({ number: num, status: 'PUBLISHED', date: '', postId: '', title: match[0] });
    }
    return items;
  });
  return fromBody;
}

async function collectDraftPosts(page: any): Promise<PostInfo[]> {
  await page.goto('https://ko-fi.com/blog/editor?back=true', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  const draftsLink = page.locator('a:has-text("draft")').first();
  if (await draftsLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    await draftsLink.click();
    await page.waitForTimeout(8000);
  }

  const draftItems = await page.evaluate(() => {
    const container = document.getElementById('draft-list');
    if (!container) return [];
    const vueApp = container.querySelector('.vue-draft-list-app');
    if (!vueApp || !(vueApp as any).__vue__) return [];
    try {
      return ((vueApp as any).__vue__.$data.allItems || []).map((item: any) => ({
        number: 0,
        status: 'DRAFT',
        date: '',
        postId: item.PostAlias || item.UrlDelete?.split('postAlias=')[1] || '',
        title: item.Title || '',
      }));
    } catch { return []; }
  });

  for (const d of draftItems) {
    const m = d.title.match(/(?:Ch(?:apter)?\.?\s*|#\s*)(\d+)/i);
    if (m) d.number = parseInt(m[1], 10);
  }

  return draftItems;
}

async function deletePost(page: any, post: PostInfo): Promise<boolean> {
  logger.info(`[KofiCleanup] Deleting Ch ${post.number} (${post.postId || post.title})`);
  try {
    if (!post.postId) { logger.warn(`[KofiCleanup] No postId`); return false; }

    await page.goto('https://ko-fi.com/manage/posts', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const token = await page.evaluate(() => {
      const input = document.querySelector('input[name="AntiforgeryToken"]') as HTMLInputElement;
      return input?.value || null;
    });
    if (!token) { logger.warn('[KofiCleanup] No antiforgery token'); return false; }

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
    }, { postId: post.postId, token });

    if (ok) logger.info(`[KofiCleanup] ✓ Deleted Ch ${post.number}`);
    else logger.warn(`[KofiCleanup] Delete returned false for Ch ${post.number}`);
    return ok;
  } catch (e: any) {
    logger.warn(`[KofiCleanup] Failed to delete Ch ${post.number}: ${e.message}`);
    return false;
  }
}

function parseChNum(title: string): number | null {
  const m = title.match(/(?:chapter|ch\.?)\s*(\d+)/i);
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

export async function cleanupKofi(
  novelSlug: string,
  options?: { strategies?: string[]; pattern?: string; min?: number; max?: number; minRun?: number; includeDrafts?: boolean; dryRun?: boolean; exclude?: number[] }
): Promise<{ deletedDuplicates: number; emptiedTrash: number; deletedOutOfOrder: number; deletedUnscheduled: number; deletedTitleRegex: number; deletedOutliers: number; deletedBadSequence: number; deletedEmptyTitle: number; deletedWrongTitleFormat: number; dryRun?: boolean; plan?: { strategy: string; items: { number: number; title: string; id: string }[] }[] }> {
  const dryRun = options?.dryRun ?? false;
  const ctx = await platformConnector.getScrapingContext('kofi', novelSlug);
  if (!ctx) return { deletedDuplicates: 0, emptiedTrash: 0, deletedOutOfOrder: 0, deletedUnscheduled: 0, deletedTitleRegex: 0, deletedOutliers: 0, deletedBadSequence: 0, deletedEmptyTitle: 0, deletedWrongTitleFormat: 0, dryRun, plan: [] };
  const p = await ctx.context.newPage();
  try {
    await applyStealthToContext(ctx.context);
    const published = await collectPublishedPosts(p, novelSlug);
    let all = [...published];

    if (options?.includeDrafts) {
      const drafts = await collectDraftPosts(p);
      all = [...all, ...drafts];
      logger.info(`[KofiCleanup] Found ${published.length} published + ${drafts.length} drafts`);
    } else {
      logger.info(`[KofiCleanup] Found ${published.length} posts`);
    }

    const allStrategies = options?.strategies || ['duplicates', 'out-of-order', 'title-regex', 'outliers', 'bad-sequence', 'empty-title', 'unscheduled', 'wrong-title-format'];
    const pattern = options?.pattern || '';
    const minNum = options?.min ?? 1;
    const maxNum = options?.max ?? 9999;
    const minRun = options?.minRun ?? 5;
    const exclude = new Set(options?.exclude || []);
    const plan: { strategy: string; items: { number: number; title: string; id: string }[] }[] = [];
    const seen = new Set<number>();

    let delDups = 0, delOOO = 0, delUnsched = 0;
    let delTitleRegex = 0, delOutliers = 0, delBadSeq = 0, delEmptyTitle = 0, delWrongTitleFormat = 0;

    for (const s of allStrategies) {
      let targets: PostInfo[] = [];
      switch (s) {
        case 'duplicates': targets = strategyDupNum(all); break;
        case 'out-of-order': targets = strategyOutOfOrderPublished(all); break;
        case 'title-regex':
          if (!pattern) { logger.warn('[KofiCleanup] title-regex requires --pattern, skipping'); continue; }
          targets = strategyTitleRegex(all, pattern); break;
        case 'outliers': targets = strategyOutliers(all, minNum, maxNum); break;
        case 'bad-sequence': targets = strategyBadSequence(all, minRun); break;
        case 'empty-title': targets = strategyEmptyTitle(all); break;
        case 'unscheduled': targets = strategyUnscheduled(all); break;
        case 'wrong-title-format': targets = strategyWrongTitleFormat(all); break;
        default: logger.warn(`[KofiCleanup] Unknown strategy: ${s}`); continue;
      }
      targets = targets.filter(t => !exclude.has(t.number) && !seen.has(t.number));
      if (!targets.length) { logger.info(`[KofiCleanup] ${s}: nothing to delete`); continue; }
      for (const t of targets) seen.add(t.number);
      logger.info(`[KofiCleanup] ${s}: ${targets.length} items to delete`);
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

    if (dryRun) logger.info(`[KofiCleanup] Dry-run: ${plan.reduce((a, p) => a + p.items.length, 0)} items would be deleted`);
    else logger.info(`[KofiCleanup] Done: dups=${delDups} ooo=${delOOO} title-regex=${delTitleRegex} outliers=${delOutliers} bad-seq=${delBadSeq} empty-title=${delEmptyTitle} unsched=${delUnsched} wrong-title-format=${delWrongTitleFormat}`);
    return {
      deletedDuplicates: delDups, emptiedTrash: 0, deletedOutOfOrder: delOOO, deletedUnscheduled: delUnsched,
      deletedTitleRegex: delTitleRegex, deletedOutliers: delOutliers, deletedBadSequence: delBadSeq, deletedEmptyTitle: delEmptyTitle, deletedWrongTitleFormat: delWrongTitleFormat,
      dryRun, plan,
    };
  } catch (e: any) {
    logger.warn(`[KofiCleanup] Failed: ${e.message}`);
    return { deletedDuplicates: 0, emptiedTrash: 0, deletedOutOfOrder: 0, deletedUnscheduled: 0, deletedTitleRegex: 0, deletedOutliers: 0, deletedBadSequence: 0, deletedEmptyTitle: 0, deletedWrongTitleFormat: 0, dryRun, plan: [] };
  } finally {
    try { await p.close(); } catch {}
    await ctx.cleanup();
  }
}
