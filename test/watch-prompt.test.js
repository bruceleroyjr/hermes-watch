// Run: node --test "test/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const { watchSystemPrompt, withWatchRules } = require('../lib/watch-prompt');

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
