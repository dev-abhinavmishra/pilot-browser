// palette.js — Ctrl+K command palette: tabs, bookmarks, history, actions
import { db, save, hostOf } from './store.js';
import {
    getTabs, activeTab, activateTab, createTab, closeTab, pinTab, unpinTab,
    navigateActive, switchSpace, splitActiveWith, closeSplit, zoomBy, zoomReset,
    devTools, tabsInSpace, spaceAccent, reopenClosedTab, wvCall,
} from './tabs.js';
import { registerPaletteCloser, openLibrary, toast, toggleFindBar, updateBookmarkBtn } from './ui.js';
import { toggleSidebarCollapsed } from './sidebar.js';
import { applyTheme } from './app.js';

let overlay, input, results, sel = 0, items = [];

const ACTIONS = () => [
    { title: 'New tab', sub: 'Ctrl+T', icon: 'fa-plus', run: () => createTab({ activate: true }) },
    { title: 'Close current tab', sub: 'Ctrl+W', icon: 'fa-xmark', run: () => activeTab() && closeTab(activeTab().id) },
    { title: 'Reopen closed tab', sub: 'Ctrl+Shift+T', icon: 'fa-rotate-left', run: () => reopenClosedTab() || toast('No closed tab to reopen', 'fa-rotate-left') },
    { title: 'Reload page', sub: 'Ctrl+R', icon: 'fa-rotate-right', run: () => wvCall(activeTab()?.webview, 'reload') },
    { title: 'Hard reload (ignore cache)', sub: 'Ctrl+Shift+R', icon: 'fa-bolt', run: () => wvCall(activeTab()?.webview, 'reloadIgnoringCache') },
    { title: 'Print page…', sub: 'Ctrl+P', icon: 'fa-print', run: () => wvCall(activeTab()?.webview, 'print') },
    { title: 'Toggle fullscreen', sub: 'F11', icon: 'fa-up-right-and-down-left-from-center', run: () => window.pilot?.toggleFullscreen?.() },
    { title: 'Toggle sidebar', sub: 'Ctrl+Shift+B', icon: 'fa-sidebar fa-flip-horizontal', run: toggleSidebarCollapsed },
    { title: 'Find in page', sub: 'Ctrl+F', icon: 'fa-magnifying-glass', run: toggleFindBar },
    { title: 'Bookmark page', sub: 'Ctrl+D', icon: 'fa-star', run: () => document.getElementById('btn-bookmark').click() },
    { title: 'Pin / unpin tab', icon: 'fa-thumbtack', run: () => { const t = activeTab(); if (t) t.pinned ? unpinTab(t.id) : pinTab(t.id); } },
    { title: 'Split view with next tab', icon: 'fa-table-columns', run: () => {
        const t = activeTab(); if (!t) return;
        if (t.splitWith) return closeSplit(t.id);
        const next = tabsInSpace().find(x => x.id !== t.id && x.url);
        if (next) splitActiveWith(next.id); else toast('No other tab to split with', 'fa-table-columns');
    } },
    { title: 'Toggle theme (dark/light)', icon: 'fa-circle-half-stroke', run: () => {
        db.settings.theme = db.settings.theme === 'dark' ? 'light' : 'dark';
        save(); applyTheme(); toast(`Theme: ${db.settings.theme}`, 'fa-circle-half-stroke');
    } },
    { title: 'Zoom in', icon: 'fa-magnifying-glass-plus', run: () => zoomBy(0.1) },
    { title: 'Zoom out', icon: 'fa-magnifying-glass-minus', run: () => zoomBy(-0.1) },
    { title: 'Reset zoom', icon: 'fa-expand', run: zoomReset },
    { title: 'History', icon: 'fa-clock-rotate-left', run: () => openLibrary('history') },
    { title: 'Bookmarks', icon: 'fa-star', run: () => openLibrary('bookmarks') },
    { title: 'Downloads', icon: 'fa-download', run: () => openLibrary('downloads') },
    { title: 'Settings', icon: 'fa-gear', run: () => openLibrary('settings') },
    { title: 'Developer tools', sub: 'F12', icon: 'fa-code', run: devTools },
    ...db.spaces.map(s => ({
        title: `Switch to space: ${s.name}`, sub: 'Space', icon: s.icon,
        run: () => switchSpace(s.id),
    })),
];

