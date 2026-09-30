// ui.js — context menus, toasts, library panel (history/bookmarks/downloads/settings), find bar
import { db, save, hostOf, removeBookmark, clearHistory, isBookmarked, toggleBookmark } from './store.js';
import {
    on, activeTab, navigateActive, createTab, closeTab, pinTab, unpinTab,
    splitActiveWith, closeSplit, tabsInSpace, pinnedInSpace, getTabs, activateTab,
    findInPage, findNext, stopFind, devTools, zoomBy, zoomReset, wvCall,
    switchSpace, spaceAccent, getTab, duplicateTab,
    reopenClosedTab, canReopenTab, navHistoryOf, SEARCH_ENGINES,
} from './tabs.js';
import { renderSettingsPanel } from './settings.js';

const $ = (sel) => document.querySelector(sel);

// macOS shows the ⌘ glyph for the platform modifier in key hints
const mk = (k) => window.__pilotPlatform === 'darwin' ? k.replace('Ctrl+', '⌘') : k;

// clipboard through the main-process bridge (navigator.clipboard is not
// guaranteed on the file:// shell page); falls back for plain-browser dev
const clip = {
    write: (t) => window.pilot?.clipboardWriteText ? window.pilot.clipboardWriteText(t) : navigator.clipboard?.writeText(t),
    read: () => window.pilot?.clipboardReadText ? window.pilot.clipboardReadText() : navigator.clipboard?.readText(),
};

// Ctrl+S — save the live page as HTML via the guest's own webContents
export async function saveActivePage() {
    const wv = activeTab()?.webview;
    const wcId = wv ? wvCall(wv, 'getWebContentsId') : null;
    if (!wcId || !window.pilot?.savePage) return;
    const path = await window.pilot.savePage(wcId);
    if (path) toast('Saved ' + path, 'fa-floppy-disk');
}

