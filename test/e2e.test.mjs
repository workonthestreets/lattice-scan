// Whole pipeline against the mock participant: snapshot, history backfill, tail, participant re-auth,
// checkpoints, self-check with repair, resume. No network, no DevNet credentials.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMockParticipant, SERVICE_TOKEN } from "./helpers/mock-participant.mjs";
import { setTestEnv, loadApp, waitFor, startTestApi } from "./helpers/app.mjs";
import { amulet, rewardCoupon, plain, created, archived, tx, ALICE, BOB, CAROL, DSO } from "./helpers/fixtures.mjs";

let mock, app, api, L;
const a1 = amulet({ owner: ALICE, amount: 100 });
const a2 = amulet({ owner: ALICE, amount: 60 }), b1 = amulet({ owner: BOB, amount: 40 });
const inst = plain({ signatories: [DSO], observers: [ALICE] });
const b1b = amulet({ owner: BOB, amount: 30 }), c1 = amulet({ owner: CAROL, amount: 10 });
const b2 = amulet({ owner: BOB, amount: 50 });

before(async () => {
  mock = await startMockParticipant();
  L = mock.ledger;
  // Ledger history: 10 create a1 (pruned away later), 20 transfer 40 alice->bob, 25 transfer 10 bob->carol, 30 mint b2 for bob.
  L.commit(tx(10, [created(a1), created(inst)]));
  L.commit(tx(20, [archived(a1), created(a2), created(b1)]));
  L.commit(tx(25, [archived(b1), created(b1b), created(c1)]));
  L.commit(tx(30, [created(b2)]));
  L.prune(15);
  setTestEnv(mock, { AUTH_MODE: "off", BATCH_SIZE: "2" });
  app = await loadApp();
});
after(async () => { if (api) await api.close(); await mock.close(); });

const meta = (k) => app.db.getMeta(k);
const q = (sql, ...a) => JSON.parse(JSON.stringify(app.db.db.prepare(sql).all(...a)));

test("bootstrap streams the ACS at ledger end with the wildcard + Holding filter and commits the cursor with the last batch", async () => {
  const r = await app.bootstrap.bootstrapOrResume();
  assert.equal(r.resumed, false); assert.equal(r.offset, 30); assert.equal(r.contracts, 5); assert.equal(r.holdings, 4);
  assert.equal(meta("snapshot_complete"), "1"); assert.equal(meta("offset"), "30"); assert.equal(meta("pruned_offset"), "15");
  assert.equal(L.tokenMints, 1, "one client-credentials mint");
  const acsReq = L.requests.find(x => x.path === "/v2/state/active-contracts").request;
  assert.equal(acsReq.activeAtOffset, 30);
  assert.equal(acsReq.filter.filtersForAnyParty.cumulative.length, 2);
  assert.ok(acsReq.filter.filtersForAnyParty.cumulative[0].identifierFilter.WildcardFilter);
  const ifl = acsReq.filter.filtersForAnyParty.cumulative[1].identifierFilter.InterfaceFilter.value;
  assert.equal(ifl.includeInterfaceView, true); assert.match(ifl.interfaceId, /Splice\.Api\.Token\.HoldingV1:Holding$/);
  assert.equal(q("SELECT count(*) AS n FROM events")[0].n, 0, "the snapshot carries no events");
  assert.equal(q("SELECT created_offset FROM contracts WHERE contract_id = ?", a2.contractId)[0].created_offset, 20, "original creation offset kept");
});

