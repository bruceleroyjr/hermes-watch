// Run: node --test zepp-app/test/
import test from 'node:test'
import assert from 'node:assert'
import { toDecimal, makeFix, locationFor, MAX_AGE_MS } from '../shared/location.js'

test('toDecimal: numbers pass through, DMS objects convert with S/W negative', () => {
  assert.strictEqual(toDecimal(40.6892), 40.6892)
  assert.ok(Math.abs(toDecimal({ degrees: 40, minutes: 41, seconds: 21, direction: 'N' }) - 40.689167) < 1e-5)
  assert.ok(Math.abs(toDecimal({ degrees: 74, minutes: 2, seconds: 40, direction: 'W' }) + 74.044444) < 1e-5)
  assert.ok(Number.isNaN(toDecimal(undefined)))
})

test('makeFix: rejects empty (0,0), out-of-range and non-numbers', () => {
  assert.deepStrictEqual(makeFix(40.69, -74.04, 5), { lat: 40.69, lon: -74.04, at: 5 })
  assert.strictEqual(makeFix(0, 0, 5), null)
  assert.strictEqual(makeFix(91, 0.5, 5), null)
  assert.strictEqual(makeFix(21, 181, 5), null)
  assert.strictEqual(makeFix(undefined, -74.04, 5), null)
})

test('locationFor: rounds to 5 decimals with age; too old or missing gives null', () => {
  const fix = { lat: 40.6891667, lon: -74.0444444, at: 1000 }
  assert.deepStrictEqual(locationFor(fix, 4000), { lat: 40.68917, lon: -74.04444, age_s: 3 })
  assert.strictEqual(locationFor(fix, 1000 + MAX_AGE_MS + 1), null)
  assert.strictEqual(locationFor(null, 4000), null)
  assert.strictEqual(locationFor({ ...fix, at: 10 * 60 * 1000 }, 0), null) // clock went backwards
})
