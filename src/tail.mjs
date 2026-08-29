// Tail: WS /v2/updates from the committed cursor (exclusive), one SQLite transaction per update.
import { config, log } from "./config.mjs";
import { transaction, getMeta, setMeta, getMetaInt, setCursor, upsertCreate, archive, insertActivity } from "./db.mjs";
import { stream } from "./ledger.mjs";
import { updatesRequest } from "./filter.mjs";
import { classify, qnameOf } from "./reduce.mjs";
import { token, tokenTtlMs } from "./token.mjs";

export const tailState = { connected: false, reconnects: 0, staleAuthReconnects: 0, lastFrameAt: null, lastUpdateAt: null, updatesApplied: 0, errors: 0, running: false, lastError: null, connectedAt: null };

export function applyTx(tx) {
  return transaction(() => {
    const ctx = { updateId: tx.updateId, recordTime: tx.recordTime, effectiveAt: tx.effectiveAt, synchronizerId: tx.synchronizerId };
    const created = [], archived = [], createdQnames = [];
    for (const e of tx.events || []) {
      if (e.CreatedEvent) {
        const ev = e.CreatedEvent;
        const r = upsertCreate(ev, ctx);
        createdQnames.push(r.qname);
        created.push({ contractId: ev.contractId, qname: r.qname, holding: r.holding });
      } else if (e.ArchivedEvent) {
        const ev = e.ArchivedEvent;
        const r = archive(ev, ctx);
        archived.push({ contractId: ev.contractId, qname: r.qname, holding: r.holding });
      } else if (e.ExercisedEvent && e.ExercisedEvent.consuming && e.ExercisedEvent.acsDelta) {
        const ev = e.ExercisedEvent;
        const r = archive({ ...ev, templateId: ev.templateId }, ctx);
        archived.push({ contractId: ev.contractId, qname: r.qname, holding: r.holding });
      }
    }
    for (const row of classify(tx, created, archived, createdQnames)) insertActivity(row);
    setCursor(tx.offset, tx.recordTime);
    setMeta("updates_applied", getMetaInt("updates_applied") + 1);
    return { created: created.length, archived: archived.length };
  });
}

function handleFrame(m) {
  tailState.lastFrameAt = Date.now();
  if (!m.update) return;
  const kind = Object.keys(m.update)[0];
  const v = m.update[kind]?.value ?? m.update[kind];
  switch (kind) {
    case "Transaction": {
      const r = applyTx(v);
      tailState.updatesApplied++; tailState.lastUpdateAt = Date.now();
      log(`update ${v.offset}: ${r.created} created, ${r.archived} archived (${v.updateId.slice(0, 12)})`);
      break;
    }
    case "OffsetCheckpoint": {
      const rt = v.synchronizerTimes?.[0]?.recordTime;
      transaction(() => setCursor(v.offset, rt));
      break;
    }
    case "Reassignment":
    case "TopologyTransaction": {
      transaction(() => setCursor(v.offset, v.recordTime));
      log(`${kind} at ${v.offset}`);
      break;
    }
    default:
      log(`unknown update kind ${kind}`);
  }
}

export async function runTail(signal) {
  tailState.running = true;
  let backoff = 1000;
  while (!signal?.aborted) {
    const cursor = Number(getMeta("offset"));
    if (!Number.isFinite(cursor)) throw new Error("no cursor; bootstrap first");
    const recycle = new AbortController();
    const recycleMs = Math.min(config.socketRecycleSec * 1000, Math.max(60_000, tokenTtlMs() * 0.8));
    const recycleTimer = setTimeout(() => { log("tail: recycling socket for a fresh token"); recycle.abort(); }, recycleMs);
    const onAbort = () => recycle.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await token();
      log(`tail: connecting from offset ${cursor} (exclusive)`);
      tailState.connected = true; tailState.connectedAt = Date.now();
      const res = await stream("/v2/updates", updatesRequest(cursor), handleFrame, { watchdogSec: config.watchdogSec, signal: recycle.signal });
      tailState.connected = false;
      if (signal?.aborted) break;
      log(`tail: stream closed (${res.code} ${res.reason || ""}), ${res.frames} frames; reconnecting from ${getMeta("offset")}`);
      backoff = 1000;
    } catch (e) {
      tailState.connected = false;
      const code = e.canton?.code;
      if (e.status === 403) { log("tail: 403, the token has no rights for this filter; set FILTER_MODE=parties"); throw e; }
      if (code === "STALE_STREAM_AUTHORIZATION") {
        // The participant re-checks stream authorization periodically and asks us to reconnect. Normal, not an
        // error, but never a tight loop: short pause, fresh token, then resume from the committed cursor.
        tailState.staleAuthReconnects++;
        log(`tail: participant asked for re-authorization (${code}); reconnecting from ${getMeta("offset")}`);
        await new Promise(r => setTimeout(r, 1000));
        try { await token(true); } catch (e2) { log(`tail: token re-mint failed: ${e2.message}`); }
        continue;
      }
      tailState.errors++; tailState.lastError = String(e.message || e).slice(0, 300);
      if (tailState.connectedAt && Date.now() - tailState.connectedAt > 30000) backoff = 1000; // a long-lived stream resets the backoff
      log(`tail: error ${tailState.lastError}; retry in ${backoff} ms`);
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    } finally {
      clearTimeout(recycleTimer);
      signal?.removeEventListener("abort", onAbort);
      tailState.reconnects++;
    }
  }
  tailState.running = false;
}
