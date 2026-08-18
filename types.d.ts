declare module 'express-ws' {
  import { Express } from 'express';
  interface WsInstance {
    app: Express & { ws: (route: string, handler: (ws: any, req: any) => void) => void };
  }
  function expressWs(app: Express): WsInstance;
  export default expressWs;
}

declare module 'playwright' {
  export interface BrowserContext {
    pages(): any[];
    newPage(): Promise<any>;
    close(): Promise<void>;
    cookies(urls?: string | string[]): Promise<any[]>;
    addCookies(cookies: any[]): Promise<void>;
    clearCookies(): Promise<void>;
    on(event: string, handler: (...args: any[]) => void): void;
    browser(): any | null;
    addInitScript(script: { content?: string; path?: string } | string): Promise<void>;
  }
  export interface Browser {
    newContext(options?: any): Promise<BrowserContext>;
    close(): Promise<void>;
    isConnected(): boolean;
    contexts(): BrowserContext[];
    newPage(): Promise<Page>;
    launchPersistentContext(userDataDir: string, options?: any): Promise<BrowserContext>;
  }
  export interface Page {
    goto(url: string, options?: any): Promise<any>;
    evaluate(fn: string | Function, ...args: any[]): Promise<any>;
    waitForSelector(selector: string, options?: any): Promise<any>;
    click(selector: string, options?: any): Promise<void>;
    type(selector: string, text: string, options?: any): Promise<void>;
    waitForTimeout(timeout: number): Promise<void>;
    url(): string;
    title(): Promise<string>;
    content(): Promise<string>;
    close(): Promise<void>;
    on(event: string, handler: (...args: any[]) => void): void;
    setDefaultTimeout(timeout: number): void;
    $eval(selector: string, fn: string | Function, ...args: any[]): Promise<any>;
    $$eval(selector: string, fn: string | Function, ...args: any[]): Promise<any>;
    waitForLoadState(state?: string, options?: { timeout?: number }): Promise<void>;
    waitForURL(url: string | RegExp | ((url: URL) => boolean), options?: { timeout?: number }): Promise<void>;
    waitForFunction(fn: string | Function, arg?: any, options?: { timeout?: number }): Promise<any>;
    locator(selector: string, options?: { hasText?: string; hasNotText?: string; exact?: boolean }): any;
  }
  export interface BrowserType {
    connectOverCDP(endpointURL: string, options?: any): Promise<Browser>;
    launch(options?: any): Promise<Browser>;
    connect(options?: any): Promise<Browser>;
    launchPersistentContext(userDataDir: string, options?: any): Promise<BrowserContext>;
  }
  export const chromium: BrowserType;
  export const firefox: BrowserType;
  export const webkit: BrowserType;
}

declare module 'vitest' {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  export function expect(value: any): any;
  export const vi: {
    fn: (...args: any[]) => any;
    clearAllMocks(): void;
    useFakeTimers(): void;
    useRealTimers(): void;
    advanceTimersByTime(ms: number): void;
    advanceTimersByTimeAsync(ms: number): Promise<void>;
    mock(path: string, factory?: (...args: any[]) => any): void;
  };
  export function beforeEach(fn: () => void): void;
  export function afterEach(fn: () => void): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
}

declare module 'vitest/config' {
  export function defineConfig(config: any): any;
}
