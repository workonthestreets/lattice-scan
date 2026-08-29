// Domain reducers: template naming, holding normalisation, per-update activity classification.
// Field paths verified against the full DevNet ACS on 2026-08-29 (research/FACTS.md).
import { toUnits, fromUnits } from "./decimal.mjs";

// templateId is "<packageId>:<Module>:<Template>"; split on the FIRST colon only.
export const qnameOf = (templateId) => templateId.slice(templateId.indexOf(":") + 1);
export const packageIdOf = (templateId) => templateId.slice(0, templateId.indexOf(":"));

export function holdingView(ev) {
  for (const v of ev.interfaceViews || []) {
    if (String(v.interfaceId).endsWith(":Splice.Api.Token.HoldingV1:Holding") && (!v.viewStatus || v.viewStatus.code === 0) && v.viewValue) return v.viewValue;
  }
  return null;
}

const INSTRUMENT = { CETH: "c8ETH", CBTC: "c8BTC", CTest: "c8TEST", RebateCC: "rCC", C8POCoin: "C8POCoin",
  CETD: "CETD", CDJD: "CDJD", CKND: "CKND", CSMD: "CSMD", CSAD: "CSAD", CERD: "CERD", Vault: "vault-token" };

/** Normalise a contract into {owner, instrument, admin, amount, locked, lock, round?, rate?} or null. */
export function asHolding(qname, a, view) {
  if (view && view.owner && view.instrumentId && view.amount !== undefined) {
    const h = { owner: view.owner, instrument: view.instrumentId.id, admin: view.instrumentId.admin, amount: String(view.amount),
      locked: !!view.lock, lock: view.lock || null };
    if (qname === "Splice.Amulet:Amulet" && a?.amount) { h.round = Number(a.amount.createdAt?.number); h.rate = a.amount.ratePerRound?.rate; }
    if (qname === "Splice.Amulet:LockedAmulet" && a?.amulet?.amount) { h.round = Number(a.amulet.amount.createdAt?.number); h.rate = a.amulet.amount.ratePerRound?.rate; }
    return h;
  }
  if (!a || typeof a !== "object") return null;
  if (qname === "Splice.Amulet:Amulet")
    return { owner: a.owner, instrument: "Amulet", admin: a.dso, amount: String(a.amount.initialAmount), locked: false, lock: null,
      round: Number(a.amount.createdAt?.number), rate: a.amount.ratePerRound?.rate };
  if (qname === "Splice.Amulet:LockedAmulet")
    return { owner: a.amulet.owner, instrument: "Amulet", admin: a.amulet.dso, amount: String(a.amulet.amount.initialAmount), locked: true,
      lock: a.lock || null, round: Number(a.amulet.amount.createdAt?.number), rate: a.amulet.amount.ratePerRound?.rate };
  if (qname.startsWith("Utility.Registry") && qname.endsWith("Holding:Holding") && a.owner && a.instrument)
    return { owner: a.owner, instrument: a.instrument.id, admin: a.instrument.source, amount: String(a.amount), locked: !!a.lock, lock: a.lock || null };
  if (/Holding:(Locked)?Holding$/.test(qname) && a.owner && a.amount !== undefined) {
    const fam = qname.split(".")[1];
    return { owner: a.owner, instrument: INSTRUMENT[fam] ?? fam, admin: a.admin ?? a.transferAgent ?? null, amount: String(a.amount),
      locked: qname.endsWith("LockedHolding"),
      lock: a.lockHolder ? { holders: [a.lockHolder], expiresAt: a.expiresAt } : null };
  }
  return null;
}

/**
 * Classify one update from ACS_DELTA holding movements (PLAN.md section 6.3).
 * created: [{holding, contractId, qname}], archived: [{holding (row), contractId, qname}], others: created qnames of non-holdings.
 * Returns activity rows.
 */
