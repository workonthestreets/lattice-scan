'use strict';

/* ---------- helpers ---------- */

const $ = (s) => document.querySelector(s);
const head = $('#head');
const view = $('#view');

function h(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatNumber(n) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '';
  return Number(n).toLocaleString('en-US');
}

// Decimal string, at most 4 decimals in tables. Truncates, never rounds up.
function amt(s) {
  if (s == null || s === '') return '';
  const str = String(s);
  const i = str.indexOf('.');
  if (i < 0) return formatNumber(str);
  const whole = formatNumber(str.slice(0, i));
  let dec = str.slice(i + 1, i + 5);
  while (dec.length < 4) dec += '0';
  return whole + '.' + dec;
}

function shortParty(id) {
  if (!id) return '';
  const i = id.indexOf('::');
  if (i < 0) return id.length > 18 ? id.slice(0, 10) + '…' + id.slice(-6) : id;
  const hint = id.slice(0, i), fp = id.slice(i + 2);
  return hint + '::' + fp.slice(0, 8) + '…' + fp.slice(-2);
}

function shortCid(id) {
  if (!id) return '';
  return id.length > 20 ? id.slice(0, 10) + '…' + id.slice(-6) : id;
}

function hintOf(id) {
  const i = id.indexOf('::');
  return i < 0 ? id : id.slice(0, i);
}

function clock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(11, 19);
}

function copyCell(full, text, cls) {
  return `<span class="${cls || 'num'} copy" data-copy="${h(full)}" title="${h(full)}">${h(text)}</span>`;
}

function partyCell(id) {
  return `<a class="num" href="#/party/${encodeURIComponent(id)}" title="${h(id)}">${h(shortParty(id))}</a>`;
}

function loading() { return '<p class="loading">Loading</p>'; }

function empty(title, body) {
  return `<div class="empty"><h3>${h(title)}</h3><p>${h(body)}</p></div>`;
}

function tbl(cls, cols, rows) {
  const head = cols.map((c) => `<span${c.r ? ' class="num--r"' : ''}>${h(c.t)}</span>`).join('');
  return `<div class="wrap"><div class="tbl"><div class="tbl__head ${cls}">${head}</div>${rows}</div></div>`;
}

const TOKEN_KEY = 'lattice_scan_token';
function token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch {} }
function authHeaders() { const t = token(); return t ? { authorization: 'Bearer ' + t } : {}; }

async function api(path, init) {
  const r = await fetch(path, { ...(init || {}), headers: { accept: 'application/json', ...authHeaders(), ...((init && init.headers) || {}) } });
  const body = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; e.body = body; if (r.status === 401 || r.status === 403) lastAuthError = e; throw e; }
  return body;
}

/* ---------- auth ---------- */

function authGate(e) {
  if (!e || (e.status !== 401 && e.status !== 403)) return null;
  const detail = (e.body && e.body.detail) || (e.status === 401 ? 'Sign in with a participant token.' : 'Not allowed for this token.');
  return `<div class="empty"><h3>${e.status === 401 ? 'Sign in with a participant token' : 'Not allowed for this token'}</h3>
    <p>${h(detail)}</p>
    <form class="auth" id="authform">
      <label class="card__label" for="tok">Bearer token issued by the participant's identity provider</label>
      <input class="input" id="tok" type="password" autocomplete="off" placeholder="eyJhbGciOi...">
      <div class="auth__row"><button class="btn btn--primary" type="submit">Use token</button>
      ${token() ? '<button class="btn btn--ghost" type="button" id="signout">Forget token</button>' : ''}</div>
    </form></div>`;
}

function bindAuth() {
  const f = document.getElementById('authform');
  if (!f) return;
  f.addEventListener('submit', (ev) => { ev.preventDefault(); setToken(document.getElementById('tok').value.trim()); route(); });
  const so = document.getElementById('signout');
  if (so) so.addEventListener('click', () => { setToken(''); route(); });
}

