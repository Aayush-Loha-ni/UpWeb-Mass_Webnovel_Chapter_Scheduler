/**
 * Electron main process for the Webnovel Automation desktop app.
 *
 * Responsibilities:
 *  - Resolve per-user paths (workspace, bundled assets, Playwright browsers)
 *    into env vars BEFORE the server module is imported (config reads env at
 *    module load).
 *  - Boot the existing Express app (createApp) on loopback and render it.
 *  - Single-instance lock + graceful shutdown via the server's gracefulShutdown.
 *
 * Dev mode (ELECTRON_DEV=1): does not import the built server; instead it
 * spawns `npm run dev` (tsx + Vite middleware) and points the window at it.
 */
const { app, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT || '3000';
const isDev = process.env.ELECTRON_DEV === '1';

let devChild = null;

function waitForServer(timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const req = http.get(
        { host: '127.0.0.1', port: PORT, path: '/healthz', timeout: 1000 },
        (res) => { res.resume(); resolve(); }
      );
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('dev server timeout'));
        else setTimeout(tick, 500);
      });
      req.on('timeout', () => req.destroy());
    };
    tick();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      webSecurity: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(`http://127.0.0.1:${PORT}`);
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins[0]) wins[0].focus();
  });

  app.whenReady().then(async () => {
    if (!isDev) {
      // Per-user + runtime env MUST be set before importing the server.
      const userData = app.getPath('userData');
      process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(userData, 'workspace');
      process.env.SHARED_DIR = process.env.SHARED_DIR || path.join(userData, 'shared');
      process.env.API_KEY = ''; // loopback bypass authorizes the renderer; avoids writing read-only shared/.api_key
      process.env.NODE_ENV = process.env.NODE_ENV || 'production';
      process.env.ELECTRON_RUN = '1';
      process.env.DIST_DIR = process.resourcesPath
        ? path.join(process.resourcesPath, 'dist')
        : path.join(__dirname, '..', 'dist');
      if (process.resourcesPath) {
        // ponytail: bundled Playwright Chromium lives here (set via PLAYWRIGHT_BROWSERS_PATH so chromium.launch() finds it)
        process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'playwright');
      }

      const serverModule = require(path.join(__dirname, '..', 'dist', 'server.cjs'));
      const { createApp, gracefulShutdown } = serverModule;
      const { app: exApp } = await createApp();
      exApp.listen(Number(PORT), '127.0.0.1');

      app.on('before-quit', (event) => {
        event.preventDefault();
        gracefulShutdown('before-quit').then(() => app.exit(0));
      });
    } else {
      const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      devChild = spawn(cmd, ['run', 'dev'], {
        cwd: path.join(__dirname, '..'),
        stdio: 'pipe',
        shell: true,
        windowsHide: true,
      });
      devChild.stdout?.on('data', (d) => process.stdout.write(`[dev] ${d}`));
      devChild.stderr?.on('data', (d) => process.stderr.write(`[dev] ${d}`));
      devChild.on('exit', (code) => {
        if (code !== 0) console.error(`[dev] server exited with code ${code}`);
      });
      try { await waitForServer(60000); }
      catch (e) { console.error('[dev] server did not start within 60s', e.message); }
    }

    createWindow();

    // Phase 5: auto-update (packaged apps only; reads publish URL from build config).
    if (!isDev && app.isPackaged) {
      autoUpdater.on('update-available', () => console.log('[updater] update available'));
      autoUpdater.on('update-downloaded', () => console.log('[updater] update downloaded; will install on restart'));
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }
  });

  app.on('window-all-closed', () => {
    if (devChild) devChild.kill();
    if (process.platform !== 'darwin') app.quit();
  });
}
