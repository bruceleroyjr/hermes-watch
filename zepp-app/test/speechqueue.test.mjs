// Run (in zepp-app): node --test test/*.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import { speechQueue } from '../shared/speechqueue.js'

test('one clip: plays when it arrives, then the queue is finished', () => {
  const q = speechQueue(1)
  assert.strictEqual(q.add(1, 'a.mp3'), 'a.mp3')
  assert.strictEqual(q.done(), null)
  assert.strictEqual(q.finished(), true)
})

test('two clips in order: clip 2 waits for clip 1 to finish', () => {
  const q = speechQueue(2)
  assert.strictEqual(q.add(1, 'one.mp3'), 'one.mp3')
  assert.strictEqual(q.add(2, 'two.mp3'), null) // clip 1 still playing
  assert.strictEqual(q.done(), 'two.mp3')
  assert.strictEqual(q.done(), null)
  assert.strictEqual(q.finished(), true)
})

test('clip 2 arriving after clip 1 already finished plays at once', () => {
  const q = speechQueue(2)
  q.add(1, 'one.mp3')
  assert.strictEqual(q.done(), null) // waiting for clip 2
  assert.strictEqual(q.finished(), false)
  assert.strictEqual(q.add(2, 'two.mp3'), 'two.mp3')
})

test('clip 2 arriving first waits for clip 1', () => {
  const q = speechQueue(2)
  assert.strictEqual(q.add(2, 'two.mp3'), null)
  assert.strictEqual(q.add(1, 'one.mp3'), 'one.mp3')
  assert.strictEqual(q.done(), 'two.mp3')
})

test('a duplicate or out-of-range clip is ignored', () => {
  const q = speechQueue(2)
  assert.strictEqual(q.add(1, 'one.mp3'), 'one.mp3')
  assert.strictEqual(q.add(1, 'again.mp3'), null)
  assert.strictEqual(q.add(5, 'x.mp3'), null)
})
