// agent.js — in-browser agent loop. Observes the live tab, asks the backend for the
// next action (POST /api/v1/assistant/agent-step), executes it in the webview, repeats.
import { db } from './store.js';
import { activeTab, navigateActive } from './tabs.js';

const MAX_STEPS = 12;
const NAV_TIMEOUT_MS = 15000;
const JS_TIMEOUT_MS = 8000;
const STEP_LIMIT_HINT = 'reached the step limit';

// Selector set shared by snapshot + element actions — element ids are indexes into
// the SAME ordered query, so the backend's ids always resolve to the same node.
const ELEMENT_QUERY = 'a[href],button,input,select,textarea,[role="button"],[role="link"],summary';

const SNAPSHOT_JS = `(() => {
  const els = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(${JSON.stringify(ELEMENT_QUERY)})) {
    if (els.length >= 40) break;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight * 2) continue;
    if (seen.has(el)) continue;
    seen.add(el);
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || el.title || '').trim().slice(0, 80);
    els.push({
      id: els.length, tag: el.tagName.toLowerCase(), text: label,
      href: el.href || null, type: el.type || null, placeholder: el.placeholder || null,
    });
  }
  return {
    url: location.href, title: document.title,
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 2500),
    elements: els,
  };
})()`;

// Click the element whose snapshot id is idx (same query order as SNAPSHOT_JS).
const CLICK_JS = (idx) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(ELEMENT_QUERY)})]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width && r.height && r.bottom >= 0 && r.top <= innerHeight * 2; });
  const el = els[${idx}];
  if (!el) return 'element not found';
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.click();
  return 'clicked ' + (el.innerText || el.href || el.tagName).toString().trim().slice(0, 80);
})()`;

const TYPE_JS = (idx, text, submit) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(ELEMENT_QUERY)})]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width && r.height && r.bottom >= 0 && r.top <= innerHeight * 2; });
  const el = els[${idx}];
  if (!el) return 'element not found';
  el.focus();
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
  if (setter && setter.set) setter.set.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  ${submit ? `
  const form = el.form;
  if (form && form.requestSubmit) form.requestSubmit();
  else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));` : ''}
  return 'typed ' + ${JSON.stringify(JSON.stringify(text))}.slice(0, 60) + ' into ' + (el.placeholder || el.name || el.tagName);
})()`;

const SCROLL_JS = (dir) => `(() => { scrollBy(0, ${dir === 'up' ? '-600' : '600'}); return 'scrolled ${dir}'; })()`;

// executeJavaScript can wedge forever on a hung guest — race it so the loop stays live
function execJs(wv, code) {
    return Promise.race([
        wv.executeJavaScript(code, true),
        new Promise((res) => setTimeout(() => res('__pilot_timeout__'), JS_TIMEOUT_MS)),
    ]);
}

// Poll isLoading instead of listening for did-finish-load: works for loadURL() AND
// for the start-tab bootstrap where the webview is created mid-wait.
function waitForLoad(wv) {
    return new Promise((resolve) => {
        const start = Date.now();
        const iv = setInterval(() => {
            let loading;
            try { loading = wv.isLoading(); } catch {
                // throws before dom-ready / after destroy — treat early throws as still loading
                if (Date.now() - start > 8000) { clearInterval(iv); resolve({ ok: false, note: 'page view unavailable' }); }
                return;
            }
            if (!loading) { clearInterval(iv); resolve({ ok: true, note: 'loaded' }); }
            else if (Date.now() - start > NAV_TIMEOUT_MS) { clearInterval(iv); resolve({ ok: false, note: 'load timeout' }); }
        }, 250);
    });
}

function waitForPossibleNav(wv, ms = 2500) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
        const cleanup = () => {
            wv.removeEventListener('did-navigate', onNav);
            clearTimeout(timer);
        };
        const onNav = () => { cleanup(); setTimeout(resolve, 600); };
        wv.addEventListener('did-navigate', onNav);
    });
}

async function snapshot(wv) {
    const snap = await execJs(wv, SNAPSHOT_JS);
    if (snap === '__pilot_timeout__') return null;   // guest wedged — caller retries/fails
    return snap || { url: wv.getURL(), title: '', text: '', elements: [] };
}

