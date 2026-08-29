// Exact decimal arithmetic on ledger amount strings, fixed scale 10 (Canton's Decimal scale).
export const SCALE = 10n;
const TEN = 10n ** SCALE;

export function toUnits(s) {
  if (s === null || s === undefined) return 0n;
  let str = String(s).trim();
  let neg = false;
  if (str.startsWith("-")) { neg = true; str = str.slice(1); }
  const [ip, fp = ""] = str.split(".");
  const frac = (fp + "0".repeat(Number(SCALE))).slice(0, Number(SCALE));
  const v = BigInt(ip || "0") * TEN + BigInt(frac || "0");
  return neg ? -v : v;
}

export function fromUnits(u) {
  const neg = u < 0n;
  const a = neg ? -u : u;
  const ip = a / TEN;
  const fp = (a % TEN).toString().padStart(Number(SCALE), "0");
  return (neg ? "-" : "") + ip.toString() + "." + fp;
}

export const add = (a, b) => toUnits(a) + toUnits(b);
export const sum = (arr) => arr.reduce((acc, x) => acc + toUnits(x), 0n);
export const isZero = (u) => u === 0n;
