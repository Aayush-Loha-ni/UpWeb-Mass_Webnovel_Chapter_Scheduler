import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseChapterFile } from '../../server/core/parser';
import { auditSequence, findGapsToFill } from '../../server/core/sequencer';
import { computeSequence, parseAllChapterNumbers, parseLatestChapter, parseCatalogSequentialNumbers } from '../../server/core/webnovel_public';

const TEST_DIR = path.join(process.cwd(), '__test_decimal__');

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmdirSync(TEST_DIR, { recursive: true });
  }
}

function writeChapter(name: string, body: string) {
  fs.writeFileSync(path.join(TEST_DIR, name), body, 'utf8');
}

describe('decimal sub-chapter parsing', () => {
  beforeEach(() => fs.mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => cleanup());

  it('preserves decimal chapter number from filename', () => {
    writeChapter('chapter_25.1.md', 'CHAPTER 25.1: THE PLAN\n\nBody text.');
    const ch = parseChapterFile(path.join(TEST_DIR, 'chapter_25.1.md'));
    expect(ch.chapter_number).toBe(25.1);
  });

  it('keeps two decimal parts distinct instead of collapsing', () => {
    writeChapter('chapter_25.1.md', 'Body 1.');
    writeChapter('chapter_25.2.md', 'Body 2.');
    const a = parseChapterFile(path.join(TEST_DIR, 'chapter_25.1.md')).chapter_number;
    const b = parseChapterFile(path.join(TEST_DIR, 'chapter_25.2.md')).chapter_number;
    expect(a).toBe(25.1);
    expect(b).toBe(25.2);
    expect(a).not.toBe(b);
  });
});

describe('integer base aware sequencing', () => {
  it('does not report chapters that exist only as decimal sub-parts as missing', () => {
    const scheduled = [
      { chapter_number: 25.1, title: '' },
      { chapter_number: 25.2, title: '' },
      { chapter_number: 26.1, title: '' },
      { chapter_number: 27, title: '' },
    ];
    const audit = auditSequence('test', scheduled as any);
    // 25 and 26 are present as decimals; only a jump to 28 would be a base gap.
    expect(audit.missing).toEqual([]);
    expect(audit.duplicates).toEqual([]);
  });

  it('still reports a base that is genuinely absent', () => {
    const scheduled = [
      { chapter_number: 25.1, date: '' },
      { chapter_number: 27, date: '' },
    ];
    const audit = auditSequence('test', scheduled as any);
    expect(audit.missing).toContain(26);
  });

  it('findGapsToFill treats decimal sub-parts as covering their integer base', () => {
    // 25 published as decimal 25.1 means integer base 25 is covered: not a gap.
    const gaps = findGapsToFill([25.1], [25.1, 26], 30);
    expect(gaps).toEqual([26]);
    // A base with no decimal/whole published still shows as a gap.
    const empty = findGapsToFill([], [25.1], 30);
    expect(empty).toEqual([25]);
  });
});

describe('catalog URL parsing with decimal sub-chapters', () => {
  const html = `
    <a href="/book/x/catalog">catalog</a>
    <a href="/book/3057/chapter-4-reunion!!_1000.html">Ch4</a>
    <a href="/book/3057/chapter-5.1-kagetsu-vs-aoshi!!_1001.html">Ch5.1</a>
    <a href="/book/3057/chapter-5.2-flash_1002.html">Ch5.2</a>
    <a href="/book/3057/chapter-6.1-gauntlet_1003.html">Ch6.1</a>
    <a href="/book/3057/chapter-7-the-hunt_1004.html">Ch7</a>
    <a href="/book/3057/chapter-312-reckoning_1005.html">Ch312</a>
    <a href="/book/3057/chapter-313-two-kage_1006.html">Ch313</a>
  `;

  it('parseLatestChapter floors decimal to base and uses max', () => {
    expect(parseLatestChapter(html)).toBe(313);
  });

  it('parseAllChapterNumbers folds sub-chapters into their integer base', () => {
    expect(parseAllChapterNumbers(html)).toEqual([4, 5, 6, 7, 312, 313]);
  });

  it('parseCatalogSequentialNumbers captures all bases, not a truncated prefix', () => {
    // 5 & 6 exist only as decimals; old code (regex without `(?:\.\d+)?` + prefix
    // truncation) would stop at [4].
    expect(parseCatalogSequentialNumbers(html)).toEqual([4, 5, 6, 7, 312, 313]);
  });
});

describe('computeSequence (local chapters panel)', () => {
  it('does not report chapters that exist only as decimal sub-parts as missing', () => {
    const report = computeSequence([1, 2, 25.1, 25.2, 25.3, 26.1, 27]);
    // bases 1,2,25,26,27 all present; 3..24 are a real gap but outside this scenario.
    expect(report.missing.filter(n => n >= 25)).toEqual([]);
  });

  it('still reports a base that is genuinely absent', () => {
    const report = computeSequence([1, 2, 25.1, 27]);
    expect(report.missing).toContain(26);
  });
});