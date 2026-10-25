// Run: node --test "test/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer, speechText, splitSpeech, approvalSpeech } = require('../relay');
const { fakeHermes, fakeStt, listen } = require('./fake-hermes');

const TOKEN = 'test-watch-token';

async function setup(t, opts = {}) {
  const hermes = opts.noHermes ? null : await fakeHermes();
  const stt = await fakeStt();
  const ran = [];
  const recorded = [];
  const notified = [];
  const spoken = [];
  const logged = [];
  const rated = [];
  const server = createServer({
    token: TOKEN,
    hermesKey: 'hermes-key',
    hermesPort: hermes ? hermes.port : 1, // port 1: connection refused
    sttUrl: stt.url,
    sessionFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')), 'session.json'),
    deadlineMs: opts.deadlineMs || 5000,
    pcHealth: async () => opts.health || '{}',
    cancelRestart: () => 'PC restart cancelled.',
    runAction: async (a) => { ran.push(a); return { ok: true, message: `Sent to ${a.contact}.` }; },
    log: line => logged.push(line),
    recordTurn: e => recorded.push(e),
    recordRating: e => rated.push(e),
    notify: text => notified.push(text),
    geocode: opts.geocode || (async () => ''), // never the real map lookup in tests
    tts: async (text) => { if (opts.ttsFails) throw new Error('voice down'); spoken.push(text); return Buffer.from(`MP3:${text}`); },
  });
  const port = await listen(server);
  t.after(() => { server.close(); stt.close(); if (hermes) hermes.close(); });
  const call = async (method, p, body, token = TOKEN) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, type: res.headers.get('content-type'), json: await res.json().catch(() => null) };
  };
  const speech = async (id, token = TOKEN) => {
    const res = await fetch(`http://127.0.0.1:${port}/watch/speech?id=${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, type: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()).toString() };
  };
  return { hermes, ran, recorded, notified, spoken, logged, rated, call, speech, ask: b => call('POST', '/watch/ask', b).then(r => r.json),
    rate: b => call('POST', '/watch/rate', b).then(r => r.json),
    confirm: b => call('POST', '/watch/confirm', b).then(r => r.json) };
}

const sleep = ms => new Promise(res => setTimeout(res, ms));
const noRate = ({ rate, ...reply }) => reply; // answers carry a random rate id

test('rating: a Hermes answer carries a rate id; a tap saves the question and reply, a second tap undoes it', async (t) => {
  const { ask, rate, rated } = await setup(t);
  const r = await ask({ text: 'what is a roth ira' });
  assert.match(r.rate, /^[0-9a-f]{12}$/);
  assert.deepStrictEqual(await rate({ rate: r.rate, kind: 'down' }), { ok: true, kind: 'down' });
  assert.deepStrictEqual(await rate({ rate: r.rate, kind: 'none' }), { ok: true, kind: 'none' });
  assert.strictEqual(rated.length, 2);
  assert.strictEqual(rated[0].kind, 'down');
  assert.strictEqual(rated[0].question, 'what is a roth ira');
  assert.strictEqual(rated[0].reply, 'echo: what is a roth ira');
  assert.match(rated[0].session, /^watch-\d{8}-[0-9a-f]{6}$/);
  assert.strictEqual(rated[1].kind, 'none');
});

test('rating: a slow answer collected by polling and /watch/last keep the rate id', async (t) => {
  const { ask, call } = await setup(t, { deadlineMs: 500 });
  const r = await ask({ text: 'slow question' });
  assert.strictEqual(r.kind, 'working');
  await sleep(2200);
  const done = (await call('POST', '/watch/result', { job: r.job })).json;
  assert.match(done.rate, /^[0-9a-f]{12}$/);
  assert.strictEqual((await call('GET', '/watch/last')).json.rate, done.rate);
});

test('rating: PC health is rateable; errors, new session and cards are not', async (t) => {
  const health = JSON.stringify({ cpuLoadPct: 10, memTotalGB: 16, memUsedGB: 8, memUsedPct: 50, uptime: '1d 2h 3m', disks: [], topMemory: [] });
  const { ask } = await setup(t, { health });
  assert.match((await ask({ text: 'PC health check' })).rate, /^[0-9a-f]{12}$/);
  assert.strictEqual((await ask({ text: 'start new session' })).rate, undefined);
  assert.strictEqual((await ask({ text: 'draft an email to Ann' })).rate, undefined); // a Yes/No card
  assert.strictEqual((await ask({ text: 'text Alex saying hi' })).rate, undefined);
  const down = await setup(t, { noHermes: true });
  assert.strictEqual((await down.ask({ text: 'hello' })).rate, undefined); // "Hermes isn't running"
});

test('rating: unknown ids and bad kinds are refused and nothing is saved; token needed', async (t) => {
  const { ask, rate, rated, call } = await setup(t);
  const r = await ask({ text: 'hi' });
  assert.strictEqual((await rate({ rate: 'nope', kind: 'up' })).ok, false);
  assert.strictEqual((await rate({ rate: r.rate, kind: 'meh' })).ok, false);
  assert.strictEqual((await call('POST', '/watch/rate', { rate: r.rate, kind: 'up' }, 'wrong')).status, 401);
  assert.strictEqual(rated.length, 0);
});

test('voice on: an answer gets a speech id; the MP3 is started right away and served from /watch/speech', async (t) => {
  const { ask, speech, spoken } = await setup(t);
  const r = await ask({ text: 'what time is it', speak: true });
  assert.strictEqual(r.text, 'echo: what time is it');
  assert.match(r.speech, /^[0-9a-f]{12}$/);
  assert.deepStrictEqual(spoken, ['echo: what time is it.']); // already being made while the phone asks for it
  const s = await speech(r.speech);
  assert.deepStrictEqual(s, { status: 200, type: 'audio/mpeg', body: 'MP3:echo: what time is it.' });
  await speech(r.speech);
  assert.strictEqual(spoken.length, 1); // fetched twice, made once
});

test('diag: the phone and watch can write short status lines into the relay log (token needed)', async (t) => {
  const { call, logged } = await setup(t);
  const r = await call('POST', '/watch/diag', { from: 'phone', events: ['speech s1: download start', 'speech s1: sent\nfake line'] });
  assert.deepStrictEqual(r.json, { ok: true });
  assert.ok(logged.includes('  phone: speech s1: download start'));
  assert.ok(logged.includes('  phone: speech s1: sent fake line')); // one line each, no injected log lines
  assert.strictEqual((await call('POST', '/watch/diag', { from: 'phone', events: ['x'] }, 'wrong')).status, 401);
  await call('POST', '/watch/diag', { from: 'watch', events: ['y'.repeat(500)] });
  assert.ok(logged.includes(`  watch: ${'y'.repeat(200)}`)); // capped
});

test('a lost poll reply: polling again gets the same answer and the same speech id (spoken once)', async (t) => {
  const { ask, call, spoken } = await setup(t, { deadlineMs: 500 });
  const r = await ask({ text: 'slow question', speak: true });
  await sleep(2000);
  const first = (await call('POST', '/watch/result', { job: r.job, speak: true })).json;
  const again = (await call('POST', '/watch/result', { job: r.job, speak: true })).json; // the first reply was lost
  assert.strictEqual(first.text, 'echo: slow question');
  assert.deepStrictEqual(again, first);
  assert.strictEqual(spoken.length, 1);
});

test('a lost Approve card comes back on the next poll until it is answered', async (t) => {
  const { ask, call, confirm } = await setup(t, { deadlineMs: 500 });
  const r = await ask({ text: 'slow question' }); // occupies nothing; separate job below
  const card = await ask({ text: 'build slow thing' });
  assert.strictEqual(card.approve, true);
  const done = await confirm({ id: card.id, yes: true });
  assert.strictEqual(done.kind, 'working');
  const polled = (await call('POST', '/watch/result', { job: done.job })).json;
  assert.strictEqual(polled.kind, 'working'); // the answered card is not shown again
  await sleep(2500);
  assert.strictEqual((await call('POST', '/watch/result', { job: done.job })).json.text, 'Built: build slow thing');
  assert.ok(r.job);
});

test('splitSpeech: short answers are one clip; long ones are the first sentence, then the rest', () => {
  assert.deepStrictEqual(splitSpeech('It is 42.'), ['It is 42.']);
  const long = 'NASA confirmed the Artemis crew today. The mission will orbit the Moon for ten days. '
    + 'Engineers are still testing the heat shield. More details come out on Friday.';
  assert.deepStrictEqual(splitSpeech(long), ['NASA confirmed the Artemis crew today.',
    'The mission will orbit the Moon for ten days. Engineers are still testing the heat shield. More details come out on Friday.']);
  const [first, rest] = splitSpeech('word '.repeat(100).trim()); // no sentence end: cut at a word
  assert.ok(first.length <= 160 && first.endsWith('word') && rest.startsWith('word'), first);
});

test('splitSpeech: a full-screen answer is three clips at most, split at sentences, nothing lost', () => {
  const sentences = Array.from({ length: 16 }, (_, i) => `Sentence number ${i + 1} says a few more words here.`);
  const text = sentences.join(' '); // ~830 chars, like a long watch answer
  const parts = splitSpeech(text);
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts.join(' '), text);
  assert.strictEqual(parts[0], sentences[0]);
  for (const p of parts.slice(1)) assert.ok(p.endsWith('.') && p.length < 500, p);
  const words = splitSpeech(speechText('word '.repeat(300))); // no sentence ends at all
  assert.ok(words.length <= 3 && words.every(Boolean), words);
});

test('voice on, full-screen answer: three clips, all started at once, served as parts 1-3', async (t) => {
  const { ask, speech, spoken } = await setup(t);
  const r = await ask({ text: 'long one', speak: true });
  assert.strictEqual(r.speechParts, 3);
  assert.strictEqual(spoken.length, 3); // every clip is being made while the text goes out
  const clips = [];
  for (const n of [1, 2, 3]) clips.push(await speech(`${r.speech}&part=${n}`));
  assert.ok(clips.every(c => c.status === 200));
  assert.ok(clips[0].body.length < clips[1].body.length, 'the first clip is the short one');
  assert.strictEqual((await speech(`${r.speech}&part=4`)).status, 404);
});

test('voice on, short answer: one clip (no speechParts), plain /watch/speech?id= still works', async (t) => {
  const { ask, speech } = await setup(t);
  const r = await ask({ text: 'what time is it', speak: true });
  assert.strictEqual(r.speechParts, undefined);
  assert.strictEqual((await speech(r.speech)).body, 'MP3:echo: what time is it.');
  assert.strictEqual((await speech(`${r.speech}&part=1`)).body, 'MP3:echo: what time is it.');
});

test('voice off: no speech id, nothing spoken', async (t) => {
  const { ask } = await setup(t);
  assert.strictEqual((await ask({ text: 'what time is it' })).speech, undefined);
});

test('voice: Yes/No cards, their results and Approve cards are spoken (Approve: what + the question)', async (t) => {
  const { ask, confirm, speech } = await setup(t);
  const card = await ask({ text: 'text Alex saying hi', speak: true });
  assert.ok(card.speech);
  assert.ok((await confirm({ id: card.id, yes: true, speak: true })).speech);
  const approve = await ask({ text: 'build a tide job', speak: true });
  assert.strictEqual(approve.approve, true);
  assert.ok(approve.speech);
  assert.strictEqual((await speech(approve.speech)).body,
    'MP3:Claude Code wants to change files in my-project: step 1: build a tide job. Approve this change?');
  await confirm({ id: approve.id, yes: false }); // let the fake Hermes finish
});

test('voice: a slow answer is spoken when the poll asks for it', async (t) => {
  const { ask, call } = await setup(t, { deadlineMs: 500 });
  const r = await ask({ text: 'slow question', speak: true });
  assert.strictEqual(r.kind, 'working');
  await sleep(2000);
  assert.ok((await call('POST', '/watch/result', { job: r.job, speak: true })).json.speech);
});

test('voice: unknown id -> 404, voice service down -> 502, needs the token', async (t) => {
  const { ask, speech } = await setup(t, { ttsFails: true });
  assert.strictEqual((await speech('nope')).status, 404);
  const r = await ask({ text: 'hello', speak: true });
  assert.strictEqual((await speech(r.speech)).status, 502);
  assert.strictEqual((await speech(r.speech, 'wrong')).status, 401);
});

test('approvalSpeech: a build card is read as its title and the question, not the whole plan', () => {
  const plan = 'Alex wants to optimize the Hermes agent. '.repeat(40);
  const said = approvalSpeech(`Claude Code wants to BUILD this:\n\nLocal DeepSeek model for Hermes\n\n${plan}\n\nApprove building it?`);
  assert.strictEqual(said, 'Claude Code wants to build this: Local DeepSeek model for Hermes. Approve building it?');
  const job = approvalSpeech(`Change 'Morning brief' (8:00 AM, topic 5): ${'make it shorter. '.repeat(30)}\n\nFiles: a.py, job prompt.\n\nApprove?`);
  assert.ok(job.startsWith("Change 'Morning brief'") && job.endsWith('Approve?') && job.length < 400, job);
  assert.strictEqual(approvalSpeech('Approve this?'), 'Approve this?');
});

test('speechText: bullets and links become plain sentences; the whole screen answer is read', () => {
  assert.strictEqual(speechText('Today:\n• Dentist 3 PM\n• Gym at 6. See https://x.example/a'), 'Today: Dentist 3 PM. Gym at 6. See.');
  const screenful = 'First sentence is here. '.repeat(45).trim(); // ~1080 chars: the 1000-char answer + its question
  assert.strictEqual(speechText(screenful), screenful);
  const said = speechText('First sentence is here. '.repeat(80).trim()); // only a runaway text is cut, at a sentence
  assert.ok(said.length <= 1200 && said.endsWith('here.'), said);
  assert.strictEqual(speechText('x'.repeat(1500)).length, 1200);
});

test('Hermes turns are streamed (so approvals can reach the watch)', async (t) => {
  const { ask, hermes } = await setup(t);
  assert.strictEqual((await ask({ text: 'what time is it' })).text, 'echo: what time is it');
  assert.strictEqual(hermes.calls[0].stream, true);
});

test('approval: Claude Code asks -> Approve card; Approve -> answer, once, Telegram told', async (t) => {
  const { ask, confirm, hermes, notified } = await setup(t);
  const card = await ask({ text: 'build a tide job' });
  assert.strictEqual(card.kind, 'confirm');
  assert.strictEqual(card.approve, true);
  assert.match(card.text, /^Claude Code wants to change files in my-project:\nstep 1: build a tide job\nApprove this change\?$/);
  const done = await confirm({ id: card.id, yes: true });
  assert.deepStrictEqual(noRate(done), { ok: true, kind: 'answer', text: 'Built: build a tide job' });
  assert.deepStrictEqual(hermes.approvals.map(a => [a.run, a.choice, a.request_id, a.auth]), [['run-1', 'once', 'req-1', 'Bearer hermes-key']]);
  assert.deepStrictEqual(notified, ['From the watch: build a tide job\n\nBuilt: build a tide job']);
});

test('approval: Deny answers at once; Hermes is told deny; nothing to Telegram', async (t) => {
  const { ask, confirm, hermes, notified, call } = await setup(t);
  const card = await ask({ text: 'build a tide job' });
  assert.deepStrictEqual(await confirm({ id: card.id, yes: false }), { ok: true, kind: 'answer', text: 'OK, denied - nothing was changed.' });
  assert.deepStrictEqual(hermes.approvals.map(a => a.choice), ['deny']);
  await sleep(200);
  assert.strictEqual((await call('GET', '/watch/last')).json.text, 'Not approved - nothing changed.');
  assert.deepStrictEqual(notified, []);
});

test('approval: a slow build -> working with a note -> result; Telegram gets it too', async (t) => {
  const { ask, confirm, call, notified } = await setup(t, { deadlineMs: 500 });
  const card = await ask({ text: 'build slow thing' });
  const r = await confirm({ id: card.id, yes: true });
  assert.strictEqual(r.kind, 'working');
  assert.match(r.note, /Telegram/);
  assert.strictEqual((await call('GET', `/watch/result?job=${r.job}`)).json.kind, 'working');
  await sleep(2000);
  assert.strictEqual((await call('GET', `/watch/result?job=${r.job}`)).json.text, 'Built: build slow thing');
  assert.deepStrictEqual(notified, ['From the watch: build slow thing\n\nBuilt: build slow thing']);
});

test('approval: a second approval in the same build comes as the next card', async (t) => {
  const { ask, confirm, hermes } = await setup(t);
  const card1 = await ask({ text: 'build twice please' });
  const card2 = await confirm({ id: card1.id, yes: true });
  assert.strictEqual(card2.approve, true);
  assert.match(card2.text, /step 2/);
  assert.strictEqual((await confirm({ id: card2.id, yes: true })).text, 'Built: build twice please');
  assert.deepStrictEqual(hermes.approvals.map(a => a.request_id), ['req-1', 'req-2']);
});

test('approval: speaking something else (Reply) denies the pending approval first', async (t) => {
  const { ask, confirm, hermes } = await setup(t);
  const card = await ask({ text: 'build a tide job' });
  assert.strictEqual((await ask({ text: 'make it hourly instead' })).text, 'echo: make it hourly instead');
  assert.deepStrictEqual(hermes.approvals.map(a => a.choice), ['deny']);
  assert.strictEqual((await confirm({ id: card.id, yes: true })).text, 'That expired, ask again.');
});

const audio = text => ({ audio_b64: Buffer.from(text).toString('base64') });

test('no token -> 401', async (t) => {
  const { call } = await setup(t);
  assert.strictEqual((await call('POST', '/watch/ask', { text: 'hi' }, null)).status, 401);
  assert.strictEqual((await call('POST', '/watch/ask', { text: 'hi' }, 'wrong')).status, 401);
});

test('ask text -> answer from Hermes in the watch session', async (t) => {
  const { ask, hermes } = await setup(t);
  const r = await ask({ text: 'what time is it' });
  assert.deepStrictEqual(noRate(r), { ok: true, heard: 'what time is it', kind: 'answer', text: 'echo: what time is it' });
  assert.match(hermes.calls[0].session, /^watch-\d{8}-[0-9a-f]{6}$/);
  assert.strictEqual(hermes.calls[0].auth, 'Bearer hermes-key');
  assert.match(hermes.calls[0].user, /Never call send_text/);
});

test('watch GPS: the fix reaches Hermes next to the question and the log; none -> the reason is logged', async (t) => {
  const { ask, hermes, logged } = await setup(t);
  const r = await ask({ text: 'where is the nearest gas station', loc: { lat: 48.858372, lon: 2.294481, age_s: 2 } });
  assert.strictEqual(r.heard, 'where is the nearest gas station'); // the screen never shows coordinates
  assert.match(hermes.calls[0].user, /Watch GPS: .+ is at 48\.85837, 2\.29448 \(fixed 2 s ago\)/);
  assert.ok(logged.includes('  gps: 48.85837, 2.29448 (2 s old)'));
  await ask({ text: 'what time is it', gps: 'no fix yet' });
  assert.doesNotMatch(hermes.calls[1].user, /Watch GPS/);
  assert.ok(logged.includes('  gps: none (no fix yet)'));
});

test('watch GPS: the mapped place goes to Hermes with the fix (looked up while transcribing)', async (t) => {
  const asked = [];
  const { ask, hermes, logged } = await setup(t, { geocode: async (loc) => { asked.push(loc); return 'Eiffel Tower (attraction), 5, Avenue Anatole France'; } });
  await ask({ text: 'what is this place', loc: { lat: 48.85826, lon: 2.2945, age_s: 5 } });
  assert.strictEqual(asked.length, 1);
  assert.match(hermes.calls[0].user, /The map lookup there says: Eiffel Tower \(attraction\), 5, Avenue Anatole France/);
  assert.ok(logged.some(l => /gps: 48\.85826, 2\.2945 \(5 s old\) - Eiffel Tower/.test(l)));
  await ask({ text: 'what is this place', gps: 'no fix yet' });
  assert.strictEqual(asked.length, 1); // no fix, no lookup
});

test('unasked CONFIRM lines: an offer to text the user is dropped, a non-action question stays as text, no card', async (t) => {
  const { ask, logged } = await setup(t);
  assert.deepStrictEqual(noRate(await ask({ text: 'what is this place' })),
    { ok: true, heard: 'what is this place', kind: 'answer', text: 'You are at the Eiffel Tower.' });
  assert.deepStrictEqual(noRate(await ask({ text: 'price of bitcoin' })),
    { ok: true, heard: 'price of bitcoin', kind: 'answer', text: 'Bitcoin is $100.\nWant me to check it again later?' });
  assert.ok(logged.some(l => /unasked CONFIRM dropped: Send you a text/.test(l)));
  const card = await ask({ text: 'draft an email to Ann' });
  assert.strictEqual(card.kind, 'confirm'); // a real proposal keeps its Yes/No buttons
});

test('audio is transcribed first', async (t) => {
  const { ask } = await setup(t);
  const r = await ask(audio('how is the weather'));
  assert.strictEqual(r.heard, 'how is the weather');
  assert.strictEqual(r.text, 'echo: how is the weather');
});

test('ask with empty transcript -> no Hermes turn', async (t) => {
  const { ask, hermes } = await setup(t);
  const r = await ask(audio(''));
  assert.deepStrictEqual(r, { ok: true, heard: '', kind: 'answer', text: "I didn't catch that." });
  assert.strictEqual(hermes.calls.length, 0);
});

test('text command -> confirm card, Hermes not called', async (t) => {
  const { ask, hermes } = await setup(t);
  const r = await ask({ text: 'text Alex saying hi' });
  assert.strictEqual(r.kind, 'confirm');
  assert.strictEqual(r.text, 'Text alex: "hi"?');
  assert.ok(r.id);
  assert.strictEqual(hermes.calls.length, 0);
});

test('confirm no -> nothing runs', async (t) => {
  const { ask, call, ran } = await setup(t);
  const { id } = await ask({ text: 'text Alex saying hi' });
  const r = (await call('POST', '/watch/confirm', { id, yes: false })).json;
  assert.deepStrictEqual(r, { ok: true, kind: 'answer', text: 'OK, not sent.' });
  assert.strictEqual(ran.length, 0);
});

test('confirm yes twice -> runs once', async (t) => {
  const { ask, call, ran } = await setup(t);
  const { id } = await ask({ text: 'text Alex saying hi' });
  const first = (await call('POST', '/watch/confirm', { id, yes: true })).json;
  const second = (await call('POST', '/watch/confirm', { id, yes: true })).json;
  assert.strictEqual(first.text, 'Sent to alex.');
  assert.strictEqual(second.text, 'That expired, ask again.');
  assert.strictEqual(ran.length, 1);
  assert.deepStrictEqual(ran[0], { kind: 'text', contact: 'alex', message: 'hi', summary: 'Text alex: "hi"?' });
});

test('retried ask with the same rid -> same reply, one Hermes turn', async (t) => {
  const { ask, hermes } = await setup(t);
  const first = await ask({ text: 'what time is it', rid: 'r1' });
  const again = await ask({ text: 'what time is it', rid: 'r1' });
  assert.deepStrictEqual(again, first);
  assert.strictEqual(hermes.calls.length, 1);
});

test('retry while the first is still running waits for it', async (t) => {
  const { ask, hermes } = await setup(t);
  const [a, b] = await Promise.all([ask({ text: 'slow one', rid: 'r2' }), ask({ text: 'slow one', rid: 'r2' })]);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(hermes.calls.length, 1);
});

test('retried confirm yes with the same rid -> same result, action runs once', async (t) => {
  const { ask, call, ran } = await setup(t);
  const { id } = await ask({ text: 'text Alex saying hi' });
  const first = (await call('POST', '/watch/confirm', { id, yes: true, rid: 'c1' })).json;
  const again = (await call('POST', '/watch/confirm', { id, yes: true, rid: 'c1' })).json;
  assert.strictEqual(first.text, 'Sent to alex.');
  assert.deepStrictEqual(again, first);
  assert.strictEqual(ran.length, 1);
});

test('PC health check -> answered by the relay, not Hermes', async (t) => {
  const health = JSON.stringify({ cpuLoadPct: 10, memTotalGB: 16, memUsedGB: 8, memUsedPct: 50, uptime: '1d 2h 3m',
    disks: [{ drive: 'C:', freeGB: 100, freePct: 30 }], topMemory: [], unexpectedShutdowns30d: 0 });
  const { ask, hermes } = await setup(t, { health });
  const r = await ask({ text: 'PC health check' });
  assert.deepStrictEqual(noRate(r), { ok: true, heard: 'PC health check', kind: 'answer', text: 'Healthy\nCPU 10%, RAM 8 of 16 GB\nC: 100 GB free\nUp 1d 2h' });
  assert.strictEqual(hermes.calls.length, 0);
});

test('misheard "PC, help check." -> still the PC health answer', async (t) => {
  const health = JSON.stringify({ cpuLoadPct: 10, memTotalGB: 16, memUsedGB: 8, memUsedPct: 50, uptime: '1d 2h 3m', disks: [], topMemory: [] });
  const { ask, hermes } = await setup(t, { health });
  assert.match((await ask({ text: 'PC, help check.' })).text, /^Healthy\n/);
  assert.strictEqual(hermes.calls.length, 0);
});

test('PC health not gathered -> Hermes answers', async (t) => {
  const { ask, hermes } = await setup(t);
  assert.strictEqual((await ask({ text: "how's my PC doing" })).text, "echo: how's my PC doing");
  assert.strictEqual(hermes.calls.length, 1);
});

test('restart my PC -> card; yes runs the restart action', async (t) => {
  const { ask, call, ran } = await setup(t);
  const r = await ask({ text: 'restart my PC' });
  assert.strictEqual(r.kind, 'confirm');
  assert.strictEqual(r.text, 'Restart the PC? It restarts 60 seconds after Yes.');
  await call('POST', '/watch/confirm', { id: r.id, yes: true });
  assert.deepStrictEqual(ran.map(a => a.kind), ['pc']);
});

test('cancel restart -> cancelled right away, no card', async (t) => {
  const { ask, hermes } = await setup(t);
  assert.deepStrictEqual(await ask({ text: 'cancel restart' }), { ok: true, heard: 'cancel restart', kind: 'answer', text: 'PC restart cancelled.' });
  assert.strictEqual(hermes.calls.length, 0);
});

test('confirm unknown id -> expired', async (t) => {
  const { call } = await setup(t);
  const r = (await call('POST', '/watch/confirm', { id: 'made-up', yes: true })).json;
  assert.deepStrictEqual(r, { ok: true, kind: 'answer', text: 'That expired, ask again.' });
});

test('hermes CONFIRM line -> confirm card; yes goes back to Hermes', async (t) => {
  const { ask, call, hermes, ran } = await setup(t);
  const r = await ask({ text: 'reply to Ann draft saying hi' });
  assert.strictEqual(r.kind, 'confirm');
  assert.strictEqual(r.text, 'Draft to Ann: Hi\nSend this email?');
  await call('POST', '/watch/confirm', { id: r.id, yes: true });
  assert.strictEqual(hermes.calls[1].user.split('\n')[0], 'yes, go ahead');
  assert.strictEqual(hermes.calls[1].session, hermes.calls[0].session);
  assert.strictEqual(ran.length, 0);
});

test('hermes CONFIRM card + No -> answered at once; Hermes told in the background', async (t) => {
  const { ask, call, hermes } = await setup(t, { deadlineMs: 500 });
  const r = await ask({ text: 'reply to Ann draft saying hi' });
  const t0 = Date.now();
  const no = (await call('POST', '/watch/confirm', { id: r.id, yes: false })).json;
  assert.deepStrictEqual(no, { ok: true, kind: 'answer', text: 'OK, not doing it.' });
  assert.ok(Date.now() - t0 < 400, `took ${Date.now() - t0} ms`);
  await new Promise(res => setTimeout(res, 100));
  assert.strictEqual(hermes.calls[1].user.split('\n')[0], "no, don't");
});

test('slow hermes -> job -> result', async (t) => {
  const { ask, call } = await setup(t, { deadlineMs: 500 });
  const r = await ask({ text: 'slow question' });
  assert.strictEqual(r.kind, 'working');
  assert.ok(r.job);
  assert.strictEqual((await call('GET', `/watch/result?job=${r.job}`)).json.kind, 'working');
  await new Promise(res => setTimeout(res, 2000));
  const done = (await call('GET', `/watch/result?job=${r.job}`)).json;
  assert.deepStrictEqual(noRate(done), { ok: true, heard: 'slow question', kind: 'answer', text: 'echo: slow question' });
});

test('last reply: the watch can collect what it missed while it was closed', async (t) => {
  const { ask, call } = await setup(t, { deadlineMs: 500 });
  assert.deepStrictEqual((await call('GET', '/watch/last')).json, { ok: true, kind: 'none' });
  await ask({ text: 'quick one' });
  let last = (await call('GET', '/watch/last')).json;
  assert.strictEqual(last.text, 'echo: quick one');
  assert.ok(last.ago_ms >= 0 && last.ago_ms < 5000);
  const r = await ask({ text: 'slow question' }); // the watch closes before the job finishes
  assert.strictEqual((await call('GET', '/watch/last')).json.job, r.job);
  await new Promise(res => setTimeout(res, 2000));
  last = (await call('GET', '/watch/last')).json; // finished without ever being polled
  assert.strictEqual(last.kind, 'answer');
  assert.strictEqual(last.text, 'echo: slow question');
  assert.strictEqual(last.heard, 'slow question');
});

test('result also works as POST {job}', async (t) => {
  const { ask, call } = await setup(t, { deadlineMs: 500 });
  const r = await ask({ text: 'slow question' });
  assert.strictEqual((await call('POST', '/watch/result', { job: r.job })).json.kind, 'working');
  await new Promise(res => setTimeout(res, 2000));
  const done = (await call('POST', '/watch/result', { job: r.job })).json;
  assert.deepStrictEqual(noRate(done), { ok: true, heard: 'slow question', kind: 'answer', text: 'echo: slow question' });
});

test('hermes down -> plain words', async (t) => {
  const { ask } = await setup(t, { noHermes: true });
  const r = await ask({ text: 'hello' });
  assert.strictEqual(r.text, "Hermes isn't running on the PC right now.");
});

test('relay-only answers are recorded for the conversation log; Hermes answers are not', async (t) => {
  const health = JSON.stringify({ cpuLoadPct: 10, memTotalGB: 16, memUsedGB: 8, memUsedPct: 50, uptime: '1d 2h 3m', disks: [], topMemory: [] });
  const { ask, call, hermes, recorded } = await setup(t, { health });
  await ask({ text: 'what time is it' });
  await ask({ text: 'PC health check' });
  const card = await ask({ text: 'restart my PC' });
  await call('POST', '/watch/confirm', { id: card.id, yes: true });
  await ask({ text: 'cancel restart' });
  const session = hermes.calls[0].session;
  assert.deepStrictEqual(recorded.map(({ ts, ...rest }) => rest), [
    { session, heard: 'PC health check', reply: 'Healthy\nCPU 10%, RAM 8 of 16 GB\nUp 1d 2h' },
    { session, heard: 'restart my PC', reply: 'Restart the PC? It restarts 60 seconds after Yes.' },
    { session, heard: 'Yes', reply: 'Sent to undefined.' },
    { session, heard: 'cancel restart', reply: 'PC restart cancelled.' },
  ]);
  assert.ok(recorded.every(e => typeof e.ts === 'number'));
});

test('start new session -> new id', async (t) => {
  const { ask, hermes } = await setup(t);
  await ask({ text: 'one' });
  const r = await ask({ text: 'start new session' });
  assert.strictEqual(r.text, 'New session started.');
  await ask({ text: 'two' });
  assert.notStrictEqual(hermes.calls[0].session, hermes.calls[1].session);
});

test('long answer is cut to 1000 characters', async (t) => {
  const { ask } = await setup(t);
  const r = await ask({ text: 'long answer please' });
  assert.ok(r.text.length <= 1000, String(r.text.length));
  assert.ok(r.text.length > 900);
});

test('replies say they are UTF-8 (PowerShell 5.1 garbled an em dash without it)', async (t) => {
  const { call } = await setup(t);
  assert.strictEqual((await call('POST', '/watch/ask', { text: 'hi' })).type, 'application/json; charset=utf-8');
});

test('health without auth', async (t) => {
  const { call } = await setup(t);
  const r = await call('GET', '/health', null, null);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
});

test('default deadline stays well under the iPhone Zepp fetch limit (20 s replies were lost)', () => {
  const { DEFAULT_DEADLINE_MS } = require('../relay');
  assert.ok(DEFAULT_DEADLINE_MS <= 12000, `got ${DEFAULT_DEADLINE_MS}`);
});
