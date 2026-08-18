/**
 * API v1 router — all REST endpoints under /api/v1/
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import multer from 'multer';
import mammoth from 'mammoth';
import { loadNovelsRegistry, saveNovelsRegistry, loadNovelConfig, saveNovelConfig, ensureWorkspaceDirectories, WORKSPACE_ROOT, SHARED_DIR } from '../core/config';
import { loadTracker, saveTrackerAtomic, computeLeadDays, getTrackerPath } from '../core/tracker';
import { scanChaptersDirectory, parseChapterFile, invalidateChapterCache } from '../core/parser';
import { unlockFile, lockFile } from '../core/locking';
import { chromium } from 'playwright';
import { applyStealthToContext } from '../core/stealth';
import { BrowserManager } from '../core/browser';
import { AutomationRunner } from '../core/runner';
import { platformConnector } from '../core/platform_connector';
import { computeNextSchedule } from '../core/scheduler';
import { auditSequence, inkstoneDateToIso } from '../core/sequencer';
import { logEventBus } from './log_events';
import { scrapePublicNovelName, fetchPublicCatalog, parseLatestChapter, computeSequence } from '../core/webnovel_public';
import { isLocalTrustedRequest, getCurrentApiKey } from '../core/auth';
import { verifyLicenseToken } from '../core/license';
import rateLimit from 'express-rate-limit';
import logger from '../core/logger';

function validateSlug(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}

// ponytail: business cap on chapter numbers — the platforms only handle up to ~1000,
// so anything above is rejected at the API boundary instead of silently never publishing.
export const MAX_CHAPTER_NUMBER = 1000;


export function createV1Router(shutdown?: () => void): Router {
  const runningSlugs = new Set<string>();
  const router = Router();

  const automationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Too many automation requests. Try again in a minute.' },
    standardHeaders: false,
    legacyHeaders: false,
  });

  const mutationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Too many requests. Try again in a minute.' },
    standardHeaders: false,
    legacyHeaders: false,
  });

  const circuitBreaker = new Map<string, { failures: number; lastFailure: number }>();
  const CB_THRESHOLD = 5;
  const CB_WINDOW_MS = 60 * 60 * 1000;
  function checkCircuitBreaker(slug: string): string | null {
    const entry = circuitBreaker.get(slug);
    if (!entry) return null;
    if (entry.failures >= CB_THRESHOLD && (Date.now() - entry.lastFailure) < CB_WINDOW_MS) return 'Too many recent failures. Automation blocked.';
    if ((Date.now() - entry.lastFailure) >= CB_WINDOW_MS) circuitBreaker.delete(slug);
    return null;
  }
  function recordCircuitFailure(slug: string): void {
    const entry = circuitBreaker.get(slug) || { failures: 0, lastFailure: 0 };
    entry.failures++; entry.lastFailure = Date.now();
    circuitBreaker.set(slug, entry);
  }
  function resetCircuitBreaker(slug: string): void {
    circuitBreaker.delete(slug);
  }

  // ==========================================
  // Auth key dispensing (bootstrap for the same-origin local SPA)
  // ==========================================

  /**
   * GET /api/v1/auth/key - Hand the configured API key to the SAME-ORIGIN local
   * SPA so it can attach X-API-Key to subsequent requests. This is the ONLY route
   * exempt from apiKeyAuth, and it is itself gated to loopback + same-origin +
   * not-proxied; otherwise it returns 403. When no key is configured (dev mode)
   * it returns 204 so the SPA stays open too.
   */
  router.get('/auth/key', (req: Request, res: Response) => {
    const key = getCurrentApiKey();
    if (!key) {
      res.status(204).end();
      return;
    }
    if (!isLocalTrustedRequest(req)) {
      res.status(403).json({ error: 'Key dispensing is only available to the local SPA.' });
      return;
    }
    res.json({ apiKey: key });
  });

  // ==========================================
  // Dashboard
  // ==========================================

  /** GET /api/v1/dashboard - Per-novel lead and sequence overview */
  router.get('/dashboard', (_req: Request, res: Response) => {
    try {
      const novels = loadNovelsRegistry();
      const stats = novels.map((n) => {
        const config = loadNovelConfig(n.slug);
        const tracker = loadTracker(n.slug);
        const lead = computeLeadDays(tracker, config);
        const inkstoneAudit = tracker.inkstone_scheduled?.length
          ? auditSequence('inkstone', tracker.inkstone_scheduled, undefined, undefined, config.timezone)
          : null;
        const patreonAudit = tracker.patreon_scheduled?.length
          ? auditSequence('patreon', tracker.patreon_scheduled, undefined, undefined, config.timezone)
          : null;
        const next_inkstone_schedule = computeNextSchedule(
          (tracker.inkstone_scheduled ?? []).map(s => inkstoneDateToIso(s.date)).filter((d): d is string => !!d),
          config.chapters_per_day,
          config.base_publish_time,
          config.timezone
        );
        const next_patreon_schedule = computeNextSchedule(
          (tracker.patreon_scheduled ?? []).map(s => s.date).filter((d): d is string => !!d),
          config.chapters_per_day,
          config.base_publish_time,
          config.timezone
        );
        const kofiAudit = tracker.kofi_scheduled?.length
          ? auditSequence('kofi', tracker.kofi_scheduled, undefined, undefined, config.timezone)
          : null;
        const next_kofi_schedule = computeNextSchedule(
          (tracker.kofi_scheduled ?? []).map(s => inkstoneDateToIso(s.date)).filter((d): d is string => !!d),
          config.chapters_per_day,
          config.base_publish_time,
          config.timezone
        );
        return {
          slug: n.slug,
          name: n.name,
          lead,
          target_lead: config.target_lead,
          patreon_last: tracker.patreon_last,
          kofi_last: tracker.kofi_last,
          webnovel_last: tracker.webnovel_last,
          execution_status: tracker.execution_status,
          inkstone_audit: inkstoneAudit,
          patreon_audit: patreonAudit,
          kofi_audit: kofiAudit,
          local_sequence: tracker.local_sequence,
          next_inkstone_schedule,
          next_patreon_schedule,
          next_kofi_schedule,
        };
      });
      res.json(stats);
    } catch {
      res.status(500).json({ error: 'Failed to compute dashboard stats.' });
    }
  });

  // ==========================================
  // Novels CRUD
  // ==========================================

  /** GET /api/v1/novels - List all novels */
  router.get('/novels', (_req: Request, res: Response) => {
    try {
      const novels = loadNovelsRegistry();
      const detailed = novels.map((n) => ({
        ...n,
        config: loadNovelConfig(n.slug),
        tracker: loadTracker(n.slug),
      }));
      res.json(detailed);
    } catch {
      res.status(500).json({ error: 'Failed to load novels registry.' });
    }
  });

  /** POST /api/v1/novels - Create a new novel */
  router.post('/novels', mutationLimiter, (req: Request, res: Response) => {
    try {
      const { slug, name, patreon_tier_id, patreon_tier_names, patreon_tag, patreon_creator, kofi_url, kofi_tier_id, kofi_tag } = req.body;
      if (!slug || !name) {
        res.status(400).json({ error: 'slug and name are required.' });
        return;
      }
      if (!patreon_tier_id && !kofi_url) {
        res.status(400).json({ error: 'At least one of patreon_tier_id or kofi_url is required.' });
        return;
      }
      const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (!validateSlug(cleanSlug)) {
        res.status(400).json({ error: 'Invalid slug. Only lowercase alphanumeric and hyphens are allowed.' });
        return;
      }
      const novels = loadNovelsRegistry();
      if (novels.some((n) => n.slug === cleanSlug)) {
        res.status(409).json({ error: `Novel "${cleanSlug}" already exists.` });
        return;
      }
      novels.push({ slug: cleanSlug, name });
      saveNovelsRegistry(novels);
      ensureWorkspaceDirectories(cleanSlug);
        const defaultConfig = {
          slug: cleanSlug, name, target_lead: 20, chapters_per_day: 1,
          batch_limit: 5, inkstone_enabled: true, patreon_enabled: true,
          patreon_tier_id: patreon_tier_id || 'tier-early-access',
          patreon_tier_names: Array.isArray(patreon_tier_names) ? patreon_tier_names : [],
          patreon_tag: patreon_tag || '',
          patreon_creator: patreon_creator || '',
          kofi_url: kofi_url || '',
          kofi_tier_id: kofi_tier_id || '',
          kofi_tag: kofi_tag || '',
          base_publish_time: '12:00',
          auto_fill_gaps: true,
          author_note: '', author_note_position: 'bottom', author_note_inkstone: true, author_note_patreon: true,
        };
       saveNovelConfig(cleanSlug, defaultConfig);
       logEventBus.emitLog(cleanSlug, `[AUDIT] Novel created: ${name}`);
      res.status(201).json({ slug: cleanSlug, name, config: defaultConfig, tracker: loadTracker(cleanSlug) });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** POST /api/v1/novels/import-url - Import novel from Inkstone URL */
  router.post('/novels/import-url', async (req: Request, res: Response) => {
    try {
      const { url, patreon_tier_id, patreon_tag, patreon_creator, kofi_url, kofi_tier_id, kofi_tag } = req.body;
      if (!url || typeof url !== 'string') {
        res.status(400).json({ error: 'url is required.' });
        return;
      }
      if (!req.body.preview && !patreon_tier_id && !kofi_url) {
        res.status(400).json({ error: 'At least one of patreon_tier_id or kofi_url is required.' });
        return;
      }
      // Validate the URL is a real http(s) URL on an allowed Webnovel/Inkstone host
      // before we trust any part of it.
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url.trim());
      } catch {
        res.status(400).json({ error: 'Invalid URL.' });
        return;
      }
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        res.status(400).json({ error: 'URL must use http or https.' });
        return;
      }
      const host = parsedUrl.hostname.toLowerCase();
      const ALLOWED_IMPORT_HOSTS = ['inkstone.webnovel.com', 'www.webnovel.com', 'webnovel.com'];
      if (!ALLOWED_IMPORT_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
        res.status(400).json({ error: 'URL host not allowed. Use an inkstone.webnovel.com or webnovel.com link.' });
        return;
      }
      // Extract slug from Inkstone (/novels/SLUG) or public Webnovel (/book/SLUG_ID) URLs
      const pathAfterNovels = parsedUrl.pathname.split(/\/(?:book|novels?)\//)[1]?.split(/[?#]/)[0];
      if (!pathAfterNovels) {
        res.status(400).json({ error: 'Could not read the novel from that URL. Use an inkstone.webnovel.com/novels/... or webnovel.com/book/... link.' });
        return;
      }
      const pathParts = pathAfterNovels.split('/');
      const rawSlug = pathParts[pathParts.length - 1];
      if (!rawSlug) {
        res.status(400).json({ error: 'Could not read the novel from that URL.' });
        return;
      }
      // Registry slug must be filesystem-safe; the raw slug (with any _ID) is kept for scraping.
      const cleanSlug = rawSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!validateSlug(cleanSlug)) {
        res.status(400).json({ error: 'Could not read the novel from that URL.' });
        return;
      }
      const novels = loadNovelsRegistry();
      if (novels.some((n) => n.slug === cleanSlug)) {
        if (req.body.preview) {
          const existing = novels.find((n) => n.slug === cleanSlug);
          res.json({ slug: cleanSlug, name: existing?.name || cleanSlug, exists: true });
          return;
        }
        res.status(409).json({ error: `Novel "${cleanSlug}" already exists.` });
        return;
      }
      const novelName = await scrapePublicNovelName(rawSlug);
      if (!novelName) {
        res.status(400).json({ error: `Could not find a novel at that URL. Check the link and try again.` });
        return;
      }
      if (req.body.preview) {
        res.json({ slug: cleanSlug, name: novelName });
        return;
      }
      novels.push({ slug: cleanSlug, name: novelName });
      saveNovelsRegistry(novels);
      ensureWorkspaceDirectories(cleanSlug);
        const defaultConfig = {
          slug: cleanSlug, name: novelName, target_lead: 20, chapters_per_day: 1,
          batch_limit: 5, inkstone_enabled: true, patreon_enabled: true,
          patreon_tier_id: req.body.patreon_tier_id || 'tier-early-access',
          patreon_tier_names: Array.isArray(req.body.patreon_tier_names) ? req.body.patreon_tier_names : [],
          patreon_tag: req.body.patreon_tag || '',
           patreon_creator: req.body.patreon_creator || '',
          kofi_url: req.body.kofi_url || '',
          kofi_tier_id: req.body.kofi_tier_id || '',
          kofi_tag: req.body.kofi_tag || '',
          base_publish_time: '12:00',
          auto_fill_gaps: true,
          author_note: '', author_note_position: 'bottom', author_note_inkstone: true, author_note_patreon: true,
        };
       saveNovelConfig(cleanSlug, defaultConfig);
       logEventBus.emitLog(cleanSlug, `[AUDIT] Novel created via import: ${novelName}`);
      res.status(201).json({ slug: cleanSlug, name: novelName, config: defaultConfig, tracker: loadTracker(cleanSlug) });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** DELETE /api/v1/novels/:slug - Remove a novel */
  router.delete('/novels/:slug', mutationLimiter, (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) {
        res.status(400).json({ error: 'Invalid slug.' });
        return;
      }
      if (runningSlugs.has(slug)) {
        res.status(409).json({ error: 'Cannot delete novel while an automation is running.' });
        return;
      }
      const tracker = loadTracker(slug);
      if (tracker.execution_status === 'running') {
        res.status(409).json({ error: 'Cannot delete novel while an automation is running.' });
        return;
      }
      const novels = loadNovelsRegistry();
      const updated = novels.filter((n) => n.slug !== slug);
      if (updated.length === novels.length) {
        res.status(404).json({ error: `Novel "${slug}" not found.` });
        return;
      }
      logEventBus.emitLog(slug, `[AUDIT] Novel deleted`);
      saveNovelsRegistry(updated);
      const novelDir = path.join(WORKSPACE_ROOT, slug);
      if (fs.existsSync(novelDir)) fs.rmSync(novelDir, { recursive: true, force: true });
      res.json({ success: true, message: `Novel "${slug}" removed.` });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** GET /api/v1/novels/:slug - Get novel details */
  router.get('/novels/:slug', (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const config = loadNovelConfig(slug);
      const tracker = loadTracker(slug);
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const chapters = scanChaptersDirectory(chaptersDir, slug);
      const enhanceStatus = (platform: 'inkstone' | 'patreon') => BrowserManager.getStatus(platform, slug);
      const next_inkstone_schedule = computeNextSchedule(
        (tracker.inkstone_scheduled ?? []).map(s => inkstoneDateToIso(s.date)).filter((d): d is string => !!d),
        config.chapters_per_day,
        config.base_publish_time,
        config.timezone
      );
      const next_patreon_schedule = computeNextSchedule(
        (tracker.patreon_scheduled ?? []).map(s => s.date).filter((d): d is string => !!d),
        config.chapters_per_day,
        config.base_publish_time,
        config.timezone
      );
      const next_kofi_schedule = computeNextSchedule(
        (tracker.kofi_scheduled ?? []).map(s => s.date).filter((d): d is string => !!d),
        config.chapters_per_day,
        config.base_publish_time,
        config.timezone
      );
      res.json({
        config, tracker, chapters,
        next_inkstone_schedule,
        next_patreon_schedule,
        next_kofi_schedule,
        browser: {
          inkstone: enhanceStatus('inkstone'),
          patreon: enhanceStatus('patreon'),
          kofi: BrowserManager.getStatus('kofi', slug),
        },
      });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** PUT /api/v1/novels/:slug/config - Update novel configuration */
  router.put('/novels/:slug/config', mutationLimiter, (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const currentConfig = loadNovelConfig(slug);
       const allowedFields = ['name', 'target_lead', 'chapters_per_day', 'batch_limit', 'inkstone_enabled', 'patreon_enabled', 'kofi_enabled', 'patreon_tier_id', 'patreon_tier_names', 'patreon_tag', 'patreon_creator', 'kofi_url', 'kofi_tier_id', 'kofi_tag', 'base_publish_time', 'auto_fill_gaps', 'author_note', 'author_note_position', 'author_note_inkstone', 'author_note_patreon'];
      const sanitized: Record<string, any> = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) sanitized[field] = req.body[field];
      }
      const updated = { ...currentConfig, ...sanitized, slug };
      saveNovelConfig(slug, updated);
      logEventBus.emitLog(slug, `[AUDIT] Config updated: ${Object.keys(sanitized).join(', ')}`);
      res.json(updated);
    } catch {
      res.status(500).json({ error: 'Failed to update configuration.' });
    }
  });

  // ==========================================
  // Chapters
  // ==========================================

  /** POST /api/v1/novels/:slug/chapters - Create a new chapter */
  router.post('/novels/:slug/chapters', mutationLimiter, (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const { chapter_number, title, body } = req.body;
      if (!chapter_number || !title || !body) {
        res.status(400).json({ error: 'chapter_number, title, and body are required.' });
        return;
      }
      if (typeof body !== 'string' || body.length > 500_000) {
        res.status(400).json({ error: 'body must be a string under 500,000 characters.' });
        return;
      }
      const chapNum = parseInt(String(chapter_number), 10);
      if (isNaN(chapNum) || chapNum < 1 || chapNum > MAX_CHAPTER_NUMBER) {
        res.status(400).json({ error: `chapter_number must be between 1 and ${MAX_CHAPTER_NUMBER}.` });
        return;
      }
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const filePath = path.join(chaptersDir, `chapter_${chapNum}.md`);
      const safeTitle = String(title).replace(/[^\w\s.-]/g, '').replace(/[\r\n\t\f\v]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      const fileContent = `---\ntitle: ${safeTitle}\nchapter_number: ${chapNum}\n---\n# ${safeTitle}\n\n${body}\n`;
      fs.writeFileSync(filePath, fileContent, 'utf8');
      invalidateChapterCache(slug);
      const parsed = parseChapterFile(filePath);
      res.status(201).json(parsed);
    } catch {
      res.status(500).json({ error: 'Failed to create chapter.' });
    }
  });

  const SUPPORTED_EXTENSIONS = ['.md', '.txt', '.docx', '.doc', '.rtf', '.csv'];
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  const upload = multer({
    storage: multer.diskStorage({
      destination: os.tmpdir(),
      filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}-${file.originalname}`),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_CHAPTER_NUMBER },
  });

  // Wrap multer so its errors (e.g. file too large) return JSON 400 instead of an HTML 500.
  function uploadFiles(req: Request, res: Response, next: () => void): void {
    upload.array('files')(req, res, (err: any) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? 'File too large (max 10MB per file).'
          : err.code === 'LIMIT_FILE_COUNT'
            ? `Too many files (max ${MAX_CHAPTER_NUMBER}).`
            : (err.message || 'Upload failed.');
        res.status(400).json({ error: msg });
        return;
      }
      next();
    });
  }

  /** POST /api/v1/novels/:slug/chapters/upload - Upload one or more chapter files */
  router.post('/novels/:slug/chapters/upload', mutationLimiter, uploadFiles, async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }

      const files = (req.files as Express.Multer.File[]) || [];
      if (files.length === 0) {
        res.status(400).json({ error: 'No files uploaded. Send files as multipart/form-data with field name "files".' });
        return;
      }

      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const results: { file_name: string; chapter_number: number; title: string }[] = [];
      const errors: { file_name: string; error: string }[] = [];

      for (const file of files) {
        const ext = path.extname(file.originalname).toLowerCase();
        try {
          if (!SUPPORTED_EXTENSIONS.includes(ext)) {
            errors.push({ file_name: file.originalname, error: `Unsupported format "${ext}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}` });
            continue;
          }

          let content: string;
          let outName: string;

          if (ext === '.docx') {
            const result = await mammoth.extractRawText({ path: file.path });
            content = result.value;
            outName = path.basename(file.originalname, '.docx') + '.md';
          } else {
            content = fs.readFileSync(file.path, 'utf8');
            outName = path.basename(file.originalname);
          }

          // ponytail: strip to basename, force alphanumerics/dots/dashes only, reject any '..' segments
          const base = path.basename(outName);
          const safeName = base.replace(/[^a-zA-Z0-9_.-]/g, '_');
          if (safeName === '..' || safeName.startsWith('..') || safeName.includes('/') || safeName.includes('\\')) {
            errors.push({ file_name: file.originalname, error: 'Invalid filename after sanitization.' });
            continue;
          }
          const outPath = path.join(chaptersDir, safeName);
          fs.writeFileSync(outPath, content, 'utf8');
          const parsed = parseChapterFile(outPath);
          if (parsed.chapter_number < 1 || parsed.chapter_number > MAX_CHAPTER_NUMBER) {
            try { fs.unlinkSync(outPath); } catch {}
            errors.push({ file_name: file.originalname, error: `Chapter number must be between 1 and ${MAX_CHAPTER_NUMBER}. Found: ${parsed.chapter_number}` });
            continue;
          }
          results.push({ file_name: file.originalname, chapter_number: parsed.chapter_number, title: parsed.title });
        } catch (e: any) {
          errors.push({ file_name: file.originalname, error: e.message || 'Parse failed' });
        } finally {
          try { fs.unlinkSync(file.path); } catch {}
        }
      }

      invalidateChapterCache(slug);
      res.status(201).json({ success: true, processed: results.length, results, errors });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  function findChapterFile(chaptersDir: string, chapNum: number): string | null {
  if (!fs.existsSync(chaptersDir)) return null;
  const files = fs.readdirSync(chaptersDir);
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ext !== '.md' && ext !== '.txt') continue;
    const m = f.match(/(?:chapter|ch|chap)?\s*(\d+)/i);
    if (m && parseInt(m[1], 10) === chapNum) return path.join(chaptersDir, f);
  }
  return null;
}

/** POST /api/v1/novels/:slug/chapters/:num/lock - Lock chapter file */
  router.post('/novels/:slug/chapters/:num/lock', (req: Request, res: Response) => {
    try {
      const { slug, num } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const filePath = findChapterFile(chaptersDir, parseInt(num, 10));
      if (!filePath) { res.status(404).json({ error: `Chapter ${num} file not found.` }); return; }
      lockFile(filePath);
      invalidateChapterCache(slug);
      res.json({ success: true, is_locked: true });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** GET /api/v1/novels/:slug/chapters/:num - Get single chapter with body */
  router.get('/novels/:slug/chapters/:num', (req: Request, res: Response) => {
    try {
      const { slug, num } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const chapNum = parseInt(num, 10);
      if (isNaN(chapNum)) { res.status(400).json({ error: 'Invalid chapter number.' }); return; }
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const filePath = findChapterFile(chaptersDir, chapNum);
      if (!filePath) { res.status(404).json({ error: `Chapter ${chapNum} not found.` }); return; }
      const parsed = parseChapterFile(filePath);
      res.json(parsed);
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** PUT /api/v1/novels/:slug/chapters/:num - Update chapter body and title */
  router.put('/novels/:slug/chapters/:num', (req: Request, res: Response) => {
    try {
      const { slug, num } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const chapNum = parseInt(num, 10);
      if (isNaN(chapNum)) { res.status(400).json({ error: 'Invalid chapter number.' }); return; }
      const { title, body, frontmatter } = req.body;
      if (title === undefined && body === undefined && frontmatter === undefined) {
        res.status(400).json({ error: 'Provide title, body, and/or frontmatter to update.' });
        return;
      }
      if (body !== undefined && (typeof body !== 'string' || body.length > 500_000)) {
        res.status(400).json({ error: 'body must be a string under 500,000 characters.' });
        return;
      }
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const filePath = findChapterFile(chaptersDir, chapNum);
      if (!filePath) { res.status(404).json({ error: `Chapter ${chapNum} not found.` }); return; }
      const existing = parseChapterFile(filePath);
      const safeTitle = title !== undefined ? String(title).replace(/[^\w\s.-]/g, '').replace(/[\r\n\t\f\v]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : existing.title;
      const newBody = body !== undefined ? String(body) : existing.body;
      const mergedFrontmatter = { ...existing.frontmatter, ...(frontmatter || {}) };
      const fmLines = Object.entries(mergedFrontmatter)
        .filter(([k]) => k !== 'title' && k !== 'chapter_number')
        .map(([k, v]) => `${k}: ${typeof v === 'string' && v.includes(' ') ? `"${v}"` : v}`)
        .join('\n');
      const fileContent = `---\ntitle: ${safeTitle}\nchapter_number: ${chapNum}${fmLines ? '\n' + fmLines : ''}\n---\n# ${safeTitle}\n\n${newBody}\n`;
      fs.writeFileSync(filePath, fileContent, 'utf8');
      invalidateChapterCache(slug);
      const updated = parseChapterFile(filePath);
      res.json(updated);
    } catch {
      res.status(500).json({ error: 'Failed to update chapter.' });
    }
  });

  /** POST /api/v1/novels/:slug/chapters/:num/unlock - Unlock chapter file */
  router.post('/novels/:slug/chapters/:num/unlock', (req: Request, res: Response) => {
    try {
      const { slug, num } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const filePath = findChapterFile(chaptersDir, parseInt(num, 10));
      if (!filePath) { res.status(404).json({ error: `Chapter ${num} file not found.` }); return; }
      unlockFile(filePath);
      invalidateChapterCache(slug);
      res.json({ success: true, is_locked: false });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** POST /api/v1/novels/:slug/chapters/:num/update-platform - Push local content update to platform */
  router.post('/novels/:slug/chapters/:num/update-platform', async (req: Request, res: Response) => {
    try {
      const { slug, num } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const chapNum = parseInt(num, 10);
      if (isNaN(chapNum)) { res.status(400).json({ error: 'Invalid chapter number.' }); return; }

      const tracker = loadTracker(slug);
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const filePath = findChapterFile(chaptersDir, chapNum);
      if (!filePath) { res.status(404).json({ error: `Chapter ${chapNum} not found.` }); return; }
      const parsed = parseChapterFile(filePath);

      const results: { platform: string; success: boolean; error?: string }[] = [];

      // Check Inkstone
      const inkstoneCh = (tracker.inkstone_scheduled || []).find(c => c.chapter_number === chapNum);
      if (inkstoneCh?.edit_url) {
        const scraper = new (await import('../adapters/inkstone_scraper')).InkstoneScraper();
        const r = await scraper.updateChapter(slug, { chapter_number: chapNum, title: parsed.title, body: parsed.body }, inkstoneCh.edit_url);
        results.push({ platform: 'inkstone', success: r.success, error: r.error });
      }

      // Check Patreon
      const patreonCh = (tracker.patreon_scheduled || []).find(c => c.chapter_number === chapNum);
      if (patreonCh?.edit_url) {
        const sync = new (await import('../adapters/patreon_sync')).PatreonSync();
        const r = await sync.updateChapter(slug, { chapter_number: chapNum, title: parsed.title, body: parsed.body }, patreonCh.edit_url);
        results.push({ platform: 'patreon', success: r.success, error: r.error });
      }

      if (results.length === 0) {
        res.status(400).json({ error: `Chapter ${chapNum} is not published or scheduled on any platform with an edit URL.` });
        return;
      }

      const allOk = results.every(r => r.success);
      res.json({ success: allOk, results });
    } catch (err: any) {
      logger.error(`Update platform chapter failed: ${err.message}`);
      res.status(500).json({ error: err.message || 'Failed to update chapter on platform.' });
    }
  });

  /** POST /api/v1/novels/:slug/queue/:platform/:num/reschedule - Reschedule a pending chapter */
  router.post('/novels/:slug/queue/:platform/:num/reschedule', async (req: Request, res: Response) => {
    try {
      const { slug, platform, num } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      if (platform !== 'inkstone' && platform !== 'patreon' && platform !== 'kofi') { res.status(400).json({ error: 'Platform must be inkstone or patreon.' }); return; }
      const chapNum = parseInt(num, 10);
      if (isNaN(chapNum)) { res.status(400).json({ error: 'Invalid chapter number.' }); return; }
      let { date } = req.body;
      if (!date) { res.status(400).json({ error: 'New date is required.' }); return; }

      // ponytail: dashboard sends date-only ("2026-08-15") from <input type="date">.
      // Adapters expect a full ISO datetime so timezone math + base_publish_time are correct.
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const cfg = loadNovelConfig(slug);
        const [ph, pm] = (cfg.base_publish_time || '12:00').split(':').map(Number);
        const tz = parseFloat(cfg.timezone || '5.75');
        const [y, mo, d] = date.split('-').map(Number);
        // Express the publish time in the novel's timezone as UTC
        const utcMs = Date.UTC(y, mo - 1, d, ph, pm, 0) - tz * 3600000;
        date = new Date(utcMs).toISOString();
      }

      const tracker = loadTracker(slug);
      const scheduled = (platform === 'inkstone' ? tracker.inkstone_scheduled : platform === 'kofi' ? tracker.kofi_scheduled : tracker.patreon_scheduled) ?? [];
      const ch = scheduled.find(c => c.chapter_number === chapNum);
      if (!ch) { res.status(404).json({ error: `Chapter ${chapNum} not found in ${platform} queue.` }); return; }
      if (!ch.edit_url) { res.status(400).json({ error: `Chapter ${chapNum} has no edit URL — cannot reschedule.` }); return; }

      const Adapter = platform === 'inkstone'
        ? (await import('../adapters/inkstone_scraper')).InkstoneScraper
        : platform === 'kofi'
          ? (await import('../adapters/kofi_sync')).KofiSync
          : (await import('../adapters/patreon_sync')).PatreonSync;
      const adapter = new Adapter();
      const ok = await adapter.rescheduleChapter(chapNum, ch.edit_url, date, slug);
      if (!ok) { res.status(500).json({ error: `Failed to reschedule chapter ${chapNum} on ${platform}.` }); return; }

      // Update tracker date
      ch.date = date;
      if (platform === 'inkstone') {
        tracker.inkstone_scheduled = [...scheduled];
      } else if (platform === 'kofi') {
        tracker.kofi_scheduled = [...scheduled];
      } else {
        tracker.patreon_scheduled = [...scheduled];
      }
      saveTrackerAtomic(slug, tracker);
      res.json({ success: true });
    } catch (err: any) {
      logger.error(`Reschedule failed: ${err.message}`);
      res.status(500).json({ error: err.message || 'Reschedule failed.' });
    }
  });

  /** POST /api/v1/novels/:slug/queue/:platform/:num/cancel - Cancel a scheduled chapter */
  router.post('/novels/:slug/queue/:platform/:num/cancel', async (req: Request, res: Response) => {
    try {
      const { slug, platform, num } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      if (platform !== 'inkstone' && platform !== 'patreon' && platform !== 'kofi') { res.status(400).json({ error: 'Platform must be inkstone or patreon.' }); return; }
      const chapNum = parseInt(num, 10);
      if (isNaN(chapNum)) { res.status(400).json({ error: 'Invalid chapter number.' }); return; }

      const tracker = loadTracker(slug);
      const scheduled = (platform === 'inkstone' ? tracker.inkstone_scheduled : platform === 'kofi' ? tracker.kofi_scheduled : tracker.patreon_scheduled) ?? [];
      const ch = scheduled.find(c => c.chapter_number === chapNum);
      if (!ch) { res.status(404).json({ error: `Chapter ${chapNum} not found in ${platform} queue.` }); return; }

      // Delete from platform if edit URL exists
      if (ch.edit_url) {
        const Adapter = platform === 'inkstone'
          ? (await import('../adapters/inkstone_scraper')).InkstoneScraper
          : platform === 'kofi'
            ? (await import('../adapters/kofi_sync')).KofiSync
            : (await import('../adapters/patreon_sync')).PatreonSync;
        const adapter = new Adapter();
        await adapter.deleteChapter(chapNum, ch.edit_url, slug).catch(() => {});
      }

      // Remove from tracker
      const updated = scheduled.filter(c => c.chapter_number !== chapNum);
      if (platform === 'inkstone') {
        tracker.inkstone_scheduled = updated;
      } else if (platform === 'kofi') {
        tracker.kofi_scheduled = updated;
      } else {
        tracker.patreon_scheduled = updated;
      }
      saveTrackerAtomic(slug, tracker);
      res.json({ success: true });
    } catch (err: any) {
      logger.error(`Cancel failed: ${err.message}`);
      res.status(500).json({ error: err.message || 'Cancel failed.' });
    }
  });

  /** POST /api/v1/novels/:slug/rollback-last-batch - Rollback chapters published in the last failed batch */
  router.post('/novels/:slug/rollback-last-batch', async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const tracker = loadTracker(slug);
      const batch = tracker.last_batch_published;
      if (!batch || batch.length === 0) {
        res.status(400).json({ error: 'No published batch to rollback.' });
        return;
      }

      const results: { chapter_number: number; platform: string; ok: boolean; error?: string }[] = [];
      for (const item of batch) {
        try {
          const Adapter = item.platform === 'inkstone'
            ? (await import('../adapters/inkstone_scraper')).InkstoneScraper
            : item.platform === 'kofi'
              ? (await import('../adapters/kofi_sync')).KofiSync
              : (await import('../adapters/patreon_sync')).PatreonSync;
          const adapter = new Adapter();
          if (item.edit_url) {
            const ok = await adapter.deleteChapter(item.chapter_number, item.edit_url, slug);
            results.push({ chapter_number: item.chapter_number, platform: item.platform, ok });
          } else {
            results.push({ chapter_number: item.chapter_number, platform: item.platform, ok: false, error: 'No edit URL' });
          }
        } catch (err: any) {
          results.push({ chapter_number: item.chapter_number, platform: item.platform, ok: false, error: err.message });
        }
      }

      // Clear the batch after rollback attempt
      tracker.last_batch_published = [];
      saveTrackerAtomic(slug, tracker);
      res.json({ results });
    } catch (err: any) {
      logger.error(`Rollback failed: ${err.message}`);
      res.status(500).json({ error: err.message || 'Rollback failed.' });
    }
  });

  /** DELETE /api/v1/novels/:slug/chapters/:num - Delete a chapter file */
  router.delete('/novels/:slug/chapters/:num', (req: Request, res: Response) => {
    try {
      const { slug, num } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const chapNum = parseInt(num, 10);
      if (isNaN(chapNum)) { res.status(400).json({ error: 'Invalid chapter number.' }); return; }
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const filePath = findChapterFile(chaptersDir, chapNum);
      if (!filePath) { res.status(404).json({ error: `Chapter ${chapNum} not found.` }); return; }
      fs.unlinkSync(filePath);
      invalidateChapterCache(slug);
      res.json({ success: true, chapter_number: chapNum });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  // ==========================================
  // Tracker
  // ==========================================

  /** GET /api/v1/novels/:slug/tracker/backups - List tracker backups */
  router.get('/novels/:slug/tracker/backups', (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const logDir = path.dirname(getTrackerPath(slug));
      if (!fs.existsSync(logDir)) { res.json({ backups: [] }); return; }
      const backups = fs.readdirSync(logDir)
        .filter(f => f.startsWith('publish_tracker_') && f.endsWith('.bak'))
        .sort()
        .reverse()
        .map(f => ({ file: f, timestamp: parseInt(f.replace('publish_tracker_', '').replace('.bak', ''), 10) }));
      res.json({ backups });
    } catch { res.status(500).json({ error: 'An internal error occurred.' }); }
  });

  /** POST /api/v1/novels/:slug/tracker/rollback/:file - Restore tracker from backup */
  router.post('/novels/:slug/tracker/rollback/:file', (req: Request, res: Response) => {
    try {
      const { slug, file } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      if (!/^publish_tracker_\d+\.bak$/.test(file)) { res.status(400).json({ error: 'Invalid backup filename.' }); return; }
      const logDir = path.dirname(getTrackerPath(slug));
      const bakPath = path.join(logDir, file);
      if (!fs.existsSync(bakPath)) { res.status(404).json({ error: 'Backup file not found.' }); return; }
      const trackerPath = getTrackerPath(slug);
      fs.copyFileSync(bakPath, trackerPath);
      res.json({ success: true, message: `Restored tracker from ${file}.` });
    } catch { res.status(500).json({ error: 'An internal error occurred.' }); }
  });

  /** PUT /api/v1/novels/:slug/tracker - Update publish tracker */
  router.put('/novels/:slug/tracker', (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const tracker = loadTracker(slug);
      const { webnovel_last, patreon_last, kofi_last, inkstone_scheduled_count, patreon_scheduled_count, next_schedule_date } = req.body;
      const toCount = (v: unknown, field: string): number => {
        const n = Number(v);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 1_000_000) {
          throw new Error(`${field} must be an integer between 0 and 1000000.`);
        }
        return n;
      };
      try {
        if (webnovel_last !== undefined) tracker.webnovel_last = toCount(webnovel_last, 'webnovel_last');
        if (patreon_last !== undefined) tracker.patreon_last = toCount(patreon_last, 'patreon_last');
        if (kofi_last !== undefined) tracker.kofi_last = toCount(kofi_last, 'kofi_last');
        if (inkstone_scheduled_count !== undefined) tracker.inkstone_scheduled_count = toCount(inkstone_scheduled_count, 'inkstone_scheduled_count');
        if (patreon_scheduled_count !== undefined) tracker.patreon_scheduled_count = toCount(patreon_scheduled_count, 'patreon_scheduled_count');
        if (next_schedule_date !== undefined) {
          if (next_schedule_date === null || next_schedule_date === '') {
            tracker.next_schedule_date = null;
          } else if (typeof next_schedule_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(next_schedule_date)) {
            tracker.next_schedule_date = next_schedule_date;
          } else {
            throw new Error('next_schedule_date must be in YYYY-MM-DD format.');
          }
        }
      } catch (validationErr: any) {
        res.status(400).json({ error: validationErr.message || 'Invalid tracker values.' });
        return;
      }
      saveTrackerAtomic(slug, tracker);
      logEventBus.emitLog(slug, `[AUDIT] Tracker updated: webnovel_last=${tracker.webnovel_last}, patreon_last=${tracker.patreon_last}, kofi_last=${tracker.kofi_last ?? 0}`);
      res.json({ success: true, tracker });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  // ==========================================
  // Automation
  // ==========================================

  /** POST /api/v1/novels/:slug/cleanup - Remove duplicates, empty trash, delete out-of-order and unscheduled items
   *  Query params:
   *    platform=inkstone|patreon|kofi (default: inkstone)
   *    dryRun=true - preview what would be deleted without executing
   *  Body (JSON):
   *    { exclude?: number[] } - chapter numbers to skip during deletion
   */
  router.post('/novels/:slug/cleanup', async (req: Request, res: Response) => {
    const { slug } = req.params;
    const platform = (req.query.platform as string) || 'inkstone';
    const dryRun = req.query.dryRun === 'true';
    const exclude: number[] = req.body?.exclude || [];
    if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
    try {
      if (runningSlugs.has(slug)) { res.status(409).json({ error: 'An automation is already running.' }); return; }
      const tracker = loadTracker(slug);
      if (tracker.execution_status === 'running') {
        res.status(409).json({ error: 'An automation is already running.' }); return;
      }
      runningSlugs.add(slug);
      tracker.execution_status = 'running';
      tracker.last_run_logs = [
        `[${new Date().toISOString()}] Cleanup started (${platform}${dryRun ? ', dry-run' : ''}). This scans the dashboard and can take a couple of minutes.`,
        ...(tracker.last_run_logs || []),
      ].slice(0, 50);
      saveTrackerAtomic(slug, tracker);
      logEventBus.emitLog(slug, `Cleanup started (${platform}${dryRun ? ', dry-run' : ''}). This scans the dashboard and can take a couple of minutes.`);
      let result: any;
      const opts = { dryRun, exclude: exclude.length ? exclude : undefined };
      try {
        switch (platform) {
          case 'patreon': {
            const { cleanupPatreon } = await import('../adapters/patreon_cleanup');
            result = await cleanupPatreon(slug, opts);
            break;
          }
          case 'kofi': {
            const { cleanupKofi } = await import('../adapters/kofi_cleanup');
            result = await cleanupKofi(slug, opts);
            break;
          }
          default: {
            const { cleanupInkstone } = await import('../adapters/inkstone_cleanup');
            result = await cleanupInkstone(slug, opts);
          }
        }
      } finally {
        runningSlugs.delete(slug);
        const t = loadTracker(slug); t.execution_status = 'idle'; saveTrackerAtomic(slug, t);
      }
      res.json(result);
    } catch (err: any) {
      runningSlugs.delete(slug);
      logger.error(`Cleanup failed for ${slug} (${platform}): ${err?.message || 'unknown'}`);
      try { const t = loadTracker(slug); t.execution_status = 'failed'; saveTrackerAtomic(slug, t); } catch {}
      res.status(500).json({ error: err?.message || 'Cleanup failed.' });
    }
  });

  /** POST /api/v1/novels/:slug/scrape - Start scraping automation */
  router.post('/novels/:slug/scrape', automationLimiter, async (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
    try {
      if (runningSlugs.has(slug)) { res.status(409).json({ error: 'An automation is already running.' }); return; }
      const tracker = loadTracker(slug);
      if (tracker.execution_status === 'running') {
        res.status(409).json({ error: 'An automation is already running.' });
        return;
      }
      const cbCheck = checkCircuitBreaker(slug);
      if (cbCheck) { res.status(429).json({ error: cbCheck }); return; }
      runningSlugs.add(slug);
      tracker.execution_status = 'running';
      saveTrackerAtomic(slug, tracker);
      AutomationRunner.executeScrape(slug).then(() => { runningSlugs.delete(slug); resetCircuitBreaker(slug); invalidateChapterCache(slug); }).catch((err) => {
        runningSlugs.delete(slug); recordCircuitFailure(slug);
        logger.error(`Scrape failed for ${slug}:`, err);
        try { const t = loadTracker(slug); t.execution_status = 'failed'; saveTrackerAtomic(slug, t); } catch {}
      });
      logEventBus.emitLog(slug, 'Scraping automation dispatched.');
      res.json({ status: 'running' });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** POST /api/v1/novels/:slug/publish-preview - Preview publish plan (no execution) */
  router.post('/novels/:slug/publish-preview', (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
    try {
      const chapterNumber = req.body?.chapter_number ? Number(req.body.chapter_number) : undefined;
      const plan = AutomationRunner.computePublishPlan(slug, chapterNumber);
      res.json(plan);
    } catch (err: any) {
      logger.error(`Publish preview failed for ${slug}: ${err?.message || 'unknown'}`);
      res.status(500).json({ error: err?.message || 'Failed to compute publish plan.' });
    }
  });

  /** POST /api/v1/novels/:slug/publish - Start publishing automation */
  router.post('/novels/:slug/publish', automationLimiter, async (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
    try {
      if (runningSlugs.has(slug)) { res.status(409).json({ error: 'An automation is already running.' }); return; }
      const tracker = loadTracker(slug);
      if (tracker.execution_status === 'running') {
        res.status(409).json({ error: 'An automation is already running.' });
        return;
      }
      const cbCheck = checkCircuitBreaker(slug);
      if (cbCheck) { res.status(429).json({ error: cbCheck }); return; }

      const { mode, dry_run, previous_plan, chapter_number } = req.body;
      const chNum = chapter_number ? Number(chapter_number) : undefined;
      if (previous_plan) {
        const freshPlan = AutomationRunner.computePublishPlan(slug, chNum);
        const changed = JSON.stringify(freshPlan.plan) !== JSON.stringify(previous_plan.plan)
          || JSON.stringify(freshPlan.conflicts) !== JSON.stringify(previous_plan.conflicts)
          || JSON.stringify(freshPlan.gaps) !== JSON.stringify(previous_plan.gaps)
          || JSON.stringify(freshPlan.warnings) !== JSON.stringify(previous_plan.warnings);
        if (changed) {
          res.json({ stale: true, plan: freshPlan });
          return;
        }
      }

      runningSlugs.add(slug);
      tracker.execution_status = 'running';
      saveTrackerAtomic(slug, tracker);
      const isDryRun = !!dry_run;
      const pubMode = mode === 'single' ? 'single' : 'all';
      AutomationRunner.executePublish(slug, pubMode, isDryRun, chNum).then(() => { runningSlugs.delete(slug); resetCircuitBreaker(slug); }).then(() => invalidateChapterCache(slug)).catch((err) => {
        runningSlugs.delete(slug); recordCircuitFailure(slug);
        logger.error(`Publish failed for ${slug}:`, err);
        try { const t = loadTracker(slug); t.execution_status = 'failed'; saveTrackerAtomic(slug, t); } catch {}
      });
      logEventBus.emitLog(slug, `Publish automation dispatched (${isDryRun ? 'dry-run' : 'live'}).`);
      res.json({ status: 'running', mode: pubMode, dry_run: isDryRun });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** POST /api/v1/novels/:slug/abort - Abort running automation */
  router.post('/novels/:slug/abort', automationLimiter, (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
    try {
      const wasRunning = AutomationRunner.abort(slug);
      logEventBus.emitLog(slug, wasRunning ? 'Automation aborted.' : 'No active automation to abort.');
      res.json({ success: true, was_running: wasRunning });
    } catch (err: any) {
      logEventBus.emitLog(slug, `Abort error: ${err?.message || 'unknown'}`);
      logger.error(`Abort failed for ${slug}: ${err?.message || 'unknown'}`);
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** POST /api/v1/novels/:slug/decision - Resolve a pending mid-run decision */
  router.post('/novels/:slug/decision', automationLimiter, (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
    try {
      const choice = (req.body?.choice || '').toString().trim();
      if (!['bulk', 'limit'].includes(choice)) { res.status(400).json({ error: 'Invalid choice. Must be "bulk" or "limit".' }); return; }
      const resolved = AutomationRunner.resolveDecision(slug, choice);
      res.json({ success: resolved });
    } catch (err: any) {
      logger.error(`Decision resolve failed for ${slug}: ${err?.message || 'unknown'}`);
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** GET /api/v1/novels/:slug/logs - Get current logs */
  router.get('/novels/:slug/logs', (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
    try {
      const activeLogs = AutomationRunner.getLogs(slug);
      const tracker = loadTracker(slug);
      const progress = AutomationRunner.getProgress(slug);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ execution_status: tracker.execution_status, logs: activeLogs.length > 0 ? activeLogs : tracker.last_run_logs, progress, pending_decision: AutomationRunner.getPendingDecision(slug), auth_error: tracker.auth_error || null });
    } catch (err: any) {
      logger.error(`Failed to fetch logs: ${err?.message || 'unknown'}`);
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** POST /api/v1/novels/:slug/webnovel-sync - Run Webnovel sync */
  router.post('/novels/:slug/webnovel-sync', automationLimiter, async (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
    try {
      if (runningSlugs.has(slug)) { res.status(409).json({ error: 'An automation is already running.' }); return; }
      const tracker = loadTracker(slug);
      if (tracker.execution_status === 'running') {
        res.status(409).json({ error: 'An automation is already running.' });
        return;
      }
      runningSlugs.add(slug);
      tracker.execution_status = 'running';
      saveTrackerAtomic(slug, tracker);
      const { WebnovelSync } = await import('../core/webnovel_sync');
      const sync = new WebnovelSync();
      sync.syncWebnovel(slug).then((result) => {
        runningSlugs.delete(slug);
        const t = loadTracker(slug); t.execution_status = 'idle'; saveTrackerAtomic(slug, t);
        AutomationRunner.clearProgress(slug);
        logger.info(`[WebnovelSync] Completed for ${slug}:`, result);
        logEventBus.emitLog(slug, `Webnovel sync completed: ${result.deletedPublished} dup pub, ${result.deletedDrafts} dup drafts, ${result.trashed} trashed`);
      }).catch((err) => {
        runningSlugs.delete(slug);
        AutomationRunner.clearProgress(slug);
        try { const t = loadTracker(slug); t.execution_status = 'failed'; saveTrackerAtomic(slug, t); } catch {}
        logger.error(`Webnovel sync failed for ${slug}:`, err);
        logEventBus.emitLog(slug, `Webnovel sync failed: ${err.message}`);
      });
      logEventBus.emitLog(slug, 'Webnovel sync dispatched.');
      res.json({ status: 'running' });
    } catch {
      res.status(500).json({ error: 'Failed to dispatch Webnovel sync.' });
    }
  });

  // ==========================================
  // Sequence Audit & Resequence
  // ==========================================

  /** GET /api/v1/novels/:slug/sequence - Audit scheduled chapter sequence */
  router.get('/novels/:slug/sequence', async (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
    try {
      const config = loadNovelConfig(slug);
      const tracker = loadTracker(slug);
      const inkAudit = tracker.inkstone_scheduled?.length
        ? auditSequence('inkstone', tracker.inkstone_scheduled, config.chapters_per_day, config.base_publish_time, config.timezone)
        : null;
      const patreonAudit = tracker.patreon_scheduled?.length
        ? auditSequence('patreon', tracker.patreon_scheduled, config.chapters_per_day, config.base_publish_time, config.timezone)
        : null;
      const kofiAudit = tracker.kofi_scheduled?.length
        ? auditSequence('kofi', tracker.kofi_scheduled, config.chapters_per_day, config.base_publish_time, config.timezone)
        : null;
      res.json({ inkstone: inkAudit, patreon: patreonAudit, kofi: kofiAudit });
    } catch (err: any) {
      logger.error(`Audit failed: ${err?.message || 'unknown'}`);
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** POST /api/v1/novels/:slug/resequence - Auto-fix chapter sequencing */
  router.post('/novels/:slug/resequence', automationLimiter, async (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
    try {
      if (runningSlugs.has(slug)) { res.status(409).json({ error: 'An automation is already running.' }); return; }
      const tracker = loadTracker(slug);
      if (tracker.execution_status === 'running') {
        res.status(409).json({ error: 'An automation is already running.' }); return;
      }
      runningSlugs.add(slug);
      tracker.execution_status = 'running';
      saveTrackerAtomic(slug, tracker);
      const config = loadNovelConfig(slug);
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const localChapters = scanChaptersDirectory(chaptersDir, slug);
      AutomationRunner.executeResequence(slug, (m: string) => {
        logEventBus.emitLog(slug, m);
        // ponytail: also write to debug file so we can see logs without WebSocket
        try {
          const fpath = path.join(SHARED_DIR, 'debug', 'reseq.log');
          fs.appendFileSync(fpath, `[${new Date().toISOString()}] ${m}\n`, 'utf8');
        } catch (logErr: any) { logger.error(`[reseq.log] Write failed: ${logErr.message}`); }
      }, config, localChapters).then(() => {
        runningSlugs.delete(slug);
        try { const t = loadTracker(slug); t.execution_status = 'idle'; saveTrackerAtomic(slug, t); } catch {}
      }).catch((err) => {
        runningSlugs.delete(slug);
        logger.error(`Resequence failed for ${slug}:`, err);
        try {
          const t = loadTracker(slug); t.execution_status = 'failed'; saveTrackerAtomic(slug, t);
          const fpath = path.join(SHARED_DIR, 'debug', 'reseq.log');
          fs.appendFileSync(fpath, `[${new Date().toISOString()}] FATAL: ${err.message}\n${err.stack}\n`, 'utf8');
        } catch (logErr: any) { logger.error(`[reseq.log] FATAL write failed: ${logErr.message}`); }
      });
      logEventBus.emitLog(slug, 'Resequence automation dispatched.');
      res.json({ status: 'running' });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** GET /api/v1/novels/:slug/sequence-check — consolidated sequence health (local + all platforms) */
  router.get('/novels/:slug/sequence-check', async (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
    try {
      const config = loadNovelConfig(slug);
      const tracker = loadTracker(slug);
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const localChapters = scanChaptersDirectory(chaptersDir, slug);
      const nums = localChapters.map(c => c.chapter_number).sort((a, b) => a - b);

      // Local sequence
      const localSeq = computeSequence(nums);

      // Per-platform date audits
      const inkstoneAudit = tracker.inkstone_scheduled?.length
        ? auditSequence('inkstone', tracker.inkstone_scheduled, config.chapters_per_day, config.base_publish_time, config.timezone)
        : null;
      const patreonAudit = tracker.patreon_scheduled?.length
        ? auditSequence('patreon', tracker.patreon_scheduled, config.chapters_per_day, config.base_publish_time, config.timezone)
        : null;
      const kofiAudit = tracker.kofi_scheduled?.length
        ? auditSequence('kofi', tracker.kofi_scheduled, config.chapters_per_day, config.base_publish_time, config.timezone)
        : null;

      const allOk = localSeq.ok
        && (!inkstoneAudit || inkstoneAudit.ok)
        && (!patreonAudit || patreonAudit.ok)
        && (!kofiAudit || kofiAudit.ok);

      res.json({
        ok: allOk,
        local: { ok: localSeq.ok, missing: localSeq.missing, from: localSeq.from, to: localSeq.to, count: nums.length },
        inkstone: inkstoneAudit,
        patreon: patreonAudit,
        kofi: kofiAudit,
      });
    } catch (err: any) {
      logger.error(`Cross-platform audit failed: ${err?.message || 'unknown'}`);
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  // ==========================================
  // License
  // ==========================================

  /** POST /api/v1/license/verify - Verify a license token server-side */
  router.post('/license/verify', (req: Request, res: Response) => {
    try {
      const { token } = req.body;
      if (!token || typeof token !== 'string') {
        res.status(400).json({ ok: false, reason: 'Token is required.' });
        return;
      }
      const payload = verifyLicenseToken(token);
      if (!payload) {
        res.json({ ok: false, reason: 'Invalid or expired license.' });
        return;
      }
      res.json({ ok: true, plan: payload.plan });
    } catch {
      res.status(500).json({ ok: false, reason: 'Internal error.' });
    }
  });

  // ==========================================
  // Browser / CDP
  // ==========================================

  /** POST /api/v1/browser/login - Login session */
  router.post('/browser/login', mutationLimiter, (req: Request, res: Response) => {
    try {
      const { platform, email, cookies, slug } = req.body;
      if (!platform || !email) { res.status(400).json({ error: 'platform and email are required.' }); return; }
      if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ error: 'A valid email is required.' }); return;
      }
      if (platform !== 'inkstone' && platform !== 'patreon' && platform !== 'kofi') {
        res.status(400).json({ error: 'platform must be inkstone or patreon.' }); return;
      }
      const status = BrowserManager.connectProfile(platform, email, cookies, slug);
      res.json({ success: true, status });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** POST /api/v1/browser/logout - Disconnect profile */
  router.post('/browser/logout', (req: Request, res: Response) => {
    try {
      const { platform, slug } = req.body;
      if (platform !== 'inkstone' && platform !== 'patreon' && platform !== 'kofi') {
        res.status(400).json({ error: 'platform must be inkstone or patreon.' }); return;
      }
      const status = BrowserManager.disconnectProfile(platform, slug);
      platformConnector.disconnect(platform, slug);
      res.json({ success: true, status: { ...status, authenticated: false } });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** GET /api/v1/browser/status - Browser status with cookie age */
  router.get('/browser/status', (req: Request, res: Response) => {
    try {
      const slug = typeof req.query.slug === 'string' ? req.query.slug : undefined;
      res.json({
        inkstone: BrowserManager.getStatus('inkstone', slug),
        patreon: BrowserManager.getStatus('patreon', slug),
        kofi: BrowserManager.getStatus('kofi', slug),
      });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** POST /api/v1/connect/:platform - Launch real browser for login */
  router.post('/connect/:platform', (req: Request, res: Response) => {
    try {
      const { platform } = req.params;
      const slug = typeof req.body?.slug === 'string' ? req.body.slug : undefined;
      if (platform !== 'inkstone' && platform !== 'patreon' && platform !== 'kofi') {
        logger.warn(`[connect] Invalid platform from req.params: ${JSON.stringify(platform)}`);
        res.status(400).json({ error: 'platform must be inkstone or patreon.' }); return;
      }
      res.json(platformConnector.startConnect(platform, slug));
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** GET /api/v1/connect/:platform/status - Poll browser connection status */
  router.get('/connect/:platform/status', (req: Request, res: Response) => {
    try {
      const { platform } = req.params;
      const slug = typeof req.query.slug === 'string' ? req.query.slug : undefined;
      if (platform !== 'inkstone' && platform !== 'patreon' && platform !== 'kofi') {
        res.status(400).json({ error: 'platform must be inkstone or patreon.' }); return;
      }
      res.json(platformConnector.getStatus(platform, slug));
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** POST /api/v1/cdp/connect - Connect to Chrome via CDP */
  router.post('/cdp/connect', async (req: Request, res: Response) => {
    try {
      const { port } = req.body || {};
      if (port !== undefined) {
        const portNum = parseInt(String(port), 10);
        if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
          res.status(400).json({ success: false, error: 'Port must be between 1 and 65535.' });
          return;
        }
      }
      const { cdpManager } = await import('../core/cdp_manager');
      const result = port ? await cdpManager.connect(parseInt(String(port), 10)) : await cdpManager.autoConnect();
      if (result.success) {
        platformConnector.connectCDP(port || cdpManager.getStatus().port);
      }
      res.json(result);
    } catch {
      res.status(500).json({ success: false, error: 'Failed to connect via CDP.' });
    }
  });

  /** POST /api/v1/cdp/disconnect - Disconnect from Chrome */
  router.post('/cdp/disconnect', async (_req: Request, res: Response) => {
    try {
      const { cdpManager } = await import('../core/cdp_manager');
      await cdpManager.disconnect();
      platformConnector.disconnectCDP();
      res.json({ success: true, message: 'Disconnected from Chrome.' });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** GET /api/v1/cdp/status - CDP connection status */
  router.get('/cdp/status', async (_req: Request, res: Response) => {
    try {
      const { cdpManager } = await import('../core/cdp_manager');
      res.json(cdpManager.getStatus());
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** POST /api/v1/cdp/save-cookies - Save CDP cookies to disk */
  router.post('/cdp/save-cookies', async (_req: Request, res: Response) => {
    try {
      const { cdpManager } = await import('../core/cdp_manager');
      await cdpManager.saveCookies();
      res.json({ success: true, message: 'Cookies saved.' });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  // ==========================================
  // Validation & Analysis
  // ==========================================

  /** POST /api/v1/novels/:slug/validate - Validate chapter integrity */
  router.post('/novels/:slug/validate', (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const chapters = scanChaptersDirectory(chaptersDir, slug);
      const issues: string[] = [];
      const chapterNums = chapters.map(c => c.chapter_number);
      const seen = new Set<number>();
      for (const num of chapterNums) {
        if (seen.has(num)) issues.push(`Duplicate chapter: ${num}`);
        seen.add(num);
      }
      if (chapterNums.length > 0) {
        // ponytail: cap loop bound to avoid pathological iteration on huge/garbage chapter numbers
        const max = Math.min(Math.max(...chapterNums), 100000);
        for (let i = 1; i <= max; i++) {
          if (!seen.has(i)) issues.push(`Missing chapter: ${i}`);
        }
      }
      for (const ch of chapters) {
        if (!ch.title || ch.title.trim() === '') issues.push(`Chapter ${ch.chapter_number} has no title`);
      }
      res.json({ success: issues.length === 0, issues, chapter_count: chapters.length });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** POST /api/v1/novels/:slug/protected/clear - Clear protected chapter lists (manual reset after renumbering) */
  router.post('/novels/:slug/protected/clear', (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const tracker = loadTracker(slug);
      const prev = tracker.protected || [];
      tracker.protected = [];
      saveTrackerAtomic(slug, tracker);
      res.json({ success: true, cleared: prev.length });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** POST /api/v1/novels/:slug/lock - Lock all published and scheduled chapters */
  router.post('/novels/:slug/lock', (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const tracker = loadTracker(slug);
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const chapters = scanChaptersDirectory(chaptersDir, slug);
      const inkstoneUpTo = tracker.webnovel_last + (tracker.inkstone_scheduled_count || 0);
      const patreonUpTo = tracker.patreon_last + (tracker.patreon_scheduled_count || 0);
      let lockedCount = 0;
      for (const ch of chapters) {
        if (ch.chapter_number <= inkstoneUpTo || ch.chapter_number <= patreonUpTo) {
          lockFile(ch.file_path);
          lockedCount++;
        }
      }
      res.json({ success: true, locked: lockedCount });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** GET /api/v1/novels/:slug/analyze - Analyze chapter state */
  router.get('/novels/:slug/analyze', (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const tracker = loadTracker(slug);
      const config = loadNovelConfig(slug);
      const chapters = scanChaptersDirectory(chaptersDir, slug);
      const diskChapters = chapters.map(c => c.chapter_number).sort((a, b) => a - b);
      res.json({
        success: true,
        analysis: {
          disk: { count: diskChapters.length, max: diskChapters.length > 0 ? Math.max(...diskChapters) : 0, chapters: diskChapters },
          inkstone: { published_count: tracker.webnovel_last, scheduled_count: tracker.inkstone_scheduled_count },
          patreon: { published_count: tracker.patreon_last, scheduled_count: tracker.patreon_scheduled_count },
          lead_buffer: computeLeadDays(tracker, config),
          lead_days: computeLeadDays(tracker, config),
        },
      });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  // ==========================================
  // Session Logs (JSONL)
  // ==========================================

  /** GET /api/v1/logs - List available log dates */
  router.get('/logs', (_req: Request, res: Response) => {
    try {
      const logDir = path.join(WORKSPACE_ROOT, '_logs');
      if (!fs.existsSync(logDir)) {
        res.json({ files: [] });
        return;
      }
      const files = fs.readdirSync(logDir)
        .filter(f => f.endsWith('_session.jsonl'))
        .sort()
        .reverse();
      res.json({ files });
    } catch {
      res.status(500).json({ error: 'Failed to list log files.' });
    }
  });

  /** GET /api/v1/logs/:filename - Read a specific log file */
  router.get('/logs/:filename', (req: Request, res: Response) => {
    try {
      const { filename } = req.params;
      if (!/^\d{4}-\d{2}-\d{2}_session\.jsonl$/.test(filename)) {
        res.status(400).json({ error: 'Invalid log filename format.' });
        return;
      }
      const logDir = path.join(WORKSPACE_ROOT, '_logs');
      const filePath = path.join(logDir, filename);
      if (!fs.existsSync(filePath)) {
        res.json({ entries: [] });
        return;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      const entries = content.split('\n')
        .filter(line => line.trim())
        .map(line => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
      res.json({ entries });
    } catch {
      res.status(500).json({ error: 'Failed to read log file.' });
    }
  });

  // ==========================================
  // Inkstone Scraper
  // ==========================================

  /** GET /api/v1/scrape/inkstone-novels - Scrape novels list from Inkstone */
  router.get('/scrape/inkstone-novels', async (_req: Request, res: Response) => {
    try {
      const scraper = await import('../adapters/inkstone_scraper');
      const InkstoneScraper = scraper.InkstoneScraper;
      const instance = new InkstoneScraper();
      const novels = await instance.listNovels();
      res.json({ success: true, novels });
    } catch (err: any) {
      logger.error(`Failed to scrape Inkstone novels: ${err?.message || 'unknown'}`);
      res.status(500).json({ success: false, error: 'An internal error occurred.' });
    }
  });

  /** GET /api/v1/platforms/status - All platform statuses */
  router.get('/platforms/status', (req: Request, res: Response) => {
    try {
      const slug = typeof req.query.slug === 'string' ? req.query.slug : undefined;
      res.json({
        inkstone: BrowserManager.getStatus('inkstone', slug),
        patreon: BrowserManager.getStatus('patreon', slug),
        kofi: BrowserManager.getStatus('kofi', slug),
      });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  // ==========================================
  // Draft Preview (P4.2)
  // ==========================================

  /** GET /api/v1/novels/:slug/chapters/:num/preview - Draft preview */
  router.get('/novels/:slug/chapters/:num/preview', (req: Request, res: Response) => {
    try {
      const { slug, num } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const chapNum = parseInt(num, 10);
      if (isNaN(chapNum)) { res.status(400).json({ error: 'Invalid chapter number.' }); return; }
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const filePath = findChapterFile(chaptersDir, chapNum);
      if (!filePath) { res.status(404).json({ error: `Chapter ${chapNum} not found.` }); return; }
      const parsed = parseChapterFile(filePath);
      const word_count = parsed.body ? parsed.body.split(/\s+/).filter(Boolean).length : 0;
      res.json({ chapter_number: parsed.chapter_number, title: parsed.title, body: parsed.body, word_count });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  // ==========================================
  // Data Export (P4.3)
  // ==========================================

  /** GET /api/v1/novels/:slug/export - Export novel data as downloadable JSON */
  router.get('/novels/:slug/export', (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const config = loadNovelConfig(slug);
      const tracker = loadTracker(slug);
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const chapterRefs = scanChaptersDirectory(chaptersDir, slug);
      const chapters = chapterRefs.map(c => {
        try { return parseChapterFile(c.file_path); } catch { return { chapter_number: c.chapter_number, title: c.title, body: '' }; }
      });
      const payload = { config, tracker, chapters };
      res.setHeader('Content-Disposition', `attachment; filename="${slug}-export.json"`);
      res.json(payload);
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  // ==========================================
  // Circuit Breaker (P4.4)
  // ==========================================

  /** GET /api/v1/novels/:slug/circuit-breaker - Check circuit breaker state */
  router.get('/novels/:slug/circuit-breaker', (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
    const entry = circuitBreaker.get(slug);
    if (!entry) { res.json({ tripped: false, failures: 0 }); return; }
    const windowPassed = (Date.now() - entry.lastFailure) >= CB_WINDOW_MS;
    res.json({ tripped: entry.failures >= CB_THRESHOLD && !windowPassed, failures: entry.failures, lastFailure: entry.lastFailure, windowExpired: windowPassed });
  });

  // ==========================================
  // File Conflict Detection (P4.5)
  // ==========================================

  /** POST /api/v1/novels/:slug/check-conflicts - Detect file conflicts */
  router.post('/novels/:slug/check-conflicts', (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const { chaptersDir } = ensureWorkspaceDirectories(slug);
      const refs = scanChaptersDirectory(chaptersDir, slug);
      const conflicts: string[] = [];
      const seenNums = new Map<number, string[]>();
      const seenTitles = new Map<string, string[]>();
      const seenBodies = new Map<string, string[]>();
      for (const ref of refs) {
        let parsed: any;
        try { parsed = parseChapterFile(ref.file_path); } catch { continue; }
        const numKey = parsed.chapter_number;
        if (!seenNums.has(numKey)) seenNums.set(numKey, []);
        seenNums.get(numKey)!.push(ref.file_path);
        const titleKey = parsed.title?.toLowerCase().trim() || '';
        if (titleKey) {
          if (!seenTitles.has(titleKey)) seenTitles.set(titleKey, []);
          seenTitles.get(titleKey)!.push(ref.file_path);
        }
        const bodyKey = parsed.body?.trim() || '';
        if (bodyKey) {
          if (!seenBodies.has(bodyKey)) seenBodies.set(bodyKey, []);
          seenBodies.get(bodyKey)!.push(ref.file_path);
        }
      }
      for (const [num, files] of seenNums) {
        if (files.length > 1) conflicts.push(`Duplicate chapter number ${num}: ${files.join(', ')}`);
      }
      for (const [title, files] of seenTitles) {
        if (files.length > 1) conflicts.push(`Chapters with same title "${title}": ${files.join(', ')}`);
      }
      for (const [, files] of seenBodies) {
        if (files.length > 1) conflicts.push(`Chapters with identical body: ${files.join(', ')}`);
      }
      res.json({ conflicts, conflict_count: conflicts.length });
    } catch {
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  });

  /** GET /api/v1/novels/:slug/patreon-info - Fetch Patreon tiers from public page */
  router.get('/novels/:slug/patreon-info', async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }

      const config = loadNovelConfig(slug);
      const patreonPage = config.patreon_creator || config.patreon_tag || slug;

      const { createStealthContext } = await import('../core/stealth');
      const { getReaderBrowser } = await import('../core/platform_connector');
      const browser = await getReaderBrowser();
      const context = await createStealthContext(browser);
      const page = await context.newPage();
      try {
        await page.goto(`https://www.patreon.com/${patreonPage}/membership`, { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(3000);

        const text = await page.evaluate(() => document.body.innerText);
        const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean);
        const tiers: { name: string; price: string }[] = [];

        for (let i = 0; i < lines.length; i++) {
          const next = lines[i + 1] || '';
          // Match "$6" on current line + "/ month" on next line (Patreon layout)
          if (/\$\d/.test(lines[i]) && (/month/i.test(lines[i]) || /month/i.test(next))) {
            const name = i > 0 && !lines[i - 1].startsWith('$') ? lines[i - 1] : '';
            if (name && !name.includes('$') && !tiers.some(t => t.name === name)) {
              const priceMatch = lines[i].match(/\$(\d+(?:\.\d+)?)/);
              tiers.push({ name, price: priceMatch ? `$${priceMatch[1]}/month` : lines[i] });
            }
          }
        }

        res.json({ tiers, collections: { selected: [], hasSelectButton: false } });
      } finally {
        await context.close().catch(() => {});
      }
    } catch (err: any) {
      logger.error(`Failed to fetch Patreon info: ${err?.message || 'unknown'}`);
      res.status(500).json({ error: 'Failed to fetch Patreon info.' });
    }
  });

  /** GET /api/v1/novels/:slug/kofi-audience - Fetch Ko-fi audience tiers from editor */
  router.get('/novels/:slug/kofi-audience', async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
      const currentConfig = loadNovelConfig(slug);

      const { platformConnector } = await import('../core/platform_connector');
      const result = await platformConnector.getScrapingContext('kofi', slug);
      if (!result) { res.status(400).json({ error: 'Ko-fi profile not authenticated.' }); return; }

      const { context, cleanup } = result;
      const { applyStealthToContext, postNavigationDelay } = await import('../core/stealth');
      await applyStealthToContext(context);
      const page = await context.newPage();
      try {
        await page.goto('https://ko-fi.com/blog/editor?back=true', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await postNavigationDelay();
        if (page.url().includes('/account/login') || page.url().includes('/auth')) {
          res.status(400).json({ error: 'Ko-fi session expired. Reconnect the profile.' });
          return;
        }
        const audiences = await page.evaluate(() => {
          const sel = document.querySelector('select[name="postAudience"]') as HTMLSelectElement;
          if (!sel) return [];
          return Array.from(sel.options).filter(o => o.value).map(o => ({ value: o.value, label: o.text.trim() }));
        });
        res.json({ audiences, selected: currentConfig.kofi_tier_id || '' });
      } finally {
        try { await page.close(); } catch {}
        await cleanup();
      }
    } catch (err: any) {
      logger.error(`Failed to fetch Ko-fi audience: ${err?.message || 'unknown'}`);
      res.status(500).json({ error: 'Failed to fetch Ko-fi audience.' });
    }
  });

  /** POST /api/v1/novels/:slug/reset-status - Force-reset stuck 'running' status to 'idle' */
  router.post('/novels/:slug/reset-status', (req: Request, res: Response) => {
    const { slug } = req.params;
    if (!validateSlug(slug)) { res.status(400).json({ error: 'Invalid slug.' }); return; }
    try {
      runningSlugs.delete(slug);
      const tracker = loadTracker(slug);
      tracker.execution_status = 'idle';
      tracker.last_run_logs = [
        ...(tracker.last_run_logs || []),
        `[${new Date().toISOString()}] Status force-reset to idle by user.`,
      ].slice(0, 50);
      saveTrackerAtomic(slug, tracker);
      AutomationRunner.clearProgress(slug);
      AutomationRunner.abort(slug);
      logger.info(`[ResetStatus] Tracker status reset to idle for ${slug}`);
      res.json({ success: true, execution_status: 'idle' });
    } catch (err: any) {
      logger.error(`[ResetStatus] Failed for ${slug}: ${err?.message || 'unknown'}`);
      res.status(500).json({ error: 'Failed to reset tracker status.' });
    }
  });

  /** POST /api/v1/shutdown - Gracefully stop the server (called when browser tab closes) */
  router.post('/shutdown', automationLimiter, (req: Request, res: Response) => {
    // apiKeyAuth (global) already gates this; additionally require an explicit opt-in
    // so a stolen/leaked key on loopback can't trivially shut down the server.
    if (process.env.ALLOW_SHUTDOWN !== '1') {
      res.status(403).json({ error: 'Shutdown is disabled. Set ALLOW_SHUTDOWN=1 to enable.' });
      return;
    }
    res.json({ success: true });
    if (shutdown) setImmediate(shutdown);
  });

  return router;
}
