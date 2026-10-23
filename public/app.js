// The board: polls the local server, then renders the "needs you" inbox, the
// user's project groups, a detail drawer and (phase 2) terminal tiles for
// background sessions.
import * as terminals from '/terminals.js';

const POLL_MS = 3000;
const CONTEXT_WINDOW = 1_000_000; // assumes 1M-token context windows

const ATTENTION = {
  blocked: { label: 'Blocked', icon: '!', tone: 'critical', rank: 0 },
  'your-turn': { label: 'Your turn', icon: '↩', tone: 'warning', rank: 1 },
  working: { label: 'Working', icon: '▸', tone: 'good', rank: 2 },
  parked: { label: 'Parked', icon: '–', tone: 'neutral', rank: 3 },
  unknown: { label: 'Unknown', icon: '?', tone: 'neutral', rank: 4 },
};

let data = null; // latest /api/state payload
let lastError = null;
let selected = decodeURIComponent(location.hash.slice(1)) || null; // sessionId shown in the drawer
let view = 'overview'; // or 'workspace': board as a sidebar beside terminal tiles
let dragging = false; // re-rendering mid-drag would cancel the drag
let mutations = 0; // bumped on each local edit so an older poll result can't undo it
let lastBadge = null;

const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function poll() {
  const seq = mutations;
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const next = await res.json();
    if (seq !== mutations && data) next.board = data.board;
    const first = !data;
    data = next;
    lastError = null;
    if (first) restoreTerminals();
  } catch (e) {
    lastError = e.message;
  }
  if (!dragging) render();
  setTimeout(poll, POLL_MS);
}

// ---- derived state ----

// Interactive sessions report `status`; background ones may report only `state`.
const STATE_AS_STATUS = { working: 'busy', blocked: 'waiting', failed: 'waiting', done: 'idle', stopped: 'idle' };

function attention(a) {
  const status = a.status ?? STATE_AS_STATUS[a.state];
  if (status === 'busy') return 'working';
  if (status !== 'waiting' && status !== 'idle') return 'unknown';
  if (isDismissed(a)) return 'parked';
  return status === 'waiting' ? 'blocked' : 'your-turn';
}

// Dismissed agents stay out of the inbox until they do something new.
function isDismissed(a) {
  const until = data.board.dismissed[a.sessionId];
  const last = a.transcript?.lastActivityTs;
  return Boolean(until) && (!last || last <= until);
}

// When the current state began: your last prompt if it is working,
// otherwise its last activity (how long it has been waiting on you).
function sinceMs(a, att) {
  const t = a.transcript;
  const ts = att === 'working' ? (t?.lastPrompt?.ts ?? t?.lastActivityTs) : t?.lastActivityTs;
  return ts ? Date.parse(ts) : a.startedAt;
}

const groupOf = (a) => data.board.groups.find((g) => g.sessions.includes(a.sessionId))?.name ?? null;
const byUrgency = (x, y) => ATTENTION[x.att].rank - ATTENTION[y.att].rank || x.since - y.since;
const canAttach = (a) => a.kind === 'background' && Boolean(a.id);

