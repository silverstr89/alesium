/** Amounts, prices and quantities are bigint micros (1e-6). Never a JS number. */
export type Micros = bigint;

export const ONE = 1_000_000n;
const CENT = 10_000n;

const DECIMAL = /^(-)?(\d+)(?:\.(\d{1,6}))?$/;

/** "1.2345" → 1_234_500n. Up to 6 decimal places. */
export function toMicros(s: string): Micros {
  const m = DECIMAL.exec(s);
  if (!m) throw new Error(`Expected a decimal with up to 6 places, got "${s}"`);
  const v = BigInt(m[2]!) * ONE + BigInt((m[3] ?? '').padEnd(6, '0'));
  return m[1] ? -v : v;
}

/** 1_234_500n → "1.234500". */
export function fromMicros(v: Micros): string {
  const abs = v < 0n ? -v : v;
  return `${v < 0n ? '-' : ''}${abs / ONE}.${(abs % ONE).toString().padStart(6, '0')}`;
}

/** a × b ÷ c, rounded half away from zero. */
export function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  const n = a * b;
  const q = n / c;
  const r = n % c;
  const twiceR = (r < 0n ? -r : r) * 2n;
  if (r === 0n || twiceR < (c < 0n ? -c : c)) return q;
  return n < 0n !== c < 0n ? q - 1n : q + 1n;
}

/** Whole cents, half away from zero. */
export function roundToCents(v: Micros): Micros {
  return roundToCentsOf(v, 1n);
}

/** `numerator ÷ denominator` micros as whole cents, rounded once, half away from zero. */
export function roundToCentsOf(numerator: bigint, denominator: bigint): Micros {
  return mulDiv(numerator, 1n, denominator * CENT) * CENT;
}
