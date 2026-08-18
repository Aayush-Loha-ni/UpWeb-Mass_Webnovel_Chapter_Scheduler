import { SequenceReport } from './models';
import { withRetry } from './error_codes';
import { applyStealthToContext } from './stealth';
import { getReaderBrowser } from './platform_connector';
import logger from './logger';

let _reqContext: any = null;
async function getReq(): Promise<any> {
  if (!_reqContext) {
    const mod = await import('playwright') as any;
    _reqContext = await mod.request.newContext();
  }
  return _reqContext;
}

export async function fetchPublicCatalog(slug: string): Promise<string> {
  const url = `https://www.webnovel.com/book/${slug}/catalog`;
  logger.info(`[WebnovelPublic] Fetching catalog: ${url}`);
  return withRetry(async () => {
    // ponytail: the public catalog is fully server-rendered — one plain-HTTP GET
    // returns every chapter link (verified: 101 anchors without any browser).
    // Cheapest fetcher first; the browser path below is the fallback for the rare
    // page that's Cloudflare-challenged or genuinely needs JS rendering.
    try {
      const req = await getReq();
      const res = await req.get(url, { timeout: 15000, maxRedirects: 0 });
      if (res.ok()) {
        const html = await res.text();
        if (html && html.length >= 500 && /chapter-\d/.test(html)) {
          logger.info(`[WebnovelPublic] Catalog via plain HTTP (${html.length} bytes)`);
          return html;
        }
        logger.warn(`[WebnovelPublic] Plain-HTTP catalog too short (${html?.length ?? 0} bytes) — falling back to browser`);
      } else {
        logger.warn(`[WebnovelPublic] Plain-HTTP catalog HTTP ${res.status()} — falling back to browser`);
      }
    } catch (e: any) {
      logger.warn(`[WebnovelPublic] Plain-HTTP catalog failed: ${e.message} — falling back to browser`);
    }

    const browser = await getReaderBrowser();
    const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
    await applyStealthToContext(context);
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      // Wait for chapter list to render
      await page.waitForSelector('a[href*="chapter-"]', { timeout: 15000 }).catch(() => {});
      // ponytail: use native mouse.wheel instead of page.evaluate — esbuild injects the
      // __name helper into serialized functions, which Playwright lacks in-page ("__name
      // is not defined"). mouse.wheel avoids serializing any function into the browser.
      for (let i = 0; i < 50; i++) {
        await page.mouse.wheel(0, 1000);
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(2000);
      const html = await page.content();
      if (!html || html.length < 500) throw new Error('Rendered page too short');
      return html;
    } finally {
      await context.close().catch(() => {});
    }
  }, { onRetry: (n, d) => logger.warn(`[WebnovelPublic] catalog fetch retry #${n} in ${d}ms`) });
}

// ponytail: extract a chapter number from a catalog href. Decimals ("chapter-5.1-...")
// are floored to their integer base (5) so sub-chapters count as "5 present".
const chapterNumRe = /chapter-(\d+(?:\.\d+)?)[-_]/gi;

export function parseLatestChapter(html: string): number {
  let last = 0;
  let match;
  while ((match = chapterNumRe.exec(html)) !== null) {
    const num = Math.floor(parseFloat(match[1]));
    if (num > last) last = num;
  }
  return last;
}

export function parseAllChapterNumbers(html: string): number[] {
  const seen = new Set<number>();
  let match;
  while ((match = chapterNumRe.exec(html)) !== null) {
    const num = Math.floor(parseFloat(match[1]));
    if (num > 0 && num < 10000) seen.add(num);
  }
  return [...seen].sort((a, b) => a - b);
}

export function parseCatalogSequentialNumbers(html: string): number[] {
  // Extract all published chapter numbers from <a> hrefs. The public catalog only
  // lists published chapters, so every captured base is a real published chapter.
  const linkPattern = /<a[^>]*href="[^"]*chapter-(\d+(?:\.\d+)?)[-_][^"]*"[^>]*>/gi;
  const seen = new Set<number>();
  let m;
  while ((m = linkPattern.exec(html)) !== null) {
    const num = Math.floor(parseFloat(m[1]));
    if (num > 0 && num < 10000) seen.add(num);
  }
  return [...seen].sort((a, b) => a - b);
}

