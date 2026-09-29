// tabs.js — tab model + <webview> lifecycle + split view + nav state
import { db, save, uid, addHistory, faviconFor, hostOf } from './store.js';

const listeners = {};
export function on(event, cb) { (listeners[event] ||= []).push(cb); }
function emit(event, payload) { (listeners[event] || []).forEach(cb => { try { cb(payload); } catch (e) { console.error(e); } }); }

// <webview> API methods throw until the element is attached AND dom-ready fired;
// every call site goes through this to stay safe on freshly built guests.
export function wvCall(wv, method, ...args) {
    try { return wv ? wv[method](...args) : undefined; } catch { return undefined; }
}

export const SEARCH_ENGINES = {
    google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    brave: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
    perplexity: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
};

const tabs = new Map(); // id -> tab object
let stageEl = null;
let webviewsEl = null;
let startOverlayEl = null;
let statusBubbleEl = null;

export function getTabs() { return [...tabs.values()]; }
export function getTab(id) { return tabs.get(id); }
export function activeTab() { return tabs.get(db.activeTabId) || null; }
export function tabsInSpace(spaceId = db.activeSpaceId) {
    return getTabs().filter(t => t.spaceId === spaceId && !t.pinned);
}
export function pinnedInSpace(spaceId = db.activeSpaceId) {
    return getTabs().filter(t => t.spaceId === spaceId && t.pinned);
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------
const URLISH = /^(https?:\/\/|about:|file:|localhost(:\d+)?(\/|$)|\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)|[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$)/;

export function normalizeInput(input) {
    const v = (input || '').trim();
    if (!v) return null;
    // only navigable schemes — file:/data:/javascript: never reach a guest
    if (/^https?:\/\//i.test(v)) return v;
    if (URLISH.test(v) && !v.includes(' ')) {
        // prefer URL form; localhost/IP/path-looking values count as URLs
        if (/\s/.test(v)) return searchUrl(v);
        return 'https://' + v;
    }
    return searchUrl(v);
}
function searchUrl(q) {
    const engine = SEARCH_ENGINES[db.settings.searchEngine] || SEARCH_ENGINES.google;
    return engine(q);
}

// ---------------------------------------------------------------------------
// Webview construction
// ---------------------------------------------------------------------------
function buildWebview(tab) {
    const wv = document.createElement('webview');
    wv.className = 'wv-hidden';
    wv.setAttribute('partition', 'persist:pilot');
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes, nodeIntegration=no, spellcheck=yes');
    wv.src = tab.url;

    wv.addEventListener('did-start-loading', () => {
        tab.loading = true;
        emit('tab-updated', tab);
        if (tab === activeTab()) emit('loading', { loading: true });
    });
    wv.addEventListener('did-stop-loading', () => {
        tab.loading = false;
        emit('tab-updated', tab);
        emit('loading', { loading: false });
    });
    wv.addEventListener('did-navigate', (e) => commitNav(tab, e.url));
    wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) commitNav(tab, e.url); });
    wv.addEventListener('page-title-updated', (e) => {
        tab.title = e.title || hostOf(tab.url);
        emit('tab-updated', tab); persistTabs();
    });
    wv.addEventListener('page-favicon-updated', (e) => {
        const f = e.favicons && e.favicons[0];
        if (f) { tab.favicon = f; emit('tab-updated', tab); persistTabs(); }
    });
    wv.addEventListener('new-window', (e) => {
        // open target=_blank links as real tabs in the same space
        if (e.url && /^https?:/i.test(e.url)) createTab({ url: e.url, spaceId: tab.spaceId, activate: true });
    });
    wv.addEventListener('context-menu', (e) => emit('webview-context-menu', { tab, params: e.params }));
    wv.addEventListener('media-started-playing', () => { tab.playing = true; emit('tab-updated', tab); });
    wv.addEventListener('media-paused', () => { tab.playing = false; emit('tab-updated', tab); });
    wv.addEventListener('update-target-url', (e) => emit('target-url', e.url));
    wv.addEventListener('did-fail-load', (e) => {
        if (e.errorCode === -3 /* aborted */ || e.isMainFrame === false) return;
        renderErrorPage(wv, e);
    });
    wv.addEventListener('found-in-page', (e) => emit('found-in-page', e.result));
    wv.addEventListener('dom-ready', () => {
        if (tab.muted) wvCall(wv, 'setAudioMuted', true); // muted survives session restore
        emit('nav-changed', tab);
    });

    tab.webview = wv;
    return wv;
}

