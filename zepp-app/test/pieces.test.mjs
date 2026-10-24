// Run: node --test zepp-app/test/
import test from 'node:test'
import assert from 'node:assert'
import { splitAudio, pieceRanges, pieceStore, PIECE_BYTES } from '../shared/pieces.js'

const clip = (n) => Uint8Array.from({ length: n }, (_, i) => i % 251).buffer

test('splitAudio: a short clip is one piece, a 90 s clip (~245 KB) is ~10 pieces of at most PIECE_BYTES', () => {
  assert.strictEqual(splitAudio(clip(20000)).length, 1)
  const parts = splitAudio(clip(245000))
  assert.strictEqual(parts.length, Math.ceil(245000 / PIECE_BYTES))
  assert.ok(parts.every((p) => p.byteLength <= PIECE_BYTES))
  assert.strictEqual(parts.reduce((n, p) => n + p.byteLength, 0), 245000)
})

test('pieceStore: the clip comes back whole (in order) when the last piece arrives', () => {
  const s = pieceStore()
  const parts = splitAudio(clip(60000)).map((p) => new Uint8Array(p))
  assert.strictEqual(s.put('r1', 1, 3, parts[0]), null)
  assert.strictEqual(s.put('r1', 2, 3, parts[1]), null)
  assert.deepStrictEqual(s.put('r1', 3, 3, parts[2]), new Uint8Array(clip(60000)))
})

test('pieceStore: a resent piece replaces itself; a resent last piece rebuilds the clip again', () => {
  const s = pieceStore()
  const parts = splitAudio(clip(30000)).map((p) => new Uint8Array(p))
  s.put('r', 1, 2, parts[0])
  s.put('r', 1, 2, parts[0])
  assert.strictEqual(s.put('r', 2, 2, parts[1]).length, 30000)
  assert.strictEqual(s.put('r', 2, 2, parts[1]).length, 30000)
})

test('pieceStore: a missing piece is reported, not glued over', () => {
  const s = pieceStore()
  assert.strictEqual(s.put('r', 1, 3, new Uint8Array(5)), null)
  assert.strictEqual(s.put('r', 3, 3, new Uint8Array(5)), null)
  assert.deepStrictEqual(s.missing('r'), [2])
  assert.strictEqual(s.missing('other'), null)
})

test('pieceStore: old recordings are dropped', () => {
  let t = 0
  const s = pieceStore({ keepMs: 1000, now: () => t })
  s.put('old', 1, 2, new Uint8Array(5))
  t = 5000
  s.put('new', 1, 2, new Uint8Array(5))
  assert.strictEqual(s.missing('old'), null)
})

test('pieceRanges: same pieces as splitAudio, as byte ranges to read from the file one at a time', () => {
  for (const size of [1, 20000, PIECE_BYTES, PIECE_BYTES + 1, 245000]) {
    const ranges = pieceRanges(size)
    const whole = new Uint8Array(clip(size))
    const fromRanges = ranges.map(({ start, length }) => whole.slice(start, start + length))
    assert.deepStrictEqual(fromRanges, splitAudio(clip(size)).map((p) => new Uint8Array(p)))
    assert.ok(ranges.every((r) => r.length > 0 && r.length <= PIECE_BYTES))
  }
  assert.deepStrictEqual(pieceRanges(0), [])
})
