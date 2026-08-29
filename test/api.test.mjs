// Every API route plus the authorization gate, against a seeded in-memory mirror and a mock participant.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMockParticipant, SERVICE_TOKEN, actAsRights } from "./helpers/mock-participant.mjs";
import { setTestEnv, loadApp, startTestApi } from "./helpers/app.mjs";
import { amulet, lockedAmulet, c8Holding, plain, rewardCoupon, created, archived, tx, ALICE, BOB, CAROL, DSO } from "./helpers/fixtures.mjs";

const ALICE_TOKEN = "alice-token";
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXPIRED_JWT = `${b64url({ alg: "none" })}.${b64url({ sub: "x", exp: Math.floor(Date.now() / 1000) - 60 })}.sig`;

let mock, app, api, seeded;
before(async () => {
  mock = await startMockParticipant({ tokens: { [ALICE_TOKEN]: { user: { id: "alice-user", primaryParty: ALICE }, rights: actAsRights([ALICE]) } } });
  setTestEnv(mock, { AUTH_MODE: "ledger" });
  app = await loadApp();
  // Seed: apply the same transactions to the mock ledger and to the mirror (as the tail would).
  const a1 = amulet({ owner: ALICE, amount: 100, round: 100 });
  const a2 = amulet({ owner: ALICE, amount: 60, round: 105 }), b1 = amulet({ owner: BOB, amount: 40, round: 105 });
  const a3 = amulet({ owner: ALICE, amount: 55, round: 105 }), la = lockedAmulet({ owner: ALICE, amount: 5, holders: [DSO] });
  const ce = c8Holding({ family: "CETH", owner: ALICE, amount: 1.25 });
  const inst = plain({ qname: "Splice.Wallet.Install:WalletAppInstall", signatories: [DSO], observers: [BOB] });
  const rc = rewardCoupon({ owner: BOB });
  const b2 = amulet({ owner: BOB, amount: 2, round: 108 });
  const txs = [
    tx(10, [created(a1), created(inst)]),
    tx(20, [archived(a1), created(a2), created(b1)]),
    tx(30, [archived(a2), created(a3), created(la), created(ce), created(rc)]),
    tx(40, [archived(rc), created(b2)]),
  ];
  for (const t of txs) { mock.ledger.commit(t); app.tail.applyTx(t); }
  app.db.setMeta("snapshot_complete", "1"); app.db.setMeta("snapshot_offset", 5); app.db.setMeta("pruned_offset", 0);
  seeded = { a1, a2, a3, b1, la, ce, inst, rc, b2, txs };
  api = startTestApi(app.api, { token: SERVICE_TOKEN });
});
after(async () => { await api.close(); await mock.close(); });

describe("open routes", () => {
  test("GET / serves the dashboard, static files have the right MIME, unknown static is 404", async () => {
    const r = await fetch(api.base() + "/"); assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/html/);
    const js = await fetch(api.base() + "/app.js"); assert.equal(js.status, 200); assert.match(js.headers.get("content-type"), /javascript/);
    assert.equal((await api.get("/nope.js", null)).status, 401, "anything that is not a known static file is ledger data and gated");
    assert.equal((await api.get("/nope.js")).status, 404);
  });
  test("GET /health needs no token and reports offsets, counts, tail and boundary", async () => {
    const { status, body } = await api.get("/health", null);
    assert.equal(status, 200);
    assert.equal(body.status, "degraded", "snapshot complete but tail not connected in this test");
    assert.equal(body.cursor_offset, 40); assert.equal(body.ledger_end, 40); assert.equal(body.gap_offsets, 0);
    assert.equal(body.contracts_total, 9); assert.equal(body.contracts_active, 6); assert.equal(body.holdings_active, 5);
    assert.equal(body.history_from_offset, 5, "no backfill -> history starts at the snapshot");
    assert.equal(body.auth_mode, "ledger"); assert.equal(body.filter_mode, "any");
    assert.equal(typeof body.lag_seconds, "number"); assert.match(body.boundary, /pruned offset/);
    assert.equal(body.tail.connected, false);
  });
  test("CORS preflight is answered", async () => {
    const r = await fetch(api.base() + "/parties/x/balances", { method: "OPTIONS" });
    assert.equal(r.status, 204); assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.match(r.headers.get("access-control-allow-headers"), /authorization/);
  });
});