async function paintWhoami() {
  const el = document.getElementById('who');
  if (!el) return;
  try {
    const w = await api('/auth/whoami');
    if (w.mode === 'off') { el.textContent = 'Open access'; el.title = 'AUTH_MODE=off'; return; }
    el.textContent = w.any_party ? `${w.user} · all parties` : `${w.user} · ${w.parties_count} parties`;
    el.title = 'Token expires ' + (w.token_expires_at || 'unknown');
  } catch (e) {
    el.textContent = token() ? 'Token rejected' : 'Not signed in';
  }
}
document.addEventListener('click', (ev) => {
  if (ev.target && ev.target.id === 'who') { setToken(''); location.hash = '#/'; route(); }
});

let lastAuthError = null;
function unreachable(e) {
  const gate = authGate(e || lastAuthError);
  if (gate) { setTimeout(bindAuth, 0); return gate; }
  return empty('API unreachable at ' + location.origin,
    'The scanner process is not answering on this origin. Start it and reload.');
}

/* ---------- routing ---------- */

let timers = [];
function stopTimers() { timers.forEach(clearInterval); timers = []; }

function setTab(name) {
  document.querySelectorAll('.nav__link').forEach((a) => {
    a.classList.toggle('nav__link--active', a.dataset.tab === name);
  });
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [seg, ...rest] = raw.split('/');
  return { seg, arg: decodeURIComponent(rest.join('/') || '') };
}

async function route() {
  stopTimers();
  const { seg, arg } = parseRoute();
  window.scrollTo(0, 0);
  lastAuthError = null;
  paintWhoami();
  if (seg === 'party' && arg) { setTab('party'); return renderParty(arg); }
  if (seg === 'party') { setTab('party'); return renderPartyPrompt(); }
  if (seg === 'contract' && arg) { setTab(''); return renderContract(arg); }
  if (seg === 'verify') { setTab('verify'); return renderVerify(); }
  setTab('overview');
  return renderOverview();
}

window.addEventListener('hashchange', route);

/* ---------- overview ---------- */

function liveStatus(t) {
  return t && t.connected
    ? '<span class="status"><span class="dot dot--live"></span>Live</span>'
    : '<span class="status"><span class="dot"></span>Tail down</span>';
}

function card(label, value, unit, support) {
  return `<div class="card"><span class="card__label">${h(label)}</span>` +
    `<span class="card__value">${h(value)}${unit ? `<span class="unit">${h(unit)}</span>` : ''}</span>` +
    `<span class="card__support">${h(support)}</span></div>`;
}

function healthStrip(d) {
  const boot = d.bootstrap_ms ? (d.bootstrap_ms / 1000).toFixed(1) + ' s' : 'not run';
  return `<div class="strip">
    ${card('Cursor offset', formatNumber(d.cursor_offset), null,
      `Ledger end ${formatNumber(d.ledger_end)}, a gap of ${formatNumber(d.gap_offsets)} offsets.`)}
    ${card('Lag', Number(d.lag_seconds).toFixed(1), 's',
      'Now minus the record time of the last update ingested. Reference scanner reports about 2.7 s.')}
    ${card('Contracts active', formatNumber(d.contracts_active), null,
      `${formatNumber(d.contracts_total)} contracts total, including archived.`)}
    ${card('Holdings active', formatNumber(d.holdings_active), null,
      'Unarchived token holding contracts in the mirror.')}
    ${card('Updates per minute', Number(d.updates_per_min).toFixed(1), null,
      `${formatNumber(d.updates_indexed)} updates applied since the tail attached.`)}
    ${card('Bootstrap', formatNumber(d.bootstrap_contracts), 'in ' + boot,
      `Active set read at offset ${formatNumber(d.snapshot_offset)}.`)}
    ${card('Parties seen', formatNumber(d.parties_seen), null,
      'Distinct stakeholder parties across the indexed contracts.')}
    ${card('Templates', formatNumber(d.templates), null,
      'Distinct template qualified names in the mirror.')}
  </div>`;
}

function updateRow(u) {
  const acts = (u.activity || [])
    .map((a) => `${a.kind.replace(/_/g, ' ')} ${amt(a.amount)} ${a.instrument || ''}`.trim())
    .join(', ');
  const ps = (u.parties || []);
  const pcell = ps.length
    ? ps.slice(0, 2).map(shortParty).join(', ') + (ps.length > 2 ? ` +${ps.length - 2}` : '')
    : '';
  const cid = u.events && u.events[0] ? u.events[0].contract_id : null;
  const tag = cid ? `<a class="tbl__row cols-upd" href="#/contract/${encodeURIComponent(cid)}">`
                  : '<div class="tbl__row cols-upd">';
  return tag +
    `<span class="num">${formatNumber(u.offset)}</span>` +
    `<span class="num num--dim">${h(clock(u.record_time))}</span>` +
    `<span class="num" title="${h(ps.join('\n'))}">${h(pcell)}</span>` +
    `<span class="num num--r">${formatNumber(u.n)}</span>` +
    `<span class="name">${h(acts)}</span>` +
    (cid ? '</a>' : '</div>');
}

