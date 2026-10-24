// Run: node --test "test/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const { watchSystemPrompt, withWatchRules, splitConfirm, confirmKind, cleanLocation } = require('../lib/watch-prompt');

test('confirmKind: unasked offers to text/email the user are dropped, non-actions become text, real proposals stay cards', () => {
  const cases = [
    ['What is this place? Tell me a little about it.', 'Send you a text with these details?', 'drop'],
    ['How do we get there from here?', 'Shall I text you directions once you tell me which one?', 'drop'],
    ['How much is Bitcoin?', 'Want me to check it again later?', 'plain'],
    ["What's the price of Bitcoin?", 'Want me to set up a Bitcoin price check?', 'plain'],
    ['help me figure out what AI model I can run locally', 'Want me to suggest one and walk you through installing it?', 'plain'],
    ["no, don't", 'Do you need anything else right now?', 'plain'],
    ['Text Alex saying hi.', 'Send Alex a text saying hi?', 'card'],
    ['send an email to myself saying hi', 'Shall I send this email to yourself?', 'card'],
    ['Who is the person that this is getting sent to?', 'Should I send this email to you?', 'card'],
    ['Open the frunk.', 'Open the frunk?', 'card'],
    ['text me the address', 'Send you a text with the address?', 'card'],
    ['', 'Send it?', 'card'], // a Yes turn
  ];
  for (const [heard, confirm, want] of cases) assert.strictEqual(confirmKind(heard, confirm), want, `${heard} -> ${confirm}`);
});

test('the rules say never to offer to text or email the user the answer', () => {
  for (const text of [watchSystemPrompt(), withWatchRules('hi')]) assert.match(text, /Never offer to text, email or send the user the answer/);
});

test('watch GPS goes next to the question, only when there is a real fix', () => {
  const text = withWatchRules("what's the closest coffee shop", { loc: { lat: 48.858372, lon: 2.294481, age_s: 4, place: 'Eiffel Tower' } });
  assert.match(text, /Watch GPS: .+ is at 48\.85837, 2\.29448 \(fixed 4 s ago\)\. The map lookup there says: Eiffel Tower/);
  assert.match(text, /instead of the default location/);
  assert.match(text, /Rule for this answer: Never call send_text/); // the other rules are still there
  assert.match(withWatchRules('hi', { loc: { lat: 48.85, lon: 2.29, age_s: 300 } }), /fixed 5 min ago/);
  for (const loc of [null, undefined, {}, { lat: 0, lon: 0 }, { lat: 'x', lon: 1 }, { lat: 95, lon: 1 }]) {
    assert.doesNotMatch(withWatchRules('hi', { loc }), /Watch GPS/, JSON.stringify(loc));
  }
  assert.doesNotMatch(withWatchRules('yes, go ahead', { confirmed: true, loc: { lat: 48.85, lon: 2.29 } }), /Watch GPS/);
});

test('cleanLocation: numbers checked and rounded, age never negative', () => {
  assert.deepStrictEqual(cleanLocation({ lat: '48.8583722', lon: 2.2944813, age_s: -3 }), { lat: 48.85837, lon: 2.29448, age_s: 0 });
  assert.strictEqual(cleanLocation({ lat: 21, lon: 200 }), null);
});

test('no GPS fix: a where-am-I question is told to say so, not to try other location tools', () => {
  for (const said of ["Can you tell me where I'm located right now indoors?", 'where am I', "what's the nearest gas station",
    'what is this place', 'tell me about this building', "what's good to eat around here"]) {
    const text = withWatchRules(said, { gps: 'no fix yet' });
    assert.match(text, /Watch GPS: no position right now \(no fix yet\)/, said);
    assert.match(text, /Do not use any other location tool/, said);
  }
  assert.doesNotMatch(withWatchRules('what is 12 times 7', { gps: 'no fix yet' }), /Watch GPS/);
  assert.doesNotMatch(withWatchRules('where am I'), /Watch GPS/); // older watch build: says nothing about GPS
  assert.doesNotMatch(withWatchRules('where am I', { loc: { lat: 48.85, lon: 2.29 }, gps: 'x' }), /no position/);
});

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

test('questions that only mention his setup, jobs or code are not build requests', () => {
  for (const said of ['Please build a script that checks my Tesla charge', 'could you set up a job for tide times',
    'I want you to fix the watch relay', 'ask Claude to make the morning email shorter',
    'write a skill that saves YouTube links', 'there is a bug in the watch app']) {
    assert.match(withWatchRules(said), /claude_code_build/, said);
  }
  for (const said of [
    "For my current PC setup, I want to optimize my Hermes agent to respond faster. I'm currently using a free cloud NVIDIA model and I was curious if there was a local deep-seek model that's free that I can download for my computer.",
    'What are some, I guess, flat rate paid models at $10 subscription that could work with my PC setup and hardware?',
    'Is my email job running?', 'add milk to my shopping list', "What's the code for the gate?",
    'set up a reminder for 5 PM']) {
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

test('proposals read as ready to go, not "I can\'t send directly" (2026-10-23 card wording)', () => {
  const text = withWatchRules('send an email to myself saying hi');
  assert.match(text, /Ready to send/);
  assert.match(text, /never say you cannot do it or need approval/);
});
