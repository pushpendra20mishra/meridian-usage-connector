// costs are integer nano-USD so nothing drifts

const DECIMAL = /^-?\d+(\.\d+)?$/;

function scaled(decimal: string, scale: number): number {
  if (!DECIMAL.test(decimal)) throw new Error(`not a decimal number: ${JSON.stringify(decimal)}`);
  const negative = decimal.startsWith("-");
  const [whole = "0", frac = ""] = decimal.replace("-", "").split(".");
  const padded = (frac + "0".repeat(scale + 1)).slice(0, scale + 1);
  let n = BigInt(whole + padded);
  n = (n + 5n) / 10n;
  const value = Number(n);
  if (!Number.isSafeInteger(value)) throw new Error("amount too large for exact arithmetic");
  return negative ? -value : value;
}

// claude sends cents as strings
export const centsStringToNano = (cents: string): number => scaled(cents, 7);

// gemini sends dollars as floats
export const usdFloatToNano = (usd: number): number => scaled(usd.toFixed(9), 9);

export const nanoToUsd = (nano: number): number => Math.round(nano / 1000) / 1e6;
