// JSON API + static UI. node:http only.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, log } from "./config.mjs";
import { db, getMeta, getMetaInt, counts } from "./db.mjs";
import { ledgerEnd, get } from "./ledger.mjs";
import { tailState } from "./tail.mjs";
import { runVerify, verifyState } from "./verify.mjs";
import { toUnits, fromUnits } from "./decimal.mjs";
import { effectiveAmount } from "./reduce.mjs";
import { authenticate, canRead, canReadAny, describe, AuthError } from "./auth.mjs";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const Q = {
  partyExists: db.prepare("SELECT 1 FROM stakeholders WHERE party = ? LIMIT 1"),
  holdingsActive: db.prepare("SELECT * FROM holdings WHERE owner = ? AND archived_offset IS NULL ORDER BY instrument, created_offset"),
  holdingsFiltered: db.prepare("SELECT * FROM holdings WHERE owner = ? AND archived_offset IS NULL AND (? = '' OR instrument = ?) AND (? = -1 OR locked = ?) ORDER BY instrument, created_offset DESC LIMIT ?"),
  history: db.prepare("SELECT * FROM activity WHERE party = ? AND (? = 0 OR offset < ?) ORDER BY offset DESC LIMIT ?"),
  historyRaw: db.prepare(`SELECT e.offset, e.node_id, e.update_id, e.kind, e.contract_id, e.qname, e.record_time, h.instrument, h.amount, h.locked
    FROM events e JOIN holdings h ON h.contract_id = e.contract_id WHERE h.owner = ? AND (? = 0 OR e.offset < ?) ORDER BY e.offset DESC LIMIT ?`),
  partyContracts: db.prepare(`SELECT c.contract_id, c.qname, s.role, c.created_offset, c.created_at, c.archived_offset
    FROM stakeholders s JOIN contracts c ON c.contract_id = s.contract_id
    WHERE s.party = ? AND (? = '' OR c.qname = ?) AND (? = 0 OR c.archived_offset IS NULL) ORDER BY c.created_offset DESC LIMIT ?`),
  partyTemplates: db.prepare(`SELECT c.qname, count(*) AS total, sum(c.archived_offset IS NULL) AS active
    FROM stakeholders s JOIN contracts c ON c.contract_id = s.contract_id WHERE s.party = ? GROUP BY c.qname ORDER BY active DESC, total DESC`),
  contract: db.prepare("SELECT * FROM contracts WHERE contract_id = ?"),
  contractEvents: db.prepare("SELECT offset, node_id, update_id, kind, record_time FROM events WHERE contract_id = ? ORDER BY offset"),
  contractHolding: db.prepare("SELECT * FROM holdings WHERE contract_id = ?"),
  contractParties: db.prepare("SELECT party FROM stakeholders WHERE contract_id = ?"),
  recentUpdates: db.prepare("SELECT update_id, max(offset) AS offset, max(record_time) AS record_time, count(*) AS n FROM events GROUP BY update_id ORDER BY offset DESC LIMIT ?"),
  updateEvents: db.prepare("SELECT kind, contract_id, qname FROM events WHERE update_id = ? ORDER BY node_id"),
  updateParties: db.prepare("SELECT DISTINCT s.party FROM events e JOIN stakeholders s ON s.contract_id = e.contract_id WHERE e.update_id = ? LIMIT 12"),
  updateActivity: db.prepare("SELECT party, instrument, kind, amount, counterparty, confidence FROM activity WHERE update_id = ?"),
  templates: db.prepare("SELECT qname, count(*) AS total, sum(archived_offset IS NULL) AS active FROM contracts GROUP BY qname ORDER BY active DESC"),
  verifyRuns: db.prepare("SELECT * FROM verify_runs ORDER BY id DESC LIMIT 20"),
  verifyFindings: db.prepare("SELECT * FROM verify_findings WHERE run_id = ? LIMIT 200"),
  updatesLast5: db.prepare("SELECT count(DISTINCT update_id) AS n FROM events WHERE record_time >= ?"),
  topParties: db.prepare(`SELECT owner AS party, instrument, count(*) AS utxo_count, sum(CAST(amount AS REAL)) AS approx_balance
    FROM holdings WHERE archived_offset IS NULL AND (? = '' OR instrument = ?)
    GROUP BY owner, instrument HAVING (? = 0 OR count(*) <= ?)
    ORDER BY CASE WHEN ? = 'balance' THEN sum(CAST(amount AS REAL)) ELSE count(*) END DESC LIMIT ?`),
  searchParties: db.prepare("SELECT DISTINCT party FROM stakeholders WHERE party LIKE ? LIMIT 20"),
  activityKinds: db.prepare("SELECT kind, count(*) AS n FROM activity GROUP BY kind ORDER BY n DESC"),
};