describe("authorization gate (AUTH_MODE=ledger)", () => {
  test("no token -> 401 with a plain explanation", async () => {
    const { status, body } = await api.get(`/parties/${ALICE}/balances`, null);
    assert.equal(status, 401); assert.equal(body.error, "unauthorized"); assert.match(body.detail, /bearer token/i);
  });
  test("token the participant rejects -> 401 quoting the participant's cause", async () => {
    const { status, body } = await api.get(`/parties/${ALICE}/balances`, "garbage");
    assert.equal(status, 401); assert.match(body.detail, /participant rejected this token: The supplied authentication is invalid/);
  });
  test("expired JWT is rejected locally without asking the participant", async () => {
    const before = mock.ledger.http.length;
    const { status, body } = await api.get(`/parties/${ALICE}/balances`, EXPIRED_JWT);
    assert.equal(status, 401); assert.match(body.detail, /expired/);
    assert.equal(mock.ledger.http.length, before);
  });
  test("party-scoped token reads its own party, gets 403 on another, 403 on participant-wide views", async () => {
    assert.equal((await api.get(`/parties/${ALICE}/balances`, ALICE_TOKEN)).status, 200);
    const other = await api.get(`/parties/${BOB}/balances`, ALICE_TOKEN);
    assert.equal(other.status, 403); assert.match(other.body.detail, /participant, not the scanner/);
    for (const p of ["/templates", "/updates/recent", "/activity/kinds", "/verify", "/parties/top"]) {
      const r = await api.get(p, ALICE_TOKEN);
      assert.equal(r.status, 403, p); assert.match(r.body.detail, /CanReadAsAnyParty/);
    }
    const c = await api.get(`/contracts/${seeded.b1.contractId}`, ALICE_TOKEN);
    assert.equal(c.status, 403, "contract with no readable stakeholder");
    assert.equal((await api.get(`/contracts/${seeded.a3.contractId}`, ALICE_TOKEN)).status, 200);
  });
  test("/auth/whoami describes the token's rights; results are cached per token", async () => {
    const me = await api.get("/auth/whoami", ALICE_TOKEN);
    assert.deepEqual(me.body, { mode: "ledger", user: "alice-user", any_party: false, primary_party: ALICE, parties_count: 1, token_expires_at: null });
    const n = mock.ledger.http.length;
    await api.get("/auth/whoami", ALICE_TOKEN);
    assert.equal(mock.ledger.http.length, n, "second call served from the auth cache");
    const svc = await api.get("/auth/whoami");
    assert.equal(svc.body.any_party, true); assert.equal(svc.body.user, "validator-backend");
  });
  test("/auth/token/demo is 404 until DEMO_LOGIN=1, then mints with the scanner's own credentials", async () => {
    assert.equal((await api.get("/health")).body.demo_login, false);
    const off = await api.post("/auth/token/demo", null);
    assert.equal(off.status, 404); assert.match(off.body.detail, /DEMO_LOGIN=1/);
    app.config.demoLogin = true;
    try {
      assert.equal((await api.get("/health")).body.demo_login, true);
      const mints = mock.ledger.tokenMints;
      const on = await api.post("/auth/token/demo", null);
      assert.equal(on.status, 200); assert.equal(on.body.access_token, SERVICE_TOKEN); assert.equal(mock.ledger.tokenMints, mints + 1);
      const me = await api.get("/auth/whoami", on.body.access_token);
      assert.equal(me.body.any_party, true);
    } finally { app.config.demoLogin = false; }
  });
  test("/search only returns parties the token may read", async () => {
    assert.deepEqual((await api.get("/search?q=1220", ALICE_TOKEN)).body, [ALICE]);
    assert.deepEqual((await api.get("/search?q=1220")).body.sort(), [DSO, ALICE, BOB].sort());
    assert.deepEqual((await api.get("/search?q=a")).body, [], "queries under 2 chars return nothing");
  });
});

