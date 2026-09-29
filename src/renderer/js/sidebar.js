// sidebar.js — space switcher, pinned grid, tab list rendering + interactions
import { db, save, hostOf } from './store.js';
import {
    on, getTabs, activeTab, tabsInSpace, pinnedInSpace,
    activateTab, closeTab, pinTab, unpinTab, toggleMute, duplicateTab,
    moveTab, moveTabToSpace, switchSpace, addSpace, deleteSpace,
    splitActiveWith, createTab, wvCall,
} from './tabs.js';
import { showContextMenu, toast } from './ui.js';

let listEl, pinnedEl, spacesEl;

export function initSidebar() {
    listEl = document.getElementById('tab-list');
    pinnedEl = document.getElementById('pinned-grid');
    spacesEl = document.getElementById('space-switcher');

    renderSpaces();
    renderTabs();

    on('tabs-changed', renderTabs);
    on('tab-updated', renderTabs);
    on('active-changed', renderTabs);
    on('space-changed', () => { renderSpaces(); renderTabs(); });

    document.getElementById('new-tab-btn').addEventListener('click', () => createTab({ activate: true }));
    document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebarCollapsed);
}

export function toggleSidebarCollapsed() {
    const app = document.getElementById('app');
    const collapsed = app.classList.toggle('sidebar-collapsed');
    db.settings.sidebarCollapsed = collapsed;
    save();
}
export function applySidebarSetting() {
    document.getElementById('app').classList.toggle('sidebar-collapsed', !!db.settings.sidebarCollapsed);
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------
function renderSpaces() {
    spacesEl.innerHTML = '';
    for (const s of db.spaces) {
        const b = document.createElement('button');
        b.className = 'space-pill' + (s.id === db.activeSpaceId ? ' active' : '');
        b.title = s.name;
        b.innerHTML = `<i class="fa-solid ${s.icon}"></i>`;
        b.addEventListener('click', () => switchSpace(s.id));
        b.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showContextMenu(e.clientX, e.clientY, [
                { label: `Switch to ${s.name}`, icon: 'fa-arrow-right', click: () => switchSpace(s.id) },
                { label: 'Rename…', icon: 'fa-pen', click: () => renameSpace(s) },
                { label: 'Delete space', icon: 'fa-trash', danger: true, click: () => deleteSpace(s.id), disabled: db.spaces.length <= 1 },
                'sep',
                { label: 'New space…', icon: 'fa-plus', click: promptNewSpace },
            ]);
        });
        spacesEl.appendChild(b);
    }
    const add = document.createElement('button');
    add.className = 'space-pill';
    add.title = 'New space';
    add.innerHTML = '<i class="fa-solid fa-plus"></i>';
    add.addEventListener('click', promptNewSpace);
    spacesEl.appendChild(add);
}

const SPACE_ICONS = ['fa-user', 'fa-briefcase', 'fa-compass', 'fa-rocket', 'fa-flask', 'fa-gamepad', 'fa-book', 'fa-code'];
const SPACE_ACCENTS = ['#7c5cff', '#2dd4bf', '#f59e0b', '#f472b6', '#38bdf8', '#a3e635'];

function promptNewSpace() {
    const name = prompt('Space name:', 'New Space');
    if (!name) return;
    const i = db.spaces.length % SPACE_ICONS.length;
    const s = addSpace(name, SPACE_ICONS[i], SPACE_ACCENTS[db.spaces.length % SPACE_ACCENTS.length]);
    switchSpace(s.id);
}
function renameSpace(s) {
    const name = prompt('Space name:', s.name);
    if (!name) return;
    s.name = name; save(); renderSpaces();
}

// ---------------------------------------------------------------------------
// Tab list
// ---------------------------------------------------------------------------
function faviconHtml(tab) {
    if (tab.loading) return '<span class="tab-spin"></span>';
    if (tab.favicon && /^https?:|^data:/.test(tab.favicon)) return `<img src="${escapeAttr(tab.favicon)}" alt="" onerror="this.remove()">`;
    return `<span>${(hostOf(tab.url || '') || 'N')[0].toUpperCase()}</span>`;
}

