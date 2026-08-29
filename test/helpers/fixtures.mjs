// Builders for JSON Ledger API v2 event and transaction shapes, matching what DevNet returns (research/FACTS.md).
export const PKG = "1220aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const DSO = "DSO::1220dso";
export const HOLDING_IFACE = `${PKG}:Splice.Api.Token.HoldingV1:Holding`;
export const ALICE = "alice::1220alice", BOB = "bob::1220bob", CAROL = "carol::1220carol";

let seq = 0;
export const cid = (tag = "c") => `00${tag}${String(++seq).padStart(6, "0")}`;
export const dec = (n) => (typeof n === "string" ? n : n.toFixed(10));

const view = (owner, instrument, amount, lock = null, admin = DSO) => ({
  interfaceId: HOLDING_IFACE, viewStatus: { code: 0, message: "" },
  viewValue: { owner, instrumentId: { admin, id: instrument }, amount: dec(amount), lock, meta: { values: {} } },
});

const base = (contractId, templateId, packageName, signatories, observers, createArgument, interfaceViews = []) => ({
  contractId, templateId, packageName, offset: null, nodeId: 0, createdAt: "2026-08-29T12:00:00.000000Z",
  signatories, observers, createArgument, interfaceViews, witnessParties: signatories, contractKey: null,
});

export function amulet({ owner, amount, contractId = cid("am"), round = 100, rate = "0.0000190259", withView = true }) {
  const a = { dso: DSO, owner, amount: { initialAmount: dec(amount), createdAt: { number: String(round) }, ratePerRound: { rate } } };
  return base(contractId, `${PKG}:Splice.Amulet:Amulet`, "splice-amulet", [DSO, owner], [], a, withView ? [view(owner, "Amulet", amount)] : []);
}
export function lockedAmulet({ owner, amount, contractId = cid("la"), holders = [DSO], expiresAt = "2026-09-01T00:00:00Z", round = 100, rate = "0.0000190259", withView = true }) {
  const a = { amulet: { dso: DSO, owner, amount: { initialAmount: dec(amount), createdAt: { number: String(round) }, ratePerRound: { rate } } }, lock: { holders, expiresAt } };
  return base(contractId, `${PKG}:Splice.Amulet:LockedAmulet`, "splice-amulet", [DSO, owner], holders, a, withView ? [view(owner, "Amulet", amount, { holders, expiresAt, context: null })] : []);
}
export function rewardCoupon({ owner, contractId = cid("rc"), round = 100 }) {
  return base(contractId, `${PKG}:Splice.Amulet:RewardCouponV2`, "splice-amulet", [DSO], [owner], { dso: DSO, user: owner, round: { number: String(round) }, amount: "1.0000000000" });
}
export function c8Holding({ family = "CETH", owner, amount, contractId = cid("c8"), locked = false, lockHolder = null, admin = "c8admin::1" }) {
  const t = locked ? "LockedHolding" : "Holding";
  const a = { owner, amount: dec(amount), admin, ...(locked ? { lockHolder, expiresAt: "2026-09-01T00:00:00Z" } : {}) };
  return base(contractId, `${PKG}:Cantor8.${family}.Holding:${t}`, `cantor8-${family.toLowerCase()}`, [admin, owner], [], a);
}
export function plain({ qname = "Splice.Wallet.Install:WalletAppInstall", contractId = cid("pl"), signatories = [DSO], observers = [], payload = {} }) {
  return base(contractId, `${PKG}:${qname}`, "splice-wallet", signatories, observers, payload);
}

export const created = (ev) => ({ CreatedEvent: ev });
export const archived = (ev) => ({ ArchivedEvent: { contractId: ev.contractId, templateId: ev.templateId, packageName: ev.packageName, offset: null, nodeId: 0, witnessParties: ev.signatories } });

let txSeq = 0;
/** Build a transaction at `offset`; stamps offset/nodeId on every event. */
export function tx(offset, events, { recordTime, updateId } = {}) {
  const rt = recordTime || new Date(Date.parse("2026-08-29T12:00:00Z") + offset * 1000).toISOString();
  let node = 0;
  for (const e of events) { const ev = e.CreatedEvent || e.ArchivedEvent; ev.offset = offset; ev.nodeId = node++; if (e.CreatedEvent) e.CreatedEvent.createdAt = rt; }
  return { updateId: updateId || `1220${String(++txSeq).padStart(8, "0")}${offset}`, commandId: "", workflowId: "", offset, recordTime: rt, effectiveAt: rt, synchronizerId: "sync::1", events, traceContext: null };
}
