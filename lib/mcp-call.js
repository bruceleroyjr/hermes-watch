// Calls one tool on a local stdio MCP server (the text and Tesla bridges) and returns its text.
// stdin stays open until the answer arrives: the servers exit when stdin closes, which would
// otherwise kill a send that is still in flight.
const { spawn } = require('child_process');

function callMcpTool(script, tool, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buffer = '';
    let settled = false;
    const finish = (ok, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve({ ok, text, child });
    };
    const timer = setTimeout(() => finish(false, `${tool} timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    child.on('error', e => finish(false, `could not start ${tool}: ${e.message}`));
    child.on('exit', () => finish(false, `${tool} stopped without answering`));
    child.stdin.on('error', () => {}); // the child may exit first; the exit handler reports it
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 2) continue;
        if (msg.error) return finish(false, msg.error.message || 'tool error');
        const text = ((msg.result && msg.result.content) || []).map(c => c.text || '').join('\n');
        return finish(!msg.result.isError, text);
      }
    });
    const send = m => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hermes-watch', version: '1' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
  });
}

module.exports = { callMcpTool };
