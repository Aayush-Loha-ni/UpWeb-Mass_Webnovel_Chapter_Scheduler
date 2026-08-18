/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { NovelConfig } from './models';
import logger from './logger';

const TIME_REGEX = /^([01]?\d|2[0-3]):[0-5]\d$/;

// WORKSPACE_ROOT is set by server/env.ts (entry-point) before this module loads.
// Electron overrides it to a per-user dir (app.getPath('userData')).
export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT
  ? path.resolve(process.env.WORKSPACE_ROOT)
  : path.join(process.cwd(), 'data');

export const SHARED_DIR = process.env.SHARED_DIR
  ? path.resolve(process.env.SHARED_DIR)
  : path.join(process.cwd(), 'shared');

export const NOVELS_REGISTRY_FILE = process.env.NOVELS_REGISTRY_FILE
  ? path.resolve(process.env.NOVELS_REGISTRY_FILE)
  : path.join(WORKSPACE_ROOT, 'novels.yaml');

/**
 * Ensures basic workspace directories exist.
 */
export function ensureWorkspaceDirectories(slug: string): {
  novelDir: string;
  chaptersDir: string;
  logsDir: string;
} {
  const novelDir = path.join(WORKSPACE_ROOT, slug);
  const chaptersDir = path.join(novelDir, 'chapters');
  const logsDir = path.join(novelDir, 'logs');

  if (!fs.existsSync(WORKSPACE_ROOT)) {
    fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  }
  if (!fs.existsSync(novelDir)) {
    fs.mkdirSync(novelDir, { recursive: true });
  }
  if (!fs.existsSync(chaptersDir)) {
    fs.mkdirSync(chaptersDir, { recursive: true });
  }
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  return { novelDir, chaptersDir, logsDir };
}

/**
 * Loads the centralized novels registry from novels.yaml.
 */
export function loadNovelsRegistry(): { slug: string; name: string }[] {
  if (!fs.existsSync(NOVELS_REGISTRY_FILE)) {
    // Return empty or create default
    fs.mkdirSync(path.dirname(NOVELS_REGISTRY_FILE), { recursive: true });
    const defaultRegistry = {
      novels: []
    };
    fs.writeFileSync(NOVELS_REGISTRY_FILE, yaml.dump(defaultRegistry), 'utf8');
    return [];
  }

  try {
    const fileContents = fs.readFileSync(NOVELS_REGISTRY_FILE, 'utf8');
    const data = yaml.load(fileContents) as any;
    if (data && Array.isArray(data.novels)) {
      return data.novels;
    }
  } catch (error) {
    logger.error('Failed to load novels registry:', error);
  }
  return [];
}

/**
 * Saves/updates the centralized novels registry.
 */
export function saveNovelsRegistry(novels: { slug: string; name: string }[]): void {
  try {
    fs.mkdirSync(path.dirname(NOVELS_REGISTRY_FILE), { recursive: true });
    const data = { novels };
    fs.writeFileSync(NOVELS_REGISTRY_FILE, yaml.dump(data), 'utf8');
  } catch (error) {
    logger.error('Failed to save novels registry:', error);
  }
}

/**
 * Loads configuration for a specific novel.
 */
export function loadNovelConfig(slug: string): NovelConfig {
  const { novelDir } = ensureWorkspaceDirectories(slug);
  const configPath = path.join(novelDir, 'config.yaml');

   const defaultValues: NovelConfig = {
     slug,
     name: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
     target_lead: 20,
     chapters_per_day: 1,
      batch_limit: 5,
     inkstone_enabled: true,
     patreon_enabled: true,
     kofi_enabled: false,
     patreon_tier_id: 'tier-early-access',
     patreon_tier_names: [],
      patreon_tag: '',
      patreon_creator: '',
      kofi_url: '',
     kofi_tier_id: '',
     kofi_tag: '',
      base_publish_time: '12:00',
      timezone: '5.75',
      auto_fill_gaps: true,
      author_note: '',
      author_note_position: 'bottom',
      author_note_inkstone: true,
      author_note_patreon: true,
      author_note_kofi: true
    };

  if (!fs.existsSync(configPath)) {
    saveNovelConfig(slug, defaultValues);
    return defaultValues;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) as any;
     const merged = {
       ...defaultValues,
       ...parsed,
       slug // enforce slug
     };
     merged.chapters_per_day = Math.max(1, Math.min(10, Number(merged.chapters_per_day))) || 1;
     merged.target_lead = Math.max(0, Math.min(1000, Number(merged.target_lead))) || 20;
     merged.batch_limit = Math.max(1, Math.min(100, Number(merged.batch_limit))) || 5;
     merged.auto_fill_gaps = merged.auto_fill_gaps ?? true; // default true
     if (typeof merged.base_publish_time !== 'string' || !TIME_REGEX.test(merged.base_publish_time)) {
       merged.base_publish_time = '12:00';
     }
     return merged;
  } catch (error) {
    logger.error(`Failed to load config for ${slug}:`, error);
    return defaultValues;
  }
}

/**
 * Saves the configuration for a specific novel.
 */
export function saveNovelConfig(slug: string, config: NovelConfig): void {
  const { novelDir } = ensureWorkspaceDirectories(slug);
  const configPath = path.join(novelDir, 'config.yaml');

  try {
    // Delete any circular reference if present, just write pure config values
    const clampedTargetLead = Math.max(0, Math.min(1000, Number(config.target_lead))) || 20;
    const clampedChaptersPerDay = Math.max(1, Math.min(10, Number(config.chapters_per_day))) || 1;
    const clampedBatchLimit = Math.max(1, Math.min(100, Number(config.batch_limit))) || 5;
      const cleanConfig = {
        name: config.name,
        target_lead: clampedTargetLead,
        chapters_per_day: clampedChaptersPerDay,
        batch_limit: clampedBatchLimit,
        timezone: config.timezone || '5.75',
        inkstone_enabled: !!config.inkstone_enabled,
        patreon_enabled: !!config.patreon_enabled,
        kofi_enabled: !!config.kofi_enabled,
        patreon_tier_id: config.patreon_tier_id || 'tier-early-access',
        patreon_tier_names: Array.isArray(config.patreon_tier_names) ? config.patreon_tier_names : [],
        patreon_tag: config.patreon_tag || '',
        patreon_creator: config.patreon_creator || '',
        kofi_url: config.kofi_url || '',
        kofi_tier_id: config.kofi_tier_id || '',
        kofi_tag: config.kofi_tag || '',
        base_publish_time: (typeof config.base_publish_time === 'string' && TIME_REGEX.test(config.base_publish_time)) ? config.base_publish_time : '12:00',
        auto_fill_gaps: config.auto_fill_gaps !== false,
        author_note: config.author_note || '',
        author_note_position: config.author_note_position === 'top' ? 'top' : 'bottom',
        author_note_inkstone: config.author_note_inkstone !== false,
        author_note_patreon: config.author_note_patreon !== false,
        author_note_kofi: config.author_note_kofi !== false
      };
    fs.writeFileSync(configPath, yaml.dump(cleanConfig), 'utf8');
  } catch (error) {
    logger.error(`Failed to save config for ${slug}:`, error);
    throw error;
  }
}


