// store.js — persisted app state (localStorage-backed, debounced writes)

const KEY = 'pilot:v1';
const HISTORY_CAP = 800;
const isElectron = typeof window !== 'undefined' && !!window.pilot;

const DEFAULTS = () => ({
    settings: {
        theme: 'dark',                 // dark | light | system
        searchEngine: 'google',        // google | bing | duckduckgo | brave | perplexity
        restoreSession: true,
        sidebarCollapsed: false,
        startTiles: [
            { name: 'GitHub', url: 'https://github.com' },
            { name: 'YouTube', url: 'https://youtube.com' },
            { name: 'Wikipedia', url: 'https://wikipedia.org' },
            { name: 'Reddit', url: 'https://reddit.com' },
            { name: 'Hacker News', url: 'https://news.ycombinator.com' },
            { name: 'ChatGPT', url: 'https://chat.openai.com' },
        ],
        backendUrl: 'http://localhost:8000',
        keepHistoryDays: 30,
    },
    spaces: [
        { id: 'personal', name: 'Personal', icon: 'fa-user', accent: '#7c5cff' },
        { id: 'work', name: 'Work', icon: 'fa-briefcase', accent: '#2dd4bf' },
        { id: 'explore', name: 'Explore', icon: 'fa-compass', accent: '#f59e0b' },
    ],
    activeSpaceId: 'personal',
    tabs: [],           // {id, spaceId, url, title, favicon, pinned, muted, splitWith}
    activeTabId: null,
    bookmarks: [],      // {id, url, title, favicon, addedAt}
    history: [],        // {url, title, favicon, visitedAt}
});

let state = load();
let saveTimer = null;

function load() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return DEFAULTS();
        const parsed = JSON.parse(raw);
        const base = DEFAULTS();
        return {
            ...base, ...parsed,
            settings: { ...base.settings, ...(parsed.settings || {}) },
            spaces: Array.isArray(parsed.spaces) && parsed.spaces.length ? parsed.spaces : base.spaces,
        };
    } catch {
        return DEFAULTS();
    }
}

export function save(immediate = false) {
    if (saveTimer) clearTimeout(saveTimer);
    const write = () => {
        try { localStorage.setItem(KEY, JSON.stringify(state)); }
        catch (err) { console.warn('pilot: save failed', err); }
    };
    if (immediate) write(); else saveTimer = setTimeout(write, 250);
}

export const db = state;
export { isElectron };

export function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function addHistory({ url, title, favicon }) {
    if (!url || !/^https?:/i.test(url)) return;
    db.history.unshift({ url, title: title || url, favicon: favicon || '', visitedAt: Date.now() });
    const cutoff = Date.now() - db.settings.keepHistoryDays * 864e5;
    db.history = db.history.filter(h => h.visitedAt > cutoff).slice(0, HISTORY_CAP);
    save();
}

export function isBookmarked(url) {
    return db.bookmarks.some(b => b.url === url);
}

export function toggleBookmark(tab) {
    const i = db.bookmarks.findIndex(b => b.url === tab.url);
    if (i >= 0) {
        db.bookmarks.splice(i, 1);
        save();
        return false;
    }
    db.bookmarks.unshift({ id: uid(), url: tab.url, title: tab.title || tab.url, favicon: tab.favicon || '', addedAt: Date.now() });
    save();
    return true;
}

export function removeBookmark(id) {
    db.bookmarks = db.bookmarks.filter(b => b.id !== id && b.url !== id);
    save();
}

export function clearHistory() {
    db.history = [];
    save();
}

export function faviconFor(url) {
    try {
        const u = new URL(url);
        return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
    } catch { return ''; }
}

export function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
