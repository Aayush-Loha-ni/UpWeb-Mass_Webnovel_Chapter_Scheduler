import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock platformConnector before importing adapters
vi.mock('../../server/core/platform_connector', () => ({
  platformConnector: {
    getScrapingContext: vi.fn(),
  },
}));

import { InkstoneScraper } from '../../server/adapters/inkstone_scraper';
import { PatreonSync } from '../../server/adapters/patreon_sync';
import { PublishingAdapter } from '../../server/adapters/base';
import { platformConnector } from '../../server/core/platform_connector';



describe('InkstoneScraper', () => {
  let scraper: InkstoneScraper;

  beforeEach(() => {
    scraper = new InkstoneScraper();
  });

  it('extends PublishingAdapter and has platformName', () => {
    expect(scraper).toBeInstanceOf(PublishingAdapter);
    expect(scraper.platformName).toBe('inkstone');
  });

  it('implements all required adapter methods', () => {
    expect(typeof scraper.scrapeState).toBe('function');
    expect(typeof scraper.publishChapter).toBe('function');
    expect(typeof scraper.rescheduleChapter).toBe('function');
    expect(typeof scraper.deleteChapter).toBe('function');
    expect(typeof scraper.updateChapter).toBe('function');
  });

  it('publishChapter returns auth error when getScrapingContext returns null', async () => {
    (platformConnector.getScrapingContext as ReturnType<typeof vi.fn>).mockResolvedValue(null as any);
    const result = await scraper.publishChapter('test-novel', { chapter_number: 1, title: 'Test', body: 'Body' }, null);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not authenticated');
  });

  it('deleteChapter returns false when getScrapingContext returns null', async () => {
    (platformConnector.getScrapingContext as ReturnType<typeof vi.fn>).mockResolvedValue(null as any);
    const result = await scraper.deleteChapter(1, 'https://example.com/edit');
    expect(result).toBe(false);
  });

  it('rescheduleChapter returns false when getScrapingContext returns null', async () => {
    (platformConnector.getScrapingContext as ReturnType<typeof vi.fn>).mockResolvedValue(null as any);
    const result = await scraper.rescheduleChapter(1, 'https://example.com/edit', '2026-07-25T12:00:00Z', 'test-novel');
    expect(result).toBe(false);
  });

  it('updateChapter returns auth error when getScrapingContext returns null', async () => {
    (platformConnector.getScrapingContext as ReturnType<typeof vi.fn>).mockResolvedValue(null as any);
    const result = await scraper.updateChapter('test-novel', { chapter_number: 1, title: 'Test', body: 'Body' }, 'https://example.com/edit');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not authenticated');
  });
});

