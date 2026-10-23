// Run (in zepp-app): node --test test/*.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import { withRetry, newRid, untilPhoneWakes, phoneError, withTimeout, resendUntil } from '../shared/retry.js'

const timedOut = () => Promise.reject(new Error('timeout'))

test('resendUntil: a request that timed out is sent again (same request id) and the next reply wins', async () => {
  let n = 0
  const r = await resendUntil(() => (++n < 3 ? timedOut() : Promise.resolve({ ok: true, text: 'hi' })), { attemptMs: 25000, budgetMs: 150000 })
  assert.deepStrictEqual(r, { ok: true, text: 'hi' })
  assert.strictEqual(n, 3)
})

test('resendUntil: stops before the budget runs out and reports the timeout', async () => {
  let t = 0
  let n = 0
  await assert.rejects(resendUntil(() => { n++; t += 25000; return timedOut() },
    { attemptMs: 25000, budgetMs: 150000, now: () => t }), /timeout/)
  assert.strictEqual(n, 5) // 25 s each; a 6th would end after 150 s
})

test('resendUntil: other errors are not resent', async () => {
  let n = 0
  await assert.rejects(resendUntil(() => { n++; return Promise.reject(new Error('ble disconnect')) }, { attemptMs: 25000, budgetMs: 150000 }), /ble/)
  assert.strictEqual(n, 1)
})

test('resendUntil: a sleeping phone ("shake timeout") is not resent - its 30 s wake wait already ran', async () => {
  let n = 0
  await assert.rejects(resendUntil(() => { n++; return Promise.reject(new Error('shake timeout')) }, { attemptMs: 25000, budgetMs: 150000 }), /shake/)
  assert.strictEqual(n, 1)
})

test('resendUntil: a "lost, retry" reply from the phone is resent; the last one is returned when time runs out', async () => {
  const lost = { ok: false, retry: true, error: "Can't reach the PC" }
  let n = 0
  const r = await resendUntil(() => Promise.resolve(++n < 3 ? lost : { ok: true, text: 'hi' }), { attemptMs: 25000, budgetMs: 150000, waitMs: 0 })
  assert.deepStrictEqual(r, { ok: true, text: 'hi' })
  let t = 0
  const last = await resendUntil(() => { t += 30000; return Promise.resolve(lost) }, { attemptMs: 25000, budgetMs: 150000, now: () => t, waitMs: 0 })
  assert.deepStrictEqual(last, lost)
})

test('withTimeout: a request that fails early clears its timer (onTimeout never runs)', async () => {
  let fired = false
  await assert.rejects(withTimeout(Promise.reject(new Error('net down')), 20, () => { fired = true }), /net down/)
  await new Promise((r) => setTimeout(r, 40))
  assert.strictEqual(fired, false)
})

test('withTimeout: an answer in time comes back as is', async () => {
  assert.deepStrictEqual(await withTimeout(Promise.resolve({ ok: true }), 1000, () => ({ ok: false })), { ok: true })
})

test('withTimeout: a reply iOS silently lost turns into a retryable failure after the limit', async () => {
  const never = new Promise(() => {})
  const r = await withTimeout(never, 20, (ms) => ({ ok: false, retry: true, error: `no reply after ${ms} ms` }))
  assert.deepStrictEqual(r, { ok: false, retry: true, error: 'no reply after 20 ms' })
})

test('a lost reply + withTimeout + withRetry: the second try gets the answer', async () => {
  const replies = [new Promise(() => {}), Promise.resolve({ ok: true, kind: 'answer', text: 'hi' })]
  let n = 0
  const r = await withRetry(() => withTimeout(replies[n++], 20, () => ({ ok: false, retry: true })), { tries: 3, budgetMs: 1000 })
  assert.deepStrictEqual(r, { ok: true, kind: 'answer', text: 'hi' })
  assert.strictEqual(n, 2)
})

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

test('uploadAllowanceMs: longer recordings get more time to reach the phone', async () => {
  const { uploadAllowanceMs } = await import('../shared/retry.js')
  assert.strictEqual(uploadAllowanceMs(0), 0)
  assert.strictEqual(uploadAllowanceMs(undefined), 0)
  assert.strictEqual(uploadAllowanceMs(40000), 10000) // a 15 s clip: +10 s
  assert.ok(uploadAllowanceMs(245000) >= 60000) // a 90 s clip: about a minute more
})