let currentRound = { number: null, at: 0 };
async function getCurrentRound() {
  if (Date.now() - currentRound.at < 60000) return currentRound.number;
  try {
    const r = await fetch(config.scanUrl + "/api/scan/v0/open-and-issuing-mining-rounds", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ cached_open_mining_round_contract_ids: [], cached_issuing_round_contract_ids: [] }) });
    const j = await r.json();
    const nums = Object.values(j.open_mining_rounds || {}).map(x => Number(x.contract?.payload?.round?.number)).filter(Number.isFinite);
    currentRound = { number: nums.length ? Math.max(...nums) : null, at: Date.now() };
  } catch { currentRound.at = Date.now(); }
  return currentRound.number;
}

let ledgerEndCache = { offset: null, at: 0 };
async function cachedLedgerEnd() {
  if (Date.now() - ledgerEndCache.at < 2000) return ledgerEndCache.offset;
  try { ledgerEndCache = { offset: (await get("/v2/state/ledger-end", 3000)).offset, at: Date.now() }; } catch { ledgerEndCache.at = Date.now(); }
  return ledgerEndCache.offset;
}

export async function health() {
  const c = counts();
  const cursor = getMetaInt("offset", null);
  const rt = getMeta("record_time");
  const end = await cachedLedgerEnd();
  const fiveMinAgo = new Date(Date.now() - 300000).toISOString();
  return {
    status: getMeta("snapshot_complete") === "1" ? (tailState.connected ? "ok" : "degraded") : "bootstrapping",
    snapshot_offset: getMetaInt("snapshot_offset", null),
    cursor_offset: cursor,
    cursor_record_time: rt || null,
    ledger_end: end,
    gap_offsets: end !== null && cursor !== null ? end - cursor : null,
    lag_seconds: rt ? Math.max(0, (Date.now() - Date.parse(rt)) / 1000) : null,
    pruned_offset: getMetaInt("pruned_offset", null),
    bootstrap_ms: getMetaInt("bootstrap_ms", null),
    history_from_offset: getMeta("backfill_done") === "1" ? getMetaInt("backfill_from", null) : getMetaInt("snapshot_offset", null),
    backfill: getMeta("backfill_done") === "1" ? { updates: getMetaInt("backfill_updates"), events: getMetaInt("backfill_events"), ms: getMetaInt("backfill_ms") } : null,
    bootstrap_contracts: getMetaInt("bootstrap_contracts", null),
    ...c,
    updates_per_min: Number((Q.updatesLast5.get(fiveMinAgo).n / 5).toFixed(2)),
    orphan_archive_total: getMetaInt("orphan_archive_total"),
    last_commit_at: getMeta("last_commit_at") || null,
    tail: { connected: tailState.connected, reconnects: tailState.reconnects, stale_auth_reconnects: tailState.staleAuthReconnects, updates_applied: tailState.updatesApplied, errors: tailState.errors, last_error: tailState.lastError },
    verify: verifyState.last ? { at_offset: verifyState.last.at_offset, only_in_ledger: verifyState.last.only_in_ledger, only_in_mirror: verifyState.last.only_in_mirror, duration_ms: verifyState.last.duration_ms } : null,
    filter_mode: config.filterMode,
    auth_mode: config.authMode,
    demo_login: config.demoLogin,
    started_at: getMeta("started_at") || null,
    uptime_s: Math.round(process.uptime()),
    boundary: "Canton Network, one participant. Contracts where a party hosted here is a stakeholder. Nothing from other validators. History before the pruned offset is not reconstructable.",
  };
}

