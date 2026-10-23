// Minimal stdio MCP server for mcp-call tests: "echo" answers after 300 ms with its name and
// args; "slow" never answers. Exits when stdin closes, like the real servers.
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } })}\n`);
  } else if (msg.method === 'tools/call') {
    if (msg.params.name === 'slow') return;
    setTimeout(() => {
      const text = JSON.stringify({ tool: msg.params.name, args: msg.params.arguments });
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } })}\n`);
    }, 300);
  }
});
process.stdin.on('end', () => process.exit(0));
