// History backfill: replay the readable window BEFORE the snapshot (pruned offset + 1 .. snapshot offset)
// into events/activity, so transfer history reaches as far back as the participant still holds.
// The active set is NOT touched by this pass: the ACS at the snapshot offset already reflects every
// create/archive in the window. Contracts created inside the window and archived inside it are added
// to the mirror with both offsets set, which keeps the "as of offset" queries and the self-check exact.
import { log } from "./config.mjs";
import { db, transaction, getMeta, setMeta, getMetaInt, upsertCreate, archive, insertActivity } from "./db.mjs";
import { stream, prunedOffset } from "./ledger.mjs";
import { updatesRequest } from "./filter.mjs";
import { classify } from "./reduce.mjs";

const getContract = db.prepare("SELECT contract_id, created_offset, archived_offset FROM contracts WHERE contract_id = ?");
const setArchivedIfEarlier = db.prepare("UPDATE contracts SET archived_offset = ? WHERE contract_id = ? AND (archived_offset IS NULL OR archived_offset > ?)");
const setHoldingArchived = db.prepare("UPDATE holdings SET archived_offset = ? WHERE contract_id = ? AND (archived_offset IS NULL OR archived_offset > ?)");

function applyHistoryTx(tx, snapshotOffset) {
  return transaction(() => {
    const ctx = { updateId: tx.updateId, recordTime: tx.recordTime, effectiveAt: tx.effectiveAt, synchronizerId: tx.synchronizerId, backfill: true };
    const created = [], archived = [], createdQnames = [];
    for (const e of tx.events || []) {
      if (e.CreatedEvent) {
        const ev = e.CreatedEvent;
        // If the ACS already has it (still active at the snapshot), upsertCreate is a no-op apart from the events row.
        const r = upsertCreate(ev, ctx);
        createdQnames.push(r.qname);
        created.push({ contractId: ev.contractId, qname: r.qname, holding: r.holding });
      } else if (e.ArchivedEvent) {
        const ev = e.ArchivedEvent;
        // Archive inside the window: the contract is either one we just inserted from this window, or unknown
        // (created before the pruned floor). Never touch anything active at the snapshot.
        const row = getContract.get(ev.contractId);
        const r = archive(ev, ctx);
        if (row && row.created_offset !== null && row.created_offset <= ev.offset && ev.offset <= snapshotOffset) {
          setArchivedIfEarlier.run(ev.offset, ev.contractId, ev.offset);
          setHoldingArchived.run(ev.offset, ev.contractId, ev.offset);
        }
        archived.push({ contractId: ev.contractId, qname: r.qname, holding: r.holding });
      }
    }
    for (const row of classify(tx, created, archived, createdQnames)) insertActivity(row);
    return { created: created.length, archived: archived.length };
  });
}

export async function backfillHistory({ force = false } = {}) {
  if (!force && getMeta("backfill_done") === "1") {
    log(`backfill: already done (${getMeta("backfill_updates")} updates from ${getMeta("backfill_from")} to ${getMeta("snapshot_offset")})`);
    return { skipped: true };
  }
  const E = getMetaInt("snapshot_offset", null);
  if (E === null) throw new Error("no snapshot; bootstrap first");
  // The participant prunes continuously: always read the live floor, never the one stored at bootstrap.
  let P = Math.max(getMetaInt("pruned_offset", 0), await prunedOffset());
  setMeta("pruned_offset", P);
  if (P >= E) { setMeta("backfill_done", "1"); return { updates: 0 }; }
  const t0 = Date.now();
  let updates = 0, events = 0, last = P, res = null;
  const onFrame = (m) => {
    if (!m.update) return;
    const kind = Object.keys(m.update)[0];
    const v = m.update[kind]?.value ?? m.update[kind];
    if (kind === "Transaction" && v.offset <= E) {
      const r = applyHistoryTx(v, E);
      updates++; events += r.created + r.archived; last = v.offset;
      if (updates % 100 === 0) log(`backfill: ${updates} updates, at offset ${v.offset}`);
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    log(`backfill: replaying updates ${P + 1}..${E} (${E - P} offsets) into history`);
    try {
      res = await stream("/v2/updates", { ...updatesRequest(P), endInclusive: E }, onFrame, { watchdogSec: 60 });
      break;
    } catch (e) {
      const earliest = Number(e.canton?.context?.earliest_offset);
      if (e.canton?.code === "PARTICIPANT_PRUNED_DATA_ACCESSED" && Number.isFinite(earliest) && earliest > P) {
        log(`backfill: floor moved to ${earliest} while we were asking; retrying from there`);
        P = earliest; setMeta("pruned_offset", P);
        continue;
      }
      throw e;
    }
  }
  if (!res) throw new Error("backfill: could not find a readable window");
  transaction(() => {
    setMeta("backfill_done", "1"); setMeta("backfill_from", P + 1); setMeta("backfill_updates", updates);
    setMeta("backfill_events", events); setMeta("backfill_ms", Date.now() - t0);
  });
  log(`backfill: ${updates} updates, ${events} events, last offset ${last}, stream closed ${res.code}, ${Date.now() - t0} ms`);
  return { updates, events, from: P + 1, to: E, ms: Date.now() - t0 };
}
