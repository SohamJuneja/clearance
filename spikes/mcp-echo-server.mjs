// Spike S6: a trivial MCP server, no dependencies.
//
//   node spikes/mcp-echo-server.mjs              # stdio (newline-delimited JSON-RPC), tool: ping
//   node spikes/mcp-echo-server.mjs --http 7791  # streamable HTTP at /mcp, tool: refund_customer
//
// Every JSON-RPC message is logged to data/spike-logs/mcp-calls.jsonl, so "the agent
// connected and listed the tools" is visible from outside the agent as well.
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    http: { type: 'string' },
    'log-dir': { type: 'string', default: '/home/prashant/projects/Clearance/data/spike-logs' },
  },
});
mkdirSync(values['log-dir'], { recursive: true });
const logFile = `${values['log-dir']}/mcp-calls.jsonl`;
const transport = values.http ? 'http' : 'stdio';
const log = (message) =>
  appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), transport, message })}\n`);

const TOOLS = values.http
  ? [
      {
        name: 'refund_customer',
        description: 'Spike stand-in for the gate: asks for a refund. Always answers PENDING.',
        inputSchema: {
          type: 'object',
          properties: { customer: { type: 'string' }, amount: { type: 'number' } },
          required: ['customer', 'amount'],
        },
      },
    ]
  : [
      {
        name: 'ping',
        description: 'Spike tool: answers pong.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

function answer(message) {
  const { id, method, params } = message;
  if (id === undefined) return null; // A notification.
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: `clearance-spike-${transport}`, version: '0.0.1' },
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const text =
        params?.name === 'refund_customer'
          ? `PENDING CLR-0042: refund of ${params?.arguments?.amount} for ${params?.arguments?.customer} needs approval.`
          : 'pong from the clearance spike server';
      return ok({ content: [{ type: 'text', text }] });
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } };
  }
}

if (values.http) {
  createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      log(message);
      const reply = answer(message);
      if (reply === null) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  }).listen(Number(values.http), '127.0.0.1', () => {
    console.log(`mcp spike server on http://127.0.0.1:${values.http}/mcp`);
  });
} else {
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    log(message);
    const reply = answer(message);
    if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
}
