// assistant.js — Pilot AI side panel. Talks to the local FastAPI backend when it's
// running (/api/v1/assistant/ask), otherwise degrades gracefully.
import { db } from './store.js';
import { activeTab, navigateActive } from './tabs.js';
import { toast } from './ui.js';
import { runAgentTask } from './agent.js';

let panel, body, input;
let backendUp = null;
let taskMode = false;
let taskControl = null;   // {cancelled} while a task is running

export function initAssistant() {
    panel = document.getElementById('assistant-panel');
    body = document.getElementById('assistant-body');
    input = document.getElementById('assistant-input');

    document.getElementById('assistant-toggle').addEventListener('click', toggle);
    document.getElementById('assistant-close').addEventListener('click', close);
    document.getElementById('assistant-send').addEventListener('click', send);
    document.getElementById('assistant-summarize').addEventListener('click', summarizePage);
    document.getElementById('assistant-task').addEventListener('click', toggleTaskMode);
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

function toggleTaskMode() {
    taskMode = !taskMode;
    document.getElementById('assistant-task').classList.toggle('active', taskMode);
    input.placeholder = taskMode ? 'Describe a task for Pilot to do…' : 'Ask anything…';
    input.focus();
}

function setRunning(running) {
    const btn = document.getElementById('assistant-send');
    btn.classList.toggle('stop', running);
    btn.innerHTML = running ? '<i class="fa-solid fa-stop"></i>' : '<i class="fa-solid fa-paper-plane"></i>';
    input.disabled = running;
}

function thinkingStep() {
    const t = document.createElement('div');
    t.className = 'agent-line thinking';
    t.innerHTML = '<i class="fa-solid fa-ellipsis"></i><span class="agent-res">Pilot is planning the next step…</span>';
    body.appendChild(t);
    body.scrollTop = body.scrollHeight;
}

function logStep(entry) {
    body.querySelectorAll('.agent-line.thinking').forEach(n => n.remove());
    const el = document.createElement('div');
    el.className = 'agent-line' + (entry.ok === false ? ' bad' : '');
    const arg = entry.arg ? Object.entries(entry.arg).map(([k, v]) => `${k}=${v}`).join(' ') : '';
    // everything below is textContent — action/arg values are page-influenced
    const step = document.createElement('span');
    step.className = 'agent-step';
    step.textContent = entry.step;
    const act = document.createElement('span');
    act.className = 'agent-act';
    act.textContent = `${entry.action}${arg ? ' ' + arg : ''}`;
    const res = document.createElement('span');
    res.className = 'agent-res';
    res.textContent = entry.thought ? `${entry.thought} — ${entry.result}` : String(entry.result ?? '');
    el.append(step, act, res);
    body.appendChild(el);
    if (entry.action !== 'done' && entry.action !== 'fail') thinkingStep();
    body.scrollTop = body.scrollHeight;
}

async function runTask(q) {
    bubble(q, 'user');
    taskControl = { cancelled: false };
    setRunning(true);
    const head = document.createElement('div');
    head.className = 'agent-line head';
    head.innerHTML = '<i class="fa-solid fa-rocket"></i> <span>Task started — Pilot is driving this tab.</span>';
    body.appendChild(head);
    thinkingStep();
    body.scrollTop = body.scrollHeight;
    try {
        const res = await runAgentTask(q, logStep, taskControl);
        backendUp = true;
        bubble(res.report, 'ai');
    } catch {
        backendUp = false;
        bubble('The Pilot backend isn\'t running — start it with `cd backend && uvicorn main:app` to run tasks.', 'ai');
    } finally {
        body.querySelectorAll('.agent-line.thinking').forEach(n => n.remove());
        taskControl = null;
        setRunning(false);
    }
}

async function send() {
    if (taskControl) { taskControl.cancelled = true; return; }   // running: button is a stop button
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    if (taskMode) { runTask(q); return; }
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

// entry point for the start-page console's ASK mode
export async function askFromConsole(q) {
    open();
    bubble(q, 'user');
    const t = typing();
    try {
        const page = await currentPageContext();
        const ans = await ask(q, page);
        t.remove();
        renderAnswer(ans);
    } catch {
        t.remove();
        backendUp = false;
        renderAnswer(fallbackAnswer(q));
    }
}

async function currentPageContext() {
    const tab = activeTab();
    if (!tab?.webview || !tab.url) return null;
    try {
        // race a timeout — a hung guest would otherwise wedge the ask forever
        const text = await Promise.race([
            tab.webview.executeJavaScript(
                `(document.body ? document.body.innerText.slice(0, 6000) : '')`, true
            ),
            new Promise((res) => setTimeout(() => res(null), 6000)),
        ]);
        if (text === null) return null;
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
