// Run (in zepp-app): node --test test/*.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import { ringDots, dotColors, blend, elapsedText, dotsText } from '../shared/spinner.js'

test('dots sit evenly on a circle, first at 12 o\'clock', () => {
  const d = ringDots(4, 233, 233, 200)
  assert.deepStrictEqual(d, [{ x: 233, y: 33 }, { x: 433, y: 233 }, { x: 233, y: 433 }, { x: 33, y: 233 }])
})

test('blend mixes two colours channel by channel', () => {
  assert.strictEqual(blend(0x000000, 0xffffff, 0), 0x000000)
  assert.strictEqual(blend(0x000000, 0xffffff, 1), 0xffffff)
  assert.strictEqual(blend(0x000000, 0x204060, 0.5), 0x102030)
})

test('the bright head moves one dot per step and its tail fades behind it', () => {
  const c = dotColors(2, 8, 0x7fd4ff, 0x101820, 4)
  assert.strictEqual(c[2], 0x7fd4ff) // head
  assert.ok(c[1] !== 0x101820 && c[1] !== 0x7fd4ff) // tail
  assert.strictEqual(c[3], 0x101820) // ahead of the head: dim
  assert.strictEqual(c[6], 0x101820)
  assert.strictEqual(dotColors(10, 8, 0x7fd4ff, 0x101820, 4)[2], 0x7fd4ff) // wraps around
})

test('tail brightness falls off with distance from the head', () => {
  const c = dotColors(0, 8, 0xffffff, 0x000000, 4)
  const level = (x) => x & 0xff
  assert.ok(level(c[0]) > level(c[7]) && level(c[7]) > level(c[6]) && level(c[6]) > level(c[5]))
  assert.strictEqual(c[4], 0x000000)
})

test('elapsed time reads m:ss', () => {
  assert.strictEqual(elapsedText(0), '0:00')
  assert.strictEqual(elapsedText(42500), '0:42')
  assert.strictEqual(elapsedText(125000), '2:05')
})

test('thinking dots cycle . .. ...', () => {
  assert.deepStrictEqual([0, 1, 2, 3].map(dotsText), ['.', '..', '...', '.'])
})
