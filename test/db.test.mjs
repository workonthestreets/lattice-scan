// The SQLite mirror in isolation: idempotent creates/archives, replayed frames, transactions, applyTx.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { amulet, lockedAmulet, plain, rewardCoupon, created, archived, tx, ALICE, BOB, DSO } from "./helpers/fixtures.mjs";

process.env.DB_PATH = ":memory:";
process.env.CLIENT_SECRET = "x";
const { db, transaction, getMeta, setMeta, getMetaInt, upsertCreate, archive, setCursor, counts } = await import("../src/db.mjs");
const { applyTx } = await import("../src/tail.mjs");

// node:sqlite rows are null-prototype objects; normalise so deepEqual compares values only.
const rows = (x) => JSON.parse(JSON.stringify(x));
const one = (sql, ...a) => rows(db.prepare(sql).get(...a));
const all = (sql, ...a) => rows(db.prepare(sql).all(...a));

describe("meta and transactions", () => {
  test("setMeta/getMeta round-trip, null clears, getMetaInt defaults", () => {
    setMeta("k1", 42); assert.equal(getMeta("k1"), "42"); assert.equal(getMetaInt("k1"), 42);
    setMeta("k1", null); assert.equal(getMeta("k1"), null);
    assert.equal(getMetaInt("nope", 7), 7); assert.equal(getMeta("nope"), undefined);
  });
  test("transaction commits on success, rolls back on throw, and nests without double BEGIN", () => {
    transaction(() => { setMeta("t", "a"); transaction(() => setMeta("t2", "b")); });
    assert.equal(getMeta("t"), "a"); assert.equal(getMeta("t2"), "b");
    assert.throws(() => transaction(() => { setMeta("t", "z"); throw new Error("boom"); }), /boom/);
    assert.equal(getMeta("t"), "a", "rolled back");
  });
});

describe("upsertCreate / archive", () => {
  const a1 = amulet({ owner: ALICE, amount: 10 }); a1.offset = 5; a1.nodeId = 0;
  test("first insert is new: contract, stakeholders with roles, holding row", () => {
    const r = upsertCreate(a1, { synchronizerId: "sync::1" });
    assert.equal(r.isNew, true); assert.equal(r.qname, "Splice.Amulet:Amulet"); assert.equal(r.holding.amount, "10.0000000000");
    const c = one("SELECT * FROM contracts WHERE contract_id = ?", a1.contractId);
    assert.equal(c.package_name, "splice-amulet"); assert.equal(c.created_offset, 5); assert.equal(c.archived_offset, null); assert.equal(c.synchronizer_id, "sync::1");
    assert.deepEqual(JSON.parse(c.holding_view).instrumentId.id, "Amulet");
    assert.deepEqual(all("SELECT party, role FROM stakeholders WHERE contract_id = ? ORDER BY party", a1.contractId), [{ party: DSO, role: "signatory" }, { party: ALICE, role: "signatory" }]);
    const h = one("SELECT * FROM holdings WHERE contract_id = ?", a1.contractId);
    assert.equal(h.owner, ALICE); assert.equal(h.locked, 0); assert.equal(h.round, 100); assert.equal(h.created_offset, 5);
  });
  test("re-inserting the same contract is a no-op (isNew=false), no duplicate rows", () => {
    const r = upsertCreate(a1, {});
    assert.equal(r.isNew, false);
    assert.equal(one("SELECT count(*) AS n FROM stakeholders WHERE contract_id = ?", a1.contractId).n, 2);
    assert.equal(one("SELECT count(*) AS n FROM holdings").n, 1);
  });
  test("locked holdings record holders and expiry; observers become observer stakeholders", () => {
    const l = lockedAmulet({ owner: BOB, amount: 2, holders: [DSO] }); l.offset = 6;
    upsertCreate(l);
    const h = one("SELECT * FROM holdings WHERE contract_id = ?", l.contractId);
    assert.equal(h.locked, 1); assert.deepEqual(JSON.parse(h.lock_holders), [DSO]); assert.equal(h.lock_expires_at, "2026-09-01T00:00:00Z");
    assert.equal(one("SELECT role FROM stakeholders WHERE contract_id = ? AND party = ?", l.contractId, DSO).role, "signatory");
  });
  test("non-holding templates get a contract row and no holding", () => {
    const p = plain({ signatories: [DSO], observers: [ALICE] }); p.offset = 7;
    const r = upsertCreate(p);
    assert.equal(r.holding, null);
    assert.equal(one("SELECT role FROM stakeholders WHERE contract_id = ? AND party = ?", p.contractId, ALICE).role, "observer");
  });
  test("archive sets archived_offset on contract and holding once; replays are idempotent; unknown ids count as orphans", () => {
    const ev = { contractId: a1.contractId, templateId: a1.templateId, offset: 9, nodeId: 1 };
    const r1 = archive(ev, {});
    assert.equal(r1.known, true); assert.equal(r1.holding.amount, "10.0000000000");
    assert.equal(one("SELECT archived_offset FROM contracts WHERE contract_id = ?", a1.contractId).archived_offset, 9);
    assert.equal(one("SELECT archived_offset FROM holdings WHERE contract_id = ?", a1.contractId).archived_offset, 9);
    const r2 = archive({ ...ev, offset: 11 }, {});
    assert.equal(r2.known, true, "already archived is treated as a replay");
    assert.equal(one("SELECT archived_offset FROM contracts WHERE contract_id = ?", a1.contractId).archived_offset, 9, "first archive offset is kept");
    assert.equal(getMetaInt("orphan_archive_total"), 0);
    const r3 = archive({ contractId: "00unknown", templateId: a1.templateId, offset: 12, nodeId: 0 }, {});
    assert.equal(r3.known, false); assert.equal(getMetaInt("orphan_archive_total"), 1);
    archive({ contractId: "00unknown2", templateId: a1.templateId, offset: 13, nodeId: 0 }, { backfill: true });
    assert.equal(getMetaInt("orphan_archive_total"), 1, "archives before the pruning floor are expected during backfill, not orphans");
  });
  test("events are recorded only when an update context is given, keyed by (offset, node_id)", () => {
    const before = one("SELECT count(*) AS n FROM events").n;
    const e = amulet({ owner: ALICE, amount: 1 }); e.offset = 20; e.nodeId = 0;
    upsertCreate(e, {});
    assert.equal(one("SELECT count(*) AS n FROM events").n, before, "no ctx.updateId -> no event row");
    upsertCreate(e, { updateId: "u-x", recordTime: "rt" });
    upsertCreate(e, { updateId: "u-x", recordTime: "rt" });
    assert.equal(one("SELECT count(*) AS n FROM events WHERE contract_id = ?", e.contractId).n, 1);
  });
});

