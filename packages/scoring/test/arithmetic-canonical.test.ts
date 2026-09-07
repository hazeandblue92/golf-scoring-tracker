import { describe, expect, it } from 'vitest'
import {
  add, compare, floor, fromTenths, isNegative, mul, neg, percent, rational,
  roundHalfUpTowardPositiveInfinity, roundToDecimals, sub, toCanonicalString,
  toNumber, ZERO,
} from '../src/rational.ts'
import { canonicalJson, canonicalNumericResult, resultHash, sha256Hex, type CanonicalValue } from '../src/canonical.ts'

describe('exact rational boundary arithmetic', () => {
  it('normalizes signs and zero and rejects invalid integer operands', () => {
    expect(rational(6, -8)).toEqual({ num: -3, den: 4 })
    expect(rational(0, 7)).toEqual(ZERO)
    expect(rational(3)).toEqual({ num: 3, den: 1 })
    for (const [num, den] of [[1.5, 1], [1, 1.5], [1, 0], [Infinity, 1], [1, NaN], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
      expect(() => rational(num!, den!)).toThrow(RangeError)
    }
  })
  it('preserves exact arithmetic, comparison and canonical representation', () => {
    const a = fromTenths(15)
    const b = percent(50)
    expect(add(a, b)).toEqual(rational(2))
    expect(sub(a, b)).toEqual(rational(1))
    expect(mul(a, b)).toEqual(rational(3, 4))
    expect(neg(a)).toEqual(rational(-3, 2))
    expect([compare(a, b), compare(b, a), compare(a, a)]).toEqual([1, -1, 0])
    expect([isNegative(a), isNegative(neg(a))]).toEqual([false, true])
    expect(toNumber(a)).toBe(1.5)
    expect(toCanonicalString(a)).toBe('3/2')
    expect(toCanonicalString(rational(-2))).toBe('-2')
    expect([floor(rational(-3, 2)), floor(rational(-4, 2)), floor(a)]).toEqual([-2, -2, 1])
    expect(roundHalfUpTowardPositiveInfinity(rational(-3, 2))).toBe(-1)
  })
  it.each([
    ['up', 2, -1], ['down', 1, -2], ['toward_zero', 1, -1], ['away_from_zero', 2, -2],
  ] as const)('rounds signed exact ties with %s', (tie, positive, negative) => {
    expect(roundToDecimals(rational(3, 2), 0, tie)).toEqual(rational(positive))
    expect(roundToDecimals(rational(-3, 2), 0, tie)).toEqual(rational(negative))
    expect(roundToDecimals(rational(14, 10), 0, tie)).toEqual(rational(1))
    expect(roundToDecimals(rational(16, 10), 0, tie)).toEqual(rational(2))
    expect(roundToDecimals(rational(125, 100), 1, tie)).toEqual(rational(tie === 'up' || tie === 'away_from_zero' ? 13 : 12, 10))
  })
})

describe('canonical serialization and SHA-256 interoperability', () => {
  it('sorts nested object keys while retaining array order and JSON escapes', () => {
    const value = { z: [null, false, true, 'quote"\n', -2], a: { b: 1, a: '3/2' } }
    expect(canonicalJson(value)).toBe('{"a":{"a":"3/2","b":1},"z":[null,false,true,"quote\\\"\\n",-2]}')
    expect(resultHash(value)).toBe('5f3d96016845ba57ce268e048cf3638e384283ddd66e87c64bd0b9899dd53c05')
    expect(() => canonicalJson({ invalid: undefined } as unknown as CanonicalValue)).toThrow(/undefined/)
    for (const value of [1.2, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => canonicalJson(value)).toThrow(RangeError)
    }
    expect(canonicalNumericResult(null)).toBeNull()
    expect(canonicalNumericResult(2)).toBe(2)
    expect(canonicalNumericResult(2.5)).toBe('2.5')
    expect(() => canonicalNumericResult(Infinity)).toThrow(RangeError)
  })
  it('matches standard UTF-8 SHA-256 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('😀')).toBe('f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9')
  })
})