// ---- formatting ----

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const fmtTime = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
// Snippets drop markdown emphasis and blank lines so more of the message fits.
const plain = (text) => (text ?? '').replace(/\*\*|`/g, '').replace(/\n\s*\n+/g, '\n').trim();

function chip(att) {
  const { label, icon, tone } = ATTENTION[att];
  return `<span class="chip ${tone}" title="${label}"><span class="icon" aria-hidden="true">${icon}</span><span class="label">${label}</span></span>`;
}

function ctxMeter(t) {
  if (!t?.contextTokens) return '<span class="ctx">ctx –</span>';
  const frac = Math.min(1, t.contextTokens / CONTEXT_WINDOW);
  return `<span class="ctx${frac >= 0.8 ? ' high' : ''}" title="Context in use: ${t.contextTokens.toLocaleString()} of ~1M tokens">`
    + `<span class="bar"><span style="width:${(frac * 100).toFixed(1)}%"></span></span>${fmtTokens(t.contextTokens)}</span>`;
}

// ---- rendering ----

const rendered = new WeakMap();
// Replace markup only when it changed, so hover, focus and scroll survive polling.
function setHTML(el, html) {
  if (rendered.get(el) === html) return false;
  rendered.set(el, html);
  el.innerHTML = html;
  return true;
}

function render() {
  const tileCount = terminals.openIds().length;
  document.body.classList.toggle('workspace', view === 'workspace' && tileCount > 0);
  const toggle = $('#view-toggle');
  toggle.hidden = tileCount === 0;
  toggle.textContent = view === 'workspace' ? 'Overview' : `Terminals (${tileCount})`;
  if (!data) {
    $('#status').textContent = lastError ? `Can't reach the server: ${lastError}` : 'Loading…';
    return;
  }
  const now = Date.now();
  const agents = data.agents.map((a) => {
    const att = attention(a);
    return { ...a, att, since: sinceMs(a, att) };
  });
  renderTop(agents);
  setHTML($('#inbox'), inboxHTML(agents, now));
  setHTML($('#groups'), groupsHTML(agents, now));
  renderDrawer(agents, now);
  const byId = new Map(agents.filter(canAttach).map((a) => [a.id, a]));
  terminals.renderHeaders((id) => tileHeaderHTML(id, byId.get(id), now));
}