function renderErrorPage(wv, e) {
    const desc = e.errorDescription || 'Network error';
    const url = e.validatedURL || '';
    // retry navigates to the failed URL, not this data: page
    const retry = JSON.stringify(url).replace(/</g, '\\u003c');
    const html = `<!doctype html><meta charset=utf-8><body style="margin:0;font-family:Inter,system-ui;background:#0d0f14;color:#e7eaf2;display:flex;align-items:center;justify-content:center;height:100vh">
      <div style="text-align:center;max-width:420px">
        <div style="font-size:44px;margin-bottom:14px">🛰️</div>
        <h2 style="font-weight:700;margin-bottom:8px">Can't reach this page</h2>
        <p style="color:#9aa3b5;font-size:13px;margin-bottom:4px">${escapeHtml(url)}</p>
        <p style="color:#6b7387;font-size:12px">${escapeHtml(desc)} (${e.errorCode})</p>
        <button id="retry-btn" style="margin-top:18px;padding:9px 22px;border:none;border-radius:999px;background:#7c5cff;color:#fff;font:600 13px Inter,system-ui;cursor:pointer">Try again</button>
      </div><script>document.getElementById('retry-btn').addEventListener('click',()=>{location.href=${retry}})</script></body>`;
    try { wv.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)); } catch { /* noop */ }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function commitNav(tab, url) {
    // data: documents (the in-guest error page) must not clobber the real URL
    if (!url || url === 'about:blank' || /^data:/i.test(url)) return;
    tab.url = url;
    tab.isStart = false;
    addHistory({ url, title: tab.title, favicon: tab.favicon });
    emit('nav-changed', tab);
    emit('tab-updated', tab);
    persistTabs();
}

// ---------------------------------------------------------------------------
// Tab operations
// ---------------------------------------------------------------------------
export function createTab({ url = null, spaceId = db.activeSpaceId, pinned = false, activate = true, index = null } = {}) {
    const tab = {
        id: uid(), spaceId, url, pinned,
        title: url ? hostOf(url) : 'New Tab',
        favicon: url ? faviconFor(url) : '',
        isStart: !url,
        muted: false, loading: false, playing: false,
        splitWith: null, webview: null,
    };
    tabs.set(tab.id, tab);

    if (url) {
        const wv = buildWebview(tab);
        insertWebview(tab, wv, index);
    }
    if (activate) activateTab(tab.id);
    emit('tabs-changed');
    persistTabs();
    return tab;
}

function insertWebview(tab, wv, index) {
    const kids = [...webviewsEl.children];
    if (index == null || index >= kids.length) webviewsEl.appendChild(wv);
    else webviewsEl.insertBefore(wv, kids[index]);
}

export function activateTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    db.activeTabId = id;
    // activating a tab that lives in another space switches the space with it
    if (tab.spaceId !== db.activeSpaceId) {
        db.activeSpaceId = tab.spaceId;
        emit('space-changed', tab.spaceId);
    }

    const splitMate = tab.splitWith ? tabs.get(tab.splitWith) : null;

    // lazy-build webview for restored tabs (before the visibility pass)
    if (tab.url && !tab.webview) {
        const wv = buildWebview(tab);
        insertWebview(tab, wv);
    }
    if (splitMate && splitMate.url && !splitMate.webview) {
        const wv = buildWebview(splitMate);
        insertWebview(splitMate, wv);
    }

    for (const t of tabs.values()) {
        if (!t.webview) continue;
        const visible = t === tab || t === splitMate;
        t.webview.classList.toggle('wv-hidden', !visible);
        if (visible) {
            // ensure it occupies correct pane
            if (t === splitMate) t.webview.classList.add('in-split-right');
            else t.webview.classList.remove('in-split-right');
        }
    }
    webviewsEl.classList.toggle('split', !!splitMate);
    if (splitMate) splitMate.webview.classList.add('in-split-right');
    updateStartOverlay();
    emit('tabs-changed');
    emit('active-changed', tab);
    save();
}

export function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    // dissolve any split
    if (tab.splitWith) {
        const mate = tabs.get(tab.splitWith);
        if (mate) { mate.splitWith = null; mate.webview && mate.webview.classList.remove('in-split-right'); }
        tab.splitWith = null;
    }
    for (const t of tabs.values()) if (t.splitWith === id) t.splitWith = null;

    if (tab.webview) tab.webview.remove();
    tabs.delete(id);

    if (db.activeTabId === id) {
        const candidates = getTabs().filter(t => t.spaceId === db.activeSpaceId);
        const next = candidates[candidates.length - 1];
        db.activeTabId = next ? next.id : null;
        if (next) activateTab(next.id);
        else { createTab({ activate: true }); return; }
    }
    emit('tabs-changed');
    persistTabs();
}

