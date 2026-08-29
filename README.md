# Lattice Scan

Participant-internal ledger scanner for the Canton Network. It takes a full snapshot of every active contract the validator's hosted parties can see, mirrors it into SQLite, follows the ledger's update stream from that exact offset, and serves balances, holdings, history and contracts over a JSON API with a one-page dashboard. A self-check re-downloads the ledger's active set and diffs it against the mirror to prove the copy is exact.

Built for Track A1 of the Cantor8 "Build on Canton" hackathon (London, 29 August 2026) against the Cantor8 DevNet validator (Canton 3.5.14, JSON Ledger API v2).

## Measured on DevNet, 29 Aug 2026

| What | Number |
|---|---|
| Bootstrap (full ACS over one WebSocket, into SQLite) | 109,778 contracts, 43,631 holdings, 26,020 parties, 145 templates, in 11.5 s |
| Resume after `kill -9` mid-tail | re-read 0 contracts, cursor resumed at the committed offset, tail reconnected in under 4 s |
| Self-check (ledger ACS at a pinned offset vs mirror) | 109,778 vs 109,778, 0 missing, 0 phantom, 9.6 to 18.4 s per run |
| Canton Coin balances vs the public Scan API oracle | 8 of 8 parties match to 10 decimal places (`scripts/oracle.mjs`) |
| History reconstructed before the snapshot | every readable update back to the participant's pruning floor: 523 updates, 1,099 events, about 25 hours (2026-08-28 14:00 UTC onward), replayed in 0.6 s; classified as reward_collect 148, transfer_in 21, transfer_out 13, self_merge 5, mint 1, unclassified 5 |
| Lag | seconds between the last record time applied and now; shown live in `/health` (the reference scanner reports about 2.7 s; DevNet on a Saturday emits an update every 10 to 60 s, so the figure tracks ledger activity, not our speed) |

## Honest boundary

This index covers contracts where a party hosted on this participant is a stakeholder. Parties hosted on other validators appear only where they transact with a local party. History before the participant's pruning floor (about 25 hours behind ledger end on DevNet, and moving) is not reconstructable from the ledger; the snapshot carries every active contract with its original creation offset, the backfill carries every update between the floor and the snapshot, and the stream carries everything from the snapshot on. `/health` reports `history_from_offset`. Canton Coin balances are the sum of each holding's face value (`initialAmount`), the same figure the Scan API and Cantor8's own scanner report; the value after accrued holding fees is shown separately. Transfer classification uses create and archive events only: when the counterparty is hosted elsewhere we say `counterparty: null, confidence: low` rather than guess.

## Run

Node 24 or newer. No `npm install`.

```bash
cp .env.example .env            # fill CLIENT_SECRET from the organisers' message
npm run check                   # token, ledger version, rights, pruned offset, mirror state
npm start                       # bootstrap (or resume) + tail + API on http://localhost:8787
npm run verify                  # one self-check run (or POST /verify/run while it is running)
npm run oracle -- <party> ...   # our CC balances vs the Scan API holdings summary
npm run measure                 # the numbers above, live
sh scripts/killtest.sh          # kill -9, restart, resume, self-check
```

## Test

```bash
npm test                        # 76 offline tests, ~3 s, no network, no credentials
npm run test:live               # 7 acceptance tests against the running scanner + DevNet (needs CLIENT_SECRET)
```

The offline suite runs the whole pipeline against a mock participant (`test/helpers/mock-participant.mjs`: Keycloak token endpoint, JSON Ledger API v2 over HTTP and a hand-rolled WebSocket server) with an in-memory SQLite mirror:

| File | Proves |
|---|---|
| `test/decimal.test.mjs` | exact 10-dp arithmetic, truncation, round-trips |
| `test/reduce.test.mjs` | template naming, `Holding` view precedence, every holding template family, every activity kind (incl. lock/unlock on net-zero moves), holding-fee decay |
| `test/db.test.mjs` | idempotent creates and archives, replayed frames are no-ops, orphan counting, transaction rollback, `applyTx` atomicity |
| `test/api.test.mjs` | every route; the auth gate (401 no token, 401 participant-rejected, 401 expired, 403 other party, 403 participant-wide views, `/search` filtering, per-token cache); `/parties/top` routing; self-check with and without repair |
| `test/e2e.test.mjs` | bootstrap filter shape and cursor commit; backfill retry when the pruning floor moves mid-request; pre-floor inputs reported as `unclassified`; live tail; `STALE_STREAM_AUTHORIZATION` reconnect from the committed cursor; abnormal close and backoff; `OffsetCheckpoint`; self-check finds and repairs a missing and a phantom contract; resume re-reads nothing; forced bootstrap |
| `test/live.test.mjs` | the deployed instance: health and tail, auth gate, balances = sum of holdings, self-check 0/0 against the participant, Scan API oracle, demo scripts through the gate |

## Who can read what

The scanner has no users of its own. With `AUTH_MODE=ledger` (the default) every data route needs a bearer token for the participant, and the scanner asks the participant two questions about it: who is this (`GET /v2/authenticated-user`) and which parties may they read (`GET /v2/users/{id}/rights`). A token the participant rejects gets a 401 here; a party the token cannot read gets a 403 here; views that span every party (overview, templates, self-check) need `CanReadAsAnyParty`. The participant decides, the scanner only relays. `GET /health` stays open (counts, no ledger data). Paste a token into the dashboard's sign-in form; it is kept in the browser only. `AUTH_MODE=off` disables the gate for local development.

