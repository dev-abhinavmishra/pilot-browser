// app.js — bootstrap, theme, window controls, global shortcuts, start page
import { db, save, isElectron, faviconFor, hostOf } from './store.js';
import {
    initTabs, restoreSession, on, activeTab, createTab, closeTab, cycleTab,
    activateAt, navigateActive, navReload, zoomBy, zoomReset, devTools,
    spaceAccent, switchSpace, isStartShowing, wvCall,
} from './tabs.js';
import { initSidebar, applySidebarSetting, toggleSidebarCollapsed } from './sidebar.js';
import { initUi, updateNavButtons, updateOmniboxUrl, updateBookmarkBtn, focusOmnibox,
    webviewContextMenu, toggleFindBar, showFindBar, hideFindBar, openLibrary, toast } from './ui.js';
import { initOmnibox } from './omnibox.js';
import { initPalette, openPalette, paletteOpen, closePalette } from './palette.js';
import { initAssistant, toggle as toggleAssistant } from './assistant.js';

export function applyTheme() {
    const t = db.settings.theme;
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    const app = document.getElementById('app');
    app.classList.toggle('theme-dark', dark);
    app.classList.toggle('theme-light', !dark);
}

export function initApp() {
    applyTheme();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (db.settings.theme === 'system') applyTheme();
    });

    initTabs();
    initUi();
    initSidebar();
    initOmnibox();
    initPalette();
    initAssistant();
    initWindowControls();
    initStartPage();
    initShortcuts();

    applySidebarSetting();
    document.documentElement.style.setProperty('--accent', spaceAccent());

    on('webview-context-menu', webviewContextMenu);
    on('space-changed', () => {
        document.documentElement.style.setProperty('--accent', spaceAccent());
        renderStartTiles();
    });

    restoreSession();
    updateNavButtons(); updateOmniboxUrl(); updateBookmarkBtn();

    window.pilot?.meta?.().then(m => { window.__pilotVersion = m.version; });
    if (db.settings.darkPages) window.pilot?.setAppTheme?.('dark-pages');
}

// ---------------------------------------------------------------------------
// Window controls (frameless window)
// ---------------------------------------------------------------------------
function initWindowControls() {
    if (!isElectron) return;
    document.getElementById('wc-close').addEventListener('click', () => window.pilot.close());
    document.getElementById('wc-min').addEventListener('click', () => window.pilot.minimize());
    document.getElementById('wc-max').addEventListener('click', () => window.pilot.maximize());
}

// ---------------------------------------------------------------------------
// Start page
// ---------------------------------------------------------------------------
function initStartPage() {
    tickClock();
    setInterval(tickClock, 5000);
    renderStartTiles();
}

function tickClock() {
    const now = new Date();
    const clock = document.getElementById('start-clock');
    const date = document.getElementById('start-date');
    if (clock) clock.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/i, '');
    if (date) date.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

export function renderStartTiles() {
    const wrap = document.getElementById('start-tiles');
    wrap.innerHTML = '';
    for (const tile of db.settings.startTiles || []) {
        const a = document.createElement('a');
        a.className = 'start-tile';
        a.href = '#';
        a.innerHTML = `<img src="${faviconFor(tile.url)}" onerror="this.outerHTML='<div class=\\'tile-letter\\'>${tile.name[0]}</div>'" alt=""><span></span>`;
        a.querySelector('span').textContent = tile.name;
        a.addEventListener('click', (e) => { e.preventDefault(); navigateActive(tile.url); });
        wrap.appendChild(a);
    }
}

// ---------------------------------------------------------------------------
// Global shortcuts
// ---------------------------------------------------------------------------
function initShortcuts() {
    document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const shift = e.shiftKey;

        if (mod && !shift && e.key.toLowerCase() === 'k') { e.preventDefault(); paletteOpen() ? closePalette() : openPalette(); return; }
        if (paletteOpen()) return; // palette handles its own keys

        if (mod && !shift && e.key.toLowerCase() === 't') { e.preventDefault(); createTab({ activate: true }); }
        else if (mod && !shift && e.key.toLowerCase() === 'w') { e.preventDefault(); const t = activeTab(); if (t) closeTab(t.id); }
        else if (mod && !shift && e.key.toLowerCase() === 'l') { e.preventDefault(); focusOmnibox(); }
        else if (mod && !shift && e.key.toLowerCase() === 'f') { e.preventDefault(); toggleFindBar(); }
        else if (mod && !shift && e.key.toLowerCase() === 'd') { e.preventDefault(); document.getElementById('btn-bookmark').click(); }
        else if (mod && !shift && e.key.toLowerCase() === 'r') { e.preventDefault(); navReload(); }
        else if (mod && !shift && e.key.toLowerCase() === 'h') { e.preventDefault(); openLibrary('history'); }
        else if (mod && shift && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebarCollapsed(); }
        else if (mod && e.key === 'Tab') { e.preventDefault(); cycleTab(shift ? -1 : 1); }
        else if (mod && !shift && e.key === '=' ) { e.preventDefault(); zoomBy(0.1); }
        else if (mod && !shift && e.key === '-') { e.preventDefault(); zoomBy(-0.1); }
        else if (mod && !shift && e.key === '0') { e.preventDefault(); zoomReset(); }
        else if (mod && /^[1-8]$/.test(e.key)) { e.preventDefault(); activateAt(parseInt(e.key, 10) - 1); }
        else if (mod && e.key === '9') { e.preventDefault(); activateAt('last'); }
        else if (mod && shift && e.key.toLowerCase() === 'j') { e.preventDefault(); toggleAssistant(); }
        else if (e.key === 'F12') { e.preventDefault(); devTools(); }
        else if (e.altKey && !mod && e.key === 'ArrowLeft') { e.preventDefault(); const t = activeTab(); wvCall(t?.webview, 'canGoBack') && wvCall(t.webview, 'goBack'); }
        else if (e.altKey && !mod && e.key === 'ArrowRight') { e.preventDefault(); const t = activeTab(); wvCall(t?.webview, 'canGoForward') && wvCall(t.webview, 'goForward'); }
        else if (e.key === 'Escape' && isStartShowing()) { /* keep start page */ }
    });
}
