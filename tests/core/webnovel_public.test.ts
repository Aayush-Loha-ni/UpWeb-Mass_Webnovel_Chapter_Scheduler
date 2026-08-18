import { describe, it, expect } from 'vitest';
import { publishDateFromPage, parseLatestChapter, parseAllChapterNumbers } from '../../server/core/webnovel_public';

describe('publishDateFromPage', () => {
  it('returns the date for a past publishTime (embedded orderIndex form)', () => {
    // 1700000000000 = 2023-11-14T21:33:20Z
    const html = `"orderIndex":12345......"publishTime":1700000000000`;
    expect(publishDateFromPage(html)).toBe('2023-11-14');
  });

  it('returns "" when publishTime is in the future (scheduled draft, not published)', () => {
    const future = String(Date.now() + 30 * 86400000);
    const html = `"orderIndex":999......"publishTime":${future}`;
    expect(publishDateFromPage(html)).toBe('');
  });

  it('returns "" when publishTime is implausibly old', () => {
    const html = `"orderIndex":1......"publishTime":900000000000`;
    expect(publishDateFromPage(html)).toBe('');
  });

  it('returns "" when no publishTime is present', () => {
    expect(publishDateFromPage('<html>no timestamps here</html>')).toBe('');
  });
});

describe('catalog chapter number parsing', () => {
  it('parseLatestChapter floors decimals to integer base', () => {
    const html = 'href=".../chapter-5.1-abc" href=".../chapter-5.2-def" href=".../chapter-4-ghi"';
    expect(parseLatestChapter(html)).toBe(5);
  });

  it('parseAllChapterNumbers dedupes and sorts', () => {
    const html = 'href=".../chapter-5-abc" href=".../chapter-2-def" href=".../chapter-5-ghi"';
    expect(parseAllChapterNumbers(html)).toEqual([2, 5]);
  });
});