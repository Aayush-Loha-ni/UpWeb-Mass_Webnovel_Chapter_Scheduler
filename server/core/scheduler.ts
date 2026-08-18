/**
 * Scheduler Module
 * Ported from Python scheduler.py
 * Timezone-aware schedule computation
 */

export interface ScheduleInfo {
  chapter_number: number;
  title: string;
  publish_date: string;
  timezone: string;
}

const MS_PER_DAY = 86400000;

export function getTZOffset(date: Date, timezone: string): number {
  // Numeric offset like "5.75" (decimal hours, can be negative)
  const numMatch = timezone.match(/^(-?\d+(?:\.\d+)?)$/);
  if (numMatch) {
    return parseFloat(numMatch[1]) * 3600000;
  }
  try {
    const parts = Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
    }).formatToParts(date);
    const vals: Record<string, number> = {};
    for (const p of parts) if (p.type !== 'literal') vals[p.type] = parseInt(p.value, 10);
    const tzTs = Date.UTC(vals.year, vals.month - 1, vals.day, vals.hour, vals.minute, vals.second);
    return tzTs - date.getTime(); // ms, positive when tz is ahead of UTC
  } catch { return 0; }
}

export function addDays(dateStr: string | null, days: number): string | null {
  if (!dateStr) return null;
  return new Date(new Date(dateStr).getTime() + days * MS_PER_DAY).toISOString();
}

/**
 * Validate a date string (ISO 8601)
 */
export function isValidDate(dateStr: string): boolean {
  try {
    const date = new Date(dateStr);
    return !isNaN(date.getTime());
  } catch {
    return false;
  }
}

/**
 * Validate a time string (HH:MM format)
 */
export function isValidTime(timeStr: string): boolean {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return false;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

/**
 * Calculate publish schedules for chapters
 */
export function calculatePublishSchedules(
  chapters: { chapter_number: number; title: string }[],
  baselineDate: string,
  chaptersPerDay: number,
  basePublishTime: string = '12:00',
  timezone: string = 'UTC'
): ScheduleInfo[] {
  if (chapters.length === 0) return [];

  const schedules: ScheduleInfo[] = [];
  let currentDate = new Date(baselineDate);

  const now = new Date();
  if (currentDate <= now) {
    currentDate = new Date(now);
  }

  const [hours, minutes] = basePublishTime.split(':').map(Number);
  // Convert basePublishTime from timezone to UTC
  const offsetMs = getTZOffset(currentDate, timezone);
  const localMin = hours * 60 + minutes;
  const utcMin = localMin - offsetMs / 60000;
  const utcH = ((Math.floor(utcMin / 60)) % 24 + 24) % 24;
  const utcM = ((utcMin % 60) + 60) % 60;
  currentDate.setUTCHours(utcH, utcM, 0, 0);
  // ponytail: DST shifts within the schedule window are ignored; acceptable for typical 1-30 day windows

  let chaptersOnCurrentDay = 0;

  for (const chapter of chapters) {
    if (chaptersOnCurrentDay >= chaptersPerDay) {
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
      currentDate.setUTCHours(utcH, utcM, 0, 0);
      chaptersOnCurrentDay = 0;
    }

    schedules.push({
      chapter_number: chapter.chapter_number,
      title: chapter.title,
      publish_date: currentDate.toISOString(),
      timezone,
    });

    chaptersOnCurrentDay++;
  }

  return schedules;
}

/**
 * Compute the date for the next chapter to be scheduled on a platform.
 * Anchors from the latest scheduled date and advances if the latest day
 * already has `chaptersPerDay` chapters.
 */
export function computeNextSchedule(
  scheduledDates: string[],
  chaptersPerDay: number,
  basePublishTime: string = '12:00',
  timezone: string = 'UTC'
): string | null {
  if (!scheduledDates.length || chaptersPerDay < 1) return null;

  const valid = scheduledDates.map(d => new Date(d)).filter(d => !isNaN(d.getTime()));
  if (!valid.length) return null;
  const sorted = valid.sort((a, b) => a.getTime() - b.getTime());
  const latest = sorted[sorted.length - 1];
  const latestStr = latest.toISOString().slice(0, 10);
  const countOnLatestDay = scheduledDates.filter(d => d.slice(0, 10) === latestStr).length;
  const daysToAdd = countOnLatestDay >= chaptersPerDay ? 1 : 0;

  const nextDate = new Date(latest);
  if (daysToAdd) nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const [hours, minutes] = basePublishTime.split(':').map(Number);
  const offsetMs = getTZOffset(nextDate, timezone);
  const localMin = hours * 60 + minutes;
  const utcMin = localMin - offsetMs / 60000;
  const utcH = ((Math.floor(utcMin / 60)) % 24 + 24) % 24;
  const utcM = ((utcMin % 60) + 60) % 60;
  nextDate.setUTCHours(utcH, utcM, 0, 0);

  return nextDate.toISOString();
}

/**
 * Format date for display
 */
export function formatDate(dateStr: string, timezone: string = 'UTC'): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: timezone,
    });
  } catch {
    return dateStr;
  }
}

/**
 * Format time for display
 */
export function formatTime(dateStr: string, timezone: string = 'UTC'): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    });
  } catch {
    return dateStr;
  }
}