let allTemplates = [];
let templatesExpanded = false;
let overviewTab = 'updates'; // survives navigation away and back within the session

function overviewTabs() {
  const tab = (name, label) =>
    `<button class="tab" role="tab" id="tab-${name}" data-panel="${name}" aria-controls="${name}"` +
    ` aria-selected="${overviewTab === name}" tabindex="${overviewTab === name ? 0 : -1}">${label}</button>`;
  return `<div class="tabs" role="tablist" aria-label="Overview tables" id="ov-tabs">` +
    tab('updates', 'Recent updates') + tab('templates', 'Templates') + '</div>';
}

function overviewPanel(name) {
  return `<div class="panel" id="${name}" role="tabpanel" aria-labelledby="tab-${name}"` +
    `${overviewTab === name ? '' : ' hidden'}>${loading()}</div>`;
}

function selectTab(name, focus) {
  overviewTab = name;
  document.querySelectorAll('#ov-tabs .tab').forEach((b) => {
    const on = b.dataset.panel === name;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
    const p = document.getElementById(b.dataset.panel);
    if (p) p.hidden = !on;
  });
}

function templatesTable() {
  const rows = (templatesExpanded ? allTemplates : allTemplates.slice(0, 20)).map((t) =>
    `<div class="tbl__row cols-tpl"><span class="name" title="${h(t.qname)}">${h(t.qname)}</span>` +
    `<span class="num num--r">${formatNumber(t.active)}</span>` +
    `<span class="num num--r num--dim">${formatNumber(t.total)}</span></div>`).join('');
  const more = allTemplates.length > 20 && !templatesExpanded
    ? `<button class="btn btn-ghost" id="tpl-all" style="margin-top:var(--space-4)">Show all ${formatNumber(allTemplates.length)}</button>`
    : '';
  return tbl('cols-tpl', [{ t: 'Template' }, { t: 'Active', r: 1 }, { t: 'Total', r: 1 }], rows) + more;
}

async function renderOverview() {
  head.innerHTML = `<div class="head-row">
      <h1 class="page__h">One Canton node. Its <em>honest</em> view.</h1>
      <span id="live"></span>
    </div><p class="page__sub" id="boundary"></p>`;
  view.innerHTML = `<div id="strip">${loading()}</div>
    <section class="sec">${overviewTabs()}${overviewPanel('updates')}${overviewPanel('templates')}</section>`;

  async function pullHealth() {
    try {
      const d = await api('/health');
      $('#live').innerHTML = liveStatus(d.tail);
      $('#boundary').textContent = d.boundary || '';
      $('#strip').innerHTML = healthStrip(d) +
        `<p class="note">History before offset ${formatNumber(d.pruned_offset)} is pruned on this participant and cannot be read.</p>`;
    } catch (e) { $('#strip').innerHTML = unreachable(e); }
  }
  async function pullUpdates() {
    try {
      const list = await api('/updates/recent?limit=50');
      $('#updates').innerHTML = list.length
        ? tbl('cols-upd', [{ t: 'Offset' }, { t: 'Time' }, { t: 'Parties' }, { t: 'Events', r: 1 },
            { t: 'Activity' }], list.map(updateRow).join(''))
        : empty('No updates yet', 'The tail is attached but no update has arrived since it started.');
    } catch (e) { $('#updates').innerHTML = unreachable(e); }
  }
  await Promise.all([pullHealth(), pullUpdates()]);
  try {
    allTemplates = await api('/templates');
    $('#templates').innerHTML = templatesTable();
  } catch (e) { $('#templates').innerHTML = unreachable(e); }

  timers.push(setInterval(pullHealth, 2000));
  timers.push(setInterval(pullUpdates, 5000));
}