export function initPalette() {
    overlay = document.getElementById('palette');
    input = document.getElementById('palette-input');
    results = document.getElementById('palette-results');
    document.getElementById('palette-btn').addEventListener('click', openPalette);

    input.addEventListener('input', () => render(input.value));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); items[sel]?.run(); closePalette(); }
        else if (e.key === 'Escape') { closePalette(); }
    });
    registerPaletteCloser(closePalette);
}

export function openPalette() {
    overlay.classList.remove('hidden');
    input.value = '';
    render('');
    setTimeout(() => input.focus(), 20);
}
export function closePalette() { overlay.classList.add('hidden'); }
export function paletteOpen() { return !overlay.classList.contains('hidden'); }

function move(d) {
    if (!items.length) return;
    sel = (sel + d + items.length) % items.length;
    paint();
    results.querySelector('.pal-item.selected')?.scrollIntoView({ block: 'nearest' });
}

function score(q, text) {
    // simple subsequence fuzzy score — higher is better
    q = q.toLowerCase(); text = (text || '').toLowerCase();
    if (!q) return 1;
    let qi = 0, sc = 0, streak = 0;
    for (let i = 0; i < text.length && qi < q.length; i++) {
        if (text[i] === q[qi]) { qi++; streak++; sc += 1 + streak; }
        else streak = 0;
    }
    return qi === q.length ? sc : -1;
}

function render(query) {
    items = []; sel = 0;
    results.innerHTML = '';
    const q = (query || '').trim();

    const candidates = [];

    // open tabs first (switch or close)
    for (const t of getTabs()) {
        if (!t.url) continue;
        candidates.push({
            title: 'Switch to ' + (t.title || hostOf(t.url)),
            sub: hostOf(t.url), icon: 'fa-arrow-right', favicon: t.favicon,
            hay: `${t.title} ${t.url} switch tab`,
            run: () => activateTab(t.id),
        });
    }
    for (const b of db.bookmarks) {
        candidates.push({
            title: b.title || b.url, sub: 'Bookmark', icon: 'fa-star', favicon: b.favicon,
            hay: `${b.title} ${b.url} bookmark`,
            run: () => navigateActive(b.url),
        });
    }
    let h = 0;
    for (const entry of db.history) {
        if (h++ > 60) break;
        candidates.push({
            title: entry.title || entry.url, sub: hostOf(entry.url), icon: 'fa-clock-rotate-left', favicon: entry.favicon,
            hay: `${entry.title} ${entry.url} history`,
            run: () => navigateActive(entry.url),
        });
    }
    for (const a of ACTIONS()) {
        candidates.push({ title: a.title, sub: a.sub || 'Action', icon: a.icon, hay: a.title + ' action', run: a.run });
    }

    let list;
    if (!q) {
        // default: show actions + tabs
        list = candidates;
    } else {
        list = candidates
            .map(c => ({ c, s: score(q, c.hay) }))
            .filter(x => x.s > 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 14)
            .map(x => x.c);
        // fall back: web search
        if (list.length) items = list;
        items.push({ title: `Search the web for "${q}"`, sub: db.settings.searchEngine, icon: 'fa-magnifying-glass', run: () => navigateActive(q) });
        if (!q) items = [];
    }
    if (!q) items = list.slice(0, 14);

    paint();
}

function paint() {
    results.innerHTML = '';
    let lastSub = null;
    items.forEach((it, i) => {
        if (it.sub !== lastSub && ['Action', 'Bookmark', 'Space'].includes(it.sub)) {
            const h = document.createElement('div');
            h.className = 'pal-section';
            h.textContent = it.sub === 'Action' ? 'Commands' : it.sub + 's';
            results.appendChild(h);
            lastSub = it.sub;
        }
        const row = document.createElement('div');
        row.className = 'pal-item' + (i === sel ? ' selected' : '');
        row.innerHTML = `<div class="pal-icon"></div><div class="pal-title"></div><div class="pal-sub"></div>`;
        const iconWrap = row.querySelector('.pal-icon');
        if (it.favicon) {
            // page-controlled URL — assign via DOM, never string-interpolate
            const img = document.createElement('img');
            img.src = it.favicon; img.alt = '';
            img.onerror = () => img.remove();
            iconWrap.appendChild(img);
        } else {
            const i2 = document.createElement('i');
            i2.className = `fa-solid ${it.icon}`;
            iconWrap.appendChild(i2);
        }
        row.querySelector('.pal-title').textContent = it.title;
        row.querySelector('.pal-sub').textContent = it.sub || '';
        row.addEventListener('click', () => { it.run(); closePalette(); });
        row.addEventListener('mousemove', () => { sel = i; paint(); });
        results.appendChild(row);
    });
}
