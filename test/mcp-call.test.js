// Run: node --test "test/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { callMcpTool } = require('../lib/mcp-call');

const FAKE = path.join(__dirname, 'fake-mcp.js');

test('answer arrives after a delay (stdin kept open)', async () => {
  const r = await callMcpTool(FAKE, 'echo', { contact: 'me', message: 'hi' }, 5000);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(JSON.parse(r.text), { tool: 'echo', args: { contact: 'me', message: 'hi' } });
});

test('no answer -> timed out, child stopped', async () => {
  const started = Date.now();
  const r = await callMcpTool(FAKE, 'slow', {}, 1000);
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /timed out/);
  assert.ok(Date.now() - started < 3000);
  assert.ok(r.child.killed || r.child.exitCode !== null, 'child still running');
});
