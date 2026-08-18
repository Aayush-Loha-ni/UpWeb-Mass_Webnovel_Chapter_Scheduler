/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SequenceReport, ScheduledChapter } from '../core/models';

export interface ScrapeResult {
  last_published_chapter: number;
  published_count: number;
  scheduled_count: number;
  latest_scheduled_date: string | null;
  scraped_items: any[];
  sequence?: SequenceReport;
  scheduled_chapters?: ScheduledChapter[];
}

export interface PublishResult {
  success: boolean;
  chapter_number: number;
  published_url?: string;
  edit_url?: string;
  error?: string;
  screenshot_path?: string;
  dom_path?: string;
}

export abstract class PublishingAdapter {
  abstract readonly platformName: 'inkstone' | 'patreon' | 'kofi';

  /**
   * Scrapes live platform states (Published, Scheduled, Draft counts).
   */
  abstract scrapeState(novelSlug: string): Promise<ScrapeResult>;

  /**
   * Automates publishing a chapter file content to the platform.
   */
  abstract publishChapter(
    novelSlug: string,
    chapter: { chapter_number: number; title: string; body: string; frontmatter?: Record<string, any> },
    targetPublishDate: string | null
  ): Promise<PublishResult>;

  /**
   * Reschedules an existing draft/post to a new publish date.
   */
  abstract rescheduleChapter(chapterNumber: number, editUrl: string, newDate: string, novelSlug: string, cvid?: string): Promise<boolean>;

  /**
   * Deletes a chapter/post from the platform. Fallback when reschedule fails.
   */
  abstract deleteChapter(chapterNumber: number, editUrl: string, novelSlug?: string): Promise<boolean>;

  /**
   * Updates the content (title + body) of an already-published or scheduled chapter.
   * The scheduled/published date is NOT changed — only content is updated.
   */
  abstract updateChapter(
    novelSlug: string,
    chapter: { chapter_number: number; title: string; body: string },
    editUrl: string
  ): Promise<PublishResult>;
}
