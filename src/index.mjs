#!/usr/bin/env node
// Lattice Scan entry point.
//   --check      auth + ledger reachability + rights summary
//   --bootstrap  force a fresh ACS snapshot (wipes the mirror)
//   --run        bootstrap-or-resume, then tail + API (+ optional verify timer)
//   --verify     one self-check run against the ledger and exit
import { config, log } from "./config.mjs";
import { token, tokenClaims } from "./token.mjs";
import { ledgerEnd, prunedOffset, version, authenticatedUser, get } from "./ledger.mjs";
import { bootstrapOrResume } from "./bootstrap.mjs";
import { backfillHistory } from "./backfill.mjs";
import { runTail } from "./tail.mjs";
import { startApi } from "./api.mjs";
import { runVerify } from "./verify.mjs";
import { counts, getMeta } from "./db.mjs";

const arg = process.argv[2] || "--run";

async function check() {
  const tok = await token();
  const claims = tokenClaims(tok);
  log(`token ok: sub=${claims?.sub} aud=${JSON.stringify(claims?.aud)} exp in ${claims ? claims.exp - Math.floor(Date.now() / 1000) : "?"}s`);
  const v = await version(); log(`ledger api version ${v.version}`);
  const me = await authenticatedUser(); log(`user ${me.user?.id}, primary party ${me.user?.primaryParty}`);
  const E = await ledgerEnd(), P = await prunedOffset();
  log(`ledger end ${E}, pruned up to ${P} (${E - P} offsets of readable history)`);
  try {
    const rights = await get(`/v2/users/${encodeURIComponent(me.user.id)}/rights`);
    const kinds = {};
    for (const r of rights.rights || []) { const k = Object.keys(r.kind)[0]; kinds[k] = (kinds[k] || 0) + 1; }
    log(`rights: ${JSON.stringify(kinds)}`);
    if (!kinds.CanReadAsAnyParty && config.filterMode === "any") log("WARNING: no CanReadAsAnyParty; filtersForAnyParty may 403. Set FILTER_MODE=parties and PARTIES=...");
  } catch (e) { log(`rights lookup failed: ${e.message}`); }
  log(`db ${config.dbPath}: ${JSON.stringify(counts())}, snapshot_complete=${getMeta("snapshot_complete") || "0"}, cursor=${getMeta("offset") || "none"}`);
}

async function run() {
  const r = await bootstrapOrResume();
  log(`mirror: ${JSON.stringify(counts())}`);
  startApi();
  try { await backfillHistory(); } catch (e) { log(`backfill failed (history starts at the snapshot): ${e.message}`); }
  const ac = new AbortController();
  process.on("SIGINT", () => { log("SIGINT, stopping"); ac.abort(); setTimeout(() => process.exit(0), 500); });
  process.on("SIGTERM", () => { ac.abort(); setTimeout(() => process.exit(0), 500); });
  if (config.verifyIntervalSec > 0) setInterval(() => runVerify().catch(e => log("verify error", e.message)), config.verifyIntervalSec * 1000);
  await runTail(ac.signal);
}

try {
  if (arg === "--check") await check();
  else if (arg === "--bootstrap") { const r = await bootstrapOrResume({ force: true }); log(JSON.stringify(r.counts || r)); }
  else if (arg === "--backfill") { const r = await backfillHistory({ force: true }); console.log(JSON.stringify(r)); }
  else if (arg === "--verify") { const r = await runVerify(); console.log(JSON.stringify(r, null, 1)); }
  else if (arg === "--run") await run();
  else { console.error("usage: index.mjs --check | --bootstrap | --run | --verify | --backfill"); process.exit(2); }
} catch (e) {
  log("fatal:", e.message || e);
  process.exit(1);
}
