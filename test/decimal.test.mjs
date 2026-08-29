import { test } from "node:test";
import assert from "node:assert/strict";
import { toUnits, fromUnits, add, sum, isZero, SCALE } from "../src/decimal.mjs";

test("scale is Canton's Decimal scale (10)", () => assert.equal(SCALE, 10n));

test("toUnits parses ledger amount strings exactly", () => {
  assert.equal(toUnits("1.5"), 15000000000n);
  assert.equal(toUnits("0.0000190259"), 190259n);
  assert.equal(toUnits("100"), 1000000000000n);
  assert.equal(toUnits("-0.5"), -5000000000n);
  assert.equal(toUnits(" 2.25 "), 22500000000n);
  assert.equal(toUnits(null), 0n);
  assert.equal(toUnits(undefined), 0n);
  assert.equal(toUnits(".5"), 5000000000n);
});

test("toUnits truncates beyond 10 decimals and never rounds", () => {
  assert.equal(toUnits("1.00000000009"), 10000000000n);
  assert.equal(toUnits("1.99999999999"), 19999999999n);
});

test("fromUnits renders fixed 10-dp strings and round-trips", () => {
  assert.equal(fromUnits(0n), "0.0000000000");
  assert.equal(fromUnits(15000000000n), "1.5000000000");
  assert.equal(fromUnits(-5000000000n), "-0.5000000000");
  assert.equal(fromUnits(1n), "0.0000000001");
  for (const s of ["12345.6789012345", "0.0000000000", "99999999999.9999999999", "-3.1400000000"]) assert.equal(fromUnits(toUnits(s)), s);
});

test("add/sum avoid floating point drift", () => {
  assert.equal(fromUnits(add("0.1", "0.2")), "0.3000000000");
  const parts = Array.from({ length: 1000 }, () => "0.0000000001");
  assert.equal(fromUnits(sum(parts)), "0.0000001000");
  assert.equal(isZero(sum(["1", "-1"])), true);
});