function renderTop(agents) {
  const count = (att) => agents.filter((a) => a.att === att).length;
  const need = count('blocked') + count('your-turn');
  document.title = need ? `(${need}) AgentsHub` : 'AgentsHub';
  if (need !== lastBadge) {
    lastBadge = need;
    navigator.setAppBadge?.(need).catch(() => {}); // Dock badge once installed as an app; 0 clears it
  }
  setHTML(
    $('#summary'),
    ['blocked', 'your-turn', 'working', 'parked'].map((att) => `<span class="stat">${chip(att)} <b>${count(att)}</b></span>`).join(''),
  );
  const status = $('#status');
  status.textContent = lastError ? `Update failed: ${lastError}` : `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
  status.classList.toggle('error', Boolean(lastError));
}

function inboxHTML(agents, now) {
  const items = agents.filter((a) => a.att === 'blocked' || a.att === 'your-turn').sort(byUrgency);
  if (!items.length) return '<p class="empty">Nothing needs you right now.</p>';
  return items.map((a) => cardHTML(a, now)).join('');
}

function cardHTML(a, now) {
  const t = a.transcript;
  const pending = t?.pendingTools.at(-1);
  const wants =
    a.att === 'blocked'
      ? `<div class="wants">${esc(a.needs ?? a.waitingFor ?? 'input needed')}${pending ? ` · <code>${esc(pending.name)}</code> ${esc(pending.detail)}` : ''}</div>`
      : '';
  const text = t ? (t.lastAssistant?.text ?? '(no message yet)') : '(no transcript found)';
  return `<article class="card ${ATTENTION[a.att].tone}" data-open="${esc(a.sessionId)}" tabindex="0">
  <header>${chip(a.att)}<span class="name">${esc(a.name)}</span><span class="since" title="since ${esc(fmtTime(a.since))}">${fmtDuration(now - a.since)}</span></header>
  <div class="meta">${esc(groupOf(a) ?? 'Ungrouped')} · ${esc(a.kind)}</div>
  ${wants}
  <p class="snippet">${esc(plain(text).slice(0, 600))}</p>
  <footer>${ctxMeter(t)}<button type="button" data-dismiss="${esc(a.sessionId)}" title="Hide until this agent does something new">Dismiss</button></footer>
</article>`;
}

function groupsHTML(agents, now) {
  const panels = data.board.groups.map((g) => panelHTML(g.name, agents.filter((a) => g.sessions.includes(a.sessionId)), now));
  const grouped = new Set(data.board.groups.flatMap((g) => g.sessions));
  const loose = agents.filter((a) => !grouped.has(a.sessionId));
  if (loose.length || !data.board.groups.length) panels.push(panelHTML(null, loose, now));
  return panels.join('');
}

function panelHTML(name, members, now) {
  const counts = Object.keys(ATTENTION)
    .map((att) => [att, members.filter((a) => a.att === att).length])
    .filter(([, n]) => n)
    .map(([att, n]) => `${n} ${ATTENTION[att].label.toLowerCase()}`)
    .join(' · ');
  const tools =
    name === null
      ? ''
      : `<button type="button" class="icon-btn" data-rename="${esc(name)}" title="Rename group" aria-label="Rename group">✎</button>`
        + `<button type="button" class="icon-btn" data-delete="${esc(name)}" title="Delete group" aria-label="Delete group">✕</button>`;
  const rows = members.sort(byUrgency).map((a) => rowHTML(a, now)).join('');
  return `<section class="panel" data-group="${esc(name ?? '')}">
  <header><h3>${esc(name ?? 'Ungrouped')}</h3><span class="counts">${counts || 'no live agents'}</span>${tools}</header>
  <ul>${rows || '<li class="empty">Drag agents here</li>'}</ul>
</section>`;
}

function rowHTML(a, now) {
  const cls = a.sessionId === selected ? ' selected' : canAttach(a) && terminals.has(a.id) ? ' open' : '';
  return `<li class="row${cls}" draggable="true" data-open="${esc(a.sessionId)}" tabindex="0">
  ${chip(a.att)}<span class="name">${esc(a.name)}</span><span class="since">${fmtDuration(now - a.since)}</span>${ctxMeter(a.transcript)}
  <span class="snippet">${esc(plain(a.transcript?.lastAssistant?.text).split('\n')[0].slice(0, 300))}</span>
</li>`;
}

function tileHeaderHTML(id, a, now) {
  const details = a
    ? `<button type="button" class="icon-btn" data-details="${esc(a.sessionId)}" title="Details" aria-label="Details">ⓘ</button>`
    : '';
  const actions = `<span class="actions">${details}<button type="button" class="icon-btn" data-close-tile="${esc(id)}" `
    + `title="Close terminal (the agent keeps running)" aria-label="Close terminal">✕</button></span>`;
  if (!a) return `<span class="name">${esc(id)}</span><span class="meta">not running</span>${actions}`;
  return `${chip(a.att)}<span class="name">${esc(a.name)}</span>`
    + `<span class="meta">${esc(groupOf(a) ?? 'Ungrouped')} · ${fmtDuration(now - a.since)}</span>${actions}`;
}

function renderDrawer(agents, now) {
  const drawer = $('#drawer');
  const a = agents.find((x) => x.sessionId === selected);
  document.body.classList.toggle('drawer-open', Boolean(a));
  drawer.hidden = !a;
  if (!a) return;
  const scroll = drawer.scrollTop;
  if (setHTML(drawer, drawerHTML(a, now))) drawer.scrollTop = scroll;
}

function drawerHTML(a, now) {
  const t = a.transcript;
  const group = groupOf(a) ?? '';
  const options = ['', ...data.board.groups.map((g) => g.name)]
    .map((g) => `<option value="${esc(g)}"${g === group ? ' selected' : ''}>${esc(g || 'Ungrouped')}</option>`)
    .join('');
  const openWith = canAttach(a)
    ? `<button type="button" data-terminal="${esc(a.id)}">Open terminal</button> <span class="since">or <code>claude attach ${esc(a.id)}</code></span>`
    : `its own terminal window (pid ${esc(a.pid)})`;
  const facts = [
    [
      'Status',
      `${chip(a.att)} <span class="since">${esc(a.att === 'unknown' ? [a.status, a.state].filter(Boolean).join(' · ') : (a.needs ?? a.waitingFor ?? ''))}</span>`,
    ],
    [a.att === 'working' ? 'Working for' : 'Waiting for', `${fmtDuration(now - a.since)} <span class="since">since ${esc(fmtTime(a.since))}</span>`],
    ['Project', `<select data-move="${esc(a.sessionId)}" aria-label="Project group">${options}</select>`],
    ['Context', ctxMeter(t)],
    ['Output tokens', t ? fmtTokens(t.outputTokens) : '–'],
    ['Model', esc([t?.model, t?.effort].filter(Boolean).join(' · ') || '–')],
    ['Open with', openWith],
    ['Started', esc(fmtTime(a.startedAt))],
    ['Directory', `<code>${esc(a.cwd)}</code>`],
    ['Session', `<code>${esc(a.sessionId)}</code>`],
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');
  const section = (title, ts, body) => `<h4>${title}${ts ? `<span class="when">${esc(fmtTime(ts))}</span>` : ''}</h4>${body}`;
  const pending = t?.pendingTools.length
    ? section(
        a.att === 'working' ? 'Running now' : 'Requested',
        null,
        t.pendingTools.map((p) => `<p class="msg"><code>${esc(p.name)}</code> ${esc(p.detail)}</p>`).join(''),
      )
    : '';
  const moveHelp = canAttach(a)
    ? ''
    : section(
        'Use it from the dashboard',
        null,
        '<p class="help">In its terminal window, type <code>/bg</code>. It moves to the background without interrupting '
          + 'what it is doing, even mid-response, and keeps its name, conversation and permission mode. It then opens '
          + 'here as a terminal and stays in its project group. You can close the old window afterwards.</p>',
      );
  const action =
    a.att === 'blocked' || a.att === 'your-turn'
      ? `<button type="button" data-dismiss="${esc(a.sessionId)}">Dismiss from inbox</button>`
      : a.att === 'parked'
        ? `<button type="button" data-undismiss="${esc(a.sessionId)}">Back to inbox</button>`
        : '';
  return `<div class="head"><h2>${esc(a.name)}</h2><button type="button" data-close>Close</button></div>
<dl class="facts">${facts}</dl>
${pending}
${section('Your last prompt', t?.lastPrompt?.ts, `<p class="msg">${esc(t?.lastPrompt?.text ?? '(none)')}</p>`)}
${section('Agent’s last message', t?.lastAssistant?.ts, `<p class="msg">${esc(t?.lastAssistant?.text ?? (t ? '(none yet)' : '(no transcript found)'))}</p>`)}
${moveHelp}
<div class="actions">${action}</div>`;
}

// ---- terminals ----

function restoreTerminals() {
  terminals.configure(data.terminalTheme, () => {
    if (!terminals.openIds().length) view = 'overview';
    render();
  });
  const attachable = new Set(data.agents.filter(canAttach).map((a) => a.id));
  const ids = terminals.saved().filter((id) => attachable.has(id));
  for (const id of ids) terminals.open(id);
  if (ids.length) view = 'workspace';
}

function openTerminal(id) {
  view = 'workspace';
  terminals.open(id);
  render();
  requestAnimationFrame(() => terminals.focus(id));
}

// Clicking an agent opens its terminal when it has one, otherwise its details.
function openAgent(sessionId) {
  const a = data.agents.find((x) => x.sessionId === sessionId);
  if (a && canAttach(a)) openTerminal(a.id);
  else openDrawer(sessionId);
}

// ---- edits (saved to data/board.json by the server) ----

async function send(method, url, body) {
  mutations += 1;
  render();
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  } catch (e) {
    lastError = `Couldn't save: ${e.message}`;
    render();
  }
}