/* ---------- party ---------- */

function renderPartyPrompt() {
  head.innerHTML = '<h1 class="page__h">Which <em>party</em>?</h1>';
  view.innerHTML = empty('Enter a party id',
    'Type a party id or a name fragment in the search field above. Party ids contain a double colon.');
}

function balancesTable(b) {
  const anyEff = b.balances.some((x) => x.effective_after_holding_fees != null);
  const rows = b.balances.map((x) =>
    `<div class="tbl__row cols-bal"><span class="name">${h(x.instrument)}</span>` +
    `<span class="num num--r" title="${h(x.balance)}">${amt(x.balance)}</span>` +
    `<span class="num num--r num--dim" title="${h(x.locked)}">${amt(x.locked)}</span>` +
    `<span class="num num--r" title="${h(x.available)}">${amt(x.available)}</span>` +
    `<span class="num num--r">${formatNumber(x.utxo_count)}</span>` +
    `<span class="num num--r ${x.effective_after_holding_fees == null ? 'num--dim' : ''}"` +
    ` title="${h(x.effective_after_holding_fees || '')}">` +
    `${x.effective_after_holding_fees == null ? '' : amt(x.effective_after_holding_fees)}</span></div>`).join('');
  const cols = [{ t: 'Instrument' }, { t: 'Balance', r: 1 }, { t: 'Locked', r: 1 },
    { t: 'Available', r: 1 }, { t: 'UTXOs', r: 1 }, { t: 'After fees', r: 1 }];
  const note = anyEff
    ? '<p class="note">After fees is Canton Coin after accrued holding fees. The ledger reports the face value.</p>'
    : '';
  return `<p class="note" style="margin-bottom:var(--space-4)">As of offset ${formatNumber(b.as_of_offset)}, round ${formatNumber(b.current_round)}.</p>` +
    tbl('cols-bal', cols, rows) + note;
}

function holdingsTable(list) {
  if (!list.length) return empty('No holdings', 'This party is a stakeholder on no unarchived holding contract.');
  const rows = list.map((x) =>
    `<a class="tbl__row cols-hold" href="#/contract/${encodeURIComponent(x.contract_id)}">` +
    `<span class="num" title="${h(x.contract_id)}">${h(shortCid(x.contract_id))}</span>` +
    `<span class="name">${h(x.instrument)}</span>` +
    `<span class="num num--r" title="${h(x.amount)}">${amt(x.amount)}</span>` +
    `<span class="num ${x.locked ? '' : 'num--dim'}">${x.locked ? 'locked' : 'free'}</span>` +
    `<span class="num num--dim">${h(x.lock_expires_at ? clock(x.lock_expires_at) : '')}</span>` +
    `<span class="num num--r num--dim">${formatNumber(x.round)}</span>` +
    `<span class="num num--r num--dim">${formatNumber(x.created_offset)}</span></a>`).join('');
  return tbl('cols-hold', [{ t: 'Contract' }, { t: 'Instrument' }, { t: 'Amount', r: 1 },
    { t: 'Lock' }, { t: 'Lock expiry' }, { t: 'Round', r: 1 }, { t: 'Created offset', r: 1 }], rows);
}

function historyTable(list) {
  if (!list.length) return empty('No classified history',
    'No update in the indexed window moved value for this party. Readable history starts at the pruning boundary.');
  const rows = list.map((x) =>
    `<div class="tbl__row cols-hist"><span class="num num--dim">${h(clock(x.record_time))}</span>` +
    `<span class="name">${h(x.kind.replace(/_/g, ' '))}</span>` +
    `<span class="num num--r" title="${h(x.amount || '')}">${amt(x.amount)}</span>` +
    `<span class="num">${h(x.instrument || '')}</span>` +
    (x.counterparty ? partyCell(x.counterparty) : '<span class="num num--dim"></span>') +
    `<span class="num num--dim">${h(x.confidence || '')}</span></div>`).join('');
  return tbl('cols-hist', [{ t: 'Time' }, { t: 'Kind' }, { t: 'Amount', r: 1 }, { t: 'Instrument' },
    { t: 'Counterparty' }, { t: 'Confidence' }], rows);
}

