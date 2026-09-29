// settings.js — settings tab rendered inside the Library overlay
import { db, save } from './store.js';
import { applyTheme } from './app.js';
import { toast } from './ui.js';

const ENGINES = [
    ['google', 'Google'], ['bing', 'Bing'], ['duckduckgo', 'DuckDuckGo'],
    ['brave', 'Brave'], ['perplexity', 'Perplexity'],
];

export function renderSettingsPanel(el) {
    const s = db.settings;
    el.innerHTML = '';

    const sec = (title) => {
        const d = document.createElement('div');
        d.className = 'set-section';
        d.innerHTML = `<h4>${title}</h4>`;
        el.appendChild(d);
        return d;
    };
    const row = (parent, label, desc, control) => {
        const r = document.createElement('div');
        r.className = 'set-row';
        const l = document.createElement('div');
        l.innerHTML = `<label></label>${desc ? `<div class="set-desc">${desc}</div>` : ''}`;
        l.querySelector('label').textContent = label;
        r.appendChild(l);
        r.appendChild(control);
        parent.appendChild(r);
        return r;
    };
    const select = (value, options, onchange) => {
        const sel = document.createElement('select');
        for (const [v, label] of options) {
            const o = document.createElement('option');
            o.value = v; o.textContent = label; sel.appendChild(o);
        }
        sel.value = value;
        sel.addEventListener('change', () => onchange(sel.value));
        return sel;
    };
    const toggle = (checked, onchange) => {
        const w = document.createElement('span');
        w.className = 'switch';
        w.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''}><span class="track"></span>`;
        w.querySelector('input').addEventListener('change', (e) => onchange(e.target.checked));
        return w;
    };
    const seg = (value, options, onchange) => {
        const w = document.createElement('div');
        w.className = 'seg';
        for (const [v, label] of options) {
            const b = document.createElement('button');
            b.textContent = label;
            b.className = v === value ? 'active' : '';
            b.addEventListener('click', () => {
                w.querySelectorAll('button').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                onchange(v);
            });
            w.appendChild(b);
        }
        return w;
    };

    // --- appearance
    const app = sec('Appearance');
    row(app, 'Theme', null, seg(s.theme, [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']], (v) => {
        s.theme = v; save(); applyTheme();
    }));
    row(app, 'Collapse sidebar by default', 'Hide the sidebar for a distraction-free window', toggle(s.sidebarCollapsed, (v) => {
        s.sidebarCollapsed = v; save();
        document.getElementById('app').classList.toggle('sidebar-collapsed', v);
    }));
    row(app, 'Dark web pages', 'Render sites that support dark mode in dark colors', toggle(!!s.darkPages, (v) => {
        s.darkPages = v; save();
        window.pilot?.setAppTheme?.(v ? 'dark-pages' : 'light');
    }));

    // --- search
    const srch = sec('Search');
    row(srch, 'Default search engine', 'Used for omnibox queries that aren\'t URLs', select(s.searchEngine, ENGINES, (v) => { s.searchEngine = v; save(); }));
    row(srch, 'History retention', null, select(String(s.keepHistoryDays), [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '1 year']], (v) => {
        s.keepHistoryDays = parseInt(v, 10);
        db.history = db.history.filter(h => h.visitedAt > Date.now() - s.keepHistoryDays * 864e5);
        save();
    }));

    // --- session
    const sess = sec('Session');
    row(sess, 'Restore tabs on launch', 'Reopen your spaces and tabs when Pilot starts', toggle(s.restoreSession, (v) => { s.restoreSession = v; save(); }));

    // --- AI
    const ai = sec('Pilot AI backend');
    row(ai, 'Backend URL', 'Optional local backend for the assistant & automation agents', (() => {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.value = s.backendUrl; inp.style.width = '220px';
        inp.addEventListener('change', () => { s.backendUrl = inp.value.trim() || 'http://localhost:8000'; save(); toast('Backend URL saved', 'fa-server'); });
        return inp;
    })());

    // --- data
    const data = sec('Data');
    row(data, 'Clear bookmarks & history', 'Permanently deletes local browsing data', (() => {
        const b = document.createElement('button');
        b.className = 'btn btn-danger';
        b.textContent = 'Clear data';
        b.addEventListener('click', () => {
            if (confirm('Delete all history and bookmarks?')) {
                db.history = []; db.bookmarks = []; save();
                toast('Browsing data cleared', 'fa-trash');
            }
        });
        return b;
    })());

    // --- about
    const about = sec('About');
    const meta = document.createElement('div');
    meta.className = 'set-desc';
    meta.innerHTML = `Pilot ${window.__pilotVersion || ''} — a minimalist AI-powered browser.<br>Electron · Chromium · FastAPI backend`;
    about.appendChild(meta);
}
