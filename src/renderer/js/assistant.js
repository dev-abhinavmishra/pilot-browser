// assistant.js — Pilot AI side panel. Talks to the local FastAPI backend when it's
// running (/api/v1/assistant/ask), otherwise degrades gracefully.
import { db } from './store.js';
import { activeTab, navigateActive } from './tabs.js';
import { toast } from './ui.js';
import { runAgentTask } from './agent.js';

let panel, body, input;
let backendUp = null;
let taskMode = false;
let taskControl = null;   // {cancelled, confirm} while a task is running
let pendingConfirm = null;  // resolve fn while an approve/skip prompt is open

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
    refreshStatus();
}
export function close() {
    panel.classList.add('hidden');
    document.getElementById('assistant-toggle').classList.remove('active');
}
export function isOpen() { return !panel.classList.contains('hidden'); }

// Status pill: shows which planner is actually answering (LLM vs built-in rules)
// so the UI is honest about when the model is offline.
async function refreshStatus() {
    const el = document.getElementById('assistant-status');
    if (!el) return;
    const base = (db.settings.backendUrl || 'http://localhost:8000').replace(/\/$/, '');
    try {
        const res = await fetch(`${base}/api/v1/assistant/status`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error('status ' + res.status);
        const s = await res.json();
        backendUp = true;
        if (s.llm_available === true) {
            el.textContent = `AI: ${s.model || 'local model'}`;
            el.className = 'ai-status on';
        } else if (s.llm_configured === false) {
            el.textContent = 'AI: built-in rules';
            el.className = 'ai-status off';
        } else if (s.llm_available === false) {
            el.textContent = 'AI: rules (model offline)';
            el.className = 'ai-status off';
        } else {
            el.textContent = 'AI: checking…';
            el.className = 'ai-status';
        }
    } catch {
        backendUp = false;
        el.textContent = 'AI: backend offline';
        el.className = 'ai-status off';
    }
}

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
    el.className = 'agent-line' + (entry.ok === false ? ' bad' : entry.ok === null ? ' skip' : '');
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

// Approve/skip/stop prompt for a consequential agent action. Resolves
// true = run it, false = skip this step, 'stop' = cancel the task.
function askConfirm(confirmText) {
    return new Promise((resolve) => {
        body.querySelectorAll('.agent-line.thinking').forEach(n => n.remove());
        pendingConfirm = resolve;
        const el = document.createElement('div');
        el.className = 'agent-line confirm';
        const lab = document.createElement('span');
        lab.className = 'agent-res';
        lab.textContent = `Approve? Pilot wants to ${confirmText}.`;
        const btns = document.createElement('div');
        btns.className = 'agent-confirm-btns';
        const mk = (txt, cls, val) => {
            const b = document.createElement('button');
            b.className = 'cf-btn ' + cls;
            b.textContent = txt;
            b.addEventListener('click', () => {
                el.remove();
                pendingConfirm = null;
                resolve(val);
            });
            return b;
        };
        btns.append(mk('Allow', 'ok', true), mk('Skip', 'skip', false), mk('Stop', 'stop', 'stop'));
        el.append(lab, btns);
        body.appendChild(el);
        body.scrollTop = body.scrollHeight;
    });
}

async function runTask(q) {
    bubble(q, 'user');
    taskControl = { cancelled: false, confirm: askConfirm };
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
        body.querySelectorAll('.agent-line.thinking, .agent-line.confirm').forEach(n => n.remove());
        pendingConfirm = null;
        taskControl = null;
        setRunning(false);
        refreshStatus();
    }
}

async function send() {
    if (taskControl) {
        taskControl.cancelled = true;
        if (pendingConfirm) {   // an approve prompt is waiting — resolve it as 'stop'
            const p = pendingConfirm;
            pendingConfirm = null;
            body.querySelectorAll('.agent-line.confirm').forEach(n => n.remove());
            p('stop');
        }
        return;   // running: button is a stop button
    }
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
        renderAskError(err, q);
    }
    refreshStatus();
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
    } catch (err) {
        t.remove();
        renderAskError(err, q);
    }
    refreshStatus();
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
    if (res.status === 429) { const e = new Error('rate limited'); e.code = 'rate_limited'; throw e; }
    if (!res.ok) throw new Error('backend ' + res.status);
    backendUp = true;
    return res.json();
}

function renderAskError(err, q) {
    if (err && err.code === 'rate_limited') {
        renderAnswer({ answer: 'Pilot is rate-limiting requests — wait a few seconds and try again.', sources: [] });
        return;
    }
    // a slow model hitting the fetch timeout is NOT the backend being offline
    if (err && (/abort|timed?\s?out/i.test(err.name || '') || /abort|timed?\s?out/i.test(err.message || ''))) {
        renderAnswer({ answer: 'The model took too long to respond — try again in a few seconds (it may still be warming up).', sources: [] });
        return;
    }
    backendUp = false;
    renderAnswer(fallbackAnswer(q));
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
    } catch (err) {
        t.remove();
        renderAskError(err, 'summarize this page');
    }
    refreshStatus();
}

function fallbackAnswer(q) {
    return {
        answer: `Pilot's AI backend is offline, so I can't run agents right now.\n\nQuick options:\n• Start it:  cd backend && uvicorn main:app\n• Or search the web — press Ctrl+K and type your question.\n\nYou asked: "${q}"`,
        sources: [],
    };
}
