#!/usr/bin/env node
// Correctness oracle: our Canton Coin balances vs the public Scan API holdings summary
// (network-wide, no auth; the DSO is a signatory on every Amulet). Snapshot is hourly.
// usage: node scripts/oracle.mjs [party ...]   (default: top CC parties from our own index)
import { config } from "../src/config.mjs";

const API = process.env.API || `http://localhost:${config.port}`;
const SCAN = config.scanUrl;

async function j(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(`${r.status} ${url}: ${(await r.text()).slice(0, 200)}`); return r.json(); }

const dso = await j(`${SCAN}/api/scan/v0/dso`);
const migrationId = Number(dso.dso_rules?.contract?.payload?.config?.migrationId ?? JSON.stringify(dso).match(/"migrationId":"(\d+)"/)?.[1] ?? 1);
const snap = await j(`${SCAN}/api/scan/v0/state/acs/snapshot-timestamp?before=${encodeURIComponent(new Date().toISOString())}&migration_id=${migrationId}`);
console.log(`scan oracle: migration ${migrationId}, snapshot record_time ${snap.record_time}`);

// The Scan API refuses any query whose holdings exceed 1,000 contracts ("Size of the result exceeded the
// limit in queryAcsSnapshot ... Limit: 1000"), so: pick parties with few UTXOs by default, and query one party
// per request so a single fragmented party cannot sink the whole batch.
const SCAN_HOLDINGS_CAP = 1000;
let parties = process.argv.slice(2);
if (!parties.length) {
  const top = await j(`${API}/parties/top?instrument=Amulet&max_utxos=100&order=balance&limit=12`);
  parties = top.map(t => t.party);
}

async function scanSummary(party) {
  const r = await fetch(`${SCAN}/api/scan/v1/holdings/summary`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ migration_id: migrationId, record_time: snap.record_time, owner_party_ids: [party] }) });
  const text = await r.text();
  if (!r.ok) return { error: text.includes("exceeded the limit") ? `scan cap: more than ${SCAN_HOLDINGS_CAP} holdings` : `HTTP ${r.status}` };
  return JSON.parse(text).summaries?.[0] || { error: "no summary" };
}

let match = 0, mismatch = 0, skipped = 0, moved = 0;
const rows = [];
for (const p of parties) {
  const ours = await fetch(`${API}/parties/${encodeURIComponent(p)}/balances`).then(r => r.ok ? r.json() : null);
  const cc = ours?.balances?.find(b => b.instrument === "Amulet");
  const theirs = await scanSummary(p);
  const a = cc ? cc.balance : "0.0000000000";
  if (theirs.error) { skipped++; rows.push({ party: p.slice(0, 44), ours: a, scan: theirs.error, utxos: cc?.utxo_count, ok: "skipped" }); continue; }
  const b = theirs.total_coin_holdings;
  const ok = cc && a === b;
  let status = ok ? "match" : "DIFF";
  if (!ok) {
    // Our index is live; the Scan snapshot is hourly. If the party moved coin after the snapshot, the
    // difference is expected and is not evidence against either side.
    const hist = await fetch(`${API}/parties/${encodeURIComponent(p)}/history?limit=1`).then(r => r.ok ? r.json() : null);
    const lastMove = hist?.classified?.[0]?.record_time;
    if (lastMove && lastMove > snap.record_time) { status = "moved since snapshot"; moved++; }
    else mismatch++;
  } else match++;
  rows.push({ party: p.slice(0, 44), ours: a, scan: b, utxos: cc?.utxo_count, locked_ours: cc?.locked, locked_scan: theirs.total_locked_coin, ok: status });
}
console.table(rows);
console.log(`oracle: ${match} match, ${mismatch} differ, ${moved} moved since the snapshot (not comparable), ${skipped} skipped (Scan API cap) out of ${parties.length} parties, as of scan snapshot ${snap.record_time}.`);
if (mismatch > 0) process.exitCode = 1;
