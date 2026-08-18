/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SequenceReport {
  ok: boolean;
  missing: number[];
  from: number;
  to: number;
}

export interface ScheduledChapter {
  chapter_number: number;
  date: string | null;
  edit_url?: string;
  platform_id?: string;
  cvid?: string;
}

export interface SequenceAudit {
  ok: boolean;
  platform: string;
  mismatches: { chapter_number: number; actual_date: string | null; expected_date: string }[];
  missing: number[];
  duplicates: number[];
}

export interface ProgressInfo {
  current: number;
  total: number;
  percent: number;
  label: string;
}

export interface FailedPublish {
  chapter_number: number;
  platform: string;
  error: string;
  timestamp: string;
}

export interface PublishTracker {
  webnovel_last: number;
  patreon_last: number;
  kofi_last?: number;
  patreon_published_count: number;
  inkstone_scheduled_count: number;
  patreon_scheduled_count: number;
  /** @deprecated read-only; use latestDateFromSchedule(scheduled) instead */
  inkstone_latest_scheduled: string | null;
  /** @deprecated read-only; use latestDateFromSchedule(scheduled) instead */
  patreon_latest_scheduled: string | null;
  next_schedule_date: string | null;
  execution_status: 'idle' | 'running' | 'failed';
  last_scraped_at: string | null;
  last_run_logs: string[];
  local_sequence: SequenceReport | null;
  patreon_sequence: SequenceReport | null;
  inkstone_sequence: SequenceReport | null;
  inkstone_scheduled: ScheduledChapter[];
  patreon_scheduled: ScheduledChapter[];
  kofi_scheduled?: ScheduledChapter[];
  progress: ProgressInfo | null;
  failed_publishes: FailedPublish[];
  last_batch_published?: { chapter_number: number; platform: string; edit_url?: string }[];
  auth_error?: { platform: string; code: string; message: string; timestamp: string } | null;
  /** Ascending chapter prefix verified sequential on a platform — NEVER deletable by cleanup/backfill. Grows monotonically. */
  protected: number[];
}

export interface NovelConfig {
  slug: string;
  name: string;
  target_lead: number; // strict Patreon/Ko-fi lead over Inkstone, default 20
  chapters_per_day: number; // target velocity, default 1 or 2
  batch_limit: number; // batch publishing limit, default 5
  inkstone_enabled: boolean;
  patreon_enabled: boolean;
  kofi_enabled?: boolean;
  patreon_tier_id: string; // Target tier for access check
  patreon_tier_names: string[]; // Tier names for publish tier selection
  patreon_tag: string; // Patreon library tag filter
  patreon_creator?: string; // Patreon creator name for membership page URL
  kofi_url?: string;
  kofi_tier_id?: string;
  kofi_tag?: string;
  base_publish_time: string; // e.g., "12:00"
  timezone?: string; // Inkstone timezone offset (e.g. "5.75" for Nepal), defaults to "5.75"
  auto_fill_gaps: boolean; // auto-fill sequence gaps if chapters available locally, default true
  author_note: string;
  author_note_position: string; // 'top' | 'bottom'
  author_note_inkstone: boolean;
  author_note_patreon: boolean;
  author_note_kofi?: boolean;
}

export interface Chapter {
  file_name: string;
  file_path: string;
  chapter_number: number;
  title: string;
  body: string;
  frontmatter: Record<string, any>;
  is_locked: boolean; // physical OS read-only status
}

export interface BrowserProfileStatus {
  platform: 'inkstone' | 'patreon' | 'kofi';
  authenticated: boolean;
  cookie_age_hours: number;
  expires_at: string | null;
  profile_path: string;
  session_expired?: boolean;
  session_max_hours?: number;
}

export interface SequenceCheck {
  ok: boolean;
  local: { ok: boolean; missing: number[]; from: number; to: number; count: number };
  inkstone: SequenceAudit | null;
  patreon: SequenceAudit | null;
  kofi?: SequenceAudit | null;
  failed_publishes?: FailedPublish[];
}

export type { LogEntry } from './session_log';

export interface NovelDetail {
  slug: string;
  name: string;
  config: NovelConfig;
  tracker: PublishTracker;
  chapters?: Chapter[];
  next_inkstone_schedule: string | null;
  next_patreon_schedule: string | null;
  next_kofi_schedule?: string | null;
  browser?: {
    inkstone: BrowserProfileStatus;
    patreon: BrowserProfileStatus;
    kofi?: BrowserProfileStatus;
  };
}
