// Bootstrap: full ACS snapshot at a pinned offset over WS, or resume if a complete snapshot exists.
import { config, log } from "./config.mjs";
import { db, getMeta, setMeta, setCursor, upsertCreate, counts } from "./db.mjs";
import { ledgerEnd, prunedOffset, stream } from "./ledger.mjs";
import { acsRequest } from "./filter.mjs";

export async function bootstrapOrResume({ force = false } = {}) {
  if (!force && getMeta("snapshot_complete") === "1") {
    const off = Number(getMeta("offset"));
    log(`resume: snapshot complete at ${getMeta("snapshot_offset")}, cursor ${off}, re-reading 0 contracts`);
    return { resumed: true, offset: off };
  }
  const t0 = Date.now();
  const E = await ledgerEnd();
  const P = await prunedOffset();
  if (E < P) throw new Error(`ledger end ${E} below pruned offset ${P}`);
  db.exec("BEGIN");
  db.exec("DELETE FROM contracts; DELETE FROM stakeholders; DELETE FROM holdings; DELETE FROM events; DELETE FROM activity;");
  setMeta("snapshot_offset", E); setMeta("snapshot_complete", "0"); setMeta("pruned_offset", P);
  setMeta("orphan_archive_total", 0); setMeta("started_at", new Date().toISOString());
  db.exec("COMMIT");
  log(`bootstrap: ledger end ${E}, pruned up to ${P}, streaming ACS (${config.filterMode === "parties" ? config.parties.length + " parties" : "filtersForAnyParty"})`);

  let n = 0, bytes = 0, skipped = 0, holdings = 0, inTx = false;
  const begin = () => { db.exec("BEGIN"); inTx = true; };
  const commit = () => { if (inTx) { db.exec("COMMIT"); inTx = false; } };
  begin();
  let res;
  try {
    res = await stream("/v2/state/active-contracts", acsRequest(E), (m) => {
      const ce = m.contractEntry;
      if (!ce) return;
      let ev = null, syncId = null;
      if (ce.JsActiveContract) { ev = ce.JsActiveContract.createdEvent; syncId = ce.JsActiveContract.synchronizerId; }
      else if (ce.JsIncompleteAssigned) { ev = ce.JsIncompleteAssigned.assignedEvent?.createdEvent; syncId = ce.JsIncompleteAssigned.assignedEvent?.target; }
      else { skipped++; return; }
      if (!ev) { skipped++; return; }
      const r = upsertCreate(ev, { synchronizerId: syncId });
      if (r.holding) holdings++;
      n++;
      if (n % config.batchSize === 0) { commit(); begin(); if (n % 20000 === 0) log(`bootstrap: ${n} contracts`); }
    }, { watchdogSec: 60 });
    if (res.code !== 1000 && res.code !== 1005) throw new Error(`ACS stream closed with code ${res.code} ${res.reason}`);
    setMeta("offset", E); setMeta("record_time", null); setMeta("snapshot_complete", "1");
    setMeta("bootstrap_ms", Date.now() - t0); setMeta("bootstrap_contracts", n);
    setMeta("last_commit_at", new Date().toISOString());
    commit();
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    inTx = false;
    throw e;
  }
  const ms = Date.now() - t0;
  log(`bootstrap: ${n} contracts (${holdings} holdings, ${skipped} skipped) at offset ${E} in ${ms} ms`);
  return { resumed: false, offset: E, contracts: n, holdings, ms, counts: counts() };
}
