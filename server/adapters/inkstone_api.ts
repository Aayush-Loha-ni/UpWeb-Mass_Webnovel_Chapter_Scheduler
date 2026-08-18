import { loadNovelConfig, SHARED_DIR } from '../core/config';
import { evalWithTimeout, injectForceVisible } from '../core/stealth';
import logger from '../core/logger';
import * as fs from 'fs';
import * as path from 'path';

export async function clickTab(page: any, tabText: string): Promise<boolean> {
  const found = await evalWithTimeout<boolean>(page, `(tab) => {
    const tabs = document.querySelectorAll('.ant-tabs-tab, [role=tab]');
    for (const t of tabs) {
      if ((t.textContent || '').toLowerCase().includes(tab.toLowerCase())) { t.click(); return true; }
    }
    return false;
  }`, tabText);
  if (!found) logger.warn(`[InkstoneScraper] Tab "${tabText}" not found on page`);
  await page.waitForTimeout(3000);
  return found;
}

export async function getCbid(page: any, novelSlug: string): Promise<string | null> {
  const url = `https://inkstone.webnovel.com/novels/view/${novelSlug}`;
  let m = page.url().match(/\/(\d{6,20})(?:\?|\/|$)/);
  if (m) return m[1];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  m = page.url().match(/\/(\d{6,20})(?:\?|\/|$)/);
  return m ? m[1] : null;
}

/**
 * Re-mint the Inkstone JWT via the SSO "Sign in to Inkstone" flow.
 * The SPA's sign-in button navigates to passport.webnovel.com with `auto=1`;
 * passport logs in silently from the existing uid/ukey cookies and redirects
 * back to /login/callback?ticket=..&userid=.., which the SPA exchanges for a
 * fresh inkstone_auth_token via /tauthorweb/login/verify.
 *
 * If auto-login fails (passport shows the provider-buttons page), fall back to
 * the Google OAuth path: click "Log in with Google" → accounts.google.com shows
 * the account chooser for the gmail account we have cookies on → click the
 * 1st account → consent → passport → callback → fresh JWT.
 */
