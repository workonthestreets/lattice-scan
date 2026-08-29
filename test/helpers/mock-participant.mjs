// A fake Canton participant for offline tests: Keycloak token endpoint, JSON Ledger API v2 (HTTP + WebSocket
// streams), and the two Scan API calls the scanner makes. It keeps a tiny ledger model: committed transactions
// build the active set; the ACS at an offset and the update stream from an offset are derived from it.
import http from "node:http";
import { acceptKey, wrapSocket } from "./ws.mjs";

export const SERVICE_TOKEN = "svc-token";

export function anyPartyRights(parties = []) {
  return [{ kind: { CanReadAsAnyParty: { value: {} } } }, { kind: { ParticipantAdmin: { value: {} } } },
    ...parties.map(p => ({ kind: { CanActAs: { value: { party: p } } } }))];
}
export const actAsRights = (parties) => parties.map(p => ({ kind: { CanActAs: { value: { party: p } } } }));

export async function startMockParticipant({ tokens = {}, miningRound = 110 } = {}) {
  const users = {
    [SERVICE_TOKEN]: { user: { id: "validator-backend", primaryParty: "operator::1" }, rights: anyPartyRights(["operator::1"]) },
    ...tokens,
  };
  const ledger = {
    end: 0, pruned: 0,
    httpPruned: null,       // when set, GET latest-pruned-offsets reports this (stale) value while streams enforce `pruned`
    contracts: new Map(),   // contractId -> { ev, created, archived, syncId }
    updates: [],            // committed transactions in offset order
    tails: new Set(),       // open /v2/updates sockets without endInclusive
    requests: [],           // every WS request received, for assertions
    http: [],               // every HTTP request path
    tokenMints: 0,
    commit(tx) {
      if (tx.offset <= this.end) throw new Error(`offset ${tx.offset} not after ledger end ${this.end}`);
      for (const e of tx.events || []) {
        if (e.CreatedEvent) this.contracts.set(e.CreatedEvent.contractId, { ev: e.CreatedEvent, created: tx.offset, archived: null, syncId: tx.synchronizerId });
        else if (e.ArchivedEvent) { const c = this.contracts.get(e.ArchivedEvent.contractId); if (c) c.archived = tx.offset; }
      }
      this.end = tx.offset; this.updates.push(tx);
      for (const ws of this.tails) ws.send({ update: { Transaction: tx } });
      return tx;
    },
    checkpoint(offset, recordTime = new Date().toISOString()) {
      this.end = Math.max(this.end, offset);
      for (const ws of this.tails) ws.send({ update: { OffsetCheckpoint: { value: { offset, synchronizerTimes: [{ synchronizerId: "sync::1", recordTime }] } } } });
    },
    prune(upToInclusive) { this.pruned = upToInclusive; this.updates = this.updates.filter(u => u.offset > upToInclusive); },
    acs(at) { return [...this.contracts.values()].filter(c => c.created <= at && (c.archived === null || c.archived > at)); },
    /** The participant re-checks stream authorization: in-band error, then a normal close. */
    staleAuth() { for (const ws of [...this.tails]) { ws.send({ code: "STALE_STREAM_AUTHORIZATION", cause: "Stream authorization is stale. Retry quickly.", context: {} }); ws.close(1000, ""); } },
    dropTails() { for (const ws of [...this.tails]) ws.close(1011, "simulated participant restart"); },
  };

  const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const bearer = (req) => { const h = req.headers.authorization || ""; return h.startsWith("Bearer ") ? h.slice(7) : ""; };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    ledger.http.push(req.method + " " + u.pathname);
    if (req.method === "POST" && u.pathname === "/token") { ledger.tokenMints++; return json(res, 200, { access_token: SERVICE_TOKEN, expires_in: 900, token_type: "Bearer" }); }
    if (u.pathname === "/api/scan/v0/open-and-issuing-mining-rounds")
      return json(res, 200, { open_mining_rounds: { r: { contract: { payload: { round: { number: String(miningRound) } } } } }, issuing_mining_rounds: {} });
    const auth = users[bearer(req)];
    if (!auth) return json(res, 401, { cause: "The supplied authentication is invalid", code: "UNAUTHENTICATED" });
    if (u.pathname === "/v2/version") return json(res, 200, { version: "3.5.14-mock" });
    if (u.pathname === "/v2/state/ledger-end") return json(res, 200, { offset: ledger.end });
    if (u.pathname === "/v2/state/latest-pruned-offsets") { const p = ledger.httpPruned ?? ledger.pruned; return json(res, 200, { participantPrunedUpToInclusive: p, allDivulgedContractsPrunedUpToInclusive: p }); }
    if (u.pathname === "/v2/authenticated-user") return json(res, 200, { user: auth.user });
    const m = u.pathname.match(/^\/v2\/users\/([^/]+)\/rights$/);
    if (m) { const id = decodeURIComponent(m[1]); const owner = Object.values(users).find(x => x.user.id === id); return owner ? json(res, 200, { rights: owner.rights }) : json(res, 404, { cause: "no such user" }); }
    json(res, 404, { cause: "no such route " + u.pathname });
  });

  server.on("upgrade", (req, socket, head) => {
    const protos = String(req.headers["sec-websocket-protocol"] || "").split(",").map(s => s.trim());
    const tok = protos.find(p => p.startsWith("jwt.token."))?.slice("jwt.token.".length);
    if (!users[tok] || !protos.includes("daml.ws.auth")) { socket.write("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n"); socket.destroy(); return; }
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(req.headers["sec-websocket-key"])}`, "Sec-WebSocket-Protocol: daml.ws.auth", "", ""].join("\r\n"));
    const ws = wrapSocket(socket, head);
    const path = new URL(req.url, "http://x").pathname;
    ws.on("message", (text) => {
      let r; try { r = JSON.parse(text); } catch { return ws.close(1003, "bad json"); }
      ledger.requests.push({ path, request: r });
      if (path === "/v2/state/active-contracts") {
        const at = Number(r.activeAtOffset);
        if (at > ledger.end) { ws.send({ code: "OFFSET_AFTER_LEDGER_END", cause: `${at} > ${ledger.end}`, context: {} }); return ws.close(1000); }
        for (const c of ledger.acs(at)) ws.send({ contractEntry: { JsActiveContract: { createdEvent: c.ev, synchronizerId: c.syncId, reassignmentCounter: 0 } }, workflowId: "" });
        return ws.close(1000, "");
      }
      if (path === "/v2/updates") {
        const begin = Number(r.beginExclusive), end = r.endInclusive === undefined ? null : Number(r.endInclusive);
        if (begin < ledger.pruned) {
          ws.send({ code: "PARTICIPANT_PRUNED_DATA_ACCESSED", cause: `Transactions request from ${begin + 1} precedes pruned offset ${ledger.pruned}`, context: { earliest_offset: ledger.pruned } });
          return ws.close(1000, "");
        }
        for (const tx of ledger.updates) if (tx.offset > begin && (end === null || tx.offset <= end)) ws.send({ update: { Transaction: tx } });
        if (end !== null) return ws.close(1000, "");
        ledger.tails.add(ws);
        ws.on("close", () => ledger.tails.delete(ws));
        return;
      }
      ws.close(1008, "unknown path " + path);
    });
  });

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    ledger, users, port,
    url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}`,
    close: () => new Promise(r => { for (const ws of ledger.tails) ws.close(1001); server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