export function navigateActive(input) {
    let tab = activeTab();
    const url = normalizeInput(input);
    if (!url) return;
    if (!tab) { createTab({ url }); return; }
    if (!tab.webview) {
        tab.url = url;
        tab.isStart = false;
        tab.title = hostOf(url);
        const wv = buildWebview(tab);
        insertWebview(tab, wv);
        wv.classList.remove('wv-hidden');
        updateStartOverlay();
        emit('tabs-changed');
    } else {
        tab.webview.src = url;
    }
    commitNavLater(tab);
    function commitNavLater(t) {
        t.url = url; t.isStart = false;
        updateStartOverlay();
        emit('nav-changed', t);
        emit('tab-updated', t);
        persistTabs();
    }
}

export function pinTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    tab.pinned = true;
    emit('tabs-changed'); persistTabs();
}
export function unpinTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    tab.pinned = false;
    emit('tabs-changed'); persistTabs();
}

export function toggleMute(id) {
    const tab = tabs.get(id);
    if (!tab || !tab.webview) return;
    tab.muted = !tab.muted;
    wvCall(tab.webview, 'setAudioMuted', tab.muted);
    emit('tab-updated', tab); persistTabs();
}

export function duplicateTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    createTab({ url: tab.url, spaceId: tab.spaceId, pinned: tab.pinned });
}

export function moveTabToSpace(id, spaceId) {
    const tab = tabs.get(id);
    if (!tab) return;
    tab.spaceId = spaceId;
    if (db.activeSpaceId !== spaceId && db.activeTabId === id) {
        const next = tabsInSpace().filter(t => t !== tab).pop();
        if (next) activateTab(next.id);
        else createTab({ activate: true }); // the vacated space still needs a live tab
    }
    emit('tabs-changed'); persistTabs();
}

export function moveTab(id, beforeId) {
    // reorder; beforeId null appends to end
    const ordered = getTabs();
    const from = ordered.findIndex(t => t.id === id);
    if (from < 0) return;
    const [tab] = ordered.splice(from, 1);
    const to = beforeId == null ? -1 : ordered.findIndex(t => t.id === beforeId);
    if (to < 0) ordered.push(tab); else ordered.splice(to, 0, tab);
    // rebuild map order (Map preserves insertion order)
    for (const t of ordered) { tabs.delete(t.id); tabs.set(t.id, t); }
    emit('tabs-changed'); persistTabs();
}

// ---------------------------------------------------------------------------
// Split view
// ---------------------------------------------------------------------------
export function splitActiveWith(otherId) {
    const tab = activeTab();
    const other = tabs.get(otherId);
    if (!tab || !other || tab === other || !other.url) return false;
    if (tab.splitWith) { // already split — switch right pane
        const old = tabs.get(tab.splitWith);
        if (old) { old.splitWith = null; }
    }
    tab.splitWith = otherId;
    other.splitWith = tab.id;
    if (other.url && !other.webview) { const wv = buildWebview(other); insertWebview(other, wv); }
    activateTab(tab.id);
    persistTabs();
    return true;
}

export function closeSplit(id) {
    const tab = tabs.get(id || db.activeTabId);
    if (!tab || !tab.splitWith) return;
    const mate = tabs.get(tab.splitWith);
    if (mate) { mate.splitWith = null; }
    tab.splitWith = null;
    emit('tabs-changed'); activateTab(tab.id); persistTabs();
}

// ---------------------------------------------------------------------------
// Navigation helpers for toolbar
// ---------------------------------------------------------------------------
export function navBack() { const t = activeTab(); if (wvCall(t?.webview, 'canGoBack')) wvCall(t.webview, 'goBack'); }
export function navForward() { const t = activeTab(); if (wvCall(t?.webview, 'canGoForward')) wvCall(t.webview, 'goForward'); }
export function navReload() {
    const t = activeTab(); if (!t) return;
    if (t.webview) { if (t.loading) wvCall(t.webview, 'stop'); else wvCall(t.webview, 'reload'); }
}
export function cycleTab(dir = 1) {
    const list = [...pinnedInSpace(), ...tabsInSpace()];
    if (!list.length) return;
    const i = list.findIndex(t => t.id === db.activeTabId);
    const next = list[(i + dir + list.length) % list.length];
    activateTab(next.id);
}
export function activateAt(index) {
    const list = [...pinnedInSpace(), ...tabsInSpace()];
    if (index === 'last') return list.length && activateTab(list[list.length - 1].id);
    if (list[index]) activateTab(list[index].id);
}

