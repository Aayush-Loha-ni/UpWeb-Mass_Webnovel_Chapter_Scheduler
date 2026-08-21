/**
 * Notification System
 * Ported from Python notifications.py
 * Supports Discord, Telegram, Email, Webhook, and Console notifications
 */

import * as https from 'https';
import * as http from 'http';
import * as dns from 'dns';
import * as net from 'net';
import * as nodemailer from 'nodemailer';
import logger from './logger';

export interface NotificationConfig {
  console_enabled: boolean;
  discord_webhook: string;
  telegram_token: string;
  telegram_chat_id: string;
  smtp_server: string;
  smtp_port: number;
  smtp_username: string;
  smtp_password: string;
  email_from: string;
  email_to: string;
  webhook_url: string;
}

async function isPrivateHost(hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err) { resolve(true); return; }
      for (const addr of addresses) {
        if (net.isIPv4(addr)) {
          const parts = addr.split('.').map(Number);
          if (parts[0] === 10) { resolve(true); return; }
          if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) { resolve(true); return; }
          if (parts[0] === 192 && parts[1] === 168) { resolve(true); return; }
          if (parts[0] === 127 || parts[0] === 0) { resolve(true); return; }
          if (parts[0] === 169 && parts[1] === 254) { resolve(true); return; }
        }
      }
      resolve(false);
    });
  });
}

const SECRET_KEY_PATTERNS = ['secret', 'token', 'password', 'key', 'credential', 'auth', 'api_key', 'apikey'];

function isSecretKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some(word => lowered.includes(word));
}

/**
 * Base notification client
 */
abstract class NotificationClient {
  constructor(protected logger: { info: (msg: string, ...args: any[]) => void; warn: (msg: string, ...args: any[]) => void }) {}

  abstract notify(subject: string, payload: Record<string, any>): Promise<void>;

  async close(): Promise<void> {}
}

/**
 * Console notification client
 */
class ConsoleNotificationClient extends NotificationClient {
  async notify(subject: string, payload: Record<string, any>): Promise<void> {
    try {
      const safePayload = Object.fromEntries(
        Object.entries(payload).filter(([k]) => !isSecretKey(k))
      );
      this.logger.info(`notification=${subject} payload=${JSON.stringify(safePayload)}`);
    } catch {
      this.logger.warn('Console notification failed');
    }
  }
}

/**
 * Discord notification client
 */
class DiscordNotificationClient extends NotificationClient {
  constructor(private webhookUrl: string, logger: { info: (msg: string, ...args: any[]) => void; warn: (msg: string, ...args: any[]) => void }) {
    super(logger);
  }

  async notify(subject: string, payload: Record<string, any>): Promise<void> {
    if (!this.webhookUrl) return;
    if (await isPrivateHost(new URL(this.webhookUrl).hostname)) return;

    try {
      const message = this.formatMessage(subject, payload);
      await this.postJson(this.webhookUrl, { content: message });
    } catch {
      this.logger.warn('Discord notification failed');
    }
  }

  private formatMessage(subject: string, payload: Record<string, any>): string {
    const lines = [`**${subject}**`];
    for (const [key, value] of Object.entries(payload)) {
      lines.push(`- ${key}: ${value}`);
    }
    return lines.join('\n');
  }

  private postJson(url: string, data: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      };

      const req = https.request(options, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });

      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('Notification request timed out')));
      req.write(JSON.stringify(data));
      req.end();
    });
  }
}

/**
 * Telegram notification client
 */
class TelegramNotificationClient extends NotificationClient {
  constructor(
    private token: string,
    private chatId: string,
    logger: { info: (msg: string, ...args: any[]) => void; warn: (msg: string, ...args: any[]) => void }
  ) {
    super(logger);
  }

  async notify(subject: string, payload: Record<string, any>): Promise<void> {
    if (!this.token || !this.chatId) return;

    try {
      const message = this.formatMessage(subject, payload);
      const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
      await this.postJson(url, {
        chat_id: this.chatId,
        text: message,
        parse_mode: 'Markdown',
      });
    } catch {
      this.logger.warn('Telegram notification failed');
    }
  }

  private formatMessage(subject: string, payload: Record<string, any>): string {
    const lines = [`*${subject}*`];
    for (const [key, value] of Object.entries(payload)) {
      lines.push(`- ${key}: ${value}`);
    }
    return lines.join('\n');
  }

  private postJson(url: string, data: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      };

      const req = https.request(options, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });

      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('Notification request timed out')));
      req.write(JSON.stringify(data));
      req.end();
    });
  }
}

/**
 * Email notification client
 */
class EmailNotificationClient extends NotificationClient {
  private transporter: nodemailer.Transporter | null = null;