```bash
curl -s localhost:8787/parties/<party>/balances                              # 401: sign in
curl -s -H 'authorization: Bearer garbage' localhost:8787/parties/<party>/balances   # 401: participant rejected this token
curl -s -H "authorization: Bearer $TOKEN" localhost:8787/parties/<party>/balances    # 200, or 403 if the token cannot read that party
```

`FILTER_MODE=any` uses `filtersForAnyParty` (needs a token with `CanReadAsAnyParty`, which the hackathon client has). If the token is party-scoped, set `FILTER_MODE=parties` and `PARTIES=<comma separated party ids>`.

## API

| Route | Returns |
|---|---|
| `GET /health` | offsets (snapshot, cursor, ledger end, gap, pruned), lag seconds, counts, updates per minute, tail state, last self-check, boundary text |
| `GET /parties/{party}/balances` | per instrument: balance, locked, available, UTXO count, effective after holding fees (Canton Coin) |
| `GET /parties/{party}/holdings?instrument=&locked=&limit=` | holding contracts |
| `GET /parties/{party}/history?limit=&before_offset=&raw=1` | classified activity (transfer_in, transfer_out, self_merge, reward_collect, lock, unlock, mint, burn, unclassified) |
| `GET /parties/{party}/contracts?qname=&active=1` | every contract the party is a stakeholder of, with role |
| `GET /parties/{party}/templates` | template counts for the party |
| `GET /parties/top?limit=` | parties by UTXO count (the fragmentation view) |
| `GET /contracts/{id}` | payload, holding view, stakeholders, lifecycle, events |
| `GET /updates/recent?limit=` | latest updates with events, parties and classified activity |
| `GET /templates` | template counts across the index |
| `GET /search?q=` | party id search |
| `GET /verify`, `POST /verify/run` | self-check runs, findings, run one now |

All amounts are decimal strings. Unknown parties return 404 with the boundary message rather than a fake zero balance.

## How it works

1. `token.mjs` mints a Keycloak client-credentials token and refreshes it at 80 percent of its 900 s TTL. WebSockets authenticate through the `jwt.token.<token>` and `daml.ws.auth` subprotocols.
2. `bootstrap.mjs` reads ledger end E and the pruned offset, then streams `WS /v2/state/active-contracts` at `activeAtOffset: E` with one cumulative filter: `WildcardFilter` (every contract the parties are stakeholders of) plus the token-standard `Holding` `InterfaceFilter` with views. Rows are committed in batches of 5,000; `snapshot_complete` and the cursor are written in the same transaction as the last batch, so a kill mid-bootstrap redoes it cleanly.
3. `tail.mjs` streams `WS /v2/updates` from the cursor (exclusive) in `TRANSACTION_SHAPE_ACS_DELTA`. Each update's creates and archives, the classified activity rows and the new cursor are one SQLite transaction. `OffsetCheckpoint` frames advance the cursor during quiet periods. The socket is recycled every 10 minutes with a fresh token, reconnects use exponential backoff, and `(offset, node_id)` is the events primary key so a replayed frame is a no-op. The DevNet participant also ends the stream about every 5 minutes with an in-band `STALE_STREAM_AUTHORIZATION` ("Retry quickly"); the tail treats that as a normal, immediate reconnect from the committed cursor and counts it separately in `/health` (`tail.stale_auth_reconnects`).
4. `reduce.mjs` normalises holdings from the `Holding` interface view (owner, instrument, amount, lock) with raw-payload fallbacks for Amulet, LockedAmulet, Utility.Registry and Cantor8 holding templates, and classifies each update from per-party, per-instrument holding deltas.
5. `backfill.mjs` runs once after bootstrap: it replays `WS /v2/updates` from the participant's live pruning floor up to the snapshot offset into the events and activity tables, so transfer history reaches as far back as the node still holds. The active set is not touched (the snapshot already reflects that window); contracts created and archived inside the window are added with both offsets. The floor moves while the node prunes, so the request reads `latest-pruned-offsets` live and retries from the `earliest_offset` the node reports.
6. `verify.mjs` re-streams the ACS at a fresh ledger end E2 once the cursor has passed E2 and set-diffs it against the mirror as of E2, repairing and recording any difference.

The HTTP variants of the list endpoints stop at 200 elements (`413 JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED`); the WebSocket variants are used for everything bulk. `POST /v2/state/active-contracts-page` exists as a paged HTTP fallback.

## Not done, not claimed

- No LEDGER_EFFECTS enrichment stream, so exact counterparties and reasons for Canton Coin flows (the `EventLog_HoldingsChange` event) are not attached; classification confidence is reported per row.
- `Reassignment` and `TopologyTransaction` updates only advance the cursor (single synchronizer on DevNet).
- Instrument ids come from each token's own `Holding` view; the same template family can carry several ids across package versions (`c8ETH` and `cETH` both exist on DevNet). They are reported as the ledger names them.
- The dashboard is a static page over the API; no auth in front of it.
