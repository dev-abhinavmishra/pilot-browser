// startpage.js — the console: clock, mechanical command bar, waypoint tiles
import { db, save, faviconFor } from './store.js';
import {
    on, navigateActive, createTab, splitActiveWith,
    activeTab, tabsInSpace, normalizeInput, SEARCH_ENGINES,
} from './tabs.js';
import { openLibrary } from './ui.js';
import { openPalette } from './palette.js';
import { askFromConsole } from './assistant.js';

const ENGINE_CAPS = {
    google: 'GG', bing: 'BIN', duckduckgo: 'DDG', brave: 'BRV', perplexity: 'PPX',
};
const MODE_HINTS = {
    search: 'Where to, captain?',
    ask: 'Ask Pilot AI anything…',
    cmd: 'Type a command — enter to pick',
};

let mode = 'search';
let openIn = 'tab';
let input;

export function initStartPage() {
    tickClock();
    setInterval(tickClock, 5000);
    renderStartTiles();
    initConsole();
}

// ---------------------------------------------------------------------------
// Clock / date
// ---------------------------------------------------------------------------
function tickClock() {
    const now = new Date();
    const clock = document.getElementById('start-clock');
    const date = document.getElementById('start-date');
    if (clock) clock.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/i, '');
    if (date) date.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------
function initConsole() {
    input = document.getElementById('start-input');
    const led = document.getElementById('con-led');

    // mode switch
    document.getElementById('con-modes').querySelectorAll('.con-mode').forEach(b => {
        b.addEventListener('click', () => setMode(b.dataset.mode));
    });
    setMode(mode);

    function setMode(m) {
        mode = m;
        document.getElementById('con-modes').querySelectorAll('.con-mode')
            .forEach(b => b.classList.toggle('active', b.dataset.mode === m));
        led.className = 'con-led' + (m === 'ask' ? ' mode-ask' : m === 'cmd' ? ' mode-cmd' : '');
        input.placeholder = MODE_HINTS[m];
        renderReadout();
    }

    // engine keycaps
    const engines = document.getElementById('con-engines');
    function renderEngines() {
        engines.innerHTML = '';
        for (const key of Object.keys(SEARCH_ENGINES)) {
            const b = document.createElement('button');
            b.textContent = ENGINE_CAPS[key] || key.slice(0, 3).toUpperCase();
            b.title = key;
            b.className = key === db.settings.searchEngine ? 'active' : '';
            b.addEventListener('click', () => {
                db.settings.searchEngine = key;
                save();
                renderEngines();
                renderReadout();
            });
            engines.appendChild(b);
        }
    }
    renderEngines();

    // open-in 3-way switch
    document.getElementById('con-openin').querySelectorAll('.con-sw').forEach(b => {
        b.addEventListener('click', () => {
            openIn = b.dataset.openin;
            document.getElementById('con-openin').querySelectorAll('.con-sw')
                .forEach(x => x.classList.toggle('active', x === b));
            renderReadout();
        });
    });

    // quick chips -> library panels
    document.querySelectorAll('.con-chips [data-lib]').forEach(b => {
        b.addEventListener('click', () => openLibrary(b.dataset.lib));
    });

    // fire on Enter
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { input.blur(); return; }
        if (e.key !== 'Enter') return;
        const q = input.value.trim();
        if (!q) return;
        fire(q);
        input.value = '';
    });

    // status readout — keeps live space/tab/engine state under the console
    function renderReadout() {
        const el = document.getElementById('con-readout');
        if (!el) return;
        const space = db.spaces.find(s => s.id === db.activeSpaceId);
        const tabs = tabsInSpace().length;
        const parts = [
            `MODE ${mode.toUpperCase()}`,
            `SPACE ${space ? space.name.toUpperCase() : '—'}`,
            `${tabs} TAB${tabs === 1 ? '' : 'S'} OPEN`,
        ];
        if (mode === 'search') parts.push(`ENGINE ${db.settings.searchEngine.toUpperCase()}`);
        if (mode === 'search' && openIn !== 'tab') parts.push(`OPEN ${openIn === 'new' ? 'NEW TAB' : 'SPLIT'}`);
        el.textContent = parts.join('  ·  ');
    }
    on('tabs-changed', renderReadout);
    on('space-changed', renderReadout);
    renderReadout();
}

function fire(q) {
    if (mode === 'ask') { askFromConsole(q); return; }
    if (mode === 'cmd') {
        // pre-fill the command deck and let the user pick
        openPalette();
        const pi = document.getElementById('palette-input');
        pi.value = q;
        pi.dispatchEvent(new Event('input'));
        return;
    }
    // search mode — honor the open-in switch
    const url = normalizeInput(q);
    if (!url) return;
    const cur = activeTab();
    if (openIn === 'new') {
        createTab({ url, activate: true });
    } else if (openIn === 'split') {
        const t = createTab({ url, activate: true });
        // split against the most recent sibling that has a page loaded
        const mate = tabsInSpace().filter(x => x.url && x.id !== t.id).pop();
        if (mate) splitActiveWith(mate.id);
    } else {
        navigateActive(url);
    }
}

// ---------------------------------------------------------------------------
// Waypoint tiles
// ---------------------------------------------------------------------------
export function renderStartTiles() {
    const wrap = document.getElementById('start-tiles');
    if (!wrap) return;
    wrap.innerHTML = '';
    for (const tile of db.settings.startTiles || []) {
        const a = document.createElement('a');
        a.className = 'start-tile';
        a.href = '#';
        const img = document.createElement('img');
        img.src = faviconFor(tile.url); img.alt = '';
        img.onerror = () => {
            const l = document.createElement('span');
            l.className = 'tile-letter';
            l.textContent = (tile.name || '?')[0];
            img.replaceWith(l);
        };
        const name = document.createElement('span');
        name.textContent = tile.name;
        a.appendChild(img); a.appendChild(name);
        a.addEventListener('click', (e) => { e.preventDefault(); navigateActive(tile.url); });
        wrap.appendChild(a);
    }
}
