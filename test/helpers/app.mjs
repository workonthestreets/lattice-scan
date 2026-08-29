// Points the scanner at a mock participant and an in-memory mirror, then imports the modules fresh.
// Env must be set BEFORE config.mjs is imported (it reads process.env and .env once, at import).
export function setTestEnv(mock, overrides = {}) {
  Object.assign(process.env, {
    LEDGER_HTTP: mock.url, LEDGER_WS: mock.wsUrl, IDP_TOKEN_URL: mock.url + "/token",
    CLIENT_ID: "test-client", CLIENT_SECRET: "test-secret", SCAN_URL: mock.url,
    DB_PATH: ":memory:", PORT: "0", FILTER_MODE: "any", AUTH_MODE: "off", DEMO_LOGIN: "0", PARTIES: "",
    VERIFY_INTERVAL_SEC: "0", SOCKET_RECYCLE_SEC: "600", BATCH_SIZE: "2", WATCHDOG_SEC: "30",
    ...overrides,
  });
}

export async function loadApp() {
  const [config, db, reduce, tail, bootstrap, backfill, verify, api, auth, ledger, token] = await Promise.all([
    import("../../src/config.mjs"), import("../../src/db.mjs"), import("../../src/reduce.mjs"), import("../../src/tail.mjs"),
    import("../../src/bootstrap.mjs"), import("../../src/backfill.mjs"), import("../../src/verify.mjs"), import("../../src/api.mjs"),
    import("../../src/auth.mjs"), import("../../src/ledger.mjs"), import("../../src/token.mjs"),
  ]);
  return { config: config.config, db, reduce, tail, bootstrap, backfill, verify, api, auth, ledger, token };
}

export async function waitFor(fn, { timeoutMs = 8000, everyMs = 20, label = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise(r => setTimeout(r, everyMs));
  }
}

/** Start the API on an ephemeral port; returns {base, server, get, post}. */
export function startTestApi(api, { token } = {}) {
  const server = api.startApi();
  const headers = token ? { authorization: "Bearer " + token } : {};
  const base = () => `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, tok = token) => {
    const r = await fetch(base() + path, { method, headers: tok ? { authorization: "Bearer " + tok } : {} });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body, headers: r.headers };
  };
  return { server, base, headers, get: (p, tok) => call("GET", p, tok), post: (p, tok) => call("POST", p, tok),
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
