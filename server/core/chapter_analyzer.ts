/**
 * Chapter Analyzer
 * Ported from Python chapter_analyzer.py
 * Analyzes chapters across disk and platforms for consistency
 */

import * as fs from 'fs';
import * as path from 'path';
import { scanChaptersDirectory } from './parser';

export interface PlatformData {
  platform: string;
  published: Record<number, string>;
  scheduled: Record<number, string>;
  duplicates: number[];
  raw_entries: [number, string][];
}

export interface AnalysisResult {
  disk_chapters: number[];
  disk_count: number;
  disk_max: number;

  inkstone: PlatformData;
  patreon: PlatformData;

  missing_disk: number[];
  missing_inkstone: number[];
  missing_patreon: number[];

  duplicates_disk: number[];
  duplicates_inkstone: number[];
  duplicates_patreon: number[];

  out_of_order_disk: [number, number][];
  out_of_order_inkstone: [number, number][];
  out_of_order_patreon: [number, number][];

  date_gaps_inkstone: [string, string, number][];
  date_gaps_patreon: [string, string, number][];

  errors: string[];
}

/**
 * Find missing numbers in a sorted sequence
 */
function findGaps(numbers: number[], start: number = 1): number[] {
  if (numbers.length === 0) return [];
  const max = Math.max(...numbers);
  const expected = new Set<number>();
  for (let i = start; i <= max; i++) {
    expected.add(i);
  }
  const actual = new Set(numbers);
  return Array.from(expected).filter(n => !actual.has(n)).sort((a, b) => a - b);
}

/**
 * Find chapter numbers that appear more than once
 */
function findDuplicates(entries: [number, string][]): number[] {
  const counts = new Map<number, number>();
  for (const [num] of entries) {
    counts.set(num, (counts.get(num) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c > 1)
    .map(([n]) => n)
    .sort((a, b) => a - b);
}

/**
 * Find pairs where a later entry has a smaller number than an earlier one
 */
function findOutOfOrder(entries: [number, string][]): [number, number][] {
  const issues: [number, number][] = [];
  for (let i = 0; i < entries.length - 1; i++) {
    if (entries[i][0] > entries[i + 1][0]) {
      issues.push([entries[i][0], entries[i + 1][0]]);
    }
  }
  return issues;
}

/**
 * Find gaps in dates between sequential entries
 */
function findDateGaps(entries: [number, string][]): [string, string, number][] {
  const dated = entries.filter(([, d]) => d);
  if (dated.length < 2) return [];

  dated.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  const gaps: [string, string, number][] = [];

  for (let i = 0; i < dated.length - 1; i++) {
    const [num1, d1] = dated[i];
    const [num2, d2] = dated[i + 1];
    if (num1 + 1 === num2) {
      try {
        const dt1 = new Date(d1);
        const dt2 = new Date(d2);
        const diff = Math.round((dt2.getTime() - dt1.getTime()) / (1000 * 60 * 60 * 24));
        if (diff > 1) {
          gaps.push([d1, d2, diff]);
        }
      } catch {
        // Invalid date format
      }
    }
  }
  return gaps;
}

/**
 * Get chapter numbers from files on disk
 */
function getDiskChapters(chapterFolder: string): number[] {
  if (!fs.existsSync(chapterFolder)) {
    return [];
  }

  const chapters = scanChaptersDirectory(chapterFolder);
  return chapters.map(c => c.chapter_number).sort((a, b) => a - b);
}

/**
 * Analyze chapter consistency across disk and platforms
 */
export function analyzeChapters(
  chapterFolder: string,
  inkstoneState?: {
    published: [number, string][];
    scheduled: [number, string][];
  },
  patreonEntries?: [number, string][]
): AnalysisResult {
  const result: AnalysisResult = {
    disk_chapters: [],
    disk_count: 0,
    disk_max: 0,
    inkstone: createEmptyPlatformData('inkstone'),
    patreon: createEmptyPlatformData('patreon'),
    missing_disk: [],
    missing_inkstone: [],
    missing_patreon: [],
    duplicates_disk: [],
    duplicates_inkstone: [],
    duplicates_patreon: [],
    out_of_order_disk: [],
    out_of_order_inkstone: [],
    out_of_order_patreon: [],
    date_gaps_inkstone: [],
    date_gaps_patreon: [],
    errors: [],
  };

  // 1. Disk chapters
  result.disk_chapters = getDiskChapters(chapterFolder);
  result.disk_count = result.disk_chapters.length;
  result.disk_max = result.disk_chapters.length > 0 ? Math.max(...result.disk_chapters) : 0;

  if (result.disk_chapters.length > 0) {
    result.missing_disk = findGaps(result.disk_chapters);

    // Check disk duplicates
    const seen = new Map<number, number>();
    for (const num of result.disk_chapters) {
      seen.set(num, (seen.get(num) || 0) + 1);
    }
    result.duplicates_disk = Array.from(seen.entries())
      .filter(([, c]) => c > 1)
      .map(([n]) => n)
      .sort((a, b) => a - b);
  }

  // 2. Inkstone data
  if (inkstoneState) {
    const pub = new Map(inkstoneState.published);
    const sched = new Map(inkstoneState.scheduled);
    const allPub = [...inkstoneState.published];

    result.inkstone = {
      platform: 'inkstone',
      published: Object.fromEntries(pub),
      scheduled: Object.fromEntries(sched),
      raw_entries: allPub,
      duplicates: [],
    };

    result.duplicates_inkstone = findDuplicates(allPub);
    result.inkstone.duplicates = result.duplicates_inkstone;

    // Check Inkstone gaps
    const allNums = Array.from(new Set([...pub.keys(), ...sched.keys()])).sort((a, b) => a - b);
    if (allNums.length > 0) {
      result.missing_inkstone = findGaps(allNums);
    }

    // Check Inkstone order
    const sortedPub = Array.from(pub.entries()).sort((a, b) => a[0] - b[0]);
    result.out_of_order_inkstone = findOutOfOrder(sortedPub);

    // Check Inkstone date gaps
    result.date_gaps_inkstone = findDateGaps(allPub);
  }

  // 3. Patreon data
  if (patreonEntries && patreonEntries.length > 0) {
    const pub = new Map<number, string>();
    for (const [num, title] of patreonEntries) {
      if (!pub.has(num)) {
        pub.set(num, title);
      }
    }

    result.patreon = {
      platform: 'patreon',
      published: Object.fromEntries(pub),
      scheduled: {},
      raw_entries: patreonEntries,
      duplicates: [],
    };

    result.duplicates_patreon = findDuplicates(patreonEntries);
    result.patreon.duplicates = result.duplicates_patreon;

    if (pub.size > 0) {
      result.missing_patreon = findGaps(Array.from(pub.keys()).sort((a, b) => a - b));
    }

    const sortedPubItems = Array.from(pub.entries()).sort((a, b) => a[0] - b[0]);
    result.out_of_order_patreon = findOutOfOrder(sortedPubItems);
  }

  return result;
}

function createEmptyPlatformData(platform: string): PlatformData {
  return {
    platform,
    published: {},
    scheduled: {},
    duplicates: [],
    raw_entries: [],
  };
}