describe("party routes", () => {
  test("balances aggregate per instrument: balance, locked, available, utxo counts, effective after fees", async () => {
    const { status, body } = await api.get(`/parties/${ALICE}/balances`);
    assert.equal(status, 200); assert.equal(body.party, ALICE); assert.equal(body.as_of_offset, 40); assert.equal(body.current_round, 110);
    const cc = body.balances.find(b => b.instrument === "Amulet");
    assert.equal(cc.balance, "60.0000000000"); assert.equal(cc.locked, "5.0000000000"); assert.equal(cc.available, "55.0000000000");
    assert.equal(cc.utxo_count, 2); assert.equal(cc.locked_count, 1); assert.equal(cc.admin, DSO);
    // a3: 55 at round 105 -> 5 rounds * 0.0000190259 ; la: 5 at round 100 -> 10 rounds
    assert.equal(cc.effective_after_holding_fees, "59.9997146115");
    const eth = body.balances.find(b => b.instrument === "c8ETH");
    assert.equal(eth.balance, "1.2500000000"); assert.equal(eth.effective_after_holding_fees, null);
  });
  test("GET /parties/{party} is the balances view too", async () => {
    assert.equal((await api.get(`/parties/${BOB}`)).body.balances[0].balance, "42.0000000000");
  });
  test("unknown party -> 404 with the boundary message, not a zero balance", async () => {
    const r = await api.get(`/parties/${CAROL}/balances`);
    assert.equal(r.status, 404); assert.match(r.body.detail, /boundary/);
    assert.equal((await api.get(`/parties/${CAROL}/holdings`)).status, 404);
  });
  test("holdings filter by instrument and lock state, limit applies", async () => {
    const all = (await api.get(`/parties/${ALICE}/holdings`)).body;
    assert.equal(all.length, 3);
    const locked = (await api.get(`/parties/${ALICE}/holdings?locked=1`)).body;
    assert.equal(locked.length, 1); assert.equal(locked[0].locked, true); assert.deepEqual(locked[0].lock_holders, [DSO]);
    const cc = (await api.get(`/parties/${ALICE}/holdings?instrument=Amulet&locked=0`)).body;
    assert.equal(cc.length, 1); assert.equal(cc[0].contract_id, seeded.a3.contractId);
    assert.equal((await api.get(`/parties/${ALICE}/holdings?limit=1`)).body.length, 1);
  });
  test("history is classified activity newest first, paged by before_offset, with an optional raw event view", async () => {
    const h = (await api.get(`/parties/${ALICE}/history`)).body;
    assert.deepEqual(h.classified.map(r => [r.offset, r.kind, r.instrument]), [[30, "mint", "c8ETH"], [30, "lock", "Amulet"], [20, "transfer_out", "Amulet"], [10, "mint", "Amulet"]]);
    assert.equal(h.classified[2].counterparty, BOB);
    assert.equal(h.raw, undefined);
    const paged = (await api.get(`/parties/${ALICE}/history?before_offset=30&limit=1`)).body;
    assert.equal(paged.classified.length, 1); assert.equal(paged.classified[0].offset, 20);
    const raw = (await api.get(`/parties/${ALICE}/history?raw=1`)).body.raw;
    assert.ok(raw.length >= 5); assert.ok(raw.every(r => r.kind === "created" || r.kind === "archived"));
    const bob = (await api.get(`/parties/${BOB}/history`)).body.classified;
    assert.deepEqual(bob.map(r => r.kind), ["reward_collect", "transfer_in"]);
  });
  test("contracts lists stakeholder contracts with role, filtered by qname and active", async () => {
    const all = (await api.get(`/parties/${BOB}/contracts`)).body;
    assert.equal(all.length, 4);
    assert.equal(all.find(c => c.contract_id === seeded.inst.contractId).role, "observer");
    const active = (await api.get(`/parties/${BOB}/contracts?active=1`)).body;
    assert.equal(active.length, 3); assert.ok(active.every(c => c.archived_offset === null));
    const q = (await api.get(`/parties/${BOB}/contracts?qname=Splice.Amulet:RewardCouponV2`)).body;
    assert.equal(q.length, 1); assert.equal(q[0].archived_offset, 40);
  });
  test("templates per party count total and active", async () => {
    const t = (await api.get(`/parties/${ALICE}/templates`)).body;
    const am = t.find(x => x.qname === "Splice.Amulet:Amulet");
    assert.equal(am.total, 3); assert.equal(am.active, 1);
  });
  test("/parties/top is routed before /parties/{party} and supports instrument, max_utxos and order", async () => {
    const top = (await api.get("/parties/top?limit=5")).body;
    assert.ok(Array.isArray(top)); assert.equal(top[0].party, ALICE); assert.equal(top[0].utxo_count, 2);
    const byBal = (await api.get("/parties/top?instrument=Amulet&order=balance")).body;
    assert.deepEqual(byBal.map(r => r.party), [ALICE, BOB]);
    const small = (await api.get("/parties/top?instrument=Amulet&max_utxos=1")).body;
    assert.deepEqual(small.map(r => r.party), [], "both CC holders have 2 UTXOs");
  });
});