async function balances(party) {
  if (!Q.partyExists.get(party)) return null;
  const rows = Q.holdingsActive.all(party);
  const round = await getCurrentRound();
  const agg = new Map();
  for (const r of rows) {
    const k = r.instrument;
    const a = agg.get(k) || { instrument: k, admin: r.admin, balance: 0n, locked: 0n, utxo_count: 0, locked_count: 0, effective: 0n, has_effective: false };
    const u = toUnits(r.amount);
    a.balance += u; a.utxo_count++;
    if (r.locked) { a.locked += u; a.locked_count++; }
    if (k === "Amulet" && r.round !== null && r.rate) { const e = effectiveAmount(r.amount, r.round, r.rate, round); if (e !== null) { a.effective += toUnits(e); a.has_effective = true; } }
    agg.set(k, a);
  }
  return {
    party, as_of_offset: getMetaInt("offset", null), current_round: round,
    balances: [...agg.values()].map(a => ({ instrument: a.instrument, admin: a.admin, balance: fromUnits(a.balance), locked: fromUnits(a.locked),
      available: fromUnits(a.balance - a.locked), utxo_count: a.utxo_count, locked_count: a.locked_count,
      effective_after_holding_fees: a.has_effective ? fromUnits(a.effective) : null })),
  };
}

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body, null, 1)); };
const notFound = (res, detail) => json(res, 404, { error: "not_found", detail });

const STATIC = { "/": "index.html", "/index.html": "index.html", "/system.css": "system.css", "/app.js": "app.js", "/hero-wireframe.webp": "hero-wireframe.webp", "/favicon.svg": "favicon.svg" };
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".webp": "image/webp", ".svg": "image/svg+xml" };

// Client-credentials exchange at the participant's identity provider. Returns the token; keeps nothing.
async function exchangeCredentials(res, clientId, clientSecret) {
  try {
    const r = await fetch(config.idpTokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }), signal: AbortSignal.timeout(15000) });
    const t = await r.json().catch(() => ({}));
    if (!r.ok) return json(res, 401, { error: "unauthorized", detail: `The identity provider rejected these credentials${t.error_description ? ": " + t.error_description : ""}.` });
    return json(res, 200, { access_token: t.access_token, expires_in: t.expires_in, token_type: t.token_type });
  } catch (e) { return json(res, 502, { error: "idp_unreachable", detail: `Could not reach the identity provider: ${e.name === "TimeoutError" ? "timeout" : e.message}` }); }
}

