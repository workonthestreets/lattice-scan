// Live acceptance test against a RUNNING scanner on DevNet (npm start) — opt-in with LIVE=1.
// Proves the deployed product, not the code: health, auth gate, balance arithmetic against the mirror,
// self-check 0/0 against the participant's ACS, and Canton Coin balances against the public Scan API.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const LIVE = process.env.LIVE === "1";
const skip = LIVE ? false : "set LIVE=1 (needs a running scanner and CLIENT_SECRET in .env)";

let API, get, post, health;
before(async () => {
  if (!LIVE) return;
  const { config } = await import("../src/config.mjs");
  const { token } = await import("../src/token.mjs");
  API = process.env.API || `http://localhost:${config.port}`;
  const tok = config.authMode === "off" ? null : await token();
  const call = async (method, path, t = tok) => {
    const r = await fetch(API + path, { method, headers: t ? { authorization: "Bearer " + t } : {} });
    const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  get = (p, t) => call("GET", p, t); post = (p, t) => call("POST", p, t);
  health = (await get("/health", null)).body;
});

test("scanner is up, snapshot complete, tail connected, cursor within a few offsets of ledger end", { skip }, async () => {
  assert.equal(health.status, "ok", JSON.stringify(health.tail));
  assert.equal(health.tail.connected, true);
  assert.ok(health.contracts_active > 1000, "DevNet has tens of thousands of active contracts");
  assert.ok(health.gap_offsets !== null && health.gap_offsets < 50, `gap ${health.gap_offsets} offsets`);
  assert.ok(health.orphan_archive_total === 0, `orphan archives: ${health.orphan_archive_total}`);
  assert.ok(health.history_from_offset <= health.snapshot_offset);
});

test("auth gate: no token 401, garbage 401, our token any_party", { skip }, async () => {
  assert.equal((await get("/templates", null)).status, 401);
  assert.equal((await get("/templates", "garbage")).status, 401);
  const me = (await get("/auth/whoami")).body;
  assert.equal(me.any_party, true, JSON.stringify(me));
});

test("balances equal the sum of active holdings for the top Canton Coin parties", { skip }, async () => {
  const { toUnits, fromUnits } = await import("../src/decimal.mjs");
  const top = (await get("/parties/top?instrument=Amulet&order=balance&limit=5")).body;
  assert.ok(top.length >= 1);
  for (const t of top) {
    const b = (await get(`/parties/${encodeURIComponent(t.party)}/balances`)).body.balances.find(x => x.instrument === "Amulet");
    const hs = (await get(`/parties/${encodeURIComponent(t.party)}/holdings?instrument=Amulet&limit=1000`)).body;
    if (hs.length >= 1000) continue; // capped listing, not comparable
    const sum = hs.reduce((acc, h) => acc + toUnits(h.amount), 0n);
    assert.equal(b.balance, fromUnits(sum), t.party);
    assert.equal(b.utxo_count, hs.length, t.party);
    assert.equal(b.available, fromUnits(toUnits(b.balance) - toUnits(b.locked)));
  }
});

test("unknown party is a 404 with the boundary message", { skip }, async () => {
  const r = await get("/parties/nobody::1220deadbeef/balances");
  assert.equal(r.status, 404); assert.match(r.body.detail, /boundary/);
});

test("self-check against the participant's ACS: 0 missing, 0 phantom", { skip }, async () => {
  const r = await post("/verify/run");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.only_in_ledger, 0, JSON.stringify(r.body.findings));
  assert.equal(r.body.only_in_mirror, 0, JSON.stringify(r.body.findings));
  assert.ok(r.body.ledger_count === r.body.mirror_count);
});

test("Canton Coin balances match the public Scan API oracle (scripts/oracle.mjs)", { skip }, () => {
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "scripts/oracle.mjs"], { encoding: "utf8", env: { ...process.env, API } });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out.slice(-1500));
  assert.match(out, /oracle: \d+ match, 0 differ/);
});

test("measure script runs against the gated API", { skip }, () => {
  const r = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "scripts/measure.mjs"], { encoding: "utf8", env: { ...process.env, API } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /status\s+ok/);
});