describe("contract, update and index routes", () => {
  test("/contracts/{id} returns parsed payload, holding view, stakeholders, holding row and lifecycle events", async () => {
    const { status, body } = await api.get(`/contracts/${seeded.a1.contractId}`);
    assert.equal(status, 200);
    assert.equal(body.qname, "Splice.Amulet:Amulet"); assert.equal(body.payload.owner, ALICE); assert.equal(body.holding_view.instrumentId.id, "Amulet");
    assert.deepEqual(body.signatories, [DSO, ALICE]); assert.equal(body.created_offset, 10); assert.equal(body.archived_offset, 20);
    assert.equal(body.holding.archived_offset, 20);
    assert.deepEqual(body.events.map(e => [e.offset, e.kind]), [[10, "created"], [20, "archived"]]);
    assert.equal((await api.get("/contracts/00nope")).status, 404);
  });
  test("/updates/recent groups events per update with parties and activity, newest first", async () => {
    const ups = (await api.get("/updates/recent?limit=2")).body;
    assert.equal(ups.length, 2); assert.equal(ups[0].offset, 40); assert.equal(ups[0].n, 2);
    assert.deepEqual(ups[0].events.map(e => e.kind), ["archived", "created"]);
    assert.equal(ups[1].offset, 30); assert.equal(ups[1].n, 5);
    assert.ok(ups[0].parties.includes(BOB));
    assert.equal(ups[0].activity[0].kind, "reward_collect");
  });
  test("/templates and /activity/kinds summarise the index", async () => {
    const t = (await api.get("/templates")).body;
    assert.equal(t.find(x => x.qname === "Splice.Amulet:Amulet").active, 3);
    assert.equal(t.find(x => x.qname === "Splice.Amulet:RewardCouponV2").active, 0);
    const k = Object.fromEntries((await api.get("/activity/kinds")).body.map(x => [x.kind, x.n]));
    assert.deepEqual(k, { mint: 2, transfer_out: 1, transfer_in: 1, lock: 1, reward_collect: 1 });
  });
  test("unknown route -> 404", async () => {
    assert.equal((await api.get("/what")).status, 404);
  });
});

describe("self-check via the API", () => {
  test("GET /verify lists no runs yet; POST /verify/run diffs the ledger ACS against the mirror (0/0 here)", async () => {
    assert.deepEqual((await api.get("/verify")).body, { running: false, runs: [], latest_findings: [] });
    const { status, body } = await api.post("/verify/run");
    assert.equal(status, 200);
    assert.equal(body.at_offset, 40); assert.equal(body.ledger_count, 6); assert.equal(body.mirror_count, 6);
    assert.equal(body.only_in_ledger, 0); assert.equal(body.only_in_mirror, 0); assert.equal(body.repaired, 0);
    const v = (await api.get("/verify")).body;
    assert.equal(v.runs.length, 1); assert.equal(v.runs[0].at_offset, 40);
    assert.equal((await api.get("/health", null)).body.verify.only_in_mirror, 0);
  });
  test("verify without repair reports findings but leaves the mirror alone", async () => {
    app.db.db.prepare("UPDATE contracts SET archived_offset = 40 WHERE contract_id = ?").run(seeded.b2.contractId);
    const r = (await api.post("/verify/run?repair=0")).body;
    assert.equal(r.only_in_ledger, 1); assert.equal(r.repaired, 0); assert.equal(r.findings[0].kind, "missing_in_mirror");
    const again = (await api.post("/verify/run")).body;
    assert.equal(again.repaired, 1);
    assert.equal(app.db.db.prepare("SELECT archived_offset FROM contracts WHERE contract_id = ?").get(seeded.b2.contractId).archived_offset, 40, "repair inserts a fresh row only when the id is absent; an archived row stays as reported");
  });
});