async function route(req, res) {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  const seg = p.split("/").filter(Boolean).map(decodeURIComponent);
  const q = u.searchParams;
  const limRaw = Number.parseInt(q.get("limit") ?? "", 10); // NaN -> datatype mismatch, <= 0 -> SQLite "no limit"
  const lim = Number.isFinite(limRaw) ? Math.min(Math.max(limRaw, 1), 1000) : 100;

  if (req.method === "GET" && STATIC[p]) {
    const f = path.join(PUBLIC, STATIC[p]);
    if (!fs.existsSync(f)) return notFound(res, "no ui file");
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
    return fs.createReadStream(f).pipe(res);
  }
  if (p === "/health") return json(res, 200, await health());
  if (p === "/auth/token" && req.method === "POST") {
    // Convenience for the dashboard: exchange a client id + secret for a bearer token at the participant's
    // identity provider. The scanner forwards the exchange and returns the token; it keeps neither.
    let body = "";
    for await (const chunk of req) { body += chunk; if (body.length > 8192) break; }
    let creds = {}; try { creds = JSON.parse(body || "{}"); } catch {}
    const clientId = String(creds.client_id || "").trim(), clientSecret = String(creds.client_secret || "").trim();
    if (!clientId || !clientSecret) return json(res, 400, { error: "bad_request", detail: "client_id and client_secret are required" });
    return exchangeCredentials(res, clientId, clientSecret);
  }
  if (p === "/auth/token/demo" && req.method === "POST") {
    // Demo-only: mint with the credentials configured on THIS scanner (CLIENT_ID/CLIENT_SECRET), so a presenter
    // signs in with one click. Anyone who can reach the page gets the operator's token while this is on,
    // hence 404 unless DEMO_LOGIN=1.
    if (!config.demoLogin) return notFound(res, "demo login is off on this scanner (DEMO_LOGIN=1 enables it)");
    if (!config.clientSecret) return json(res, 500, { error: "misconfigured", detail: "CLIENT_SECRET is not set on the scanner" });
    return exchangeCredentials(res, config.clientId, config.clientSecret);
  }

  // Everything below is ledger data: the participant decides who may read what.
  let auth;
  try { auth = await authenticate(req); }
  catch (e) { if (e instanceof AuthError) return json(res, e.status, { error: e.status === 401 ? "unauthorized" : "forbidden", detail: e.message }); throw e; }
  const forbidden = (detail) => json(res, 403, { error: "forbidden", detail });
  const needAll = () => forbidden("This view spans every party on the participant; your token can read only its own parties (no CanReadAsAnyParty right).");
  if (p === "/auth/whoami") return json(res, 200, describe(auth));
  if (p === "/parties/top") {
    if (!auth.anyParty) return needAll();
    const inst = q.get("instrument") || "", mx = Number(q.get("max_utxos") || 0), ord = q.get("order") === "balance" ? "balance" : "utxos";
    return json(res, 200, Q.topParties.all(inst, inst, mx, mx, ord, lim));
  }
  if (seg[0] === "parties" && seg.length >= 2) {
    const party = seg[1];
    if (!canRead(auth, party)) return forbidden("Your token has no read rights on this party. The participant, not the scanner, decides that.");
    if (seg[2] === undefined || seg[2] === "balances") { const b = await balances(party); return b ? json(res, 200, b) : notFound(res, "party not in this participant's index (boundary: only parties hosted here or transacting with them)"); }
    if (!Q.partyExists.get(party)) return notFound(res, "party not in this participant's index");
    if (seg[2] === "holdings") { const locked = q.get("locked"); return json(res, 200, Q.holdingsFiltered.all(party, q.get("instrument") || "", q.get("instrument") || "", locked === null ? -1 : Number(locked), locked === null ? -1 : Number(locked), lim).map(h => ({ ...h, locked: !!h.locked, lock_holders: h.lock_holders ? JSON.parse(h.lock_holders) : null }))); }
    if (seg[2] === "history") { const b = Number(q.get("before_offset") || 0); const rows = Q.history.all(party, b, b, lim); return json(res, 200, { party, classified: rows, raw: q.get("raw") ? Q.historyRaw.all(party, b, b, lim) : undefined }); }
    if (seg[2] === "contracts") return json(res, 200, Q.partyContracts.all(party, q.get("qname") || "", q.get("qname") || "", q.get("active") === "1" ? 1 : 0, lim));
    if (seg[2] === "templates") return json(res, 200, Q.partyTemplates.all(party));
  }
  if (seg[0] === "contracts" && seg[1]) {
    const c = Q.contract.get(seg[1]); if (!c) return notFound(res, "contract not in index");
    if (!canReadAny(auth, Q.contractParties.all(seg[1]).map(x => x.party))) return forbidden("Your token can read none of this contract's stakeholders.");
    return json(res, 200, { ...c, payload: JSON.parse(c.payload), holding_view: c.holding_view ? JSON.parse(c.holding_view) : null,
      signatories: JSON.parse(c.signatories), observers: JSON.parse(c.observers), holding: Q.contractHolding.get(seg[1]) || null, events: Q.contractEvents.all(seg[1]) });
  }
  if (p === "/updates/recent") {
    if (!auth.anyParty) return needAll();
    const ups = Q.recentUpdates.all(Math.min(lim, 200));
    return json(res, 200, ups.map(u => ({ ...u, events: Q.updateEvents.all(u.update_id), parties: Q.updateParties.all(u.update_id).map(x => x.party), activity: Q.updateActivity.all(u.update_id) })));
  }
  if (p === "/templates") { if (!auth.anyParty) return needAll(); return json(res, 200, Q.templates.all()); }
  if (p === "/search") { const s = q.get("q") || ""; const hits = s.length < 2 ? [] : Q.searchParties.all("%" + s + "%").map(x => x.party); return json(res, 200, hits.filter(x => canRead(auth, x))); }
  if (p === "/activity/kinds") { if (!auth.anyParty) return needAll(); return json(res, 200, Q.activityKinds.all()); }
  if (p.startsWith("/verify") && !auth.anyParty) return needAll();
  if (p === "/verify" && req.method === "GET") { const runs = Q.verifyRuns.all(); return json(res, 200, { running: verifyState.running, runs, latest_findings: runs[0] ? Q.verifyFindings.all(runs[0].id) : [] }); }
  if (p === "/verify/run" && req.method === "POST") {
    try { return json(res, 200, await runVerify({ repair: q.get("repair") !== "0" })); }
    catch (e) { return json(res, 409, { error: "verify_failed", detail: String(e.message || e) }); }
  }
  return notFound(res, "no such route");
}

export function startApi() {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type" }); return res.end(); }
    route(req, res).catch(e => { log("api error", e.message); try { json(res, 500, { error: "internal", detail: String(e.message || e) }); } catch {} });
  });
  server.listen(config.port, () => log(`api: http://localhost:${config.port}/  (health at /health)`));
  return server;
}