test("backfill replays the readable window before the snapshot and survives the pruning floor moving mid-request", async () => {
  // The floor moves to 18 between the live floor read (still reporting 15) and the stream request:
  // the first request (begin 15) is refused with earliest_offset 18 and must be retried from there.
  L.prune(18); L.httpPruned = 15;
  const r = await app.backfill.backfillHistory();
  L.httpPruned = null;
  assert.equal(r.from, 19); assert.equal(r.to, 30); assert.equal(r.updates, 3); assert.equal(r.events, 7);
  assert.equal(meta("pruned_offset"), "18"); assert.equal(meta("backfill_done"), "1");
  const reqs = L.requests.filter(x => x.path === "/v2/updates").map(x => x.request);
  assert.deepEqual(reqs.map(x => [x.beginExclusive, x.endInclusive]), [[15, 30], [18, 30]]);
  assert.equal(reqs[0].updateFormat.includeTransactions.transactionShape, "TRANSACTION_SHAPE_ACS_DELTA");
  const act = q("SELECT offset, party, kind, amount, counterparty FROM activity ORDER BY offset, party");
  assert.deepEqual(act, [
    // Offset 20 spent a1, which was created before the pruning floor: its amount is not knowable from an
    // ArchivedEvent, so the scanner reports the inflows as unclassified (low confidence) instead of guessing.
    { offset: 20, party: ALICE, kind: "unclassified", amount: "60.0000000000", counterparty: null },
    { offset: 20, party: BOB, kind: "unclassified", amount: "40.0000000000", counterparty: null },
    // Offset 25 spent b1, created inside the window: exact classification with counterparties.
    { offset: 25, party: BOB, kind: "transfer_out", amount: "10.0000000000", counterparty: CAROL },
    { offset: 25, party: CAROL, kind: "transfer_in", amount: "10.0000000000", counterparty: BOB },
    { offset: 30, party: BOB, kind: "mint", amount: "50.0000000000", counterparty: null },
  ]);
  assert.equal(q("SELECT confidence FROM activity WHERE offset = 20")[0].confidence, "low");
  assert.equal(q("SELECT archived_offset FROM contracts WHERE contract_id = ?", b1.contractId)[0].archived_offset, 25, "contract created and archived inside the window carries both offsets");
  // a1 was archived inside the window but created before the floor: it is an event, not a mirror row, and not an orphan.
  assert.equal(q("SELECT count(*) AS n FROM contracts WHERE contract_id = ?", a1.contractId)[0].n, 0);
  assert.equal(q("SELECT kind FROM events WHERE contract_id = ?", a1.contractId)[0].kind, "archived");
  assert.equal(app.db.getMetaInt("orphan_archive_total"), 0);
  assert.equal(app.db.counts().contracts_active, 5, "the active set is untouched by the backfill");
  const again = await app.backfill.backfillHistory();
  assert.equal(again.skipped, true);
});

test("API reflects the mirror; health reports the history floor and degraded until the tail connects", async () => {
  api = startTestApi(app.api);
  const h = (await api.get("/health")).body;
  assert.equal(h.status, "degraded"); assert.equal(h.history_from_offset, 19); assert.deepEqual(h.backfill.updates, 3);
  assert.equal(h.cursor_offset, 30); assert.equal(h.ledger_end, 30);
  const bob = (await api.get(`/parties/${BOB}/balances`)).body.balances[0];
  assert.equal(bob.balance, "80.0000000000"); assert.equal(bob.utxo_count, 2);
});

let tailAbort, tailDone;
test("tail connects from the cursor (exclusive) and applies live transactions atomically", async () => {
  tailAbort = new AbortController();
  tailDone = app.tail.runTail(tailAbort.signal);
  await waitFor(() => L.tails.size === 1, { label: "tail socket" });
  assert.equal(app.tail.tailState.connected, true);
  const req = L.requests.filter(x => x.path === "/v2/updates").at(-1).request;
  assert.equal(req.beginExclusive, 30); assert.equal(req.endInclusive, undefined);
  assert.equal((await api.get("/health")).body.status, "ok");

  // bob merges b1b + b2 into one UTXO
  const b3 = amulet({ owner: BOB, amount: 80 });
  L.commit(tx(40, [archived(b1b), archived(b2), created(b3)]));
  await waitFor(() => meta("offset") === "40", { label: "cursor 40" });
  const bob = (await api.get(`/parties/${BOB}/balances`)).body.balances[0];
  assert.equal(bob.balance, "80.0000000000"); assert.equal(bob.utxo_count, 1);
  assert.equal(q("SELECT kind FROM activity WHERE offset = 40")[0].kind, "self_merge");
  assert.equal(app.tail.tailState.updatesApplied, 1);
});

test("STALE_STREAM_AUTHORIZATION is an immediate reconnect from the committed cursor, counted separately", async () => {
  const errorsBefore = app.tail.tailState.errors;
  L.staleAuth();
  await waitFor(() => app.tail.tailState.staleAuthReconnects === 1 && L.tails.size === 1, { label: "reconnect after stale auth" });
  assert.equal(app.tail.tailState.errors, errorsBefore, "not counted as an error");
  const req = L.requests.filter(x => x.path === "/v2/updates").at(-1).request;
  assert.equal(req.beginExclusive, 40, "resumed from the committed cursor, not from the snapshot");
  // alice collects a reward
  const a3 = amulet({ owner: ALICE, amount: 1.5 }), rc = rewardCoupon({ owner: ALICE });
  L.commit(tx(50, [created(rc)]));
  L.commit(tx(51, [archived(rc), created(a3)]));
  await waitFor(() => meta("offset") === "51", { label: "cursor 51" });
  assert.equal(q("SELECT kind FROM activity WHERE offset = 51")[0].kind, "reward_collect");
});

