// Stand-ins for Hermes' API server and the STT worker, for relay tests.
// Hermes: echoes the first line of the user message; "slow" and "no, don't" answer after 2 s; "draft" replies
// with a CONFIRM line; "long" replies with 3000 characters. "build" asks for an approval first (like
// claude_code_edit's MCP elicitation) and answers once POST /v1/runs/run-N/approval resolves it
// ("build slow" answers 2 s after the approval, "build twice" asks twice). Streams when asked to, like Hermes.
// Every call and approval answer is recorded.
const http = require('http');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const sse = (event, data) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

async function fakeHermes() {
  const calls = [];
  const approvals = [];
  const waiting = new Map(); // run id -> resolve(choice)
  let runs = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(200); return res.end('{}'); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const approval = req.url.match(/^\/v1\/runs\/([^/]+)\/approval$/);
      if (approval) {
        approvals.push({ run: approval[1], ...body, auth: req.headers.authorization });
        const resolve = waiting.get(approval[1]);
        if (!resolve) { res.writeHead(409); return res.end('{"error":{"code":"approval_not_active"}}'); }
        waiting.delete(approval[1]);
        resolve(body.choice);
        res.writeHead(200);
        return res.end(JSON.stringify({ resolved: 1, choice: body.choice }));
      }
      const user = body.messages.find(m => m.role === 'user').content;
      const first = user.split('\n')[0];
      calls.push({ session: req.headers['x-hermes-session-id'], auth: req.headers.authorization, user,
        system: body.messages[0].content, stream: body.stream });
      const run = `run-${++runs}`;
      let content = `echo: ${first}`;
      if (/draft/.test(first)) content = 'Draft to Ann: Hi\nCONFIRM: Send this email?';
      if (/long/.test(first)) content = 'word '.repeat(600);
      if (/this place/.test(first)) content = 'You are at the Eiffel Tower.\nCONFIRM: Send you a text with these details?';
      if (/bitcoin/i.test(first)) content = 'Bitcoin is $100.\nCONFIRM: Want me to check it again later?';
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sse('', { choices: [{ delta: { role: 'assistant' } }] }));
      }
      const send = (text) => {
        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
        }
        res.write(sse('hermes.tool.progress', { tool: 'x', status: 'completed' }));
        for (let i = 0; i < text.length; i += 40) res.write(sse('', { choices: [{ delta: { content: text.slice(i, i + 40) } }] }));
        res.write(sse('', '[DONE]'));
        res.end();
      };
      const ask = (n) => new Promise((resolve) => {
        waiting.set(run, resolve);
        res.write(sse('approval.request', { run_id: run, request_id: `req-${n}`, event: 'approval.request',
          command: `Claude Code wants to change files in my-project:\n\nstep ${n}: ${first}\n\nApprove this change?`,
          choices: ['once', 'session', 'always', 'deny'] }));
      });
      if (body.stream && /^build/.test(first)) {
        (async () => {
          let choice = await ask(1);
          if (choice === 'once' && /twice/.test(first)) choice = await ask(2);
          const answer = choice === 'once' ? `Built: ${first}` : 'Not approved - nothing changed.';
          if (/slow/.test(first) && choice === 'once') setTimeout(() => send(answer), 2000); else send(answer);
        })();
        return;
      }
      if (/slow|^no, don't/.test(first)) setTimeout(() => send(content), 2000); else send(content);
    });
  });
  const port = await listen(server);
  return { port, calls, approvals, close: () => server.close() };
}

async function fakeStt() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: Buffer.concat(chunks).toString('utf8'), seconds: 1, level_db: -30, ms: 5 }));
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/stt`, close: () => server.close() };
}

module.exports = { fakeHermes, fakeStt, listen };
