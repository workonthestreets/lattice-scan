import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { qnameOf, packageIdOf, holdingView, asHolding, classify, effectiveAmount } from "../src/reduce.mjs";
import { amulet, lockedAmulet, c8Holding, PKG, DSO, ALICE, BOB, CAROL, HOLDING_IFACE } from "./helpers/fixtures.mjs";

describe("template naming", () => {
  test("splits templateId on the first colon only (package ids contain no colon, qnames contain one)", () => {
    const t = `${PKG}:Splice.Amulet:Amulet`;
    assert.equal(qnameOf(t), "Splice.Amulet:Amulet");
    assert.equal(packageIdOf(t), PKG);
    assert.equal(qnameOf("#splice-amulet:Splice.Amulet:Amulet"), "Splice.Amulet:Amulet");
  });
});

describe("holdingView", () => {
  test("returns the Holding interface view when present and ok", () => {
    const ev = amulet({ owner: ALICE, amount: 10 });
    assert.equal(holdingView(ev).owner, ALICE);
    assert.equal(holdingView(ev).instrumentId.id, "Amulet");
  });
  test("ignores failed views and unrelated interfaces", () => {
    const ev = amulet({ owner: ALICE, amount: 10 });
    ev.interfaceViews[0].viewStatus = { code: 3, message: "failed" };
    assert.equal(holdingView(ev), null);
    ev.interfaceViews = [{ interfaceId: `${PKG}:Other.Iface:Thing`, viewStatus: { code: 0 }, viewValue: { owner: ALICE } }];
    assert.equal(holdingView(ev), null);
    assert.equal(holdingView({}), null);
  });
  test("matches the interface by qualified name, not package id", () => {
    const ev = amulet({ owner: ALICE, amount: 10 });
    ev.interfaceViews[0].interfaceId = "someotherpkg:Splice.Api.Token.HoldingV1:Holding";
    assert.equal(holdingView(ev).amount, "10.0000000000");
  });
});

describe("asHolding", () => {
  test("Amulet with view: owner/instrument/amount from the view, round and rate from the payload", () => {
    const ev = amulet({ owner: ALICE, amount: 12.5, round: 42, rate: "0.0000190259" });
    const h = asHolding(qnameOf(ev.templateId), ev.createArgument, holdingView(ev));
    assert.deepEqual(h, { owner: ALICE, instrument: "Amulet", admin: DSO, amount: "12.5000000000", locked: false, lock: null, round: 42, rate: "0.0000190259" });
  });
  test("Amulet without view falls back to the raw payload (initialAmount)", () => {
    const ev = amulet({ owner: ALICE, amount: 7, withView: false, round: 9 });
    const h = asHolding(qnameOf(ev.templateId), ev.createArgument, holdingView(ev));
    assert.equal(h.amount, "7.0000000000"); assert.equal(h.instrument, "Amulet"); assert.equal(h.round, 9); assert.equal(h.locked, false);
  });
  test("LockedAmulet is locked, carries lock holders and expiry, with and without view", () => {
    for (const withView of [true, false]) {
      const ev = lockedAmulet({ owner: BOB, amount: 3, holders: [DSO, CAROL], expiresAt: "2026-09-01T00:00:00Z", withView });
      const h = asHolding(qnameOf(ev.templateId), ev.createArgument, holdingView(ev));
      assert.equal(h.locked, true, `withView=${withView}`);
      assert.equal(h.owner, BOB); assert.equal(h.amount, "3.0000000000"); assert.equal(h.round, 100);
      assert.deepEqual(h.lock.holders, [DSO, CAROL]); assert.equal(h.lock.expiresAt, "2026-09-01T00:00:00Z");
    }
  });
  test("Cantor8 holding families map to their instrument names; LockedHolding is locked", () => {
    const h1 = asHolding("Cantor8.CETH.Holding:Holding", { owner: ALICE, amount: "1.0000000000", admin: "a::1" }, null);
    assert.equal(h1.instrument, "c8ETH"); assert.equal(h1.locked, false); assert.equal(h1.admin, "a::1");
    const h2 = asHolding("Cantor8.CBTC.Holding:LockedHolding", { owner: ALICE, amount: "2.0000000000", transferAgent: "t::1", lockHolder: BOB, expiresAt: "x" }, null);
    assert.equal(h2.instrument, "c8BTC"); assert.equal(h2.locked, true); assert.deepEqual(h2.lock, { holders: [BOB], expiresAt: "x" }); assert.equal(h2.admin, "t::1");
    const h3 = asHolding("Cantor8.NewThing.Holding:Holding", { owner: ALICE, amount: "2.0000000000" }, null);
    assert.equal(h3.instrument, "NewThing", "unknown families keep their module name");
  });
  test("Utility.Registry holdings use instrument.id and instrument.source", () => {
    const h = asHolding("Utility.Registry.Holding.V0.Holding:Holding", { owner: ALICE, amount: "5.0000000000", instrument: { id: "USDX", source: "reg::1" }, lock: null }, null);
    assert.deepEqual(h, { owner: ALICE, instrument: "USDX", admin: "reg::1", amount: "5.0000000000", locked: false, lock: null });
  });
  test("the view wins over template-specific fallbacks and reports the ledger's instrument id", () => {
    const view = { owner: ALICE, instrumentId: { id: "cETH", admin: "a::2" }, amount: "1.0000000000", lock: null };
    const h = asHolding("Cantor8.CETH.Holding:Holding", { owner: ALICE, amount: "1.0000000000" }, view);
    assert.equal(h.instrument, "cETH");
  });
  test("non-holding templates and junk yield null", () => {
    assert.equal(asHolding("Splice.Wallet.Install:WalletAppInstall", { owner: ALICE }, null), null);
    assert.equal(asHolding("Splice.Amulet:Amulet", null, null), null);
    assert.equal(asHolding("Splice.Amulet:Amulet", "string", null), null);
  });
});

