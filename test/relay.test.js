// Run: node --test "test/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../relay');
const { fakeHermes, fakeStt, listen } = require('./fake-hermes');

const TOKEN = 'test-watch-token';

async function setup(t, opts = {}) {
  const hermes = opts.noHermes ? null : await fakeHermes();
  const stt = await fakeStt();
  const ran = [];
  const recorded = [];
  const notified = [];
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
    log: () => {},
    recordTurn: e => recorded.push(e),
    notify: text => notified.push(text),
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
  return { hermes, ran, recorded, notified, call, ask: b => call('POST', '/watch/ask', b).then(r => r.json),
    confirm: b => call('POST', '/watch/confirm', b).then(r => r.json) };
}

const sleep = ms => new Promise(res => setTimeout(res, ms));

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
  assert.deepStrictEqual(done, { ok: true, kind: 'answer', text: 'Built: build a tide job' });
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
  assert.deepStrictEqual(r, { ok: true, heard: 'what time is it', kind: 'answer', text: 'echo: what time is it' });
  assert.match(hermes.calls[0].session, /^watch-\d{8}-[0-9a-f]{6}$/);
  assert.strictEqual(hermes.calls[0].auth, 'Bearer hermes-key');
  assert.match(hermes.calls[0].user, /Never call send_text/);
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
  assert.deepStrictEqual(r, { ok: true, heard: 'PC health check', kind: 'answer', text: 'Healthy\nCPU 10%, RAM 8 of 16 GB\nC: 100 GB free\nUp 1d 2h' });
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
  assert.deepStrictEqual(done, { ok: true, heard: 'slow question', kind: 'answer', text: 'echo: slow question' });
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
  assert.deepStrictEqual(done, { ok: true, heard: 'slow question', kind: 'answer', text: 'echo: slow question' });
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