function contractsTable(list) {
  if (!list.length) return empty('No active contracts', 'This party is a stakeholder on nothing the mirror still holds as active.');
  const rows = list.map((x) =>
    `<a class="tbl__row cols-con" href="#/contract/${encodeURIComponent(x.contract_id)}">` +
    `<span class="name" title="${h(x.qname)}">${h(x.qname)}</span>` +
    `<span class="num num--dim">${h(x.role || '')}</span>` +
    `<span class="num num--r num--dim">${formatNumber(x.created_offset)}</span>` +
    `<span class="num num--r num--dim">${x.archived_offset == null ? 'active' : formatNumber(x.archived_offset)}</span></a>`).join('');
  return tbl('cols-con', [{ t: 'Template' }, { t: 'Role' }, { t: 'Created offset', r: 1 },
    { t: 'Archived offset', r: 1 }], rows);
}

async function renderParty(id) {
  head.innerHTML = `<h1 class="page__h">What <em>${h(hintOf(id))}</em> holds</h1>` +
    `<p class="pid copy" data-copy="${h(id)}" title="Click to copy">${h(id)}</p>`;
  view.innerHTML = loading();

  let bal;
  try {
    bal = await api(`/parties/${encodeURIComponent(id)}/balances`);
  } catch (e) {
    if (e.status === 404) {
      view.innerHTML = empty('Not in this index',
        (e.body && e.body.detail) || 'This participant holds nothing for that party.');
      return;
    }
    view.innerHTML = unreachable(e);
    return;
  }

  view.innerHTML = `<section id="s-bal">${balancesTable(bal)}</section>
    <section class="sec"><div class="sec__head"><h2 class="sec__h">Holdings</h2></div>
      <div id="s-hold">${loading()}</div></section>
    <section class="sec"><div class="sec__head"><h2 class="sec__h">History</h2></div>
      <div id="s-hist">${loading()}</div></section>
    <section class="sec"><div class="sec__head"><h2 class="sec__h">Contracts</h2>
      <select class="input" id="tpl-filter" aria-label="Filter contracts by template"><option value="">All templates</option></select></div>
      <div id="s-con">${loading()}</div></section>`;

  const P = (p) => api(p).catch(() => null);
  const [hold, hist, cons, tpls] = await Promise.all([
    P(`/parties/${encodeURIComponent(id)}/holdings?limit=200`),
    P(`/parties/${encodeURIComponent(id)}/history?limit=100`),
    P(`/parties/${encodeURIComponent(id)}/contracts?active=1&limit=200`),
    P(`/parties/${encodeURIComponent(id)}/templates`)
  ]);

  $('#s-hold').innerHTML = hold ? holdingsTable(hold) : unreachable();
  $('#s-hist').innerHTML = hist ? historyTable(hist.classified || []) : unreachable();

  const all = cons || [];
  $('#s-con').innerHTML = cons ? contractsTable(all) : unreachable();
  const sel = $('#tpl-filter');
  if (sel && tpls) {
    sel.innerHTML = '<option value="">All templates</option>' + tpls.map((t) =>
      `<option value="${h(t.qname)}">${h(t.qname)} (${formatNumber(t.active)})</option>`).join('');
    sel.addEventListener('change', () => {
      const q = sel.value;
      $('#s-con').innerHTML = contractsTable(q ? all.filter((c) => c.qname === q) : all);
    });
  }
}

/* ---------- contract ---------- */

function partyList(list) {
  if (!list || !list.length) return '<span class="num num--dim">none</span>';
  return list.map((p) => partyCell(p)).join('<br>');
}

function jsonBlock(obj) {
  const raw = JSON.stringify(obj, null, 2);
  return '<pre class="code">' + raw.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    .replace(/"([^"\\]*)":/g, '<span class="c-key">"$1"</span>:') + '</pre>';
}

