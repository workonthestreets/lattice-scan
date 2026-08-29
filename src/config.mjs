// Configuration: .env (no dependency) + process.env + defaults.
import fs from "node:fs";
import path from "node:path";

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv(path.resolve(process.cwd(), ".env"));

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);

export const config = {
  ledgerHttp: env("LEDGER_HTTP", "https://api.validator.dev.digik.cantor8.tech/api/ledger"),
  ledgerWs: env("LEDGER_WS", "wss://api.validator.dev.digik.cantor8.tech/api/ledger"),
  idpTokenUrl: env("IDP_TOKEN_URL", "https://auth.dev.digik.cantor8.tech/realms/master/protocol/openid-connect/token"),
  clientId: env("CLIENT_ID", "hackathon"),
  clientSecret: env("CLIENT_SECRET", ""),
  scanUrl: env("SCAN_URL", "https://sv-proxy.dev.digik.cantor8.tech"),
  dbPath: env("DB_PATH", "./scanner.db"),
  port: Number(env("PORT", "8787")),
  filterMode: env("FILTER_MODE", "any"),               // any | parties
  parties: env("PARTIES", "").split(",").map(s => s.trim()).filter(Boolean),
  verifyIntervalSec: Number(env("VERIFY_INTERVAL_SEC", "0")),
  socketRecycleSec: Number(env("SOCKET_RECYCLE_SEC", "600")),
  batchSize: Number(env("BATCH_SIZE", "5000")),
  watchdogSec: Number(env("WATCHDOG_SEC", "150")),
  holdingInterface: "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
};

export function log(...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(ts, ...args);
}
