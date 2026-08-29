// Authorization gate: the scanner does not have its own users. A caller presents a bearer token for the
// participant; the participant says who that is (GET /v2/authenticated-user) and which parties that user
// may read (GET /v2/users/{id}/rights). The scanner shows exactly that and nothing else. A token the
// participant rejects is rejected here; a party the token cannot read is a 403 here.
import { config } from "./config.mjs";

export class AuthError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

const cache = new Map(); // token -> { exp, ctx }
const CACHE_MS = 60_000;

function claimsOf(tok) {
  try { const p = tok.split(".")[1]; return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()); }
  catch { return null; }
}

async function ledgerGet(path, tok) {
  const r = await fetch(config.ledgerHttp + path, { headers: { authorization: "Bearer " + tok } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

export const OPEN = Object.freeze({ mode: "off", user: "anonymous", anyParty: true, parties: null, primaryParty: null });

/** Returns an auth context or throws AuthError(401|403|502). */
export async function authenticate(req) {
  if (config.authMode !== "ledger") return OPEN;
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!tok) throw new AuthError(401, "A bearer token for the participant is required. The scanner shows only what the participant lets that token read.");
  const hit = cache.get(tok);
  if (hit && hit.exp > Date.now()) return hit.ctx;

  const claims = claimsOf(tok);
  if (claims?.exp && claims.exp * 1000 < Date.now()) throw new AuthError(401, "Token expired; mint a new one from the identity provider.");

  const me = await ledgerGet("/v2/authenticated-user", tok);
  if (me.status === 401 || me.status === 403) {
    const cause = me.body?.cause || (typeof me.body === "string" ? me.body.slice(0, 120) : "");
    throw new AuthError(401, "The participant rejected this token" + (cause ? ": " + cause : "") + ".");
  }
  if (me.status !== 200) throw new AuthError(502, `Participant returned ${me.status} while checking the token.`);
  const userId = me.body?.user?.id;
  const primaryParty = me.body?.user?.primaryParty || null;

  const parties = new Set();
  let anyParty = false;
  const rights = await ledgerGet(`/v2/users/${encodeURIComponent(userId)}/rights`, tok);
  for (const r of rights.body?.rights || []) {
    const k = Object.keys(r.kind || {})[0];
    if (k === "CanReadAsAnyParty") anyParty = true;
    const p = r.kind?.[k]?.value?.party;
    if (p && (k === "CanReadAs" || k === "CanActAs" || k === "CanExecuteAs")) parties.add(p);
  }
  if (primaryParty) parties.add(primaryParty);

  const ctx = { mode: "ledger", user: userId, anyParty, parties, primaryParty, tokenExp: claims?.exp || null };
  const exp = Math.min(Date.now() + CACHE_MS, claims?.exp ? claims.exp * 1000 : Infinity);
  cache.set(tok, { exp, ctx });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return ctx;
}

export const canRead = (ctx, party) => ctx.anyParty || (ctx.parties && ctx.parties.has(party));
export const canReadAny = (ctx, parties) => ctx.anyParty || parties.some(p => ctx.parties && ctx.parties.has(p));

export function describe(ctx) {
  return { mode: ctx.mode, user: ctx.user, any_party: ctx.anyParty, primary_party: ctx.primaryParty,
    parties_count: ctx.parties ? ctx.parties.size : null, token_expires_at: ctx.tokenExp ? new Date(ctx.tokenExp * 1000).toISOString() : null };
}
