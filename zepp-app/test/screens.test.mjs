// Run (in zepp-app): node --test test/*.test.mjs
import test from 'node:test'
import assert from 'node:assert'
import { screenFor, pollStep, resumeFor, lastIsNew, RESUME_MS, CARD_MS, APPROVE_MS } from '../shared/screens.js'

const NOW = 1_800_000_000_000

test('a spoken reply keeps its speech id (answers and Yes/No cards)', () => {
  assert.deepStrictEqual(screenFor({ ok: true, kind: 'answer', text: 'Hi', speech: 's1' }),
    { screen: 'answer', heard: '', text: 'Hi', speech: 's1' })
  assert.strictEqual(screenFor({ ok: true, kind: 'confirm', text: 'Text Alex: hi?', id: 'c', speech: 's2' }).speech, 's2')
})

test('a long spoken reply keeps how many clips it has', () => {
  assert.deepStrictEqual(screenFor({ ok: true, kind: 'answer', text: 'Long...', speech: 's3', speechParts: 2 }),
    { screen: 'answer', heard: '', text: 'Long...', speech: 's3', speechParts: 2 })
})

test('approval card keeps approve; working keeps the relay note', () => {
  assert.deepStrictEqual(screenFor({ ok: true, kind: 'confirm', approve: true, text: 'Claude Code wants to change files', id: 'a1' }),
    { screen: 'confirm', heard: '', text: 'Claude Code wants to change files', id: 'a1', approve: true })
  assert.deepStrictEqual(screenFor({ ok: true, kind: 'working', job: 'j', note: 'You can close the app' }),
    { screen: 'working', heard: '', text: 'Still working on it...', job: 'j', note: 'You can close the app' })
})

test('resume: an Approve card stays live for Hermes\' 5-minute approval wait', () => {
  const model = { screen: 'confirm', heard: '', text: 'Claude Code wants to change files', id: 'a1', approve: true }
  assert.deepStrictEqual(resumeFor({ at: NOW - 3 * 60 * 1000, model }, NOW), { show: model })
  assert.match(resumeFor({ at: NOW - APPROVE_MS - 1, model }, NOW).show.text, /expired/)
})

test('resume: nothing saved, or older than the Hermes session -> start screen', () => {
  assert.strictEqual(resumeFor(null, NOW), null)
  assert.strictEqual(resumeFor({ at: NOW - RESUME_MS - 1, model: { screen: 'answer', heard: '', text: 'x' } }, NOW), null)
})

test('resume: an error is never brought back (it looked stuck after a reboot)', () => {
  assert.strictEqual(resumeFor({ at: NOW - 1000, model: { screen: 'error', heard: '', text: 'No answer from the phone.' } }, NOW), null)
})

test('resume: an answer comes back as it was', () => {
  const model = { screen: 'answer', heard: 'You said: hi', text: 'Hello' }
  assert.deepStrictEqual(resumeFor({ at: NOW - 60000, model }, NOW), { show: model })
})

test('resume: a fresh Yes/No card comes back; an expired one becomes a plain answer', () => {
  const model = { screen: 'confirm', heard: 'You said: text alex', text: 'Text alex: hi?', id: 'c1' }
  assert.deepStrictEqual(resumeFor({ at: NOW - 10000, model }, NOW), { show: model })
  assert.deepStrictEqual(resumeFor({ at: NOW - CARD_MS - 1, model }, NOW),
    { show: { screen: 'answer', heard: 'You said: text alex', text: 'Text alex: hi?\n(That card expired - tap TALK to answer.)' } })
})

test('resume: thinking or working -> ask the PC for the reply it kept', () => {
  assert.deepStrictEqual(resumeFor({ at: NOW - 5000, since: NOW - 9000, model: { screen: 'thinking', heard: '' } }, NOW),
    { fetchLast: NOW - 9000, heard: '' })
  assert.deepStrictEqual(resumeFor({ at: NOW - 5000, since: NOW - 9000, model: { screen: 'working', heard: 'You said: x', job: 'j' } }, NOW),
    { fetchLast: NOW - 9000, heard: 'You said: x' })
})

test('last reply only counts if it came after the question (in the watch clock)', () => {
  assert.strictEqual(lastIsNew({ ok: true, kind: 'answer', ago_ms: 1000 }, NOW - 5000, NOW), true)
  assert.strictEqual(lastIsNew({ ok: true, kind: 'answer', ago_ms: 60000 }, NOW - 5000, NOW), false)
  assert.strictEqual(lastIsNew({ ok: true, kind: 'none' }, NOW - 5000, NOW), false)
  assert.strictEqual(lastIsNew(null, NOW - 5000, NOW), false)
})

test('answer', () => {
  assert.deepStrictEqual(screenFor({ ok: true, heard: 'hi there', kind: 'answer', text: 'Hello there' }),
    { screen: 'answer', heard: 'You said: hi there', text: 'Hello there' })
})

test('answer without heard (after a confirm)', () => {
  assert.deepStrictEqual(screenFor({ ok: true, kind: 'answer', text: 'Sent to alex.' }),
    { screen: 'answer', heard: '', text: 'Sent to alex.' })
})

test('confirm keeps the id', () => {
  assert.deepStrictEqual(screenFor({ ok: true, heard: 'unlock the car', kind: 'confirm', text: 'Unlock the car?', id: 'abc' }),
    { screen: 'confirm', heard: 'You said: unlock the car', text: 'Unlock the car?', id: 'abc' })
})

test('working keeps the job', () => {
  assert.deepStrictEqual(screenFor({ ok: true, heard: 'slow one', kind: 'working', job: 'j1' }),
    { screen: 'working', heard: 'You said: slow one', text: 'Still working on it...', job: 'j1' })
})

test('ok:false is an error with its reason', () => {
  assert.deepStrictEqual(screenFor({ ok: false, error: "Can't reach the PC (is Tailscale on?)" }),
    { screen: 'error', heard: '', text: "Can't reach the PC (is Tailscale on?)" })
})

test('no reply is an error', () => {
  assert.deepStrictEqual(screenFor(undefined), { screen: 'error', heard: '', text: 'No answer from the phone. Is the Zepp app running?' })
})

test('poll: working keeps waiting and clears failures', () => {
  assert.deepStrictEqual(pollStep({ ok: true, kind: 'working' }, 2), { done: false, failures: 0 })
})

test('poll: a dropped connection is retried', () => {
  assert.deepStrictEqual(pollStep({ ok: false, error: "Can't reach the PC (is Tailscale on?)", retry: true }, 0), { done: false, failures: 1 })
  assert.deepStrictEqual(pollStep(undefined, 3), { done: false, failures: 4 })
})

test('poll: gives up after 5 dropped connections in a row', () => {
  const r = { ok: false, error: "Can't reach the PC (is Tailscale on?)", retry: true }
  assert.deepStrictEqual(pollStep(r, 4), { done: true, reply: r })
})

test('poll: an answer or a real error ends it', () => {
  const a = { ok: true, kind: 'answer', text: 'hi' }
  assert.deepStrictEqual(pollStep(a, 3), { done: true, reply: a })
  const e = { ok: false, error: 'The watch token was rejected by the PC.' }
  assert.deepStrictEqual(pollStep(e, 0), { done: true, reply: e })
})