async function execAction(tab, action, arg) {
    let wv = tab.webview;
    // bootstrap: start tabs have no webview — navigate/search can spawn one
    if (!wv) {
        if (action !== 'navigate' && action !== 'search') {
            return { ok: false, result: 'no page loaded — the tab is still on the start screen' };
        }
        const url = action === 'navigate'
            ? String(arg.url || '')
            : 'https://duckduckgo.com/?q=' + encodeURIComponent(String(arg.query || ''));
        if (!/^https?:\/\//i.test(url)) return { ok: false, result: 'refused: only http(s) navigation is allowed' };
        try { navigateActive(url); } catch (e) { return { ok: false, result: 'could not open a page view: ' + e.message }; }
        wv = tab.webview;
        if (!wv) return { ok: false, result: 'could not open a page view' };
        const r = await waitForLoad(wv);
        return { ok: r.ok, result: r.ok ? `navigated to ${wv.getURL() || url}` : `navigation failed: ${r.note}` };
    }
    switch (action) {
        case 'navigate': {
            const url = String(arg.url || '');
            if (!/^https?:\/\//i.test(url)) return { ok: false, result: 'refused: only http(s) navigation is allowed' };
            try { wv.loadURL(url); } catch (e) { return { ok: false, result: 'navigation failed: ' + e.message }; }
            const r = await waitForLoad(wv);
            return { ok: r.ok, result: r.ok ? `navigated to ${wv.getURL() || url}` : `navigation failed: ${r.note}` };
        }
        case 'search': {
            const q = String(arg.query || '');
            const url = 'https://duckduckgo.com/?q=' + encodeURIComponent(q);
            try { wv.loadURL(url); } catch (e) { return { ok: false, result: 'navigation failed: ' + e.message }; }
            const r = await waitForLoad(wv);
            return { ok: r.ok, result: r.ok ? `searched for "${q}"` : `search navigation failed: ${r.note}` };
        }
        case 'click': {
            const res = await execJs(wv, CLICK_JS(arg.id));
            await waitForPossibleNav(wv);
            if (res === '__pilot_timeout__') return { ok: false, result: 'page unresponsive (script timeout)' };
            return { ok: typeof res === 'string' && !res.startsWith('element not found'), result: String(res || 'clicked') };
        }
        case 'type': {
            const res = await execJs(wv, TYPE_JS(arg.id, String(arg.text || ''), !!arg.submit));
            if (arg.submit) await waitForPossibleNav(wv);
            if (res === '__pilot_timeout__') return { ok: false, result: 'page unresponsive (script timeout)' };
            return { ok: typeof res === 'string' && !res.startsWith('element not found'), result: String(res || 'typed') };
        }
        case 'press_enter': {
            const res = await execJs(wv, `(() => {
                const el = document.activeElement;
                if (el && el.form && el.form.requestSubmit) { el.form.requestSubmit(); return 'submitted form'; }
                if (el) { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'pressed Enter'; }
                return 'no focused element';
            })()`);
            await waitForPossibleNav(wv);
            if (res === '__pilot_timeout__') return { ok: false, result: 'page unresponsive (script timeout)' };
            return { ok: true, result: String(res || 'pressed Enter') };
        }
        case 'scroll': {
            const res = await execJs(wv, SCROLL_JS(arg.direction));
            if (res === '__pilot_timeout__') return { ok: false, result: 'page unresponsive (script timeout)' };
            return { ok: true, result: String(res || 'scrolled') };
        }
        case 'extract': {
            const snap = await snapshot(wv);
            if (!snap) return { ok: false, result: 'page unresponsive (script timeout)' };
            return { ok: true, result: (snap.text || '').slice(0, 2000) || 'page had no readable text' };
        }
        default:
            return { ok: false, result: `unknown action: ${action}` };
    }
}

async function nextStep(goal, snap, history) {
    const base = (db.settings.backendUrl || 'http://localhost:8000').replace(/\/$/, '');
    const res = await fetch(`${base}/api/v1/assistant/agent-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal, snapshot: snap, history }),
        signal: AbortSignal.timeout(90000),   // local models on CPU can take ~60s/step
    });
    if (!res.ok) throw new Error('backend ' + res.status);
    return res.json();
}

// Runs a task to completion. onStep(entry) is called after every executed action with
// {step, thought, action, arg, result, ok}; returns {status:'done'|'failed'|'cancelled'|'stopped', report}.
export async function runAgentTask(goal, onStep = () => {}, control = { cancelled: false }) {
    const tab = activeTab();
    if (!tab) return { status: 'failed', report: 'No tab is open — create a tab first.' };

    const history = [];
    let deadSnaps = 0;
    for (let step = 1; step <= MAX_STEPS; step++) {
        if (control.cancelled) return { status: 'cancelled', report: 'Task cancelled.' };

        let snap = null;
        if (tab.webview && document.contains(tab.webview)) {
            try { snap = await snapshot(tab.webview); } catch { snap = null; }
        }
        if (snap === null && tab.webview) {
            deadSnaps++;
            if (deadSnaps >= 3) return { status: 'failed', report: 'The page stopped responding — aborting the task.' };
        } else deadSnaps = 0;

        let plan;
        try { plan = await nextStep(goal, snap, history); }
        catch (e) {
            const msg = (e.name === 'AbortError' || /timed? ?out|abort/i.test(e.message || ''))
                ? 'the planner took too long to respond (model too slow or backend down)'
                : `backend error: ${e.message}`;
            return { status: 'failed', report: `Stopped — ${msg}.` };
        }

        const action = String(plan.action || 'fail');
        if (action === 'done' || action === 'fail') {
            const report = plan.final_answer || plan.thought || (action === 'done' ? 'Done.' : 'Couldn\'t complete the task.');
            const ok = action === 'done' && !(report || '').includes(STEP_LIMIT_HINT);
            onStep({ step, thought: plan.thought, action, result: report, ok });
            return { status: ok ? 'done' : 'failed', report };
        }

        // consequential actions (clicks, form fills, submits) pause for user approval
        if (plan.confirm && control.confirm) {
            const decision = await control.confirm(String(plan.confirm));
            if (decision === 'stop' || control.cancelled) {
                onStep({ step, thought: plan.thought, action, arg: plan.arg, result: 'stopped by you', ok: null });
                return { status: 'cancelled', report: 'Task cancelled.' };
            }
            if (!decision) {
                history.push({ action, arg: plan.arg, result: 'user declined this action', ok: false });
                onStep({ step, thought: plan.thought, action, arg: plan.arg, result: `skipped — ${plan.confirm}`, ok: null });
                continue;
            }
        }

        let outcome;
        try { outcome = await execAction(tab, action, plan.arg || {}); }
        catch (e) { outcome = { ok: false, result: e.message || 'action failed' }; }

        const entry = { step, thought: plan.thought, action, arg: plan.arg, result: outcome.result, ok: outcome.ok };
        history.push({ action, arg: plan.arg, result: outcome.result.slice(0, 500), ok: outcome.ok });
        onStep(entry);

        if (tab !== activeTab() || (tab.webview && !document.contains(tab.webview))) {
            return { status: 'failed', report: 'The tab the agent was driving was closed or switched.' };
        }
    }
    return { status: 'failed', report: 'Stopped — reached the step limit without finishing the task.' };
}
