// Hardening regressions found by review: query limits that SQLite would read as "no limit", a WebSocket
// constructor throw that used to hang the tail forever, and the "connected" flag being set while still dialling.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMockParticipant, SERVICE_TOKEN } from "./helpers/mock-participant.mjs";
import { setTestEnv, loadApp, startTestApi, waitFor } from "./helpers/app.mjs";
import { amulet, created, tx, ALICE } from "./helpers/fixtures.mjs";

let mock, app, api;
before(async () => {
  mock = await startMockParticipant();
  setTestEnv(mock, { AUTH_MODE: "off" });
  app = await loadApp();
  const holdings = [1, 2, 3, 4, 5].map(n => amulet({ owner: ALICE, amount: n * 10, round: 100 + n }));
  const t = tx(10, holdings.map(created));
  mock.ledger.commit(t); app.tail.applyTx(t);
  app.db.setMeta("snapshot_complete", "1"); app.db.setMeta("snapshot_offset", 5); app.db.setMeta("pruned_offset", 0);
  api = startTestApi(app.api, { token: SERVICE_TOKEN });
});
after(async () => { await api.close(); await mock.close(); });

describe("query limit is clamped to 1..1000", () => {
  test("limit=-1 is not SQLite's 'no limit'", async () => {
    const r = await api.get(`/parties/${ALICE}/holdings?limit=-1`);
    assert.equal(r.status, 200); assert.equal(r.body.length, 1);
  });
  test("limit=0 returns one row, not everything", async () => {
    assert.equal((await api.get(`/parties/${ALICE}/holdings?limit=0`)).body.length, 1);
  });
  test("a non-numeric limit falls back to the default instead of a 500 datatype mismatch", async () => {
    const r = await api.get(`/parties/${ALICE}/holdings?limit=abc`);
    assert.equal(r.status, 200); assert.equal(r.body.length, 5);
    assert.equal((await api.get(`/parties/${ALICE}/contracts?limit=1e3`)).status, 200);
  });
  test("limit=2 still pages", async () => {
    assert.equal((await api.get(`/parties/${ALICE}/holdings?limit=2`)).body.length, 2);
  });
});

describe("stream() and the tail on a socket that cannot be opened", () => {
  test("a WebSocket constructor throw rejects the stream promise instead of hanging it", async () => {
    const saved = app.config.ledgerWs;
    app.config.ledgerWs = "not a url";
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("stream() hung")), 3000));
      await assert.rejects(Promise.race([app.ledger.stream("/v2/updates", {}, () => {}), timeout]), (e) => e.message !== "stream() hung");
    } finally { app.config.ledgerWs = saved; }
  });
  test("tail reports connected=false while dialling fails, counts the error, and stops on abort", async () => {
    const saved = app.config.ledgerWs;
    app.config.ledgerWs = "ws://127.0.0.1:1"; // nothing listens there
    const abort = new AbortController();
    const done = app.tail.runTail(abort.signal);
    try {
      await waitFor(() => app.tail.tailState.errors >= 1, { label: "tail error" });
      assert.equal(app.tail.tailState.connected, false);
      assert.equal(app.tail.tailState.connectedAt, null, "connectedAt is only set once the socket is open");
    } finally { abort.abort(); await done; app.config.ledgerWs = saved; }
    assert.equal(app.tail.tailState.running, false);
  });
});
