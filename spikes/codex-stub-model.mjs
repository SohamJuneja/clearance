// Spike S5, Codex without a login: a stub of the OpenAI Responses API. Real Codex CLI,
// real hook engine, fake model. The first request answers with a tool call that runs
// STUB_COMMAND; the next answers with text quoting the tool output. This proves Codex's
// mechanics only, never agent behaviour, and it is not a run under Switch.
//
//   node spikes/codex-stub-model.mjs [--port 7792] [--command "git push"]
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '7792' },
    command: { type: 'string', default: 'git push' },
    'log-dir': { type: 'string', default: '/home/you/projects/Clearance/data/spike-logs' },
  },
});
mkdirSync(values['log-dir'], { recursive: true });
const logFile = `${values['log-dir']}/codex-stub.jsonl`;

const sse = (res, type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);

function toolCall(tools) {
  const names = (tools ?? []).map((tool) => tool.name ?? tool.type);
  if (names.includes('exec_command'))
    return { name: 'exec_command', arguments: JSON.stringify({ cmd: values.command }) };
  if (names.includes('shell_command'))
    return { name: 'shell_command', arguments: JSON.stringify({ command: values.command }) };
  return { name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', values.command] }) };
}

let counter = 0;
createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"stub: not found"}}');
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const outputs = (body.input ?? []).filter((item) => item.type === 'function_call_output');
    appendFileSync(
      logFile,
      `${JSON.stringify({
        at: new Date().toISOString(),
        tools: (body.tools ?? []).map((tool) => tool.name ?? tool.type),
        tool_outputs: outputs.map((item) => String(item.output?.content ?? item.output).slice(0, 600)),
      })}\n`
    );
    counter += 1;
    const id = `resp_stub_${counter}`;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse(res, 'response.created', { response: { id } });
    // Decide on the last input item, not on any output in the history: a resumed
    // conversation carries old tool outputs, and it still needs a new tool call.
    const item =
      body.input?.at(-1)?.type !== 'function_call_output'
        ? { type: 'function_call', call_id: `call_stub_${counter}`, ...toolCall(body.tools) }
        : {
            type: 'message',
            role: 'assistant',
            id: `msg_stub_${counter}`,
            content: [
              { type: 'output_text', text: `STUB saw tool output: ${String(outputs.at(-1).output?.content ?? outputs.at(-1).output).slice(0, 300)}` },
            ],
          };
    sse(res, 'response.output_item.done', { item });
    sse(res, 'response.completed', {
      response: { id, output: [], usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } },
    });
    res.end();
  });
}).listen(Number(values.port), '127.0.0.1', () => {
  console.log(`codex stub model on http://127.0.0.1:${values.port}/v1, command: ${values.command}`);
});