export async function renewInkstoneSession(page: any, returnUrl: string): Promise<boolean> {
  const host = 'inkstone.webnovel.com';
  const callbackReturn = `https://${host}/login/callback?redirectUrl=${encodeURIComponent(returnUrl)}`;
  const params = new URLSearchParams({
    auto: '1',
    target: 'iframe',
    maskOpacity: '50',
    popup: '1',
    format: 'redirect',
    appid: '900',
    areaid: '8',
    source: 'qidianoversea',
    returnurl: callbackReturn,
  });
  const loginUrl = `https://passport.webnovel.com/login.html?${params.toString()}`;
  logger.info('[InkstoneScraper] Renewing Inkstone session via SSO...');

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  // passport auto-logs-in → redirects to the SPA callback → verify → redirect to returnUrl
  const autoDeadline = Date.now() + 30000;
  while (Date.now() < autoDeadline && page.url().includes('passport.webnovel.com')) {
    await page.waitForTimeout(2000);
  }

  if (page.url().includes('passport.webnovel.com')) {
    // Auto-login failed — passport is showing the provider-buttons page. Drive Google OAuth.
    logger.warn('[InkstoneScraper] Passport auto-login failed — attempting Google OAuth...');
    const clicked = await page.evaluate(() => {
      const g = document.querySelector<HTMLAnchorElement>('a.bt._g[href*="login/google"]');
      if (g) { g.click(); return true; }
      return false;
    }).catch(() => false);
    if (!clicked) {
      await page.goto('https://ptlogin.webnovel.com/login/google?ver=2&channel=google', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }

    // Now on accounts.google.com: pick the 1st account from the chooser, else hit consent.
    const googleDeadline = Date.now() + 60000;
    while (Date.now() < googleDeadline) {
      await page.waitForTimeout(2000);
      if (!page.url().includes('accounts.google.com')) break;
      const acted = await page.evaluate(() => {
        // Account chooser / account list
        const first = document.querySelector('[data-identifier]');
        if (first instanceof HTMLElement) { first.click(); return true; }
        // Consent / continue button
        const btn = Array.from(document.querySelectorAll('button'))
          .find((b) => /continue|allow/i.test((b.textContent || '').trim())) as HTMLElement | undefined;
        if (btn) { btn.click(); return true; }
        // Email-entry form visible → no Google session we have cookies for
        const hasEmailInput = document.querySelector('input[type="email"], input[autocomplete="username"]');
        return hasEmailInput ? 'bail' : false;
      }).catch(() => false);
      if (acted === 'bail') {
        logger.warn('[InkstoneScraper] Google shows email form — no session cookies. Manual login required.');
        return false;
      }
    }
  }

  // Wait for the OAuth → passport → SPA callback → /login/verify round-trip.
  const roundtripDeadline = Date.now() + 60000;
  while (Date.now() < roundtripDeadline) {
    const url = page.url();
    if (!url.includes('passport.webnovel.com') && !url.includes('ptlogin.webnovel.com') && !url.includes('accounts.google.com')) break;
    await page.waitForTimeout(2000);
  }
  if (page.url().includes('passport.webnovel.com') || page.url().includes('accounts.google.com')) {
    logger.warn('[InkstoneScraper] SSO renewal timed out on the login flow.');
    return false;
  }
  // SPA processes the /login/callback ticket and redirects; give it a moment
  await page.waitForTimeout(8000);
  const cookies = await page.context().cookies('https://inkstone.webnovel.com').catch(() => [] as any[]);
  const tok = cookies.find((c: any) => c.name === 'inkstone_auth_token');
  if (!tok || !tok.value) {
    logger.warn('[InkstoneScraper] No inkstone_auth_token after SSO renewal.');
    return false;
  }
  logger.info('[InkstoneScraper] Inkstone SSO renewal succeeded (fresh token).');
  return true;
}

export async function apiFetchDraftCcids(page: any, cbid: string, slug?: string): Promise<Array<{ ccid: string; cvid: string; title: string; date?: string }>> {
  const config = loadNovelConfig(slug || '');
  const tz = config?.timezone || '5.75';
  const baseUrl = `https://inkstone.webnovel.com/tauthorweb/chapter/paginateDraftList?CBID=${cbid}&timezone=${tz}&pageSize=200`;
  const results: Array<{ ccid: string; cvid: string; title: string; date?: string }> = [];
  const apiDiagLines: string[] = [];
  let capturedHeaders: Record<string, string> = {};
  await page.route('**/tauthorweb/**', async (route: any) => {
    const req = route.request();
    const hdrs = await req.allHeaders();
    for (const [k, v] of Object.entries(hdrs)) {
      if (k.toLowerCase().startsWith('authorization') || k.toLowerCase().startsWith('x-')) { capturedHeaders[k] = String(v); }
    }
    route.continue();
  });
  await page.evaluate(() => fetch('https://inkstone.webnovel.com/tauthorweb/dashboard/getContestList?pageNo=1&pageSize=1').catch(() => {}));
  await page.waitForTimeout(2000);
  await page.unroute('**/tauthorweb/**');
  apiDiagLines.push(`auth_headers=${JSON.stringify(capturedHeaders).slice(0,400)}`);

  const doFetch = async (pgn: number): Promise<string> => {
    const resp = await page.request.fetch(`${baseUrl}&pageNo=${pgn}`, { headers: capturedHeaders });
    return await resp.text();
  };
  for (let pg = 1; pg < 50; pg++) {
    try {
      let text = await doFetch(pg);
      if (apiDiagLines.length === 1) apiDiagLines.push(`body=${text.slice(0,600).replace(/\n/g,' ')}`);
      let data: any;
      try { data = JSON.parse(text); } catch { if (apiDiagLines.length < 3) apiDiagLines.push('not JSON'); break; }
      if (data.returnCode !== 200) {
        apiDiagLines.push(`rc=${data.returnCode}: ${(data.returnMsg||'').slice(0,80)}`);
        if (data.returnCode === 4001 && pg === 1) {
          apiDiagLines.push('session_expired_sso_attempt');
          const ok = await renewInkstoneSession(page, `https://inkstone.webnovel.com/novels/view/${slug || cbid}`);
          apiDiagLines.push(ok ? 'sso_recovered' : 'sso_failed');
          if (!ok) { apiDiagLines.push('jwt_still_expired_final'); break; }
          capturedHeaders = {};
          await page.route('**/tauthorweb/**', async (route: any) => {
            const req = route.request();
            const hdrs = await req.allHeaders();
            for (const [k, v] of Object.entries(hdrs)) { if (k.toLowerCase().startsWith('authorization') || k.toLowerCase().startsWith('x-')) { capturedHeaders[k] = String(v); } }
            route.continue();
          });
          await page.evaluate(() => fetch('https://inkstone.webnovel.com/tauthorweb/dashboard/getContestList?pageNo=1&pageSize=1').catch(() => {}));
          await page.waitForTimeout(5000);
          await page.unroute('**/tauthorweb/**');
          apiDiagLines.push(`retry_headers=${JSON.stringify(capturedHeaders).slice(0,400)}`);
          text = await doFetch(1);
          let retryData: any;
          try { retryData = JSON.parse(text); } catch { retryData = null; }
          if (retryData && retryData.returnCode === 200) {
            data = retryData;
            apiDiagLines.push('jwt_recovered');
          } else {
            apiDiagLines.push('jwt_still_expired_final');
            break;
          }
        } else { break; }
      }
      const records = data?.result?.records || data?.records || data?.result?.list || data?.list;
      if (!records || !records.length) break;
      let pageCount = 0;
      for (const rec of records) {
        const vos = rec.chapterInfoVos || rec.items || (Array.isArray(rec) ? rec : [rec]);
        const arr = Array.isArray(vos) ? vos : [vos];
        for (const vo of arr) {
          const ccid = String(vo.ccid || vo.CCID || '');
          const cvid = String(vo.cvid || vo.CVID || vo.chapterInfoVo?.cvid || '');
          const title = vo.chapterTitle || vo.chapterName || vo.title || '';
          const apiDate = vo.publishTime || vo.scheduledPublishTime || vo.scheduleTime || vo.fireTime || vo.publishDate || vo.gmtCreate || '';
          let date = '';
          if (apiDate) {
            const ds = String(apiDate);
            const fullMonth = ds.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i);
            if (fullMonth) {
              const months: Record<string, string> = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
              date = fullMonth[5] + '-' + months[fullMonth[4]] + '-' + String(parseInt(fullMonth[3], 10)).padStart(2, '0');
            } else if (/^\d{4}-\d{2}-\d{2}/.test(ds)) {
              date = ds.slice(0, 10);
            }
          }
          if (ccid) { results.push({ ccid, cvid, title, date }); pageCount++; }
        }
      }
      if (pageCount === 0) break;
    } catch (e: any) { apiDiagLines.push(`err pg${pg}: ${e.message}`); break; }
  }
  apiDiagLines.push(`parsed ${results.length}`);
  try { fs.writeFileSync(path.join(SHARED_DIR, 'debug', `api_${Date.now()}.log`), apiDiagLines.join('\n'), 'utf8'); } catch {}
  logger.info(`[InkstoneScraper] Browser API returned ${results.length} drafts`);
  return results;
}

