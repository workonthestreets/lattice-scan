// Keycloak client-credentials token with refresh at 80% of its TTL (TTL on DevNet: 900 s).
import { config, log } from "./config.mjs";

let cached = { tok: null, exp: 0 };

export async function token(force = false) {
  if (!force && cached.tok && Date.now() < cached.exp) return cached.tok;
  if (!config.clientSecret) throw new Error("CLIENT_SECRET is not set (see .env.example)");
  const r = await fetch(config.idpTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });
  if (!r.ok) throw new Error(`token endpoint returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  cached = { tok: j.access_token, exp: Date.now() + Number(j.expires_in || 900) * 800 };
  log(`token: minted, expires_in=${j.expires_in}s, refresh in ${Math.round((cached.exp - Date.now()) / 1000)}s`);
  return cached.tok;
}

export function tokenClaims(tok) {
  try {
    const p = tok.split(".")[1];
    return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  } catch { return null; }
}
