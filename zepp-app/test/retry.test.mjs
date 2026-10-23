// Run (in zepp-app): node --test test/*.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import { withRetry, newRid, untilPhoneWakes, phoneError } from '../shared/retry.js'

const asleep = () => Promise.reject(new Error('shake timeout'))
const fakeClock = () => {
  let t = 0
  return { now: () => t, sleep: async (ms) => { t += ms }, tick: (ms) => { t += ms } }
}

test('phone asleep (shake timeout): retried until the Zepp app answers', async () => {
  const clock = fakeClock()
  let n = 0
  let waits = 0
  const r = await untilPhoneWakes(() => (++n < 3 ? (clock.tick(5000), asleep()) : Promise.resolve('hi')),
    { budgetMs: 30000, waitMs: 1000, onWait: () => waits++, now: clock.now, sleep: clock.sleep })
  assert.strictEqual(r, 'hi')
  assert.strictEqual(n, 3)
  assert.strictEqual(waits, 2)
})

test('phone asleep: gives up after the budget with the last error', async () => {
  const clock = fakeClock()
  let n = 0
  await assert.rejects(untilPhoneWakes(() => { n++; clock.tick(5000); return asleep() },
    { budgetMs: 30000, waitMs: 1000, now: clock.now, sleep: clock.sleep }), /shake timeout/)
  assert.strictEqual(n, 5) // 5 x (5 s handshake + 1 s wait) = 30 s
})

test('other failures are not retried (the question may have reached the phone)', async () => {
  let n = 0
  await assert.rejects(untilPhoneWakes(() => { n++; return Promise.reject(new Error('timeout')) }, { budgetMs: 30000 }), /timeout/)
  assert.strictEqual(n, 1)
})

test('phoneError says to open Zepp when the phone is asleep', () => {
  assert.match(phoneError(new Error('shake timeout')), /Open the Zepp app on your iPhone/)
  assert.strictEqual(phoneError(new Error('timeout')), "The phone didn't answer (timeout).")
})

const lost = { ok: false, error: "Can't reach the PC", retry: true }

test('a lost reply is retried and the next answer is returned', async () => {
  const replies = [lost, { ok: true, kind: 'answer', text: 'hi' }]
  let n = 0
  const r = await withRetry(async () => replies[n++], { tries: 3, budgetMs: 1000 })
  assert.deepStrictEqual(r, { ok: true, kind: 'answer', text: 'hi' })
  assert.strictEqual(n, 2)
})

test('stops after the given number of tries', async () => {
  let n = 0
  const r = await withRetry(async () => { n++; return lost }, { tries: 3, budgetMs: 1000 })
  assert.deepStrictEqual(r, lost)
  assert.strictEqual(n, 3)
})

test('no retry once the time budget is spent', async () => {
  let n = 0
  let t = 0
  const r = await withRetry(async () => { n++; t += 600; return lost }, { tries: 3, budgetMs: 1000, now: () => t })
  assert.deepStrictEqual(r, lost)
  assert.strictEqual(n, 2)
})

test('real errors are not retried', async () => {
  let n = 0
  const e = { ok: false, error: 'The watch token was rejected by the PC.' }
  assert.deepStrictEqual(await withRetry(async () => { n++; return e }, { tries: 3, budgetMs: 1000 }), e)
  assert.strictEqual(n, 1)
})

test('rids differ', () => {
  assert.notStrictEqual(newRid(), newRid())
})
