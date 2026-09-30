// app.js — bootstrap, theme, window controls, global shortcuts
import { db, isElectron } from './store.js';
import {
    initTabs, restoreSession, on, activeTab, createTab, closeTab, cycleTab,
    activateAt, navReload, zoomBy, zoomReset, devTools,
    spaceAccent, wvCall, reopenClosedTab,
} from './tabs.js';
import { initStartPage, renderStartTiles } from './startpage.js';
import { initSidebar, applySidebarSetting, toggleSidebarCollapsed } from './sidebar.js';
import { initUi, updateNavButtons, updateOmniboxUrl, updateBookmarkBtn, focusOmnibox,
    webviewContextMenu, toggleFindBar, openLibrary, toast, printActive, saveActivePage } from './ui.js';
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
    initGuestShortcuts();

    applySidebarSetting();
    document.documentElement.style.setProperty('--accent', spaceAccent());

    on('webview-context-menu', webviewContextMenu);
    on('space-changed', () => {
        document.documentElement.style.setProperty('--accent', spaceAccent());
        renderStartTiles();
    });

    restoreSession();
    updateNavButtons(); updateOmniboxUrl(); updateBookmarkBtn();

    window.pilot?.meta?.().then(m => {
        window.__pilotVersion = m.version;
        window.__pilotPlatform = m.platform;
        if (m.platform) document.getElementById('app').classList.add('platform-' + m.platform);
        // hardcoded shortcut hints show the mac glyph where relevant
        if (m.platform === 'darwin') {
            document.querySelectorAll('.start-hints kbd, .icon-btn[title], button[title]').forEach(el => {
                const t = el.getAttribute('title') || el.textContent;
                const swapped = t.replace(/Ctrl\+?/g, '⌘');
                if (el.hasAttribute('title')) el.title = swapped; else el.textContent = swapped;
            });
        }
    });
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
// Global shortcuts
// ---------------------------------------------------------------------------
function initGuestShortcuts() {
    // focused webview guests forward shell combos here — re-dispatch as a
    // real keydown so the normal shortcut chain handles them uniformly
    window.pilot?.onGuestShortcut?.((combo) => {
        const [kind, key] = combo.split(':');
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: key === 'tab' ? 'Tab' : key, bubbles: true,
            ctrlKey: kind !== 'k' && window.__pilotPlatform !== 'darwin',
            metaKey: kind !== 'k' && window.__pilotPlatform === 'darwin',
            shiftKey: kind === 'ms',
        }));
    });
}

function initShortcuts() {
    document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const shift = e.shiftKey;

        if (mod && !shift && e.key.toLowerCase() === 'k') { e.preventDefault(); paletteOpen() ? closePalette() : openPalette(); return; }
        if (paletteOpen()) return; // palette handles its own keys

        if (mod && shift && e.key.toLowerCase() === 't') {
            e.preventDefault();
            if (!reopenClosedTab()) toast('No closed tab to reopen', 'fa-rotate-left');
        }
        else if (mod && shift && e.key.toLowerCase() === 'r') { e.preventDefault(); wvCall(activeTab()?.webview, 'reloadIgnoringCache'); }
        else if (mod && !shift && e.key.toLowerCase() === 'p') { e.preventDefault(); printActive(); }
        else if (mod && !shift && e.key.toLowerCase() === 'q') { e.preventDefault(); window.pilot?.close(); }
        else if (e.key === 'F11') { e.preventDefault(); window.pilot?.toggleFullscreen?.(); }
        else if (mod && !shift && e.key.toLowerCase() === 't') { e.preventDefault(); createTab({ activate: true }); }
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
        else if (mod && !shift && e.key.toLowerCase() === 's') { e.preventDefault(); saveActivePage(); }
        else if (mod && !shift && e.key.toLowerCase() === 'j') { e.preventDefault(); openLibrary('downloads'); }
        else if (mod && shift && e.key.toLowerCase() === 'o') { e.preventDefault(); openLibrary('bookmarks'); }
        else if (e.key === 'F6') { e.preventDefault(); focusOmnibox(); }
        else if (e.key === 'F12') { e.preventDefault(); devTools(); }
        else if (e.altKey && !mod && e.key === 'ArrowLeft') { e.preventDefault(); const t = activeTab(); wvCall(t?.webview, 'canGoBack') && wvCall(t.webview, 'goBack'); }
        else if (e.altKey && !mod && e.key === 'ArrowRight') { e.preventDefault(); const t = activeTab(); wvCall(t?.webview, 'canGoForward') && wvCall(t.webview, 'goForward'); }
    });
}
