// Run (in zepp-app): node --test test/*.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import { onceBy } from '../shared/once.js'

test('the same key runs once; later callers get the same promise', async () => {
  const jobs = new Map()
  let runs = 0
  const start = () => onceBy(jobs, 's1', async () => { runs++; return { ok: true } })
  const [a, b] = [start(), start()] // phone starts it as the reply passes; the watch asks too
  assert.strictEqual(a, b)
  assert.deepStrictEqual(await a, { ok: true })
  assert.strictEqual(runs, 1)
})

test('a failed job is forgotten at once, so the next caller tries again', async () => {
  const jobs = new Map()
  let runs = 0
  const r1 = await onceBy(jobs, 's1', async () => { runs++; return { ok: false, error: 'voice down' } })
  assert.strictEqual(r1.ok, false)
  await new Promise((r) => setTimeout(r, 0))
  const r2 = await onceBy(jobs, 's1', async () => { runs++; return { ok: true } })
  assert.deepStrictEqual(r2, { ok: true })
  assert.strictEqual(runs, 2)
})

test('different keys run separately', async () => {
  const jobs = new Map()
  let runs = 0
  await Promise.all([onceBy(jobs, 'a', async () => runs++), onceBy(jobs, 'b', async () => runs++)])
  assert.strictEqual(runs, 2)
})

test('finished keys are forgotten after keepMs, so the map does not grow', async () => {
  const jobs = new Map()
  await onceBy(jobs, 'x', async () => 1, { keepMs: 10 })
  await new Promise((r) => setTimeout(r, 30))
  assert.strictEqual(jobs.size, 0)
})