export function parseNovelName(html: string): string | null {
  const og = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (og) return og[1];
  const titleTag = html.match(/<title>([^<]+)<\/title>/i);
  if (titleTag) return titleTag[1].replace(/\s*[-–|]\s*Webnovel\s*$/i, '').trim();
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1) return h1[1].trim();
  return null;
}

export function publishDateFromPage(page: string): string {
  // ponytail: return the chapter's publish date (YYYY-MM-DD) only if the chapter is
  // actually published. A publishTime in the future means a scheduled draft — webnovel
  // lists those on the catalog too — and a draft date is not a valid anchor.
  const m = page.match(/["']orderIndex["']\s*:\s*(\d+)[\s\S]{0,8000}?["']publishTime["']\s*:\s*(\d{10,13})/);
  const raw = m ? m[2] : [...page.matchAll(/"publishTime":(\d{10,13})/g)].pop()?.[1];
  if (!raw) return '';
  const d = new Date(parseInt(raw, 10));
  if (isNaN(d.getTime())) return '';
  const iso = d.toISOString().slice(0, 10);
  if (iso > new Date().toISOString().slice(0, 10)) return '';
  if (iso < '2000-01-01') return '';
  return iso;
}

export async function fetchLatestPublishedPublishDate(slug: string): Promise<string> {
  // ponytail: anchor = publish date of the latest *published* chapter, read live from
  // the chapter page's embedded JSON (publishTime epoch-ms). The drafts API returns
  // no date for published chapters, so this is the reliable source.
  try {
    const catalog = await fetchPublicCatalog(slug);
    const links = [...catalog.matchAll(/href="([^"]*\/chapter-(\d+)_(\d+)[^"]*)"/gi)]
      .map(m => ({ href: m[1], num: parseInt(m[2], 10), cid: m[3] }))
      .sort((a, b) => b.num - a.num);
    // ponytail: the newest links can be future-scheduled drafts, not published
    // chapters; scan down until publishDateFromPage yields a real published date.
    for (const link of links.slice(0, 5)) {
      const url = link.href.startsWith('http') ? link.href : `https://www.webnovel.com${link.href}`;
      const page = await withRetry(async () => {
        const req = await getReq();
        const res = await req.get(url, { timeout: 15000, maxRedirects: 0 });
        if (!res.ok()) throw new Error(`HTTP ${res.status()} from webnovel.com`);
        return await res.text();
      }, { onRetry: (n, d) => logger.warn(`[WebnovelPublic] chapter fetch retry #${n} in ${d}ms`) });
      const iso = publishDateFromPage(page);
      if (iso) return iso;
      logger.warn(`[WebnovelPublic] Ch ${link.num} has no published date (draft or blocked) — skipping`);
    }
  } catch (e) {
    logger.warn(`[WebnovelPublic] fetchLatestPublishedPublishDate failed: ${e}`);
  }
  return '';
}

export function computeSequence(nums: number[]): SequenceReport {
  const sorted = [...new Set(nums)].filter(n => n > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return { ok: false, missing: [], from: 0, to: 0 };
  // ponytail: check gaps by integer base (Math.floor) so chapters split into decimal
  // sub-parts (25.1, 25.2) count as "25 present" instead of showing as missing.
  const present = new Set(sorted.map(n => Math.floor(n)));
  const missing: number[] = [];
  const from = Math.floor(sorted[0]);
  const to = Math.floor(sorted[sorted.length - 1]);
  const max = Math.min(to, 100000);
  for (let i = from; i <= max; i++) {
    if (!present.has(i)) missing.push(i);
  }
  return { ok: missing.length === 0 && from === 1, missing, from, to };
}

export async function scrapePublicNovelName(slug: string): Promise<string | null> {
  try {
    const url = `https://www.webnovel.com/book/${slug}`;
    return await withRetry(async () => {
      const req = await getReq();
    const res = await req.get(url, { timeout: 15000, maxRedirects: 0 });
      if (!res.ok()) throw new Error(`HTTP ${res.status()} from webnovel.com`);
      return parseNovelName(await res.text());
    });
  } catch (e) {
    logger.warn(`[WebnovelPublic] scrapeNovelName failed: ${e}`);
    return null;
  }
}
