// Spike: a local stand-in for the Anthropic Messages API, so the isolated-HOME layer can be tested
// with a dummy key and no network. It records the tool names sent to the model, which is the
// strongest evidence of what a session can reach. Credentials are never logged, only whether one came.
//
//   node spikes/anthropic-stub.mjs [--port 7793]
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { port: { type: 'string', default: '7793' } } });
const LOG = '/home/prashant/projects/Clearance/data/spike-logs/anthropic-stub.jsonl';

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const path = new URL(req.url, 'http://local').pathname;
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      body = {};
    }
    appendFileSync(
      LOG,
      `${JSON.stringify({
        at: new Date().toISOString(),
        path,
        model: body.model,
        tool_names: (body.tools ?? []).map((tool) => tool.name),
        x_api_key: { present: Boolean(req.headers['x-api-key']), length: String(req.headers['x-api-key'] ?? '').length },
        bearer: { present: Boolean(req.headers.authorization) },
      })}\n`
    );
    if (path.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":1}');
      return;
    }
    if (!path.endsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"not_found_error","message":"stub"}}');
      return;
    }
    const id = `msg_stub_${Date.now()}`;
    const usage = { input_tokens: 1, output_tokens: 1 };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage })
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  });
}).listen(Number(values.port), '127.0.0.1', () => {
  console.log(`anthropic stub on http://127.0.0.1:${values.port}`);
});
