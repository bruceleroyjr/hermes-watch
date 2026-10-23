// Run: node --test "test/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const { isResetCommand } = require('../lib/voice-common');

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