async function renderContract(id) {
  head.innerHTML = `<h1 class="page__h">Contract</h1><p class="pid copy" data-copy="${h(id)}" title="Click to copy">${h(id)}</p>`;
  view.innerHTML = loading();
  let c;
  try { c = await api('/contracts/' + encodeURIComponent(id)); }
  catch (e) {
    view.innerHTML = e.status === 404
      ? empty('Not in this index',
          (e.body && e.body.detail) || 'This contract id is not in the mirror. It may predate the pruning boundary, or belong to parties this node does not host.')
      : unreachable();
    return;
  }

  head.innerHTML = `<h1 class="page__h">${h(c.qname)}</h1>` +
    `<p class="pid copy" data-copy="${h(c.contract_id)}" title="Click to copy">${h(c.contract_id)}</p>`;

  const rows = [
    ['Package name', `<span class="num">${h(c.package_name || '')}</span>`],
    ['Created offset', `<span class="num">${formatNumber(c.created_offset)}</span>`],
    ['Created at', `<span class="num">${h(c.created_at || '')}</span>`],
    ['Archived offset', c.archived_offset == null
      ? '<span class="num">active</span>'
      : `<span class="num">${formatNumber(c.archived_offset)}</span>`],
    ['Signatories', partyList(c.signatories)],
    ['Observers', partyList(c.observers)]
  ];
  if (c.holding) {
    rows.push(['Holding amount', `<span class="num" title="${h(c.holding.amount || '')}">${amt(c.holding.amount)} ${h(c.holding.instrument || '')}</span>`]);
    rows.push(['Holding owner', c.holding.owner ? partyCell(c.holding.owner) : '<span class="num num--dim">none</span>']);
  }
  const kv = '<dl class="kv">' + rows.map(([k, v]) =>
    `<dt>${h(k)}</dt><dd>${v}</dd>`).join('') + '</dl>';

  const ev = (c.events || []).length
    ? tbl('cols-ev', [{ t: 'Offset' }, { t: 'Node' }, { t: 'Kind' }, { t: 'Time' }, { t: 'Update' }],
        c.events.map((e) =>
          `<div class="tbl__row cols-ev"><span class="num">${formatNumber(e.offset)}</span>` +
          `<span class="num num--dim">${formatNumber(e.node_id)}</span>` +
          `<span class="name">${h(e.kind)}</span>` +
          `<span class="num num--dim">${h(clock(e.record_time))}</span>` +
          copyCell(e.update_id, shortCid(e.update_id)) + '</div>').join(''))
    : empty('No events', 'The mirror holds this contract without any recorded lifecycle event.');

  const holdingView = c.holding_view
    ? `<section class="sec"><div class="sec__head"><h2 class="sec__h">Holding view</h2></div>${jsonBlock(c.holding_view)}</section>`
    : '';

  view.innerHTML = kv + holdingView +
    `<section class="sec"><div class="sec__head"><h2 class="sec__h">Payload</h2></div>${jsonBlock(c.payload || {})}</section>` +
    `<section class="sec"><div class="sec__head"><h2 class="sec__h">Events</h2></div>${ev}</section>`;
}

/* ---------- verify ---------- */

function diffCount(r) { return Number(r.only_in_ledger || 0) + Number(r.only_in_mirror || 0); }

function runsTable(runs) {
  if (!runs.length) return empty('No self-check has run',
    'Press Run self-check to pin an offset, re-read the active set from the ledger, and diff it.');
  const rows = runs.map((r) =>
    `<div class="tbl__row cols-run"><span class="num num--dim">${h(clock(r.finished_at || r.started_at))}</span>` +
    `<span class="num">${formatNumber(r.at_offset)}</span>` +
    `<span class="num num--r">${formatNumber(r.ledger_count)}</span>` +
    `<span class="num num--r">${formatNumber(r.mirror_count)}</span>` +
    `<span class="num num--r${Number(r.only_in_ledger) ? ' alert' : ' num--dim'}">${formatNumber(r.only_in_ledger)}</span>` +
    `<span class="num num--r${Number(r.only_in_mirror) ? ' alert' : ' num--dim'}">${formatNumber(r.only_in_mirror)}</span>` +
    `<span class="num num--r num--dim">${formatNumber(r.repaired)}</span>` +
    `<span class="num num--r num--dim">${formatNumber(r.duration_ms)}</span></div>`).join('');
  return tbl('cols-run', [{ t: 'Time' }, { t: 'Offset' }, { t: 'Ledger', r: 1 }, { t: 'Mirror', r: 1 },
    { t: 'Missing', r: 1 }, { t: 'Phantom', r: 1 }, { t: 'Repaired', r: 1 }, { t: 'ms', r: 1 }], rows);
}