// Electron's wv.print() is silent (no dialog, straight to the default
// printer) — printToPDF + a save dialog is the usable equivalent
export async function printActive() {
    const wv = activeTab()?.webview;
    if (!wv || !window.pilot?.savePdf) return;
    try {
        const data = await wv.printToPDF({});
        const path = await window.pilot.savePdf(data);
        if (path) toast('Saved ' + path, 'fa-print');
    } catch { toast('Print failed', 'fa-print'); }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
export function toast(msg, icon = 'fa-check') {
    const wrap = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<i class="fa-solid ${icon}"></i><span></span>`;
    el.querySelector('span').textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 260);
    }, 2400);
}

// ---------------------------------------------------------------------------
// Context menu (custom, matches theme)
// ---------------------------------------------------------------------------
let ctxEl;
export function initUi() {
    ctxEl = $('#ctx-menu');
    document.addEventListener('click', (e) => {
        if (!ctxEl.classList.contains('hidden') && !ctxEl.contains(e.target)) hideContextMenu();
        const sug = $('#omni-suggest');
        if (!sug.contains(e.target) && e.target.id !== 'omni-input') sug.classList.remove('open');
    });
    // clicks inside a guest never reach the shell document — the webview
    // element gaining DOM focus is the signal to drop open menus
    document.addEventListener('focus', (e) => {
        if (e.target.tagName === 'WEBVIEW') {
            hideContextMenu();
            $('#omni-suggest').classList.remove('open');
        }
    }, true);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // Esc also stops a page load, like the browser it's modeled on
            const t = activeTab();
            if (t?.loading) wvCall(t.webview, 'stop');
            hideContextMenu();
            hideLibrary();
            hidePaletteExt();
            hideFindBar();
        }
    });
    initFindBar();
    initLibrary();
    initToolbar();
    initDownloads();

    // shell text inputs get the same edit menu a native browser chrome has
    document.addEventListener('contextmenu', (e) => {
        const inp = e.target.closest?.('input[type="text"], textarea');
        if (!inp) return;
        e.preventDefault();
        const hasSel = inp.selectionStart !== inp.selectionEnd;
        showContextMenu(e.clientX, e.clientY, [
            ...(inp.id === 'omni-input' ? [
                { label: 'Paste and go', icon: 'fa-arrow-right', click: async () => {
                    const t = (await clip.read())?.trim();
                    if (t) { inp.value = t; navigateActive(t); }
                } },
                'sep',
            ] : []),
            { label: 'Cut', icon: 'fa-scissors', disabled: !hasSel, click: () => {
                clip.write(inp.value.slice(inp.selectionStart, inp.selectionEnd));
                inp.setRangeText('', inp.selectionStart, inp.selectionEnd, 'start');
            } },
            { label: 'Copy', icon: 'fa-copy', disabled: !hasSel, click: () => clip.write(inp.value.slice(inp.selectionStart, inp.selectionEnd)) },
            { label: 'Paste', icon: 'fa-paste', click: async () => {
                const t = await clip.read();
                if (t) inp.setRangeText(t, inp.selectionStart, inp.selectionEnd, 'end');
            } },
            'sep',
            { label: 'Select all', icon: 'fa-i-cursor', click: () => inp.select() },
        ]);
    });
}

function buildCtxItems(container, items, openLeft) {
    for (const item of items) {
        if (item === 'sep' || item.sep) {
            const sep = document.createElement('div');
            sep.className = 'ctx-sep';
            container.appendChild(sep);
            continue;
        }
        const el = document.createElement('div');
        el.className = 'ctx-item' + (item.disabled ? ' disabled' : '') + (item.submenu ? ' has-sub' : '');
        el.innerHTML = `<i class="fa-solid ${item.icon || 'fa-circle'}"></i><span></span>${item.key ? `<span class="ctx-key">${mk(item.key)}</span>` : ''}${item.submenu ? '<i class="fa-solid fa-chevron-right ctx-caret"></i>' : ''}`;
        el.querySelector('span:not(.ctx-key)').textContent = item.label;
        if (item.danger) el.style.color = '#f87171';
        if (item.submenu && item.submenu.length) {
            const sub = document.createElement('div');
            sub.className = 'ctx-sub' + (openLeft ? ' left' : '');
            buildCtxItems(sub, item.submenu, openLeft);
            el.appendChild(sub);
            el.addEventListener('click', (e) => { e.stopPropagation(); });
        } else {
            el.addEventListener('click', () => { hideContextMenu(); item.click && item.click(); });
        }
        container.appendChild(el);
    }
}

export function showContextMenu(x, y, items) {
    ctxEl.innerHTML = '';
    buildCtxItems(ctxEl, items, x > innerWidth - 440);
    ctxEl.classList.remove('hidden');
    // clamp inside viewport
    const r = ctxEl.getBoundingClientRect();
    ctxEl.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    ctxEl.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
export function hideContextMenu() { ctxEl.classList.add('hidden'); }

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------
function initToolbar() {
    const back = $('#nav-back'), fwd = $('#nav-forward'), reload = $('#nav-reload');
    const bmBtn = $('#btn-bookmark'), findBtn = $('#btn-find'), splitBtn = $('#btn-split'), menuBtn = $('#btn-menu');

    back.addEventListener('click', () => navBackSafe());
    fwd.addEventListener('click', () => navFwdSafe());
    // Chrome parity: right-clicking back/forward lists this tab's session
    // history and jumps straight to an entry
    back.addEventListener('contextmenu', (e) => { e.preventDefault(); navHistoryMenu(e, -1); });
    fwd.addEventListener('contextmenu', (e) => { e.preventDefault(); navHistoryMenu(e, 1); });
    // lock icon gives the same one-glance security answer Chrome does
    $('#omni-lock').addEventListener('click', (e) => {
        const t = activeTab();
        if (!t?.url) return;
        const https = t.url.startsWith('https');
        showContextMenu(e.clientX, e.clientY, [
            { label: https ? 'Connection is secure' : 'Connection is not secure',
              icon: https ? 'fa-lock' : 'fa-unlock', disabled: true },
            { label: `This site is ${https ? 'https' : 'http'} — data sent is ${https ? 'encrypted' : 'not encrypted'}`, icon: 'fa-circle-info', disabled: true },
            'sep',
            { label: 'Copy page URL', icon: 'fa-link', click: () => { clip.write(t.url); toast('URL copied', 'fa-link'); } },
        ]);
    });
    on('zoom', (pct) => toast(`Zoom ${pct}%`, 'fa-magnifying-glass'));
    reload.addEventListener('click', () => {
        const t = activeTab();
        if (t?.webview) { if (t.loading) wvCall(t.webview, 'stop'); else wvCall(t.webview, 'reload'); }
    });
    bmBtn.addEventListener('click', () => {
        const t = activeTab();
        if (!t || !t.url) return;
        const added = toggleBookmarkAction(t);
        toast(added ? 'Bookmarked' : 'Bookmark removed', added ? 'fa-star' : 'fa-star-half-stroke');
        updateBookmarkBtn();
    });
    findBtn.addEventListener('click', toggleFindBar);
    splitBtn.addEventListener('click', () => {
        const t = activeTab();
        if (!t) return;
        if (t.splitWith) { closeSplit(t.id); return; }
        const candidates = getTabs().filter(x => x.spaceId === t.spaceId && x.id !== t.id && x.url);
        if (!candidates.length) { toast('Open another tab to split with', 'fa-table-columns'); return; }
        splitActiveWith(candidates[0].id);
        toast('Split view on — right pane: ' + (candidates[0].title || 'tab'), 'fa-table-columns');
    });
    menuBtn.addEventListener('click', (e) => { e.stopPropagation(); appMenu(e); });

    on('nav-changed', (t) => {
        if (t !== activeTab()) return;
        updateNavButtons(); updateOmniboxUrl(); updateBookmarkBtn();
    });
    on('active-changed', () => { updateNavButtons(); updateOmniboxUrl(); updateBookmarkBtn(); updateSplitBtn(); });
    on('tab-updated', (t) => { if (t === activeTab()) { updateNavButtons(); updateOmniboxUrl(); } });
    on('loading', ({ loading }) => {
        $('#progress').classList.toggle('loading', loading);
        const fill = $('#progress-fill');
        if (loading) {
            fill.style.transition = 'none'; fill.style.width = '8%';
            requestAnimationFrame(() => { fill.style.transition = 'width .4s'; fill.style.width = '82%'; });
        } else {
            fill.style.transition = 'width .2s, opacity .35s .1s'; fill.style.width = '100%';
            setTimeout(() => { if (!$('#progress').classList.contains('loading')) fill.style.width = '0%'; }, 400);
        }
    });
    on('found-in-page', (r) => {
        if (!r) return;
        $('#find-count').textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : '0/0';
    });

    function navBackSafe() { const t = activeTab(); if (wvCall(t?.webview, 'canGoBack')) wvCall(t.webview, 'goBack'); }
    function navFwdSafe() { const t = activeTab(); if (wvCall(t?.webview, 'canGoForward')) wvCall(t.webview, 'goForward'); }

    function navHistoryMenu(e, dir) {
        const t = activeTab();
        const { entries, index } = navHistoryOf(t);
        if (!entries.length) return;
        const items = entries.map((h, i) => ({
            label: h.title || hostOf(h.url),
            icon: i === index ? 'fa-circle-dot' : 'fa-clock-rotate-left',
            disabled: i === index,
            click: () => wvCall(t.webview, 'goToOffset', i - index),
        })).slice(-10);
        showContextMenu(e.clientX, e.clientY, items);
    }
}

export function updateNavButtons() {
    const t = activeTab();
    $('#nav-back').disabled = !wvCall(t?.webview, 'canGoBack');
    $('#nav-forward').disabled = !wvCall(t?.webview, 'canGoForward');
    const rl = $('#nav-reload i');
    if (rl) rl.className = t?.loading ? 'fa-solid fa-xmark' : 'fa-solid fa-rotate-right';
    $('#omni-lock').className = 'fa-solid ' + (t?.url?.startsWith('https') ? 'fa-lock' : t?.url ? 'fa-globe' : 'fa-magnifying-glass');
    updateSplitBtn();
}
function updateSplitBtn() {
    const t = activeTab();
    $('#btn-split').classList.toggle('active', !!t?.splitWith);
}
export function updateOmniboxUrl() {
    const t = activeTab();
    const input = $('#omni-input');
    if (!input.matches(':focus')) input.value = t && t.url ? prettyUrl(t.url) : '';
}
export function updateBookmarkBtn() {
    const t = activeTab();
    const icon = $('#btn-bookmark i');
    const marked = t?.url && isBookmarked(t.url);
    icon.className = marked ? 'fa-solid fa-star' : 'fa-regular fa-star';
    $('#btn-bookmark').classList.toggle('active', !!marked);
}
function prettyUrl(url) {
    try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + u.pathname + u.search; } catch { return url; }
}
export function focusOmnibox() {
    const input = $('#omni-input');
    input.focus(); input.select();
}

// ---------------------------------------------------------------------------
// App (⋮) menu
// ---------------------------------------------------------------------------
function appMenu(e) {
    const t = activeTab();
    showContextMenu(e.clientX, e.clientY, [
        { label: 'New tab', icon: 'fa-plus', key: 'Ctrl+T', click: () => createTab({ activate: true }) },
        { label: 'New space…', icon: 'fa-square-plus', click: () => document.querySelector('#space-switcher .space-pill:last-child')?.click() },
        'sep',
        { label: 'Bookmark this page', icon: 'fa-star', key: 'Ctrl+D', click: () => $('#btn-bookmark').click(), disabled: !t?.url },
        { label: t?.splitWith ? 'Close split view' : 'Split view', icon: 'fa-table-columns', click: () => $('#btn-split').click() },
        { label: 'Duplicate tab', icon: 'fa-clone', disabled: !t?.url, click: () => t && duplicateTab(t.id) },
        { label: 'Reopen closed tab', icon: 'fa-rotate-left', key: 'Ctrl+Shift+T', disabled: !canReopenTab(), click: () => reopenClosedTab() },
        'sep',
        { label: 'Zoom in', icon: 'fa-magnifying-glass-plus', key: 'Ctrl+=', click: () => zoomBy(0.1) },
        { label: 'Zoom out', icon: 'fa-magnifying-glass-minus', key: 'Ctrl+-', click: () => zoomBy(-0.1) },
        { label: 'Reset zoom', icon: 'fa-expand', key: 'Ctrl+0', click: zoomReset },
        'sep',
        { label: 'Print page…', icon: 'fa-print', key: 'Ctrl+P', disabled: !t?.webview, click: printActive },
        { label: 'Save page as…', icon: 'fa-floppy-disk', key: 'Ctrl+S', disabled: !t?.webview, click: saveActivePage },
        { label: 'Toggle fullscreen', icon: 'fa-up-right-and-down-left-from-center', key: 'F11', click: () => window.pilot?.toggleFullscreen?.() },
        'sep',
        { label: 'Downloads', icon: 'fa-download', key: 'Ctrl+J', click: () => openLibrary('downloads') },
        { label: 'Library', icon: 'fa-layer-group', key: 'Ctrl+H', click: () => openLibrary('history') },
        { label: 'Settings', icon: 'fa-gear', click: () => openLibrary('settings') },
        { label: 'Developer tools', icon: 'fa-code', key: 'F12', click: devTools },
        'sep',
        { label: 'Quit Pilot', icon: 'fa-power-off', key: 'Ctrl+Q', click: () => window.pilot?.close() },
    ]);
}

// ---------------------------------------------------------------------------
// Webview context menu (right-click inside pages)
// ---------------------------------------------------------------------------
export function webviewContextMenu({ tab, params }) {
    const wv = tab.webview;
    if (!wv) return;
    const items = [];
    if (params.linkURL) {
        items.push(
            { label: 'Open link in new tab', icon: 'fa-plus', click: () => createTab({ url: params.linkURL, spaceId: tab.spaceId }) },
            { label: 'Open link in split', icon: 'fa-table-columns', click: () => splitActiveWith(createTab({ url: params.linkURL, activate: false, spaceId: tab.spaceId }).id) },
            { label: 'Copy link', icon: 'fa-link', click: () => { clip.write(params.linkURL); toast('Link copied', 'fa-link'); } },
            'sep',
        );
    }
    if (params.mediaType === 'image' && params.srcURL) {
        items.push(
            { label: 'Open image in new tab', icon: 'fa-image', click: () => createTab({ url: params.srcURL, spaceId: tab.spaceId }) },
            { label: 'Copy image address', icon: 'fa-link', click: () => { clip.write(params.srcURL); toast('Image address copied', 'fa-link'); } },
            { label: 'Save image as…', icon: 'fa-floppy-disk', click: () => window.pilot?.downloadUrl?.(params.srcURL) },
            'sep',
        );
    }
    if (params.isEditable || params.editFlags?.canPaste) {
        items.push(
            { label: 'Cut', icon: 'fa-scissors', click: () => wv.cut(), disabled: !params.editFlags?.canCut },
            { label: 'Copy', icon: 'fa-copy', click: () => wv.copy(), disabled: !params.editFlags?.canCopy },
            { label: 'Paste', icon: 'fa-paste', click: () => wv.paste(), disabled: !params.editFlags?.canPaste },
            'sep',
        );
    } else if (params.selectionText) {
        items.push({ label: 'Copy', icon: 'fa-copy', click: () => { clip.write(params.selectionText); toast('Copied', 'fa-copy'); } }, 'sep');
        const q = params.selectionText.trim();
        if (q) items.push({
            label: `Search ${db.settings.searchEngine} for "${q.length > 24 ? q.slice(0, 24) + '…' : q}"`,
            icon: 'fa-magnifying-glass',
            click: () => createTab({ url: (SEARCH_ENGINES[db.settings.searchEngine] || SEARCH_ENGINES.google)(q), spaceId: tab.spaceId }),
        }, 'sep');
    }
    items.push(
        { label: 'Back', icon: 'fa-arrow-left', click: () => wvCall(wv, 'canGoBack') && wvCall(wv, 'goBack'), disabled: !wvCall(wv, 'canGoBack') },
        { label: 'Forward', icon: 'fa-arrow-right', click: () => wvCall(wv, 'canGoForward') && wvCall(wv, 'goForward'), disabled: !wvCall(wv, 'canGoForward') },
        { label: 'Reload', icon: 'fa-rotate-right', click: () => wvCall(wv, 'reload') },
        { label: 'Save page as…', icon: 'fa-floppy-disk', click: saveActivePage },
        { label: 'Copy page URL', icon: 'fa-link', click: () => { clip.write(wvCall(wv, 'getURL')); toast('URL copied', 'fa-link'); } },
        'sep',
        { label: 'View page source', icon: 'fa-code', click: () => createTab({ url: 'view-source:' + wvCall(wv, 'getURL'), spaceId: tab.spaceId }) },
        { label: 'Inspect element', icon: 'fa-bug', click: () => { wvCall(wv, 'openDevTools'); } },
    );
    showContextMenu(params.x ?? 200, params.y ?? 200, items);
}

// ---------------------------------------------------------------------------
// Find bar
// ---------------------------------------------------------------------------
let findOpen = false;
function initFindBar() {
    const input = $('#find-input');
    input.addEventListener('input', () => {
        const v = input.value;
        if (v) findInPage(v); else stopFind();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') findNext(input.value, !e.shiftKey);
        if (e.key === 'Escape') hideFindBar();
    });
    $('#find-next').addEventListener('click', () => findNext(input.value, true));
    $('#find-prev').addEventListener('click', () => findNext(input.value, false));
    $('#find-close').addEventListener('click', hideFindBar);
}
export function toggleFindBar() {
    const t = activeTab();
    if (!t?.webview) return;
    findOpen ? hideFindBar() : showFindBar();
}
export function showFindBar() {
    findOpen = true;
    $('#find-bar').classList.remove('hidden');
    const input = $('#find-input');
    input.focus(); input.select();
    if (input.value) findInPage(input.value);
}
export function hideFindBar() {
    if (!findOpen) return;
    findOpen = false;
    $('#find-bar').classList.add('hidden');
    $('#find-count').textContent = '';
    stopFind();
}

// ---------------------------------------------------------------------------
// Library (history / bookmarks / downloads / settings)
// ---------------------------------------------------------------------------
let libTab = 'history';
function initLibrary() {
    document.querySelectorAll('.lib-tab').forEach(b => {
        b.addEventListener('click', () => openLibrary(b.dataset.lib));
    });
    $('#library-close').addEventListener('click', hideLibrary);
    $('#library-btn')?.addEventListener('click', () => {
        $('#library').classList.contains('hidden') ? openLibrary('history') : hideLibrary();
    });
    $('#settings-btn')?.addEventListener('click', () => openLibrary('settings'));
    $('#library').addEventListener('click', (e) => { if (e.target.id === 'library') hideLibrary(); });
    $('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') hidePaletteExt(); });
}
export function openLibrary(which = 'history') {
    libTab = which;
    document.querySelectorAll('.lib-tab').forEach(b => b.classList.toggle('active', b.dataset.lib === which));
    renderLibraryContent();
    $('#library').classList.remove('hidden');
}
export function hideLibrary() { $('#library').classList.add('hidden'); }

function renderLibraryContent() {
    const el = $('#library-content');
    el.innerHTML = '';
    if (libTab === 'history') renderHistory(el);
    else if (libTab === 'bookmarks') renderBookmarks(el);
    else if (libTab === 'downloads') renderDownloads(el);
    else if (libTab === 'settings') renderSettingsPanel(el);
}

function searchBox(el, placeholder, onInput) {
    const box = document.createElement('div');
    box.className = 'lib-search';
    box.innerHTML = `<i class="fa-solid fa-magnifying-glass"></i><input type="text" placeholder="${placeholder}">`;
    const input = box.querySelector('input');
    input.addEventListener('input', () => onInput(input.value.toLowerCase()));
    el.appendChild(box);
    return input;
}

function renderHistory(el) {
    const rows = [];
    const list = document.createElement('div');
    el.appendChild(list);

    const paint = (filter = '') => {
        list.innerHTML = '';
        const items = db.history.filter(h => !filter || (h.title + ' ' + h.url).toLowerCase().includes(filter));
        if (!items.length) { list.innerHTML = `<div class="lib-empty"><i class="fa-solid fa-clock-rotate-left"></i>No history${filter ? ' matches' : ' yet'}</div>`; return; }
        let lastDay = '';
        for (const h of items.slice(0, 300)) {
            const day = new Date(h.visitedAt).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
            if (day !== lastDay) { lastDay = day; const d = document.createElement('div'); d.className = 'lib-day'; d.textContent = day; list.appendChild(d); }
            list.appendChild(historyRow(h));
        }
    };
    searchBox(el, 'Search history…', paint);
    paint();

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;padding:10px 4px;';
    const btn = document.createElement('button');
    btn.className = 'btn btn-danger';
    btn.textContent = 'Clear all history';
    btn.addEventListener('click', () => { clearHistory(); paint(); toast('History cleared', 'fa-trash'); });
    footer.appendChild(btn);
    el.appendChild(footer);

    function historyRow(h) {
        const r = document.createElement('div');
        r.className = 'lib-row';
        r.innerHTML = `
            <div class="lib-favicon"></div>
            <div class="lib-text"><div class="lib-title"></div><div class="lib-url"></div></div>
            <div class="lib-meta">${new Date(h.visitedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            <button class="icon-btn lib-del" title="Remove"><i class="fa-solid fa-xmark"></i></button>`;
        libFavicon(r.querySelector('.lib-favicon'), h.favicon, h.url);
        r.querySelector('.lib-title').textContent = h.title || h.url;
        r.querySelector('.lib-url').textContent = hostOf(h.url);
        r.addEventListener('click', (e) => {
            if (e.target.closest('.lib-del')) return;
            navigateActive(h.url); hideLibrary();
        });
        r.querySelector('.lib-del').addEventListener('click', () => {
            db.history = db.history.filter(x => x !== h); save(); r.remove();
        });
        rows.push(r);
        return r;
    }
}

function renderBookmarks(el) {
    const list = document.createElement('div');
    el.appendChild(list);
    const paint = (filter = '') => {
        list.innerHTML = '';
        const items = db.bookmarks.filter(b => !filter || (b.title + ' ' + b.url).toLowerCase().includes(filter));
        if (!items.length) { list.innerHTML = `<div class="lib-empty"><i class="fa-solid fa-star"></i>No bookmarks${filter ? ' match' : ' yet'} — press Ctrl+D on a page</div>`; return; }
        for (const b of items) {
            const r = document.createElement('div');
            r.className = 'lib-row';
            r.innerHTML = `
                <div class="lib-favicon"></div>
                <div class="lib-text"><div class="lib-title"></div><div class="lib-url"></div></div>
                <div class="lib-meta">${new Date(b.addedAt).toLocaleDateString()}</div>
                <button class="icon-btn lib-del" title="Remove bookmark"><i class="fa-solid fa-xmark"></i></button>`;
            libFavicon(r.querySelector('.lib-favicon'), b.favicon, b.url);
            r.querySelector('.lib-title').textContent = b.title || b.url;
            r.querySelector('.lib-url').textContent = b.url;
            r.addEventListener('click', (e) => {
                if (e.target.closest('.lib-del')) return;
                navigateActive(b.url); hideLibrary();
            });
            r.querySelector('.lib-del').addEventListener('click', () => { removeBookmark(b.id); r.remove(); updateBookmarkBtn(); });
            list.appendChild(r);
        }
    };
    searchBox(el, 'Search bookmarks…', paint);
    paint();
}

// downloads are kept in-memory by the main process; mirror the latest list here
const downloadCache = new Map();
function initDownloads() {
    if (window.pilot?.onDownloadUpdate) {
        window.pilot.onDownloadUpdate((d) => {
            downloadCache.set(d.id, d);
            if (d.state === 'completed') toast(`Downloaded ${d.name}`, 'fa-download');
            if (libTab === 'downloads' && !$('#library').classList.contains('hidden')) renderLibraryContent();
        });
        window.pilot.listDownloads?.().then(list => (list || []).forEach(d => downloadCache.set(d.id, d)));
    }
}

function renderDownloads(el) {
    const list = document.createElement('div');
    el.appendChild(list);
    const items = [...downloadCache.values()].sort((a, b) => b.id.localeCompare(a.id));
    if (!items.length) {
        list.innerHTML = `<div class="lib-empty"><i class="fa-solid fa-download"></i>No downloads yet</div>`;
        return;
    }
    for (const d of items) {
        const pct = d.total ? Math.round(100 * d.received / d.total) : null;
        const r = document.createElement('div');
        r.className = 'lib-row';
        r.innerHTML = `
            <div class="lib-favicon"><i class="fa-solid ${d.state === 'completed' ? 'fa-check' : d.state === 'progressing' ? 'fa-arrow-down' : 'fa-triangle-exclamation'}"></i></div>
            <div class="lib-text"><div class="lib-title"></div><div class="lib-url"></div></div>
            <div class="lib-meta">${d.state}${pct != null ? ' · ' + pct + '%' : ''}</div>`;
        r.querySelector('.lib-title').textContent = d.name;
        r.querySelector('.lib-url').textContent = d.path;
        r.addEventListener('click', () => window.pilot?.showItemInFolder?.(d.path));
        list.appendChild(r);
    }
}

function toggleBookmarkAction(tab) {
    return toggleBookmark(tab);
}

// palette bridge (palette.js registers its closer here)
let _hidePalette = () => {};
export function registerPaletteCloser(fn) { _hidePalette = fn; }
function hidePaletteExt() { _hidePalette(); }

function libFavicon(el, favicon, url) {
    if (favicon) {
        const img = document.createElement('img');
        img.src = favicon;
        img.onerror = () => img.remove();
        el.appendChild(img);
    } else {
        el.textContent = hostOf(url)[0].toUpperCase();
    }
}
