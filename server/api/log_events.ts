/**
 * Central event bus for real-time log streaming.
 * The runner publishes log events; WebSocket subscribers receive them.
 */

import { EventEmitter } from 'events';

export interface LogEvent {
  slug: string;
  message: string;
  timestamp: string;
}

class LogEventBus extends EventEmitter {
  private static instance: LogEventBus;
  private connectionCount = 0;
  private readonly MAX_LISTENERS = 50;

  private constructor() {
    super();
    this.setMaxListeners(this.MAX_LISTENERS);
  }

  static getInstance(): LogEventBus {
    if (!LogEventBus.instance) {
      LogEventBus.instance = new LogEventBus();
    }
    return LogEventBus.instance;
  }

  emitLog(slug: string, message: string): void {
    const event: LogEvent = {
      slug,
      message,
      timestamp: new Date().toISOString(),
    };
    this.emit('log', event);
    this.emit(`log:${slug}`, event);
  }

  onLog(slug: string, callback: (event: LogEvent) => void): () => void {
    const handler = (event: LogEvent) => {
      if (event.slug === slug) callback(event);
    };
    this.on('log', handler);
    this.connectionCount++;
    return () => {
      this.off('log', handler);
      this.connectionCount--;
    };
  }

  onAnyLog(callback: (event: LogEvent) => void): () => void {
    this.on('log', callback);
    this.connectionCount++;
    return () => {
      this.off('log', callback);
      this.connectionCount--;
    };
  }

  getConnectionCount(): number {
    return this.connectionCount;
  }
}

export const logEventBus = LogEventBus.getInstance();