  constructor(
    private config: NotificationConfig,
    logger: { info: (msg: string, ...args: any[]) => void; warn: (msg: string, ...args: any[]) => void }
  ) {
    super(logger);
    if (config.smtp_server && config.smtp_username) {
      this.transporter = nodemailer.createTransport({
        host: config.smtp_server,
        port: config.smtp_port || 587,
        secure: config.smtp_port === 465,
        auth: {
          user: config.smtp_username,
          pass: config.smtp_password,
        },
      });
    }
  }

  async notify(subject: string, payload: Record<string, any>): Promise<void> {
    if (!this.transporter || !this.config.email_from || !this.config.email_to) return;

    try {
      const message = this.formatMessage(subject, payload);
      await this.transporter.sendMail({
        from: this.config.email_from,
        to: this.config.email_to,
        subject: `UpWeb: ${subject}`,
        text: message,
      });
    } catch {
      this.logger.warn('Email notification failed');
    }
  }

  private formatMessage(subject: string, payload: Record<string, any>): string {
    const lines = [subject, ''];
    for (const [key, value] of Object.entries(payload)) {
      lines.push(`${key}: ${value}`);
    }
    return lines.join('\n');
  }
}

/**
 * Webhook notification client
 */
class WebhookNotificationClient extends NotificationClient {
  constructor(private webhookUrl: string, logger: { info: (msg: string, ...args: any[]) => void; warn: (msg: string, ...args: any[]) => void }) {
    super(logger);
  }

  async notify(subject: string, payload: Record<string, any>): Promise<void> {
    if (!this.webhookUrl) return;
    if (await isPrivateHost(new URL(this.webhookUrl).hostname)) return;

    try {
      await this.postJson(this.webhookUrl, { subject, payload });
    } catch {
      this.logger.warn('Webhook notification failed');
    }
  }

  private postJson(url: string, data: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      };

      const client = urlObj.protocol === 'https:' ? https : http;
      const req = client.request(options, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });

      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('Notification request timed out')));
      req.write(JSON.stringify(data));
      req.end();
    });
  }
}

/**
 * Load notification config from environment variables.
 */
export function loadNotificationConfigFromEnv(): NotificationConfig {
  return {
    console_enabled: process.env.NOTIFY_CONSOLE !== 'false',
    discord_webhook: process.env.NOTIFY_DISCORD_WEBHOOK || '',
    telegram_token: process.env.NOTIFY_TELEGRAM_TOKEN || '',
    telegram_chat_id: process.env.NOTIFY_TELEGRAM_CHAT_ID || '',
    smtp_server: process.env.NOTIFY_SMTP_SERVER || '',
    smtp_port: parseInt(process.env.NOTIFY_SMTP_PORT || '587', 10),
    smtp_username: process.env.NOTIFY_SMTP_USERNAME || '',
    smtp_password: process.env.NOTIFY_SMTP_PASSWORD || '',
    email_from: process.env.NOTIFY_EMAIL_FROM || '',
    email_to: process.env.NOTIFY_EMAIL_TO || '',
    webhook_url: process.env.NOTIFY_WEBHOOK_URL || '',
  };
}

/**
 * Convenience: build clients from env and send a notification.
 */
export async function notifyFromEnv(subject: string, payload: Record<string, any>): Promise<void> {
  try {
    const config = loadNotificationConfigFromEnv();
    const clients = buildNotificationClients(config, logger);
    if (clients.length > 0) {
      await sendNotifications(clients, subject, payload);
      await closeAllNotifications(clients);
    }
  } catch {}
}

/**
 * Build notification clients from config
 */
export function buildNotificationClients(
  config: NotificationConfig,
  logger: { info: (msg: string, ...args: any[]) => void; warn: (msg: string, ...args: any[]) => void }
): NotificationClient[] {
  const clients: NotificationClient[] = [];

  if (config.console_enabled) {
    clients.push(new ConsoleNotificationClient(logger));
  }

  if (config.discord_webhook) {
    clients.push(new DiscordNotificationClient(config.discord_webhook, logger));
  }

  if (config.telegram_token && config.telegram_chat_id) {
    clients.push(new TelegramNotificationClient(config.telegram_token, config.telegram_chat_id, logger));
  }

  if (config.webhook_url) {
    clients.push(new WebhookNotificationClient(config.webhook_url, logger));
  }

  if (config.smtp_server && config.smtp_username && config.email_from && config.email_to) {
    clients.push(new EmailNotificationClient(config, logger));
  }

  return clients;
}

/**
 * Send notification to all configured clients
 */
export async function sendNotifications(
  clients: NotificationClient[],
  subject: string,
  payload: Record<string, any>
): Promise<void> {
  await Promise.allSettled(
    clients.map(client => client.notify(subject, payload))
  );
}

/**
 * Close all notification client connections (call on shutdown).
 */
export async function closeAllNotifications(clients: NotificationClient[]): Promise<void> {
  await Promise.allSettled(
    clients.map(client => client.close?.())
  );
}
