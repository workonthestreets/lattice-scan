// SQLite mirror (node:sqlite, WAL). Schema per PLAN.md section 4.
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.mjs";
import { qnameOf, packageIdOf, asHolding, holdingView } from "./reduce.mjs";

export const db = new DatabaseSync(config.dbPath);
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA temp_store=MEMORY;
PRAGMA cache_size=-200000;

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS contracts (
  contract_id     TEXT PRIMARY KEY,
  qname           TEXT NOT NULL,
  package_id      TEXT, package_name TEXT,
  created_offset  INTEGER, created_node INTEGER, created_at TEXT,
  archived_offset INTEGER,
  synchronizer_id TEXT,
  payload         TEXT NOT NULL,
  holding_view    TEXT,
  signatories     TEXT NOT NULL,
  observers       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_contracts_active ON contracts(qname) WHERE archived_offset IS NULL;
CREATE INDEX IF NOT EXISTS ix_contracts_created ON contracts(created_offset);
CREATE INDEX IF NOT EXISTS ix_contracts_archived ON contracts(archived_offset);

CREATE TABLE IF NOT EXISTS stakeholders (
  contract_id TEXT NOT NULL, party TEXT NOT NULL, role TEXT NOT NULL,
  PRIMARY KEY (contract_id, party)
);
CREATE INDEX IF NOT EXISTS ix_stake_party ON stakeholders(party);

CREATE TABLE IF NOT EXISTS holdings (
  contract_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL, instrument TEXT NOT NULL, admin TEXT,
  amount TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0, lock_expires_at TEXT, lock_holders TEXT,
  round INTEGER, rate TEXT,
  created_offset INTEGER, archived_offset INTEGER
);
CREATE INDEX IF NOT EXISTS ix_hold_owner ON holdings(owner, instrument) WHERE archived_offset IS NULL;
CREATE INDEX IF NOT EXISTS ix_hold_owner_all ON holdings(owner);

CREATE TABLE IF NOT EXISTS events (
  offset INTEGER NOT NULL, node_id INTEGER NOT NULL,
  update_id TEXT NOT NULL, kind TEXT NOT NULL,
  contract_id TEXT NOT NULL, qname TEXT NOT NULL,
  record_time TEXT, effective_at TEXT,
  PRIMARY KEY (offset, node_id)
);
CREATE INDEX IF NOT EXISTS ix_events_contract ON events(contract_id);
CREATE INDEX IF NOT EXISTS ix_events_update ON events(update_id);
CREATE INDEX IF NOT EXISTS ix_events_time ON events(record_time);

CREATE TABLE IF NOT EXISTS activity (
  update_id TEXT NOT NULL, offset INTEGER NOT NULL, record_time TEXT,
  party TEXT NOT NULL, instrument TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount TEXT, counterparty TEXT, confidence TEXT,
  PRIMARY KEY (update_id, party, instrument)
);
CREATE INDEX IF NOT EXISTS ix_activity_party ON activity(party, offset);

CREATE TABLE IF NOT EXISTS verify_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, finished_at TEXT,
  at_offset INTEGER, ledger_count INTEGER, mirror_count INTEGER,
  only_in_ledger INTEGER, only_in_mirror INTEGER, repaired INTEGER, duration_ms INTEGER
);
CREATE TABLE IF NOT EXISTS verify_findings (
  run_id INTEGER, contract_id TEXT, kind TEXT, qname TEXT, action TEXT,
  PRIMARY KEY (run_id, contract_id)
);
`);

const S = {
  getMeta: db.prepare("SELECT v FROM meta WHERE k = ?"),
  setMeta: db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
  insContract: db.prepare(`INSERT OR IGNORE INTO contracts
    (contract_id, qname, package_id, package_name, created_offset, created_node, created_at, archived_offset, synchronizer_id, payload, holding_view, signatories, observers)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`),
  insStake: db.prepare("INSERT OR IGNORE INTO stakeholders(contract_id, party, role) VALUES (?, ?, ?)"),
  insHolding: db.prepare(`INSERT OR REPLACE INTO holdings
    (contract_id, owner, instrument, admin, amount, locked, lock_expires_at, lock_holders, round, rate, created_offset, archived_offset)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`),
  insEvent: db.prepare(`INSERT OR IGNORE INTO events(offset, node_id, update_id, kind, contract_id, qname, record_time, effective_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  archiveContract: db.prepare("UPDATE contracts SET archived_offset = ? WHERE contract_id = ? AND archived_offset IS NULL"),
  archiveHolding: db.prepare("UPDATE holdings SET archived_offset = ? WHERE contract_id = ? AND archived_offset IS NULL"),
  getHolding: db.prepare("SELECT * FROM holdings WHERE contract_id = ?"),
  contractExists: db.prepare("SELECT qname, archived_offset FROM contracts WHERE contract_id = ?"),
  insActivity: db.prepare(`INSERT OR REPLACE INTO activity(update_id, offset, record_time, party, instrument, kind, amount, counterparty, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
};

export const getMeta = (k) => S.getMeta.get(k)?.v;
export const setMeta = (k, v) => S.setMeta.run(k, v === null || v === undefined ? null : String(v));
export const getMetaInt = (k, d = 0) => { const v = getMeta(k); return v === undefined || v === null ? d : Number(v); };

let depth = 0;
export function transaction(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  finally { depth--; }
}

/** Insert a CreatedEvent (ACS entry or tail event). Returns {isNew, holding}. */
export function upsertCreate(ev, ctx = {}) {
  const qname = qnameOf(ev.templateId);
  const view = holdingView(ev);
  const sig = ev.signatories || [], obs = ev.observers || [];
  const r = S.insContract.run(
    ev.contractId, qname, packageIdOf(ev.templateId), ev.packageName || null,
    ev.offset ?? null, ev.nodeId ?? null, ev.createdAt || null,
    ctx.synchronizerId || null,
    JSON.stringify(ev.createArgument ?? null), view ? JSON.stringify(view) : null,
    JSON.stringify(sig), JSON.stringify(obs),
  );
  const isNew = r.changes > 0;
  if (isNew) {
    for (const p of sig) S.insStake.run(ev.contractId, p, "signatory");
    for (const p of obs) S.insStake.run(ev.contractId, p, "observer");
  }
  let holding = asHolding(qname, ev.createArgument, view);
  if (holding && isNew) {
    S.insHolding.run(ev.contractId, holding.owner, holding.instrument, holding.admin || null, holding.amount,
      holding.locked ? 1 : 0, holding.lock?.expiresAt || null, holding.lock?.holders ? JSON.stringify(holding.lock.holders) : null,
      holding.round ?? null, holding.rate ?? null, ev.offset ?? null);
  }
  if (ctx.updateId) S.insEvent.run(ev.offset, ev.nodeId, ctx.updateId, "created", ev.contractId, qname, ctx.recordTime || null, ctx.effectiveAt || null);
  return { isNew, holding, qname };
}

/** Apply an ArchivedEvent. Returns {known, holding (row before archive), qname}. */
export function archive(ev, ctx = {}) {
  const qname = qnameOf(ev.templateId);
  const holding = S.getHolding.get(ev.contractId) || null;
  const r = S.archiveContract.run(ev.offset, ev.contractId);
  let known = r.changes > 0;
  if (!known) {
    const ex = S.contractExists.get(ev.contractId);
    if (!ex) { if (!ctx.backfill) setMeta("orphan_archive_total", getMetaInt("orphan_archive_total") + 1); }
    else known = true; // already archived (replayed frame): idempotent no-op
  }
  if (holding) S.archiveHolding.run(ev.offset, ev.contractId);
  if (ctx.updateId) S.insEvent.run(ev.offset, ev.nodeId, ctx.updateId, "archived", ev.contractId, qname, ctx.recordTime || null, ctx.effectiveAt || null);
  return { known, holding, qname };
}

export function insertActivity(row) {
  S.insActivity.run(row.update_id, row.offset, row.record_time || null, row.party, row.instrument, row.kind,
    row.amount ?? null, row.counterparty ?? null, row.confidence ?? null);
}

export function setCursor(offset, recordTime) {
  setMeta("offset", offset);
  if (recordTime) setMeta("record_time", recordTime);
  setMeta("last_commit_at", new Date().toISOString());
}

export function counts() {
  const one = (sql) => Object.values(db.prepare(sql).get())[0];
  return {
    contracts_total: one("SELECT count(*) FROM contracts"),
    contracts_active: one("SELECT count(*) FROM contracts WHERE archived_offset IS NULL"),
    holdings_active: one("SELECT count(*) FROM holdings WHERE archived_offset IS NULL"),
    events_indexed: one("SELECT count(*) FROM events"),
    updates_indexed: one("SELECT count(DISTINCT update_id) FROM events"),
    parties_seen: one("SELECT count(DISTINCT party) FROM stakeholders"),
    templates: one("SELECT count(DISTINCT qname) FROM contracts"),
  };
}
