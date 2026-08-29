#!/usr/bin/env node
// Prints the numbers for the judges from the running scanner.
import { apiJson as j } from "./_client.mjs";

const h = await j("/health");
const kinds = await j("/activity/kinds");
const v = await j("/verify");
const lines = [
  ["status", h.status],
  ["bootstrap", `${h.bootstrap_contracts?.toLocaleString()} contracts in ${h.bootstrap_ms} ms`],
  ["contracts active / total", `${h.contracts_active?.toLocaleString()} / ${h.contracts_total?.toLocaleString()}`],
  ["holdings active", h.holdings_active?.toLocaleString()],
  ["parties seen", h.parties_seen?.toLocaleString()],
  ["templates", h.templates],
  ["cursor / ledger end / gap", `${h.cursor_offset} / ${h.ledger_end} / ${h.gap_offsets}`],
  ["lag seconds", h.lag_seconds],
  ["updates applied / per min", `${h.updates_indexed} / ${h.updates_per_min}`],
  ["events indexed", h.events_indexed],
  ["orphan archives", h.orphan_archive_total],
  ["tail", `${h.tail.connected ? "connected" : "disconnected"}, ${h.tail.reconnects} reconnects, ${h.tail.errors} errors`],
  ["pruned offset (history floor)", h.pruned_offset],
  ["activity kinds", kinds.map(k => `${k.kind}=${k.n}`).join(", ") || "none yet"],
  ["last self-check", v.runs[0] ? `offset ${v.runs[0].at_offset}: ledger ${v.runs[0].ledger_count} vs mirror ${v.runs[0].mirror_count}, ${v.runs[0].only_in_ledger} missing, ${v.runs[0].only_in_mirror} phantom, ${v.runs[0].duration_ms} ms` : "none"],
  ["uptime s", h.uptime_s],
];
for (const [k, val] of lines) console.log(k.padEnd(30), val);