describe("applyTx (tail)", () => {
  before(() => { db.exec("DELETE FROM contracts; DELETE FROM stakeholders; DELETE FROM holdings; DELETE FROM events; DELETE FROM activity; DELETE FROM meta;"); setMeta("offset", 0); });
  const a = amulet({ owner: ALICE, amount: 100 });
  const a2 = amulet({ owner: ALICE, amount: 60 }), b = amulet({ owner: BOB, amount: 40 });
  const t2 = tx(51, [archived(a), created(a2), created(b)]);
  test("creates, archives, activity rows, cursor and updates_applied are one transaction", () => {
    const t1 = tx(50, [created(a)]);
    const r1 = applyTx(t1);
    assert.deepEqual(r1, { created: 1, archived: 0 });
    assert.equal(getMeta("offset"), "50"); assert.equal(getMeta("record_time"), t1.recordTime); assert.equal(getMetaInt("updates_applied"), 1);
    assert.equal(all("SELECT * FROM activity")[0].kind, "mint");

    assert.deepEqual(applyTx(t2), { created: 2, archived: 1 });
    assert.equal(getMeta("offset"), "51");
    const act = all("SELECT party, kind, amount, counterparty, confidence FROM activity WHERE offset = 51 ORDER BY party");
    assert.deepEqual(act, [
      { party: ALICE, kind: "transfer_out", amount: "40.0000000000", counterparty: BOB, confidence: "exact" },
      { party: BOB, kind: "transfer_in", amount: "40.0000000000", counterparty: ALICE, confidence: "exact" },
    ]);
    assert.equal(all("SELECT * FROM events WHERE offset = 51").length, 3);
    assert.equal(one("SELECT archived_offset FROM holdings WHERE contract_id = ?", a.contractId).archived_offset, 51);
  });
  test("a replayed frame changes nothing", () => {
    const snapshot = () => JSON.stringify({ c: counts(), a: all("SELECT * FROM activity ORDER BY offset, party"), e: all("SELECT * FROM events ORDER BY offset, node_id"), off: getMeta("offset") });
    const s1 = snapshot();
    applyTx(t2);
    assert.equal(snapshot(), s1);
    assert.equal(getMetaInt("updates_applied"), 3, "the counter is the only thing that moves on a replay");
  });
  test("consuming ExercisedEvent with acsDelta archives like an ArchivedEvent", () => {
    const c = amulet({ owner: BOB, amount: 5 });
    applyTx(tx(52, [created(c)]));
    const ex = { ExercisedEvent: { contractId: c.contractId, templateId: c.templateId, offset: 53, nodeId: 0, consuming: true, acsDelta: true, choice: "Amulet_Expire" } };
    const r = applyTx({ updateId: "u-ex", offset: 53, recordTime: "2026-08-29T13:00:00Z", events: [ex] });
    assert.deepEqual(r, { created: 0, archived: 1 });
    assert.equal(one("SELECT archived_offset FROM contracts WHERE contract_id = ?", c.contractId).archived_offset, 53);
    assert.equal(one("SELECT kind FROM activity WHERE offset = 53").kind, "transfer_out");
  });
  test("a failing update rolls back completely, cursor untouched", () => {
    const off = getMeta("offset");
    const bad = tx(60, [created(amulet({ owner: ALICE, amount: 1 }))]);
    bad.events[0].CreatedEvent.templateId = null; // qnameOf will throw
    assert.throws(() => applyTx(bad));
    assert.equal(getMeta("offset"), off);
    assert.equal(all("SELECT * FROM events WHERE offset = 60").length, 0);
  });
  test("counts() reflects the mirror", () => {
    const c = counts();
    assert.equal(c.contracts_total, 4); assert.equal(c.contracts_active, 2); assert.equal(c.holdings_active, 2);
    assert.equal(c.parties_seen, 3); assert.equal(c.templates, 1); assert.equal(c.updates_indexed, 4);
  });
});
