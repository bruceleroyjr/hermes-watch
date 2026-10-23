// Run (in zepp-app): node --test test/*.test.mjs
// zml's BasePage copies its own methods (request, call, ...) over the page's with Object.assign, so a
// page method with the same name is silently replaced. A page `call()` once became zml's one-way
// messaging.call: every request "succeeded" with no reply and nothing reached the PC.
import test from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'

const here = new URL('..', import.meta.url)
const page = readFileSync(new URL('page/index.js', here), 'utf8')
const zml = readFileSync(new URL('node_modules/@zeppos/zml/dist/zml-page.js', here), 'utf8')
const LIFECYCLE = new Set(['build', 'onInit', 'onCreate', 'onResume', 'onPause', 'onDestroy'])

test('no page method is overwritten by a zml BasePage method', () => {
  const mine = [...page.matchAll(/^ {4}([a-zA-Z]+)\(/gm)].map(m => m[1])
  const theirs = new Set([...zml.matchAll(/[,{}]([a-zA-Z]+)\([a-zA-Z,=.{}]*\)\{/g)].map(m => m[1]))
  assert.ok(theirs.has('request') && theirs.has('call'), 'zml method list not found')
  const clashes = mine.filter(name => theirs.has(name) && !LIFECYCLE.has(name))
  assert.deepStrictEqual(clashes, [])
})
