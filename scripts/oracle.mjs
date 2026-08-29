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

let parties = process.argv.slice(2);
if (!parties.length) {
  const top = await j(`${API}/parties/top?limit=40`);
  parties = [...new Set(top.filter(t => t.instrument === "Amulet").map(t => t.party))].slice(0, 12);
}
const summary = await j(`${SCAN}/api/scan/v1/holdings/summary`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ migration_id: migrationId, record_time: snap.record_time, owner_party_ids: parties }) });
const byParty = new Map((summary.summaries || []).map(s => [s.party_id, s]));

let match = 0, mismatch = 0;
const rows = [];
for (const p of parties) {
  const ours = await fetch(`${API}/parties/${encodeURIComponent(p)}/balances`).then(r => r.ok ? r.json() : null);
  const cc = ours?.balances?.find(b => b.instrument === "Amulet");
  const theirs = byParty.get(p);
  const a = cc ? cc.balance : "0.0000000000", b = theirs ? theirs.total_coin_holdings : "n/a";
  const ok = theirs && cc && Number(a) === Number(b);
  if (ok) match++; else mismatch++;
  rows.push({ party: p.slice(0, 44), ours: a, scan: b, locked_ours: cc?.locked, locked_scan: theirs?.total_locked_coin, ok: ok ? "match" : "DIFF" });
}
console.table(rows);
console.log(`oracle: ${match} match, ${mismatch} differ out of ${parties.length} parties (as of scan snapshot ${snap.record_time}; our index is live, so parties active since the snapshot may differ)`);