export function findInPage(text, forward = true) {
    const t = activeTab();
    if (!t || !t.webview || !text) return;
    wvCall(t.webview, 'findInPage', text, { forward, findNext: false });
}
export function findNext(text, forward) {
    const t = activeTab();
    if (!t || !t.webview || !text) return;
    wvCall(t.webview, 'findInPage', text, { forward, findNext: true });
}
export function stopFind() {
    const t = activeTab();
    if (t?.webview) wvCall(t.webview, 'stopFindInPage', 'clearSelection');
}

export function zoomBy(delta) {
    const t = activeTab();
    if (!t?.webview) return;
    const f = wvCall(t.webview, 'getZoomFactor');
    if (typeof f === 'number') wvCall(t.webview, 'setZoomFactor', Math.min(3, Math.max(0.25, f + delta)));
}
export function zoomReset() { const t = activeTab(); if (t?.webview) wvCall(t.webview, 'setZoomFactor', 1); }

export function devTools() { const t = activeTab(); if (t?.webview) wvCall(t.webview, 'openDevTools'); }

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------
export function switchSpace(spaceId) {
    if (!db.spaces.some(s => s.id === spaceId)) return;
    db.activeSpaceId = spaceId;
    const list = [...pinnedInSpace(spaceId), ...tabsInSpace(spaceId)];
    const first = list.find(t => !t.isStart) || list[0];
    if (first) activateTab(first.id);
    else createTab({ spaceId, activate: true });
    document.getElementById('app').style.setProperty('--accent', spaceAccent(spaceId));
    emit('space-changed', spaceId);
    emit('tabs-changed');
    save();
}
export function spaceAccent(spaceId = db.activeSpaceId) {
    return (db.spaces.find(s => s.id === spaceId) || {}).accent || '#7c5cff';
}
export function addSpace(name, icon, accent) {
    const s = { id: uid(), name, icon: icon || 'fa-folder', accent: accent || '#7c5cff' };
    db.spaces.push(s); save();
    emit('space-changed', s.id);
    return s;
}
export function deleteSpace(spaceId) {
    if (db.spaces.length <= 1) return;
    db.spaces = db.spaces.filter(s => s.id !== spaceId);
    for (const t of getTabs().filter(t => t.spaceId === spaceId)) {
        if (t.webview) t.webview.remove();
        tabs.delete(t.id);
    }
    if (db.activeSpaceId === spaceId) switchSpace(db.spaces[0].id);
    persistTabs(); // db.tabs is rebuilt from the map — deleted tabs must not come back
    emit('space-changed', db.activeSpaceId);
}

// ---------------------------------------------------------------------------
// Start overlay
// ---------------------------------------------------------------------------
function updateStartOverlay() {
    const t = activeTab();
    const show = !t || t.isStart;
    startOverlayEl.classList.toggle('hidden', !show);
    if (show) {
        const input = document.getElementById('start-input');
        setTimeout(() => input && input.focus(), 30);
    }
}
export function isStartShowing() {
    const t = activeTab();
    return !t || t.isStart;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
export function persistTabs() {
    db.tabs = getTabs().map(t => ({
        id: t.id, spaceId: t.spaceId, url: t.url, title: t.title,
        favicon: t.favicon, pinned: t.pinned, muted: t.muted,
        isStart: t.isStart, splitWith: t.splitWith,
    }));
    save();
}

export function restoreSession() {
    const saved = db.tabs || [];
    if (db.settings.restoreSession && saved.length) {
        for (const s of saved) {
            const tab = { ...s, loading: false, playing: false, webview: null };
            tabs.set(tab.id, tab);
        }
        // don't auto-create webviews — they materialize lazily on activate
        const active = tabs.get(db.activeTabId) || [...tabs.values()].find(t => t.spaceId === db.activeSpaceId) || [...tabs.values()][0];
        db.activeTabId = active ? active.id : null;
        if (active) activateTab(active.id);
        emit('tabs-changed');
        return;
    }
    if (!tabs.size) createTab({ activate: true });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
export function initTabs() {
    stageEl = document.getElementById('stage');
    webviewsEl = document.getElementById('webviews');
    startOverlayEl = document.getElementById('start-overlay');
    statusBubbleEl = document.getElementById('status-bubble');

    on('target-url', (url) => {
        if (!url) { statusBubbleEl.classList.add('hidden'); return; }
        statusBubbleEl.textContent = url;
        statusBubbleEl.classList.remove('hidden');
    });

    // new window requests from shell (window.open in shell code)
    if (window.pilot?.onOpenUrlInTab) {
        window.pilot.onOpenUrlInTab((url) => createTab({ url }));
    }
}
