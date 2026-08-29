// JSON Ledger API v2 helpers: HTTP GET/POST and an authenticated WebSocket stream reader.
import { config, log } from "./config.mjs";
import { token } from "./token.mjs";

export class LedgerError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status} from ${url}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
    this.status = status; this.body = body;
  }
}

async function call(method, path, body) {
  const url = config.ledgerHttp + path;
  const r = await fetch(url, {
    method,
    headers: { authorization: "Bearer " + (await token()), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!r.ok) throw new LedgerError(r.status, parsed, url);
  return parsed;
}
export const get = (path) => call("GET", path);
export const post = (path, body) => call("POST", path, body);

export const ledgerEnd = async () => (await get("/v2/state/ledger-end")).offset;
export const prunedOffset = async () => (await get("/v2/state/latest-pruned-offsets")).participantPrunedUpToInclusive ?? 0;
export const version = () => get("/v2/version");
export const authenticatedUser = () => get("/v2/authenticated-user");

/**
 * Open an authenticated WebSocket to `path`, send `request`, call `onFrame(obj)` per JSON frame.
 * Resolves {code, reason, frames} on close. Rejects on in-band JsCantonError frames (top-level `code`)
 * unless `opts.tolerateErrors`. `opts.signal` (AbortSignal) closes the socket early.
 */
export function stream(path, request, onFrame, opts = {}) {
  return new Promise(async (resolve, reject) => {
    let tok;
    try { tok = await token(); } catch (e) { return reject(e); }
    const url = config.ledgerWs + path;
    const ws = new WebSocket(url, ["jwt.token." + tok, "daml.ws.auth"]);
    let frames = 0, settled = false, lastFrameAt = Date.now();
    const finish = (fn, v) => { if (!settled) { settled = true; clearInterval(wd); fn(v); } };
    const wd = opts.watchdogSec ? setInterval(() => {
      if (Date.now() - lastFrameAt > opts.watchdogSec * 1000) {
        log(`ws ${path}: no frame for ${opts.watchdogSec}s, closing`);
        try { ws.close(4000, "watchdog"); } catch {}
      }
    }, 5000) : null;
    if (opts.signal) opts.signal.addEventListener("abort", () => { try { ws.close(4001, "abort"); } catch {} }, { once: true });
    ws.onopen = () => ws.send(JSON.stringify(request));
    ws.onmessage = (m) => {
      frames++; lastFrameAt = Date.now();
      let obj;
      try { obj = JSON.parse(m.data); } catch (e) { return finish(reject, new Error("bad frame: " + String(m.data).slice(0, 200))); }
      if (obj && obj.code && !obj.update && !obj.contractEntry) {
        const err = new LedgerError(obj.code === "PERMISSION_DENIED" ? 403 : 400, obj, url);
        err.canton = obj;
        if (!opts.tolerateErrors) { try { ws.close(); } catch {} return finish(reject, err); }
      }
      try { onFrame(obj); } catch (e) { try { ws.close(); } catch {} return finish(reject, e); }
    };
    ws.onerror = (e) => finish(reject, new Error(`ws error on ${path}: ${e && e.message ? e.message : "unknown"}`));
    ws.onclose = (e) => finish(resolve, { code: e.code, reason: e.reason, frames });
  });
}
