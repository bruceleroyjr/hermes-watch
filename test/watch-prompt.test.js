// Run: node --test "test/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const { watchSystemPrompt, withWatchRules, splitConfirm } = require('../lib/watch-prompt');

test('CONFIRM is only for actions; other follow-ups are plain questions', () => {
  for (const text of [watchSystemPrompt(), withWatchRules('hi')]) {
    assert.match(text, /Use CONFIRM only to propose one of those actions/);
    assert.match(text, /any other follow-up question or offer (.*), ask it in plain words with no CONFIRM line/);
  }
});

test('email reads get the mark-read-first rule next to the question', () => {
  for (const said of ['Read my latest email', 'read me my emails', 'Can you read my email?']) {
    const text = withWatchRules(said);
    assert.match(text, /call gmail_mark_read FIRST/, said);
    assert.match(text, /"latest email" = only the newest unread one/, said);
    assert.match(text, /never just "Done"/, said);
  }
});

test('build and code requests get the Claude Code rule next to the question', () => {
  for (const said of ['Build me a job that checks tide times', 'can you fix the relay bug',
    'have Claude add a weather line to my morning email', 'set up a script that backs up my notes']) {
    assert.match(withWatchRules(said), /claude_code_build .* or claude_code_edit .* your FIRST tool call/, said);
  }
  for (const said of ['What time is it in Tokyo?', 'How much is Bitcoin?', 'read my latest email']) {
    assert.doesNotMatch(withWatchRules(said), /claude_code_build/, said);
  }
});

test('other questions do not get the email rule', () => {
  assert.doesNotMatch(withWatchRules('How much is Bitcoin?'), /gmail_mark_read/);
  assert.doesNotMatch(withWatchRules('anything urgent in my email'), /gmail_mark_read FIRST/);
});

test('Claude Code changes are approved on the watch', () => {
  assert.match(watchSystemPrompt(), /Approve \/ Deny card for every change/);
});

test('Yes on the watch lets Hermes do the proposed action (the never-call rule made it refuse to send an email)', () => {
  const text = withWatchRules('yes, go ahead', { confirmed: true });
  assert.doesNotMatch(text, /Never call/);
  assert.match(text, /tapped Yes/);
  assert.match(text, /email_send_draft with confirmed=true/);
  assert.match(text, /no CONFIRM line/);
  assert.match(withWatchRules('send an email saying hi'), /Never call send_text/);
});

test('splitConfirm drops a last text line that repeats the CONFIRM question (the card showed it twice)', () => {
  const reply = 'Draft email:\n\nSubject: Reminder\n\nPick up Alex at 4pm.\n\nShall I send this email?\n\nCONFIRM: Shall I send this email?';
  assert.deepStrictEqual(splitConfirm(reply), { text: 'Draft email:\n\nSubject: Reminder\n\nPick up Alex at 4pm.', confirm: 'Shall I send this email?' });
  assert.strictEqual(splitConfirm('Body.\nshall i send it\nCONFIRM: Shall I send it?').text, 'Body.');
  assert.strictEqual(splitConfirm('Is 4pm right?\nCONFIRM: Send it?').text, 'Is 4pm right?');
});
