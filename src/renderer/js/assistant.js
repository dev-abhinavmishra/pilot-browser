// assistant.js — Pilot AI side panel. Talks to the local FastAPI backend when it's
// running (/api/v1/assistant/ask), otherwise degrades gracefully.
import { db } from './store.js';
import { activeTab, navigateActive } from './tabs.js';
import { toast } from './ui.js';

let panel, body, input;
let backendUp = null;

export function initAssistant() {
    panel = document.getElementById('assistant-panel');
    body = document.getElementById('assistant-body');
    input = document.getElementById('assistant-input');

    document.getElementById('assistant-toggle').addEventListener('click', toggle);
    document.getElementById('assistant-close').addEventListener('click', close);
    document.getElementById('assistant-send').addEventListener('click', send);
    document.getElementById('assistant-summarize').addEventListener('click', summarizePage);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

    emptyState();
}

export function toggle() { panel.classList.contains('hidden') ? open() : close(); }
export function open() {
    panel.classList.remove('hidden');
    document.getElementById('assistant-toggle').classList.add('active');
    setTimeout(() => input.focus(), 60);
    if (!body.children.length) emptyState();
}
export function close() {
    panel.classList.add('hidden');
    document.getElementById('assistant-toggle').classList.remove('active');
}
export function isOpen() { return !panel.classList.contains('hidden'); }

function emptyState() {
    body.innerHTML = `<div class="assistant-empty">
        <i class="fa-solid fa-wand-magic-sparkles"></i>
        <div><b>Pilot AI</b></div>
        <div style="margin-top:6px">Ask questions about the page, or anything else.<br>
        ${backendUp === false ? 'Local backend offline — showing built-in answers.' : 'Powered by your local backend when running.'}</div>
    </div>`;
}

function bubble(text, who = 'ai') {
    const empty = body.querySelector('.assistant-empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = `msg ${who}`;
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
}

function typing() {
    const el = document.createElement('div');
    el.className = 'msg ai typing';
    el.innerHTML = '<span></span><span></span><span></span>';
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
}

async function send() {
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    bubble(q, 'user');
    const t = typing();
    try {
        const page = await currentPageContext();
        const ans = await ask(q, page);
        t.remove();
        renderAnswer(ans);
    } catch (err) {
        t.remove();
        backendUp = false;
        renderAnswer(fallbackAnswer(q));
    }
}

async function currentPageContext() {
    const tab = activeTab();
    if (!tab?.webview || !tab.url) return null;
    try {
        const text = await tab.webview.executeJavaScript(
            `(document.body ? document.body.innerText.slice(0, 6000) : '')`
        );
        return { url: tab.url, title: tab.title, excerpt: text };
    } catch { return null; }
}

async function ask(query, page) {
    const base = (db.settings.backendUrl || 'http://localhost:8000').replace(/\/$/, '');
    const res = await fetch(`${base}/api/v1/assistant/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, page }),
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error('backend ' + res.status);
    backendUp = true;
    return res.json();
}

function renderAnswer(ans) {
    const text = typeof ans === 'string' ? ans : (ans.answer || ans.summary || JSON.stringify(ans));
    const el = bubble('', 'ai');
    el.textContent = text;
    if (ans && ans.sources && ans.sources.length) {
        const src = document.createElement('div');
        src.style.cssText = 'margin-top:8px;display:flex;flex-direction:column;gap:3px;';
        for (const s of ans.sources.slice(0, 4)) {
            const a = document.createElement('a');
            a.href = '#'; a.textContent = s.title || s.url;
            a.style.cssText = 'font-size:11px;';
            a.addEventListener('click', (e) => { e.preventDefault(); navigateToSource(s.url); });
            src.appendChild(a);
        }
        el.appendChild(src);
    }
}

function navigateToSource(url) {
    navigateActive(url);
}

async function summarizePage() {
    const tab = activeTab();
    if (!tab?.webview || !tab.url) { toast('No page loaded to summarize', 'fa-align-left'); return; }
    input.value = '';
    bubble(`Summarize ${tab.title || tab.url}`, 'user');
    const t = typing();
    try {
        const page = await currentPageContext();
        const ans = await ask('Summarize this page in 4-6 bullet points.', page);
        t.remove();
        renderAnswer(ans);
    } catch {
        t.remove();
        backendUp = false;
        bubble('The Pilot backend isn\'t running — start it with `cd backend && uvicorn main:app` to enable AI summaries.', 'ai');
    }
}

function fallbackAnswer(q) {
    return {
        answer: `Pilot's AI backend is offline, so I can't run agents right now.\n\nQuick options:\n• Start it:  cd backend && uvicorn main:app\n• Or search the web — press Ctrl+K and type your question.\n\nYou asked: "${q}"`,
        sources: [],
    };
}
