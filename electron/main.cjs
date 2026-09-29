// Pilot Browser — main process
// Frameless window, persistent browsing session, download management,
// and a small IPC surface for the renderer shell.

const { app, BrowserWindow, ipcMain, shell, Menu, session, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const isDev = !app.isPackaged;
const RENDERER_URL = process.env.PILOT_RENDERER_URL; // e.g. http://localhost:3000
const DIST_INDEX = path.join(__dirname, '..', 'dist', 'renderer', 'index.html');
const SRC_INDEX = path.join(__dirname, '..', 'src', 'renderer', 'index.html');

// ---------------------------------------------------------------------------
// Tiny JSON store (no dependency) — used only for window bounds + misc flags.
// ---------------------------------------------------------------------------
class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = {};
    }
  }
  get(key, fallback) {
    return key in this.data ? this.data[key] : fallback;
  }
  set(key, value) {
    this.data[key] = value;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('store write failed', err);
    }
  }
}

let store;
let mainWindow = null;
const downloads = new Map();

function createWindow() {
  const bounds = store.get('windowBounds', { width: 1440, height: 900 });

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 560,
    show: false,
    frame: false,
    backgroundColor: '#0d0f14',
    title: 'Pilot',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true, // the renderer embeds <webview> tabs
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (store.get('maximized', false)) mainWindow.maximize();
  });

  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    store.set('maximized', mainWindow.isMaximized());
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
  };
  mainWindow.on('resized', persistBounds);
  mainWindow.on('moved', persistBounds);
  mainWindow.on('close', persistBounds);
  mainWindow.on('maximize', () => mainWindow.webContents.send('window-state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-state', { maximized: false }));

  if (RENDERER_URL) {
    mainWindow.loadURL(RENDERER_URL);
  } else if (fs.existsSync(DIST_INDEX)) {
    mainWindow.loadFile(DIST_INDEX);
  } else {
    mainWindow.loadFile(SRC_INDEX);
  }

  // The shell never opens real OS windows itself; links that want a new window
  // are routed back into the tab system.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') || url.startsWith('file')) {
      mainWindow.webContents.send('open-url-in-tab', url);
    }
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------
// Downloads — one persistent session for all <webview> guests.
// ---------------------------------------------------------------------------
function setupDownloads() {
  const ses = session.fromPartition('persist:pilot');
  ses.on('will-download', (_event, item) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const name = item.getFilename();
    const dir = app.getPath('downloads');
    const target = path.join(dir, name);
    item.setSavePath(target);

    const entry = { id, name, path: target, total: item.getTotalBytes(), received: 0, state: 'progressing' };
    downloads.set(id, entry);
    const push = () => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('download-update', entry);

    item.on('updated', (_e, state) => {
      entry.received = item.getReceivedBytes();
      entry.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      push();
    });
    item.once('done', (_e, state) => {
      entry.state = state; // completed | cancelled | interrupted
      entry.received = item.getReceivedBytes();
      push();
    });
    push();
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.on('window-maximize', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.on('window-close', () => mainWindow && mainWindow.close());
  ipcMain.handle('window-is-maximized', () => (mainWindow ? mainWindow.isMaximized() : false));
  ipcMain.handle('app-meta', () => ({
    version: app.getVersion(),
    platform: process.platform,
    dev: isDev,
  }));
  ipcMain.handle('set-app-theme', (_e, t) => {
    // dark pages feature: let guests follow app theme when user opts in via settings
    nativeTheme.themeSource = t === 'dark-pages' ? 'dark' : 'light';
    return true;
  });
  ipcMain.handle('show-item-in-folder', (_e, p) => {
    if (typeof p === 'string' && p) shell.showItemInFolder(p);
    return true;
  });
  ipcMain.handle('open-path', async (_e, p) => {
    if (typeof p !== 'string' || !p) return 'invalid path';
    return shell.openPath(p);
  });
  ipcMain.handle('open-external', async (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
    return true;
  });
  ipcMain.handle('list-downloads', () => [...downloads.values()]);
  ipcMain.handle('pick-directory', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });
  // Dark titlebar-free menu: hide the default app menu entirely.
  Menu.setApplicationMenu(null);
}

// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  store = new JsonStore(path.join(app.getPath('userData'), 'pilot-state.json'));

  // Keep web pages rendering the way their authors intended: the OS dark
  // theme would otherwise flip guest page canvases dark. Our chrome is
  // CSS-themed, so guests stay on 'light' regardless of the app theme.
  nativeTheme.themeSource = 'light';

  // Make webview guests behave like a real browser: real UA, no Electron badge.
  app.userAgentFallback = app
    .userAgentFallback
    .replace(/\s*Electron\/\S+/, '')
    .replace(/\s*Pilot(?:Browser)?\/\S+/, '');

  setupDownloads();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => console.error('Uncaught:', err));
