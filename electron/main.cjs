// Pilot Browser — main process
// Frameless window, persistent browsing session, download management,
// and a small IPC surface for the renderer shell.

const { app, BrowserWindow, ipcMain, shell, Menu, session, dialog, nativeTheme, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');

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

  // a saved position can land off-screen when monitors change — only restore
  // x/y if some display actually shows that point
  let pos = {};
  if (bounds.x != null && bounds.y != null) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return bounds.x >= a.x - 100 && bounds.x < a.x + a.width && bounds.y >= a.y - 40 && bounds.y < a.y + a.height;
    });
    if (visible) pos = { x: bounds.x, y: bounds.y };
  }

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...pos,
    minWidth: 900,
    minHeight: 560,
    show: false,
    frame: false,
    backgroundColor: '#04060c',
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
  mainWindow.on('enter-full-screen', () => mainWindow.webContents.send('window-state', { fullscreen: true }));
  mainWindow.on('leave-full-screen', () => mainWindow.webContents.send('window-state', { fullscreen: false }));

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
    if (/^https?:\/\//i.test(url)) {
      mainWindow.webContents.send('open-url-in-tab', url);
    }
    return { action: 'deny' };
  });

  // Our renderer attaches <webview> guests; a compromised renderer could ask
  // for unsafe guest prefs, so the safe set is forced here regardless.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    delete webPreferences.preload;
    if (params.partition !== 'persist:pilot') params.partition = 'persist:pilot';
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
  ipcMain.on('window-fullscreen', () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });
  ipcMain.handle('window-is-maximized', () => (mainWindow ? mainWindow.isMaximized() : false));
  // clipboard via main process — navigator.clipboard isn't guaranteed on
  // file:// shell pages and execCommand('paste') is dead
  ipcMain.handle('clipboard-read-text', () => clipboard.readText());
  ipcMain.handle('clipboard-write-text', (_e, text) => {
    if (typeof text === 'string') clipboard.writeText(text);
    return true;
  });
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
    // only files we downloaded — a compromised renderer must not launch
    // arbitrary local paths
    const dir = path.resolve(app.getPath('downloads'));
    const target = path.resolve(p);
    if (target !== dir && !target.startsWith(dir + path.sep)) return 'path outside downloads';
    return shell.openPath(target);
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
  // Application menu: null on Windows/Linux (frameless chrome is ours), but
  // macOS needs a real menu — without one Cmd+Q/Cmd+W/edit shortcuts die,
  // and the Edit role also powers copy/paste inside webview guests.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' }, { type: 'separator' },
          { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
          { type: 'separator' }, { role: 'quit', label: 'Quit Pilot' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
          { type: 'separator' }, { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
}

// ---------------------------------------------------------------------------
// Browsers are single-instance: a second launch focuses the live window
// instead of forking a parallel session.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(() => {
  // Windows needs this for taskbar grouping / notification attribution.
  app.setAppUserModelId('com.pilot.browser');

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

  // Guest popups (target=_blank / window.open): the webview 'new-window'
  // event doesn't fire on current Electron — guests' window.open goes through
  // their own webContents open handler, routed back into the tab system here.
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (/^https?:\/\//i.test(url) && mainWindow && !mainWindow.isDestroyed()) {
        // middle/ctrl-click guests ask for background-tab disposition —
        // honor it so the new tab doesn't steal focus
        mainWindow.webContents.send('open-url-in-tab', {
          url, from: contents.getURL(), background: disposition === 'background-tab',
        });
      }
      return { action: 'deny' };
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => console.error('Uncaught:', err));
