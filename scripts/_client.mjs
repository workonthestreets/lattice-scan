// Shared by the demo scripts: an API client that presents the scanner's own participant token
// (the API is gated with AUTH_MODE=ledger; the scripts read the same .env the scanner does).
import { config } from "../src/config.mjs";
import { token } from "../src/token.mjs";

export const API = process.env.API || `http://localhost:${config.port}`;

export async function authHeaders() {
  if (config.authMode === "off") return {};
  return { authorization: "Bearer " + (process.env.TOKEN || await token()) };
}

/** fetch against the scanner API with the bearer token; returns the Response. */
export async function apiFetch(path, opts = {}) {
  const headers = { ...(await authHeaders()), ...(opts.headers || {}) };
  return fetch(API + path, { ...opts, headers });
}

/** GET/POST JSON; throws on non-2xx with the body's detail. */
export async function apiJson(path, opts) {
  const r = await apiFetch(path, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`${r.status} ${path}: ${body?.detail || String(text).slice(0, 200)}`);
  return body;
}