/**
 * Fetch all published chapter numbers from the Inkstone published tab.
 * Paginates through all pages to get the complete list.
 */
export async function apiFetchPublishedNumbers(page: any, cbid: string): Promise<number[]> {
  const allNums: number[] = [];
  const tabClicked = await clickTab(page, 'published');
  logger.info(`[InkstoneScraper] apiFetchPublishedNumbers: clickTab returned ${tabClicked}, url=${page.url()}`);
  await injectForceVisible(page);
  await page.waitForTimeout(2000);
  for (let pg = 1; pg < 200; pg++) {
    const res = await page.evaluate(() => {
      const panel = document.querySelector('.ant-tabs-tabpane-active');
      if (!panel) return { nums: [] as number[], hasNext: false };
      const lis = panel.querySelectorAll('li.ant-list-item');
      const nums: number[] = [];
      for (const li of lis) {
        const link = li.querySelector('a[class*="title"]');
        const text = link?.textContent?.trim() || '';
        const m = text.match(/(?:chapter|ch\.?)\s*#?\s*(\d+)/i);
        if (m) nums.push(parseInt(m[1], 10));
      }
      const nextBtn = panel.querySelector('.ant-pagination-next');
      return { nums, hasNext: !!nextBtn && !nextBtn.classList.contains('ant-pagination-disabled') };
    });
    if (!res.nums.length) break;
    allNums.push(...res.nums);
    if (!res.hasNext) break;
    await page.evaluate(() => {
      const panel = document.querySelector('.ant-tabs-tabpane-active');
      const next = panel?.querySelector('.ant-pagination-next') as HTMLElement | null;
      if (next && !next.classList.contains('ant-pagination-disabled')) next.click();
    });
    await page.waitForTimeout(2000);
  }
  logger.info(`[InkstoneScraper] Published tab returned ${allNums.length} chapter numbers`);
  return [...new Set(allNums)].sort((a, b) => a - b);
}

export async function apiDeleteDraftByCcid(page: any, cbid: string, ccid: string): Promise<boolean> {
  const result = await evalWithTimeout<string>(page, (async ([fetchUrl, cbidVal, ccidVal]: [string, string, string]) => {
    try {
      const r = await fetch(fetchUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ CBID: cbidVal, CCID: ccidVal }),
      });
      return JSON.stringify(await r.json());
    } catch (e: any) { return 'ERROR: ' + e.message; }
  }) as any, ['https://inkstone.webnovel.com/tauthorweb/chapter/deleteChapter', cbid, ccid]);
  if (!result || result.startsWith('ERROR')) return false;
  try {
    const parsed = JSON.parse(result);
    if (parsed.returnCode === 4001) {
      const ok = await renewInkstoneSession(page, `https://inkstone.webnovel.com/novels/view/${cbid}`);
      if (!ok) return false;
      const retry = await evalWithTimeout<string>(page, (async ([fetchUrl, cbidVal, ccidVal]: [string, string, string]) => {
        try {
          const r = await fetch(fetchUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ CBID: cbidVal, CCID: ccidVal }),
          });
          return JSON.stringify(await r.json());
        } catch (e: any) { return 'ERROR: ' + e.message; }
      }) as any, ['https://inkstone.webnovel.com/tauthorweb/chapter/deleteChapter', cbid, ccid]);
      if (!retry || retry.startsWith('ERROR')) return false;
      const retryParsed = JSON.parse(retry);
      return retryParsed.returnCode === 200;
    }
    return parsed.returnCode === 200;
  } catch {
    return false;
  }
}
