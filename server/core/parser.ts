/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { isFileReadOnly } from './locking';
import { Chapter } from './models';
import logger from './logger';

const MAX_CHAPTER = 99999;

// ponytail: in-memory cache avoids re-reading all chapter files on every API request
const chapterCache = new Map<string, { chapters: Chapter[]; timestamp: number }>();
const CACHE_TTL_MS = 2000;

export function invalidateChapterCache(slug: string): void {
  chapterCache.delete(slug);
}

function getCachedChapters(slug: string, chaptersDir: string): Chapter[] | null {
  const cached = chapterCache.get(slug);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.chapters;
  return null;
}

function setCachedChapters(slug: string, chapters: Chapter[]): void {
  chapterCache.set(slug, { chapters, timestamp: Date.now() });
}

/**
 * Extracts and parses metadata from a chapter file.
 */
export function parseChapterFile(filePath: string): Chapter {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileName = path.basename(filePath);
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    if ((err as any)?.code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw err;
  }
  
  let frontmatter: Record<string, any> = {};
  let body = rawContent;
  let title = '';

  // 1. Defensively parse YAML Frontmatter
  // Match blocks starting and ending with ---
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
  const match = rawContent.match(frontmatterRegex);

  if (match) {
    const yamlString = match[1];
    try {
      const parsed = yaml.load(yamlString);
      if (parsed && typeof parsed === 'object') {
        frontmatter = parsed as Record<string, any>;
      }
    } catch (e) {
      logger.warn(`Warning: Invalid frontmatter in ${fileName}. Proceeding as raw content.`);
    }
    // Isolate body
    body = rawContent.slice(match[0].length);
  }

  // 2. Extract Title
  // Priority: 1. Frontmatter 'title'. 2. "Chapter N followed by title" from file name or top of body text.
  // Fallback to "Chapter N". Never use the novel/book name as the title.
  if (frontmatter.title && typeof frontmatter.title === 'string') {
    title = frontmatter.title;
  } else {
    // Matches "Chapter 115: The Situation and Naruto", "CHAPTER 1: CHASED FROM THE START", "# Chapter 101 — The Uchiha Clan"
    const chTitleRe = /^(?:#{1,6}\s*)?(?:chapter|ch\.?)\s+\d+(?:\.\d+)?\s*[:：\-—–]\s*\S.*$/i;
    const fileNameBase = path.basename(fileName, path.extname(fileName));
    if (chTitleRe.test(fileNameBase)) {
      title = fileNameBase;
    } else {
      const firstLine = (body.match(/^\s*[^\r\n]*/) || [''])[0].trim();
      if (chTitleRe.test(firstLine)) {
        title = firstLine.replace(/^#{1,6}\s*/, '').trim();
        // Remove the title line from body so it isn't duplicated in content
        body = body.replace(/^[^\r\n]*\r?\n?/, '');
      }
    }
  }

  // 3. Extract chapter counter safely (int or decimal).
  // Uses regex to capture sequences of digits preceded by "chapter" or as standalone integers.
  // ponytail: filenames like "...Chapter_5__Chapter_5.1___" contain both integer and decimal;
  // we take the LAST match which is the specific decimal sub-chapter.
  let chapter_number = 0;
  const fileNumMatches = [...fileName.matchAll(/(?:chapter|ch|chap)?\s*(\d+(?:\.\d+)?)/gi)];
  if (fileNumMatches.length > 0) {
    // Use the last match to prefer decimal sub-chapters (e.g. "Chapter 5.1" over "Chapter 5")
    const lastMatch = fileNumMatches[fileNumMatches.length - 1];
    chapter_number = Math.min(Math.max(0, parseFloat(lastMatch[1])), MAX_CHAPTER);
  } else if (frontmatter.chapter_number && typeof frontmatter.chapter_number === 'number') {
    chapter_number = Math.min(Math.max(0, frontmatter.chapter_number), MAX_CHAPTER);
  } else {
    // Try matching in title - also use last match
    const titleMatches = [...title.matchAll(/(?:chapter|ch|chap)?\s*(\d+(?:\.\d+)?)/gi)];
    if (titleMatches.length > 0) {
      const lastMatch = titleMatches[titleMatches.length - 1];
      chapter_number = Math.min(Math.max(0, parseFloat(lastMatch[1])), MAX_CHAPTER);
    }
  }

  // If no "Chapter N followed by title" was found, fall back to "Chapter N"
  if (chapter_number > 0 && !frontmatter.title && !title.trim()) {
    title = `Chapter ${chapter_number}`;
  }

  // 4. Inspect file physical locking state
  const is_locked = isFileReadOnly(filePath);

  // Strip leading book-name heading (e.g. "# THE NAMELESS COURT") and chapter title
  // heading (e.g. "## Chapter 100") from body start, in any heading level/case.
  // Rule: the body must never contain the book name or the chapter title.
  body = body.replace(/^(?:#{1,6}\s*)?[A-Za-z][A-Za-z0-9' .-]*\n+(?:#{1,6}\s*)?Chapter\s+\d+(?:\.\d+)?(?:\s*[:：\-—–]\s*\S.*)?\r?\n/i, '');
  body = body.replace(/^(?:#{1,6}\s*)?Chapter\s+\d+(?:\.\d+)?(?:\s*[:：\-—–]\s*\S.*)?\r?\n/i, '');

  // Sanitize body and frontmatter elements to prevent injection (simple string replacements or sanitization)
  let sanitizedTitle = title.replace(/[<>"]/g, '').trim() || `Chapter ${chapter_number}`;
  // Ensure chapter number is always present; strip novel name from title
  if (chapter_number > 0) {
    if (/^(?:chapter|ch\.?)\s*\d+/i.test(sanitizedTitle)) {
      // Already has chapter number — keep as-is
    } else if (sanitizedTitle.includes(':')) {
      // Has a subtitle like "The Nameless Court: The Awakening" → "Chapter N: The Awakening"
      const subtitle = sanitizedTitle.split(':').slice(1).join(':').trim();
      sanitizedTitle = subtitle ? `Chapter ${chapter_number}: ${subtitle}` : `Chapter ${chapter_number}`;
    } else {
      // Generic title (novel name) → just "Chapter N"
      sanitizedTitle = `Chapter ${chapter_number}`;
    }
  }
  const sanitizedBody = body.trim();

  return {
    file_name: fileName,
    file_path: filePath,
    chapter_number,
    title: sanitizedTitle,
    body: sanitizedBody,
    frontmatter,
    is_locked,
  };
}

/**
 * Scans a folder for all markdown, txt, or docx files and parses them in sequence.
 */
export function scanChaptersDirectory(dirPath: string, slug?: string): Chapter[] {
  if (slug) {
    const cached = getCachedChapters(slug, dirPath);
    if (cached) return cached;
  }
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  let files: string[];
  try {
    files = fs.readdirSync(dirPath);
  } catch {
    return [];
  }
  const chapters: Chapter[] = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (['.md', '.txt'].includes(ext)) {
      try {
        const parsed = parseChapterFile(path.join(dirPath, file));
        chapters.push(parsed);
      } catch (error) {
        logger.error(`Failed to parse chapter file ${file}:`, error);
      }
    }
  }

  const sorted = chapters.sort((a, b) => a.chapter_number - b.chapter_number);
  if (slug) setCachedChapters(slug, sorted);
  return sorted;
}

export function applyAuthorNote(body: string, authorNote: string | undefined, position: string | undefined): string {
  if (!authorNote) return body;
  const separator = '\n\n---\n\n';
  return position === 'top' ? authorNote + separator + body : body + separator + authorNote;
}

export function mdToHtml(md: string): string {
  let html = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  const parts = html.split(/\n{2,}/);
  return parts.map(p => { p = p.trim(); if (!p) return ''; return '<p>' + p.replace(/\n/g, '<br>\n') + '</p>'; }).filter(Boolean).join('\n');
}