function saveGroups(groups) {
  data.board.groups = groups;
  send('PUT', '/api/groups', { groups });
}

function moveAgent(sessionId, target) {
  const current = data.board.groups.find((g) => g.sessions.includes(sessionId))?.name ?? '';
  if (!sessionId || current === target) return;
  const groups = data.board.groups.map((g) => ({ ...g, sessions: g.sessions.filter((id) => id !== sessionId) }));
  if (target) groups.find((g) => g.name === target).sessions.push(sessionId);
  saveGroups(groups);
}

function askGroupName(message, current = '') {
  const name = prompt(message, current)?.trim();
  if (!name || name === current) return null;
  if (data.board.groups.some((g) => g.name === name)) {
    alert(`There is already a group called "${name}".`);
    return null;
  }
  return name;
}

function newGroup() {
  const name = askGroupName('Name of the new project group:');
  if (name) saveGroups([...data.board.groups, { name, sessions: [] }]);
}

function renameGroup(old) {
  const name = askGroupName('Rename group:', old);
  if (name) saveGroups(data.board.groups.map((g) => (g.name === old ? { ...g, name } : g)));
}

function deleteGroup(name) {
  if (confirm(`Delete the group "${name}"? Its agents move to Ungrouped.`)) {
    saveGroups(data.board.groups.filter((g) => g.name !== name));
  }
}