function findingsTable(list) {
  if (!list.length) return '';
  const rows = list.map((f) =>
    `<a class="tbl__row cols-find" href="#/contract/${encodeURIComponent(f.contract_id)}">` +
    `<span class="num" title="${h(f.contract_id)}">${h(shortCid(f.contract_id))}</span>` +
    `<span class="num alert">${h(f.kind)}</span>` +
    `<span class="name" title="${h(f.qname || '')}">${h(f.qname || '')}</span>` +
    `<span class="num num--dim">${h(f.action || '')}</span></a>`).join('');
  return `<section class="sec"><div class="sec__head"><h2 class="sec__h">Latest findings</h2></div>` +
    tbl('cols-find', [{ t: 'Contract' }, { t: 'Kind' }, { t: 'Template' }, { t: 'Action' }], rows) +
    '</section>';
}

function verifyBody(data) {
  const runs = data.runs || [];
  const latest = runs[0];
  const n = latest ? diffCount(latest) : null;
  const big = latest
    ? `<p class="big${n > 0 ? ' alert' : ''}">${formatNumber(n)} difference${n === 1 ? '' : 's'}</p>
       <p class="note">Offset ${formatNumber(latest.at_offset)}. Ledger reported ${formatNumber(latest.ledger_count)} active contracts, the mirror held ${formatNumber(latest.mirror_count)}, in ${formatNumber(latest.duration_ms)} ms.</p>`
    : '';
  return `<div id="v-latest">${big}</div>
    <section class="sec"><div class="sec__head"><h2 class="sec__h">Runs</h2></div>${runsTable(runs)}</section>
    ${findingsTable(data.latest_findings || [])}`;
}

async function renderVerify() {
  head.innerHTML = `<h1 class="page__h">The mirror, checked against the <em>ledger</em>.</h1>
    <p class="page__sub">The self-check pins the current offset, re-downloads the ledger's active contract set at that offset, and diffs it against the mirror contract by contract. The expected result is zero differences: every contract the ledger reports is in the mirror, and nothing extra.</p>
    <div style="margin-top:var(--space-5)"><button class="btn btn-primary" id="run">Run self-check</button></div>`;
  view.innerHTML = loading();

  async function pull() {
    try { view.innerHTML = verifyBody(await api('/verify')); }
    catch (e) { view.innerHTML = unreachable(e); }
  }
  await pull();

  $('#run').addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    b.textContent = 'Running';
    try {
      await api('/verify/run', { method: 'POST' });
      await pull();
    } catch (e) {
      view.innerHTML = unreachable(e);
    } finally {
      b.disabled = false;
      b.textContent = 'Run self-check';
    }
  });
}

/* ---------- search + copy ---------- */

const q = $('#q');
q.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const v = q.value.trim();
  if (!v) return;
  if (v.includes('::')) { location.hash = '#/party/' + encodeURIComponent(v); return; }
  if (/^00/.test(v) && v.length > 40) { location.hash = '#/contract/' + encodeURIComponent(v); return; }
  try {
    const hits = await api('/search?q=' + encodeURIComponent(v));
    if (hits && hits.length) { location.hash = '#/party/' + encodeURIComponent(hits[0]); return; }
  } catch (err) { /* fall through to the party route, which reports its own boundary */ }
  location.hash = '#/party/' + encodeURIComponent(v);
});

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-copy]');
  if (!t) return;
  if (navigator.clipboard) navigator.clipboard.writeText(t.dataset.copy).catch(() => {});
});

document.addEventListener('click', (e) => {
  if (e.target.id === 'tpl-all') { templatesExpanded = true; $('#templates').innerHTML = templatesTable(); }
  const t = e.target.closest('#ov-tabs .tab');
  if (t) selectTab(t.dataset.panel, false);
});

// Arrow keys move between tabs, per the WAI-ARIA tabs pattern.
document.addEventListener('keydown', (e) => {
  const t = e.target instanceof Element ? e.target.closest('#ov-tabs .tab') : null;
  if (!t) return;
  const tabs = Array.from(document.querySelectorAll('#ov-tabs .tab'));
  const i = tabs.indexOf(t);
  let j = null;
  if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
  else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = tabs.length - 1;
  if (j == null) return;
  e.preventDefault();
  selectTab(tabs[j].dataset.panel, true);
});

route();