describe("classify", () => {
  const H = (owner, amount, instrument = "Amulet", locked = false) => ({ holding: { owner, instrument, amount: typeof amount === "string" ? amount : amount.toFixed(10), locked }, contractId: "x", qname: locked ? "Splice.Amulet:LockedAmulet" : "Splice.Amulet:Amulet" });
  const T = { updateId: "u1", offset: 100, recordTime: "2026-08-29T12:00:00Z" };
  const run = (created, archived, createdQnames = []) => classify(T, created, archived, createdQnames);
  const byKind = (rows) => Object.fromEntries(rows.map(r => [r.party + ":" + r.kind, r]));

  test("no holding movement -> no rows", () => {
    assert.deepEqual(run([], []), []);
    assert.deepEqual(run([{ holding: null, qname: "X:Y" }], [{ holding: null, qname: "X:Y" }]), []);
  });
  test("exact two-party transfer: sender's out carries the receiver, receiver's in carries the sender", () => {
    const rows = run([H(ALICE, 60), H(BOB, 40)], [H(ALICE, 100)]);
    const k = byKind(rows);
    assert.equal(rows.length, 2);
    assert.deepEqual(k[ALICE + ":transfer_out"], { update_id: "u1", offset: 100, record_time: T.recordTime, party: ALICE, instrument: "Amulet", kind: "transfer_out", amount: "40.0000000000", counterparty: BOB, confidence: "exact" });
    assert.equal(k[BOB + ":transfer_in"].amount, "40.0000000000"); assert.equal(k[BOB + ":transfer_in"].counterparty, ALICE); assert.equal(k[BOB + ":transfer_in"].confidence, "exact");
  });
  test("one sender, two receivers: out has no single counterparty (medium), ins are exact", () => {
    const k = byKind(run([H(ALICE, 50), H(BOB, 30), H(CAROL, 20)], [H(ALICE, 100)]));
    assert.equal(k[ALICE + ":transfer_out"].counterparty, null); assert.equal(k[ALICE + ":transfer_out"].confidence, "medium");
    assert.equal(k[BOB + ":transfer_in"].counterparty, ALICE); assert.equal(k[CAROL + ":transfer_in"].amount, "20.0000000000");
  });
  test("self merge: net zero for one party is reported as self_merge with amount 0", () => {
    const rows = run([H(ALICE, 100)], [H(ALICE, 60), H(ALICE, 40)]);
    assert.equal(rows.length, 1); assert.equal(rows[0].kind, "self_merge"); assert.equal(rows[0].amount, "0.0000000000"); assert.equal(rows[0].confidence, "exact");
  });
  test("net zero with a locked share moving: lock / unlock with the exact locked amount (LockedAmulet shares the Amulet instrument)", () => {
    const lock = run([H(ALICE, 90), H(ALICE, 10, "Amulet", true)], [H(ALICE, 100)], ["Splice.Amulet:Amulet", "Splice.Amulet:LockedAmulet"]);
    assert.equal(lock.length, 1); assert.equal(lock[0].kind, "lock"); assert.equal(lock[0].amount, "10.0000000000"); assert.equal(lock[0].confidence, "exact");
    const unlock = run([H(ALICE, 100)], [H(ALICE, 90), H(ALICE, 10, "Amulet", true)]);
    assert.equal(unlock[0].kind, "unlock"); assert.equal(unlock[0].amount, "10.0000000000");
    const rows = run([H(ALICE, 90, "Amulet", true), H(ALICE, 10, "Amulet", true)], [H(ALICE, 100, "Amulet", true)]);
    assert.equal(rows[0].kind, "self_merge", "locked-to-locked split is still a self merge");
  });
  test("outflow with no visible receiver: transfer_out low confidence, or lock when a lock contract was created", () => {
    const a = run([], [H(ALICE, 10)]);
    assert.equal(a[0].kind, "transfer_out"); assert.equal(a[0].confidence, "low"); assert.equal(a[0].counterparty, null);
    const b = run([], [H(ALICE, 10)], ["Splice.Amulet:LockedAmulet"]);
    assert.equal(b[0].kind, "lock"); assert.equal(b[0].amount, "10.0000000000");
    const c = run([], [H(ALICE, 10)], ["Splice.Api.Token.TransferInstructionV1:TransferInstruction"]);
    assert.equal(c[0].kind, "lock");
  });
  test("inflow with no visible sender: mint, reward_collect when a coupon was archived, unlock when a lock was archived", () => {
    assert.equal(run([H(ALICE, 5)], [])[0].kind, "mint");
    const reward = run([H(ALICE, 5)], [{ holding: null, qname: "Splice.Amulet:RewardCouponV2" }]);
    assert.equal(reward[0].kind, "reward_collect"); assert.equal(reward[0].amount, "5.0000000000");
    const unlock = run([H(ALICE, 5)], [{ holding: null, qname: "Splice.Amulet:LockedAmulet" }]);
    assert.equal(unlock[0].kind, "unlock");
  });
  test("transfer with fees (total < 0): medium-confidence out/in with counterparties when unambiguous", () => {
    const k = byKind(run([H(ALICE, 59), H(BOB, 40)], [H(ALICE, 100)]));
    assert.equal(k[ALICE + ":transfer_out"].amount, "41.0000000000"); assert.equal(k[ALICE + ":transfer_out"].confidence, "medium"); assert.equal(k[ALICE + ":transfer_out"].counterparty, BOB);
    assert.equal(k[BOB + ":transfer_in"].counterparty, ALICE);
  });
  test("net-positive multi-party movement is unclassified, not invented", () => {
    const rows = run([H(BOB, 20)], [H(ALICE, 10)]);
    assert.deepEqual(rows.map(r => r.kind), ["unclassified", "unclassified"]);
    assert.ok(rows.every(r => r.confidence === "low" && r.counterparty === null));
    assert.equal(rows.find(r => r.party === ALICE).amount, "10.0000000000", "amounts are reported as magnitudes");
  });
  test("instruments are classified independently within one update", () => {
    const rows = run([H(BOB, 1, "Amulet"), H(ALICE, 3, "c8ETH")], [H(ALICE, 1, "Amulet")]);
    assert.equal(rows.filter(r => r.instrument === "Amulet").length, 2);
    assert.equal(rows.find(r => r.instrument === "c8ETH").kind, "mint");
  });
  test("amounts are exact decimals, not floats", () => {
    const rows = run([H(ALICE, "0.1000000000"), H(BOB, "0.2000000000")], [H(ALICE, "0.3000000000")]);
    assert.equal(rows.find(r => r.party === ALICE).amount, "0.2000000000");
  });
});

describe("effectiveAmount", () => {
  test("subtracts the per-round holding fee for elapsed rounds", () => {
    assert.equal(effectiveAmount("100.0000000000", 100, "0.0000190259", 110), "99.9998097410");
    assert.equal(effectiveAmount("100.0000000000", 100, "0.0000190259", 100), "100.0000000000");
  });
  test("never goes below zero, never runs backwards, null when inputs are missing", () => {
    assert.equal(effectiveAmount("0.0000100000", 1, "0.0000190259", 100), "0.0000000000");
    assert.equal(effectiveAmount("100.0000000000", 200, "0.0000190259", 100), "100.0000000000");
    assert.equal(effectiveAmount("100", null, "0.1", 5), null);
    assert.equal(effectiveAmount("100", 1, null, 5), null);
    assert.equal(effectiveAmount("100", 1, "0.1", null), null);
  });
});