function setDismissed(sessionId, on) {
  const a = data.agents.find((x) => x.sessionId === sessionId);
  const until = on ? (a?.transcript?.lastActivityTs ?? new Date().toISOString()) : null;
  if (until) data.board.dismissed[sessionId] = until;
  else delete data.board.dismissed[sessionId];
  send('POST', '/api/dismiss', { sessionId, until });
}

function openDrawer(sessionId) {
  selected = sessionId;
  history.replaceState(null, '', sessionId ? `#${encodeURIComponent(sessionId)}` : location.pathname);
  render();
}

// ---- events ----

document.addEventListener('click', (e) => {
  const el = e.target.closest('button, [data-open]');
  if (!el || !data) return;
  const d = el.dataset;
  if (el.id === 'new-group') newGroup();
  else if (el.id === 'view-toggle') {
    view = view === 'workspace' ? 'overview' : 'workspace';
    render();
  } else if ('dismiss' in d) setDismissed(d.dismiss, true);
  else if ('undismiss' in d) setDismissed(d.undismiss, false);
  else if ('rename' in d) renameGroup(d.rename);
  else if ('delete' in d) deleteGroup(d.delete);
  else if ('close' in d) openDrawer(null);
  else if ('terminal' in d) openTerminal(d.terminal);
  else if ('closeTile' in d) terminals.close(d.closeTile);
  else if ('reconnect' in d) terminals.reconnect(d.reconnect);
  else if ('details' in d) openDrawer(d.details);
  else if ('open' in d) openAgent(d.open);
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('.xterm')) return; // keys typed into a terminal belong to the agent
  if (e.key === 'Escape' && selected) openDrawer(null);
  else if (e.key === 'Enter' && e.target.matches?.('[data-open]')) openAgent(e.target.dataset.open);
});

document.addEventListener('change', (e) => {
  if (e.target.matches('select[data-move]')) moveAgent(e.target.dataset.move, e.target.value);
});

document.addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('.row');
  if (!row) return;
  dragging = true;
  e.dataTransfer.setData('text/plain', row.dataset.open);
  e.dataTransfer.effectAllowed = 'move';
});

document.addEventListener('dragover', (e) => {
  const panel = e.target.closest?.('.panel');
  if (!panel || !dragging) return;
  e.preventDefault();
  for (const p of document.querySelectorAll('.panel.over')) if (p !== panel) p.classList.remove('over');
  panel.classList.add('over');
});

document.addEventListener('drop', (e) => {
  const panel = e.target.closest?.('.panel');
  if (!panel) return;
  e.preventDefault();
  // The re-render in moveAgent replaces the dragged row, so its dragend may never reach us.
  dragging = false;
  moveAgent(e.dataTransfer.getData('text/plain'), panel.dataset.group);
});

document.addEventListener('dragend', () => {
  dragging = false;
  for (const p of document.querySelectorAll('.panel.over')) p.classList.remove('over');
  render();
});

poll();
