// Run: node --test "test/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const { parseAction, createPending, takePending, teslaMessage, CONFIRM_TTL_MS } = require('../lib/actions');

const texts = [
  ['text Alex saying I love you', 'alex', 'I love you'],
  ["Text Sam I'm running late", 'sam', "I'm running late"],
  ['send a text to me that the oven is on', 'me', 'the oven is on'],
  ['text Jason Lee saying call me', 'jason lee', 'call me'],
];
for (const [said, contact, message] of texts) {
  test(`parses text: ${said}`, () => {
    const a = parseAction(said);
    assert.strictEqual(a.kind, 'text');
    assert.strictEqual(a.contact, contact);
    assert.strictEqual(a.message, message);
  });
}

test('text summary wording', () => {
  assert.strictEqual(parseAction('text Alex saying I love you').summary, 'Text alex: "I love you"?');
});

const tesla = [
  ['unlock the car', 'tesla_unlock', 'Unlock the car?'],
  ['unlock my Tesla', 'tesla_unlock', 'Unlock the car?'],
  ['lock the car', 'tesla_lock', 'Lock the car?'],
  ['open the trunk', 'tesla_open_trunk', 'Open the trunk?'],
  ['open the frunk', 'tesla_open_frunk', 'Open the frunk?'],
  ['honk the horn', 'tesla_honk_horn', 'Honk the horn?'],
  ['flash the lights', 'tesla_flash_lights', 'Flash the lights?'],
];
for (const [said, tool, summary] of tesla) {
  test(`parses car: ${said}`, () => {
    assert.deepStrictEqual(parseAction(said), { kind: 'tesla', tool, summary });
  });
}

const notActions = [
  'text Alex',
  'what did Alex text me',
  'tell me about Tesla stock',
  'is the car unlocked',
  'how do I unlock a Tesla',
  'read my email',
  'texting while driving tips',
];
for (const said of notActions) {
  test(`not an action: ${said}`, () => {
    assert.strictEqual(parseAction(said), null);
  });
}

test('takePending returns the action once', () => {
  const action = parseAction('unlock the car');
  const id = createPending(action, 1000);
  assert.deepStrictEqual(takePending(id, 2000), action);
  assert.strictEqual(takePending(id, 2000), null);
});

test('takePending expires after the confirm window', () => {
  const id = createPending(parseAction('unlock the car'), 1000);
  assert.strictEqual(CONFIRM_TTL_MS, 60000);
  assert.strictEqual(takePending(id, 1000 + 60001), null);
});

test('takePending unknown id', () => {
  assert.strictEqual(takePending('nope'), null);
});

test('PC restart -> confirm card', () => {
  const card = { kind: 'pc', tool: 'restart', summary: 'Restart the PC? It restarts 60 seconds after Yes.' };
  assert.deepStrictEqual(parseAction('restart my PC'), card);
  assert.deepStrictEqual(parseAction('Reboot the computer.'), card);
  assert.deepStrictEqual(parseAction('confirm restart'), card);
  assert.deepStrictEqual(parseAction('Start my PC.'), card); // Whisper dropped the "re"

});

test('cancel restart is not a card (the relay cancels right away)', () => {
  assert.strictEqual(parseAction('cancel restart'), null);
});

const OK = JSON.stringify({ status: 200, body: '{"response":{"result":true,"reason":""}}\n' });
test('car results read as plain words', () => {
  assert.strictEqual(teslaMessage('tesla_unlock', OK), 'Car unlocked.');
  assert.strictEqual(teslaMessage('tesla_lock', OK), 'Car locked.');
  assert.strictEqual(teslaMessage('tesla_open_trunk', OK), 'Trunk opened.');
  assert.strictEqual(teslaMessage('tesla_open_frunk', OK), 'Frunk opened.');
  assert.strictEqual(teslaMessage('tesla_honk_horn', OK), 'Horn honked.');
  assert.strictEqual(teslaMessage('tesla_flash_lights', OK), 'Lights flashed.');
});

test('a refused car command gives the reason', () => {
  const no = JSON.stringify({ status: 200, body: '{"response":{"result":false,"reason":"vehicle unavailable"}}' });
  assert.strictEqual(teslaMessage('tesla_unlock', no), "The car didn't do it: vehicle unavailable.");
});

test('anything else is shown as it came, cut to 200 characters', () => {
  assert.strictEqual(teslaMessage('tesla_unlock', 'Tesla proxy is not running'), 'Tesla proxy is not running');
  assert.strictEqual(teslaMessage('tesla_unlock', 'x'.repeat(300)).length, 200);
});
