/**
 * Session Logging System
 * Ported from Python session_log.py
 * Thread-safe session log with JSONL persistence
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface LogEntry {
  timestamp: string;
  event: string;
  status: 'info' | 'error' | 'warning' | 'success';
  details: Record<string, any>;
}

export interface SessionSummary {
  session_id: string;
  start_time: string;
  total_entries: number;
  errors: number;
  duration_seconds: number;
}

export class SessionLog {
  private session_id: string;
  private start_time: string;
  private entries: LogEntry[] = [];
  private logDir: string;

  constructor(logDir: string) {
    this.session_id = randomUUID().substring(0, 12);
    this.start_time = new Date().toISOString();
    this.logDir = logDir;
  }

  /**
   * Record a log entry
   */
  record(event: string, details: Record<string, any> = {}, status: LogEntry['status'] = 'info'): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      event,
      status,
      details,
    };
    this.entries.push(entry);
  }

  /**
   * Save entries to JSONL file (daily rotation)
   */
  save(): string {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    const dateStr = new Date().toISOString().split('T')[0];
    const filePath = path.join(this.logDir, `${dateStr}_session.jsonl`);

    const entriesToSave = [...this.entries];

    const lines = entriesToSave
      .map(entry => {
        try {
          return JSON.stringify(entry);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .join('\n') + '\n';

    fs.appendFileSync(filePath, lines, 'utf8');
    this.entries = [];
    return filePath;
  }

  /**
   * Get session summary
   */
  summary(): SessionSummary {
    const total = this.entries.length;
    const errors = this.entries.filter(e => e.status === 'error').length;
    const duration = (Date.now() - new Date(this.start_time).getTime()) / 1000;

    return {
      session_id: this.session_id,
      start_time: this.start_time,
      total_entries: total,
      errors,
      duration_seconds: Math.round(duration * 10) / 10,
    };
  }

  /**
   * Read all log entries from a JSONL file
   */
  static readLogFile(filePath: string): LogEntry[] {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());

    return lines.map(line => {
      try {
        return JSON.parse(line) as LogEntry;
      } catch {
        return null;
      }
    }).filter((entry): entry is LogEntry => entry !== null);
  }

  /**
   * Read all log files from a directory
   */
  static readAllLogs(logDir: string): LogEntry[] {
    if (!fs.existsSync(logDir)) {
      return [];
    }

    const files = fs.readdirSync(logDir)
      .filter(f => f.endsWith('_session.jsonl'))
      .sort()
      .reverse();

    const allEntries: LogEntry[] = [];
    for (const file of files) {
      const entries = this.readLogFile(path.join(logDir, file));
      allEntries.push(...entries);
    }

    return allEntries;
  }
}
