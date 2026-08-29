// Self-check: ledger ACS at a pinned offset vs the mirror's active set as of that offset.
import { log } from "./config.mjs";
import { db, transaction, getMeta, upsertCreate } from "./db.mjs";
import { ledgerEnd, stream } from "./ledger.mjs";
import { acsRequest } from "./filter.mjs";
import { qnameOf } from "./reduce.mjs";

const activeAsOf = db.prepare("SELECT qname FROM contracts WHERE contract_id = ? AND created_offset <= ? AND (archived_offset IS NULL OR archived_offset > ?)");
const mirrorAsOf = db.prepare("SELECT contract_id, qname FROM contracts WHERE created_offset <= ? AND (archived_offset IS NULL OR archived_offset > ?)");
const insRun = db.prepare(`INSERT INTO verify_runs(started_at, finished_at, at_offset, ledger_count, mirror_count, only_in_ledger, only_in_mirror, repaired, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insFinding = db.prepare("INSERT OR REPLACE INTO verify_findings(run_id, contract_id, kind, qname, action) VALUES (?, ?, ?, ?, ?)");
const repairPhantom = db.prepare("UPDATE contracts SET archived_offset = ? WHERE contract_id = ? AND archived_offset IS NULL");
const repairPhantomHolding = db.prepare("UPDATE holdings SET archived_offset = ? WHERE contract_id = ? AND archived_offset IS NULL");

export const verifyState = { running: false, last: null };

export async function runVerify({ repair = true, waitMs = 60000 } = {}) {
  if (verifyState.running) throw new Error("verify already running");
  verifyState.running = true;
  const started = new Date().toISOString(); const t0 = Date.now();
  try {
    const E2 = await ledgerEnd();
    const tw = Date.now();
    while (Number(getMeta("offset")) < E2) {
      if (Date.now() - tw > waitMs) throw new Error(`cursor ${getMeta("offset")} did not reach ${E2} within ${waitMs} ms`);
      await new Promise(r => setTimeout(r, 500));
    }
    log(`verify: ledger end ${E2}, cursor ${getMeta("offset")}, streaming ACS`);
    const ledgerIds = new Set(); const missing = [];
    const res = await stream("/v2/state/active-contracts", acsRequest(E2), (m) => {
      const ce = m.contractEntry; if (!ce) return;
      const ev = ce.JsActiveContract?.createdEvent || ce.JsIncompleteAssigned?.assignedEvent?.createdEvent;
      if (!ev) return;
      ledgerIds.add(ev.contractId);
      if (!activeAsOf.get(ev.contractId, E2, E2)) missing.push({ ev, synchronizerId: ce.JsActiveContract?.synchronizerId });
    }, { watchdogSec: 60 });
    if (res.code !== 1000 && res.code !== 1005) throw new Error(`ACS stream closed with ${res.code}`);
    const mirror = mirrorAsOf.all(E2, E2);
    const phantom = mirror.filter(r => !ledgerIds.has(r.contract_id));
    let repaired = 0;
    const runId = transaction(() => {
      const r = insRun.run(started, new Date().toISOString(), E2, ledgerIds.size, mirror.length, missing.length, phantom.length, 0, Date.now() - t0);
      const id = Number(r.lastInsertRowid);
      for (const m of missing) {
        let action = "reported";
        if (repair) { upsertCreate(m.ev, { synchronizerId: m.synchronizerId }); action = "inserted"; repaired++; }
        insFinding.run(id, m.ev.contractId, "missing_in_mirror", qnameOf(m.ev.templateId), action);
      }
      for (const p of phantom) {
        let action = "reported";
        if (repair) { repairPhantom.run(E2, p.contract_id); repairPhantomHolding.run(E2, p.contract_id); action = "archived_at_" + E2; repaired++; }
        insFinding.run(id, p.contract_id, "phantom_in_mirror", p.qname, action);
      }
      db.prepare("UPDATE verify_runs SET repaired = ? WHERE id = ?").run(repaired, id);
      return id;
    });
    const out = { run_id: runId, at_offset: E2, ledger_count: ledgerIds.size, mirror_count: mirror.length,
      only_in_ledger: missing.length, only_in_mirror: phantom.length, repaired, duration_ms: Date.now() - t0,
      findings: [...missing.map(m => ({ kind: "missing_in_mirror", contract_id: m.ev.contractId, qname: qnameOf(m.ev.templateId) })),
                 ...phantom.map(p => ({ kind: "phantom_in_mirror", contract_id: p.contract_id, qname: p.qname }))].slice(0, 200) };
    verifyState.last = out;
    log(`verify: ledger ${out.ledger_count} vs mirror ${out.mirror_count} at ${E2}: ${out.only_in_ledger} missing, ${out.only_in_mirror} phantom, ${repaired} repaired, ${out.duration_ms} ms`);
    return out;
  } finally { verifyState.running = false; }
}