function renderTabs() {
    // pinned grid
    const pinned = pinnedInSpace();
    document.getElementById('pinned-label').style.display = pinned.length ? '' : 'none';
    pinnedEl.innerHTML = '';
    for (const t of pinned) {
        const b = document.createElement('button');
        b.className = 'pin-btn' + (t.id === db.activeTabId ? ' active' : '') + (t.playing ? ' playing' : '');
        b.title = t.title || hostOf(t.url);
        b.innerHTML = `${faviconHtml(t)}<span class="pin-badge"><i class="fa-solid fa-volume-high"></i></span>`;
        b.addEventListener('click', () => activateTab(t.id));
        b.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(e, t); });
        pinnedEl.appendChild(b);
    }

    // regular tab list
    listEl.innerHTML = '';
    for (const t of tabsInSpace()) {
        const row = document.createElement('div');
        row.className = 'tab-item' + (t.id === db.activeTabId ? ' active' : '');
        row.dataset.tabId = t.id;
        row.draggable = true;

        const fav = document.createElement('div');
        fav.className = 'tab-favicon';
        fav.innerHTML = faviconHtml(t);

        const title = document.createElement('div');
        title.className = 'tab-title';
        title.textContent = t.title || (t.url ? hostOf(t.url) : 'New Tab');

        const actions = document.createElement('div');
        actions.className = 'tab-actions';
        if (t.playing) {
            const au = document.createElement('button');
            au.className = 'tab-action tab-audio' + (t.muted ? ' muted' : '');
            au.title = t.muted ? 'Unmute' : 'Mute';
            au.innerHTML = `<i class="fa-solid ${t.muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>`;
            au.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(t.id); });
            actions.appendChild(au);
        }
        if (t.splitWith) {
            const sp = document.createElement('span');
            sp.className = 'tab-action';
            sp.title = 'In split view';
            sp.innerHTML = '<i class="fa-solid fa-table-columns"></i>';
            actions.appendChild(sp);
        }
        const close = document.createElement('button');
        close.className = 'tab-action';
        close.title = 'Close tab';
        close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
        actions.appendChild(close);

        row.append(fav, title, actions);
        row.addEventListener('click', () => activateTab(t.id));
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(e, t); });
        row.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t.id); });

        // drag to reorder
        row.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/pilot-tab', t.id);
            e.dataTransfer.effectAllowed = 'move';
            row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('dragging');
            listEl.querySelectorAll('.drop-above,.drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
        });
        row.addEventListener('dragover', (e) => {
            e.preventDefault();
            const rect = row.getBoundingClientRect();
            const above = e.clientY < rect.top + rect.height / 2;
            row.classList.toggle('drop-above', above);
            row.classList.toggle('drop-below', !above);
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            const dragId = e.dataTransfer.getData('text/pilot-tab');
            if (!dragId || dragId === t.id) return;
            const rect = row.getBoundingClientRect();
            const above = e.clientY < rect.top + rect.height / 2;
            moveTab(dragId, above ? t.id : nextTabIdAfter(t.id));
            row.classList.remove('drop-above', 'drop-below');
        });

        listEl.appendChild(row);
    }
}

function nextTabIdAfter(id) {
    const list = tabsInSpace();
    const i = list.findIndex(t => t.id === id);
    return list[i + 1] ? list[i + 1].id : null; // null -> moveTab appends? we handle
}

function tabMenu(e, tab) {
    const items = [
        { label: tab.pinned ? 'Unpin tab' : 'Pin tab', icon: 'fa-thumbtack', click: () => tab.pinned ? unpinTab(tab.id) : pinTab(tab.id) },
        { label: 'Duplicate tab', icon: 'fa-clone', click: () => duplicateTab(tab.id) },
        { label: tab.muted ? 'Unmute tab' : 'Mute tab', icon: tab.muted ? 'fa-volume-high' : 'fa-volume-xmark', click: () => toggleMute(tab.id) },
        'sep',
        { label: 'Split right with…', icon: 'fa-table-columns', submenu: getTabs().filter(t => t.spaceId === tab.spaceId && t.id !== tab.id && t.url).map(t => ({
            label: t.title || hostOf(t.url), icon: 'fa-window-maximize',
            click: () => { activateTab(tab.id); splitActiveWith(t.id); },
        })) },
        { label: 'Move to space', icon: 'fa-arrow-right-to-bracket', submenu: db.spaces.filter(s => s.id !== tab.spaceId).map(s => ({
            label: s.name, icon: s.icon, click: () => moveTabToSpace(tab.id, s.id),
        })) },
        'sep',
        { label: 'Reload', icon: 'fa-rotate-right', click: () => { activateTab(tab.id); tab.webview && wvCall(tab.webview, 'reload'); } },
        { label: 'Close tab', icon: 'fa-xmark', click: () => closeTab(tab.id), key: 'Ctrl+W' },
        { label: 'Close other tabs', icon: 'fa-xmarks-lines', click: () => closeOthers(tab) },
    ];
    showContextMenu(e.clientX, e.clientY, items);
}

function closeOthers(keep) {
    for (const t of tabsInSpace()) {
        if (t.id !== keep.id) closeTab(t.id);
    }
}

function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
