/**
 * Exact rational arithmetic for handicap calculations.
 *
 * Spec §7.3: same normalized input and engine version must always produce
 * byte-equivalent canonical JSON. Ratings and handicaps are fixed decimal
 * inputs (tenths); slope division by 113 and percentage allowances are exact
 * rationals. Doing this math in IEEE doubles puts .5 rounding ties at the
 * mercy of representation error, so every intermediate handicap value is a
 * normalized integer rational until the one named rounding step.
 *
 * Magnitudes stay far below 2^53: |numerator| is bounded by handicap-index
 * tenths (<=540) x slope (<=155) x allowance scale (100) x weight scales.
 */

export interface Rational {
  /** Numerator; carries the sign. */
  readonly num: number
  /** Denominator; always a positive integer. */
  readonly den: number
}

function gcd(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b !== 0) {
    const t = a % b
    a = b
    b = t
  }
  return a === 0 ? 1 : a
}

export function rational(num: number, den = 1): Rational {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den === 0) {
    throw new RangeError(`invalid rational ${num}/${den}`)
  }
  if (den < 0) {
    num = -num
    den = -den
  }
  const g = gcd(num, den)
  return { num: num / g, den: den / g }
}

/** A fixed-decimal value expressed in tenths, e.g. 12.3 -> fromTenths(123). */
export function fromTenths(tenths: number): Rational {
  return rational(tenths, 10)
}

/** A percentage allowance, e.g. percent(85) = 85%. */
export function percent(hundredths: number): Rational {
  return rational(hundredths, 100)
}

export const ZERO: Rational = { num: 0, den: 1 }

export function add(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den + b.num * a.den, a.den * b.den)
}

export function sub(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den - b.num * a.den, a.den * b.den)
}

export function mul(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den)
}

export function neg(a: Rational): Rational {
  return { num: -a.num, den: a.den }
}

export function compare(a: Rational, b: Rational): number {
  const d = a.num * b.den - b.num * a.den
  return d < 0 ? -1 : d > 0 ? 1 : 0
}

export function isNegative(a: Rational): boolean {
  return a.num < 0
}

/** Exact floor of a/b for safe integers, correct for negative values. */
function floorDiv(a: number, b: number): number {
  const q = Math.trunc(a / b)
  return a % b !== 0 && (a < 0) !== (b < 0) ? q - 1 : q
}

/** floor(r) as an integer. */
export function floor(r: Rational): number {
  return floorDiv(r.num, r.den)
}

/**
 * Spec §7.5 usga_whs_2024 rounding: floor(value + 0.5).
 * Whole-number .5 ties round upward toward positive infinity, which moves a
 * negative internal plus handicap toward zero. Exact: floor((2n + d) / 2d).
 */
export function roundHalfUpTowardPositiveInfinity(r: Rational): number {
  return floorDiv(2 * r.num + r.den, 2 * r.den)
}

/**
 * Round to `decimals` places with the given tie direction, returning a
 * Rational (used by committee_custom profiles that keep intermediate
 * precision). Ties are exact-half values only.
 */
export function roundToDecimals(
  r: Rational,
  decimals: number,
  tie: 'up' | 'down' | 'toward_zero' | 'away_from_zero',
): Rational {
  const scale = 10 ** decimals
  const scaled = mul(r, rational(scale))
  const f = floor(scaled)
  const fracNum = scaled.num - f * scaled.den
  const twice = 2 * fracNum
  let n: number
  if (twice < scaled.den) n = f
  else if (twice > scaled.den) n = f + 1
  else {
    // exact .5 tie
    switch (tie) {
      case 'up':
        n = f + 1
        break
      case 'down':
        n = f
        break
      case 'toward_zero':
        n = f >= 0 ? f : f + 1
        break
      case 'away_from_zero':
        n = f >= 0 ? f + 1 : f
        break
    }
  }
  return rational(n, scale)
}

/** Display/interop value; NEVER feed this back into a calculation. */
export function toNumber(r: Rational): number {
  return r.num / r.den
}

/** Canonical string form, e.g. "-17/10"; stable for hashing. */
export function toCanonicalString(r: Rational): string {
  return r.den === 1 ? String(r.num) : `${r.num}/${r.den}`
}