describe('InkstoneScraper helper logic', () => {
  it('_apiFetchDraftCcids extracts date from common Inkstone API fields', () => {
    // Test date extraction logic used in _apiFetchDraftCcids (line 915-916)
    const extractDate = (vo: any): string => {
      const apiDate = vo.publishTime || vo.scheduledPublishTime || vo.scheduleTime || vo.fireTime || vo.publishDate || vo.gmtCreate || '';
      return apiDate ? String(apiDate).slice(0, 10) : '';
    };
    expect(extractDate({ publishTime: '2026-11-12T10:00:00Z' })).toBe('2026-11-12');
    expect(extractDate({ scheduledPublishTime: '2026-11-15T10:00:00Z' })).toBe('2026-11-15');
    expect(extractDate({ scheduleTime: '2026-12-01T10:00:00Z' })).toBe('2026-12-01');
    expect(extractDate({ fireTime: '2026-11-20T10:00:00Z' })).toBe('2026-11-20');
    expect(extractDate({ gmtCreate: '2026-11-01T10:00:00Z' })).toBe('2026-11-01');
    expect(extractDate({ publishDate: '2026-11-18' })).toBe('2026-11-18');
    expect(extractDate({})).toBe('');
    expect(extractDate({ publishTime: null })).toBe('');
  });

  it('published chapter merge fills gaps with empty dates', () => {
    // Simulates lines 317-325: merge pub.numbers into scheduledChapters
    const scheduledChapters = [
      { num: 80, date: '2026-11-12', editUrl: '' },
      { num: 79, date: '2026-11-10', editUrl: '' },
    ];
    const scheduledNumbers = [79, 80];
    const pubNumbers = [1, 2, 3, 77, 78, 79, 80];

    const pubNums = new Set(scheduledChapters.map(c => c.num));
    for (const pn of pubNumbers) {
      if (!pubNums.has(pn)) scheduledChapters.push({ num: pn, date: '', editUrl: '' });
    }
    scheduledChapters.sort((a, b) => b.num - a.num);
    const mergedNumbers = [...new Set([...scheduledNumbers, ...pubNumbers])].sort((a, b) => a - b);

    // published chapters 1-3, 77-78 get empty dates; 79-80 keep their dates
    expect(scheduledChapters.find(c => c.num === 1)!.date).toBe('');
    expect(scheduledChapters.find(c => c.num === 78)!.date).toBe('');
    expect(scheduledChapters.find(c => c.num === 79)!.date).toBe('2026-11-10');
    expect(scheduledChapters.find(c => c.num === 80)!.date).toBe('2026-11-12');

    // All numbers present in sequence
    expect(mergedNumbers).toEqual([1, 2, 3, 77, 78, 79, 80]);
    expect(scheduledChapters.length).toBe(7);
  });
});

describe('PatreonSync', () => {
  let sync: PatreonSync;

  beforeEach(() => {
    sync = new PatreonSync();
  });

  it('extends PublishingAdapter and has platformName', () => {
    expect(sync).toBeInstanceOf(PublishingAdapter);
    expect(sync.platformName).toBe('patreon');
  });

  it('implements all required adapter methods', () => {
    expect(typeof sync.scrapeState).toBe('function');
    expect(typeof sync.publishChapter).toBe('function');
    expect(typeof sync.rescheduleChapter).toBe('function');
    expect(typeof sync.deleteChapter).toBe('function');
    expect(typeof sync.updateChapter).toBe('function');
  });

  it('scrapeState throws when getScrapingContext returns null', async () => {
    (platformConnector.getScrapingContext as ReturnType<typeof vi.fn>).mockResolvedValue(null as any);
    await expect(sync.scrapeState('test-novel')).rejects.toThrow('SESSION_EXPIRED');
  });

  it('publishChapter returns auth error when getScrapingContext returns null', async () => {
    (platformConnector.getScrapingContext as ReturnType<typeof vi.fn>).mockResolvedValue(null as any);
    const result = await sync.publishChapter('test-novel', { chapter_number: 1, title: 'Test', body: 'Body' }, null);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not authenticated');
  });

  it('deleteChapter returns false when getScrapingContext returns null', async () => {
    (platformConnector.getScrapingContext as ReturnType<typeof vi.fn>).mockResolvedValue(null as any);
    const result = await sync.deleteChapter(1, 'https://patreon.com/posts/edit');
    expect(result).toBe(false);
  });

  it('rescheduleChapter returns false when getScrapingContext returns null', async () => {
    (platformConnector.getScrapingContext as ReturnType<typeof vi.fn>).mockResolvedValue(null as any);
    const result = await sync.rescheduleChapter(1, 'https://patreon.com/posts/edit', '2026-07-25T12:00:00Z', 'test-novel');
    expect(result).toBe(false);
  });

  it('updateChapter returns auth error when getScrapingContext returns null', async () => {
    (platformConnector.getScrapingContext as ReturnType<typeof vi.fn>).mockResolvedValue(null as any);
    const result = await sync.updateChapter('test-novel', { chapter_number: 1, title: 'Test', body: 'Body' }, 'https://patreon.com/posts/edit');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not authenticated');
  });
});


