// Run: node --test "test/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const { isResetCommand } = require('../lib/voice-common');
const { formatPcHealth } = require('../lib/pc-health');

test('new-session commands, including how Whisper hears them', () => {
  for (const said of ['start new session', 'Start a new session.', 'Start the new session.', 'please start new session',
    'New session', 'new chat', 'Start a new chat.', 'Hermes, new conversation', 'okay start a new conversation please',
    'Hermes, start new session', 'can you start a new session', "let's start a new session", 'start new session Hermes']) {
    assert.strictEqual(isResetCommand(said), true, said);
  }
});

test('questions that only mention the words are not a reset', () => {
  for (const said of ["what's new in the chat app", 'new session of congress',
    'tell me about the new chat feature', 'What is the price of Bitcoin?']) {
    assert.strictEqual(isResetCommand(said), false, said);
  }
});

// The PC health / restart shortcuts shell out on Windows and macOS only. Elsewhere they answer at once
// instead of throwing. process.platform is swapped for the test and put back after.
function onPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true, writable: true });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', original); }
}

test('PC health on an unsupported platform resolves to {} without shelling out', async () => {
  const { gatherPcHealthAsync } = require('../lib/voice-common');
  const raw = await onPlatform('freebsd', () => gatherPcHealthAsync(1));
  assert.strictEqual(raw, '{}');
  assert.strictEqual(formatPcHealth(raw), null);
});

test('PC restart on an unsupported platform says so instead of throwing', () => {
  const { restartPc, cancelPcRestart } = require('../lib/voice-common');
  onPlatform('freebsd', () => {
    assert.strictEqual(restartPc(), "PC restart isn't supported on this platform.");
    assert.strictEqual(cancelPcRestart(), "PC restart isn't supported on this platform.");
  });
});

test('macOS cancel with no countdown running', () => {
  const { cancelPcRestart } = require('../lib/voice-common');
  assert.strictEqual(onPlatform('darwin', () => cancelPcRestart()), 'No PC restart was pending.');
});