export function classify(tx, created, archived, createdQnames) {
  const delta = new Map(); // key party|instrument -> {party, instrument, units, nIn, nOut}
  const bump = (p, i, u, isIn) => {
    const k = p + "|" + i;
    const e = delta.get(k) || { party: p, instrument: i, units: 0n, nIn: 0, nOut: 0 };
    e.units += u; if (isIn) e.nIn++; else e.nOut++;
    delta.set(k, e);
  };
  for (const c of created) if (c.holding) bump(c.holding.owner, c.holding.instrument, toUnits(c.holding.amount), true);
  for (const a of archived) if (a.holding) bump(a.holding.owner, a.holding.instrument, -toUnits(a.holding.amount), false);
  if (!delta.size) return [];

  const rows = [];
  const base = { update_id: tx.updateId, offset: tx.offset, record_time: tx.recordTime };
  const byInstrument = new Map();
  for (const e of delta.values()) {
    const arr = byInstrument.get(e.instrument) || []; arr.push(e); byInstrument.set(e.instrument, arr);
  }
  const lockCreated = createdQnames.some(q => /LockedAmulet$|LockedHolding$|TransferInstruction$/.test(q));
  const rewardArchived = archived.some(a => a.qname === "Splice.Amulet:RewardCouponV2");
  const lockArchived = archived.some(a => /LockedAmulet$|LockedHolding$/.test(a.qname));

  for (const [instrument, entries] of byInstrument) {
    const neg = entries.filter(e => e.units < 0n), pos = entries.filter(e => e.units > 0n), zero = entries.filter(e => e.units === 0n);
    const total = entries.reduce((s, e) => s + e.units, 0n);
    for (const z of zero) if (z.nIn + z.nOut > 0)
      rows.push({ ...base, party: z.party, instrument, kind: "self_merge", amount: "0.0000000000", counterparty: null, confidence: "exact" });
    if (neg.length === 1 && pos.length >= 1 && total === 0n) {
      const s = neg[0];
      rows.push({ ...base, party: s.party, instrument, kind: "transfer_out", amount: fromUnits(-s.units), counterparty: pos.length === 1 ? pos[0].party : null, confidence: pos.length === 1 ? "exact" : "medium" });
      for (const r of pos) rows.push({ ...base, party: r.party, instrument, kind: "transfer_in", amount: fromUnits(r.units), counterparty: s.party, confidence: "exact" });
    } else if (neg.length === 1 && pos.length === 0) {
      const s = neg[0];
      if (lockCreated) rows.push({ ...base, party: s.party, instrument, kind: "lock", amount: fromUnits(-s.units), counterparty: null, confidence: "medium" });
      else rows.push({ ...base, party: s.party, instrument, kind: "transfer_out", amount: fromUnits(-s.units), counterparty: null, confidence: "low" });
    } else if (pos.length === 1 && neg.length === 0) {
      const r = pos[0];
      if (lockArchived) rows.push({ ...base, party: r.party, instrument, kind: "unlock", amount: fromUnits(r.units), counterparty: null, confidence: "medium" });
      else if (rewardArchived) rows.push({ ...base, party: r.party, instrument, kind: "reward_collect", amount: fromUnits(r.units), counterparty: null, confidence: "medium" });
      else rows.push({ ...base, party: r.party, instrument, kind: "mint", amount: fromUnits(r.units), counterparty: null, confidence: "medium" });
    } else if (neg.length >= 1 && pos.length >= 1 && total < 0n) {
      for (const s of neg) rows.push({ ...base, party: s.party, instrument, kind: "transfer_out", amount: fromUnits(-s.units), counterparty: pos.length === 1 ? pos[0].party : null, confidence: "medium" });
      for (const r of pos) rows.push({ ...base, party: r.party, instrument, kind: "transfer_in", amount: fromUnits(r.units), counterparty: neg.length === 1 ? neg[0].party : null, confidence: "medium" });
    } else {
      for (const e of [...neg, ...pos]) rows.push({ ...base, party: e.party, instrument, kind: "unclassified", amount: fromUnits(e.units < 0n ? -e.units : e.units), counterparty: null, confidence: "low" });
    }
  }
  return rows;
}

/** Effective Amulet amount after accrued holding fees at round R. */
export function effectiveAmount(amount, round, rate, currentRound) {
  if (round === null || round === undefined || !rate || !currentRound) return null;
  const elapsed = BigInt(Math.max(0, currentRound - round));
  const v = toUnits(amount) - toUnits(rate) * elapsed;
  return fromUnits(v < 0n ? 0n : v);
}
