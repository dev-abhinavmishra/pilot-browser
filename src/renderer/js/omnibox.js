// omnibox.js — toolbar address bar with live suggestions
import { db, hostOf } from './store.js';
import { activeTab, navigateActive, activateTab, getTabs, normalizeInput } from './tabs.js';
import { updateOmniboxUrl, updateBookmarkBtn, updateNavButtons } from './ui.js';

let input, box, items = [], sel = -1;

export function initOmnibox() {
    input = document.getElementById('omni-input');
    box = document.getElementById('omni-suggest');

    input.addEventListener('focus', () => { input.select(); renderSuggestions(input.value); });
    input.addEventListener('click', () => input.select());
    input.addEventListener('input', () => renderSuggestions(input.value));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            const pick = items[sel];
            if (pick) pick.go();
            else navigateActive(input.value);
            closeSuggestions();
            input.blur();
        } else if (e.key === 'Escape') {
            closeSuggestions(); input.blur();
        }
    });
}

function closeSuggestions() { box.classList.remove('open'); items = []; sel = -1; }

function moveSel(d) {
    if (!items.length) return;
    sel = (sel + d + items.length) % items.length;
    box.querySelectorAll('.suggest-item').forEach((el, i) => el.classList.toggle('selected', i === sel));
    input.value = items[sel].raw;
}

function iconFor(url) {
    const fav = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(url))}&sz=32`;
    return fav;
}

function addItem(icon, title, hint, raw, go) {
    return { icon, title, hint, raw, go };
}

function renderSuggestions(query) {
    const q = (query || '').trim().toLowerCase();
    items = []; sel = -1;
    box.innerHTML = '';

    if (!q) { closeSuggestions(); return; }

    const seen = new Set();
    const push = (item) => {
        const key = item.raw;
        if (seen.has(key) || items.length >= 8) return;
        seen.add(key);
        items.push(item);
    };

    // open tabs
    for (const t of getTabs()) {
        if (!t.url) continue;
        if ((t.title || '').toLowerCase().includes(q) || t.url.toLowerCase().includes(q)) {
            push(addItem('', 'Switch to: ' + (t.title || hostOf(t.url)), hostOf(t.url), t.url,
                () => activateTab(t.id)));
        }
    }
    // bookmarks
    for (const b of db.bookmarks) {
        if ((b.title || '').toLowerCase().includes(q) || b.url.toLowerCase().includes(q)) {
            push(addItem(b.favicon || iconFor(b.url), b.title || b.url, 'Bookmark', b.url, () => navigateActive(b.url)));
        }
    }
    // history
    let hCount = 0;
    for (const h of db.history) {
        if (hCount >= 4) break;
        if ((h.title || '').toLowerCase().includes(q) || h.url.toLowerCase().includes(q)) {
            push(addItem(h.favicon || iconFor(h.url), h.title || h.url, hostOf(h.url), h.url, () => navigateActive(h.url)));
            hCount++;
        }
    }
    // direct URL / search fallback first-class rows
    const nav = normalizeInput(q);
    if (nav) {
        if (nav.toLowerCase().startsWith('http')) {
            items.unshift(addItem('', nav, 'Go to address', nav, () => navigateActive(nav)));
        } else {
            items.push(addItem('', `Search ${db.settings.searchEngine} for "${query}"`, 'Search', query, () => navigateActive(query)));
        }
    }

    if (!items.length) { closeSuggestions(); return; }

    items.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'suggest-item' + (i === sel ? ' selected' : '');
        row.innerHTML = `${it.icon ? `<img src="${it.icon}" onerror="this.outerHTML='<i class=\\'fa-solid fa-globe\\'></i>'">` : `<i class="fa-solid ${it.hint === 'Search' ? 'fa-magnifying-glass' : it.hint === 'Bookmark' ? 'fa-star' : it.title.startsWith('Switch') ? 'fa-arrow-right' : 'fa-clock-rotate-left'}"></i>`}
            <span class="s-title"></span><span class="s-hint"></span>`;
        row.querySelector('.s-title').textContent = it.title;
        row.querySelector('.s-hint').textContent = it.hint;
        row.addEventListener('mousedown', (e) => { e.preventDefault(); it.go(); closeSuggestions(); input.blur(); });
        row.addEventListener('mousemove', () => { sel = i; box.querySelectorAll('.suggest-item').forEach((el, j) => el.classList.toggle('selected', j === sel)); });
        box.appendChild(row);
    });
    box.classList.add('open');
}

// called by app.js when tab/nav changes happen elsewhere
export { updateOmniboxUrl, updateBookmarkBtn, updateNavButtons };