test("an abnormal close is retried with backoff and the stream resumes", async () => {
  L.dropTails();
  await waitFor(() => L.tails.size === 1 && app.tail.tailState.reconnects >= 2, { label: "reconnect after drop" });
  L.commit(tx(55, [created(amulet({ owner: CAROL, amount: 7 }))]));
  await waitFor(() => meta("offset") === "55", { label: "cursor 55" });
  assert.equal((await api.get(`/parties/${CAROL}/balances`)).body.balances[0].balance, "17.0000000000");
});

test("OffsetCheckpoint frames advance the cursor and record time during quiet periods", async () => {
  L.checkpoint(60, "2026-08-29T13:00:00.000000Z");
  await waitFor(() => meta("offset") === "60", { label: "checkpoint cursor" });
  assert.equal(meta("record_time"), "2026-08-29T13:00:00.000000Z");
  const h = await waitFor(async () => { const b = (await api.get("/health")).body; return b.ledger_end === 60 ? b : null; }, { label: "ledger end cache (2 s) to refresh", timeoutMs: 4000 });
  assert.equal(h.gap_offsets, 0); assert.equal(h.cursor_offset, 60);
});

test("self-check: exact mirror is 0/0; a corrupted mirror is found and repaired; the next run is clean again", async () => {
  const clean = await app.verify.runVerify();
  // active at 60: inst, a2, c1, b3, a3, carol's 7 (a1, b1, b1b, b2, rc archived)
  assert.equal(clean.at_offset, 60); assert.equal(clean.ledger_count, 6); assert.equal(clean.mirror_count, 6);
  assert.equal(clean.only_in_ledger, 0); assert.equal(clean.only_in_mirror, 0);

  // Corrupt: drop a real contract (missing) and plant a fake active one (phantom).
  const realId = q("SELECT contract_id FROM holdings WHERE owner = ? AND archived_offset IS NULL AND amount = '7.0000000000'", CAROL)[0].contract_id;
  app.db.db.prepare("DELETE FROM contracts WHERE contract_id = ?").run(realId);
  app.db.db.prepare("DELETE FROM holdings WHERE contract_id = ?").run(realId);
  const ghost = plain({ contractId: "00ghost", signatories: [DSO] }); ghost.offset = 45; ghost.nodeId = 0;
  app.db.upsertCreate(ghost, {});
  const r = await app.verify.runVerify();
  assert.equal(r.only_in_ledger, 1); assert.equal(r.only_in_mirror, 1); assert.equal(r.repaired, 2);
  assert.deepEqual(r.findings.map(f => f.kind).sort(), ["missing_in_mirror", "phantom_in_mirror"]);
  assert.equal(q("SELECT archived_offset FROM contracts WHERE contract_id = '00ghost'")[0].archived_offset, 60, "phantom archived at the check offset");
  assert.equal((await api.get(`/parties/${CAROL}/balances`)).body.balances[0].balance, "17.0000000000", "missing holding restored");
  const again = await app.verify.runVerify();
  assert.equal(again.only_in_ledger + again.only_in_mirror, 0);
  const v = (await api.get("/verify")).body;
  assert.equal(v.runs.length, 3); assert.equal(v.runs[1].repaired, 2);
});

test("verify refuses to run concurrently and times out if the cursor cannot reach ledger end", async () => {
  L.end = 999; // ledger end far ahead of anything the tail will see
  const p1 = app.verify.runVerify({ waitMs: 300 });
  await assert.rejects(app.verify.runVerify(), /already running/);
  await assert.rejects(p1, /did not reach 999/);
  L.end = 60;
});

test("restart resumes from the committed cursor and re-reads nothing", async () => {
  tailAbort.abort();
  await tailDone;
  assert.equal(app.tail.tailState.running, false);
  const mintsBefore = L.tokenMints, reqsBefore = L.requests.length;
  const r = await app.bootstrap.bootstrapOrResume();
  assert.deepEqual(r, { resumed: true, offset: 60 });
  assert.equal(L.requests.length, reqsBefore, "no ACS stream on resume");
  assert.equal(L.tokenMints, mintsBefore);
  assert.equal(app.db.counts().contracts_active, 6);
});

test("a forced bootstrap wipes and rebuilds the mirror at the new ledger end", async () => {
  const r = await app.bootstrap.bootstrapOrResume({ force: true });
  assert.equal(r.resumed, false); assert.equal(r.offset, 60); assert.equal(r.contracts, 6);
  assert.equal(q("SELECT count(*) AS n FROM events")[0].n, 0);
  assert.equal(meta("backfill_done"), "1", "backfill flag is separate; --run would not replay unless forced");
});
