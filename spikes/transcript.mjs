// Spike helper: read Claude Code transcripts for a spike working directory.
//
//   node spikes/transcript.mjs tools <workdir-name> [--last 1]   # tool calls, results, replies
//   node spikes/transcript.mjs usage [workdir-name ...]          # turns and tokens per directory
//
// Bearer tokens are masked; output is cut short per line.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { last: { type: 'string', default: '1' }, width: { type: 'string', default: '420' } },
});
const [command, ...names] = positionals;
const projects = join(homedir(), '.claude', 'projects');
const WORK_PREFIX = join(homedir(), '.local/share/clearance-tools/spike-work').replaceAll(/[/.]/g, '-');
const mask = (text) => String(text).replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1***');
const width = Number(values.width);

function transcripts(name) {
  const dir = join(projects, `${WORK_PREFIX}-${name}`);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => join(dir, file))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

const entries = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

function printTools(file) {
  console.log(`--- ${file.split('/').pop()}`);
  for (const entry of entries(file)) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'text' && entry.type === 'assistant')
        console.log(`  text: ${mask(block.text).slice(0, width)}`);
      if (block.type === 'tool_use')
        console.log(`  call: ${block.name} ${mask(JSON.stringify(block.input)).slice(0, width)}`);
      if (block.type === 'tool_result') {
        const text =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        console.log(`  ${block.is_error ? 'ERR ' : 'ok  '}: ${mask(text).slice(0, width)}`);
      }
    }
    if (entry.attachment?.hookName || entry.attachment?.type?.includes?.('hook'))
      console.log(`  hook-attachment: ${mask(JSON.stringify(entry.attachment)).slice(0, width)}`);
  }
}

function usageFor(name) {
  const totals = { sessions: 0, apiCalls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, models: new Set() };
  for (const file of transcripts(name)) {
    totals.sessions += 1;
    const seen = new Set();
    for (const entry of entries(file)) {
      const usage = entry.message?.usage;
      if (entry.type !== 'assistant' || !usage) continue;
      // One API call appears as several entries sharing a message id.
      if (seen.has(entry.message.id)) continue;
      seen.add(entry.message.id);
      totals.apiCalls += 1;
      totals.input += usage.input_tokens ?? 0;
      totals.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      totals.cacheRead += usage.cache_read_input_tokens ?? 0;
      totals.output += usage.output_tokens ?? 0;
      if (entry.message.model) totals.models.add(entry.message.model);
    }
  }
  return { ...totals, models: [...totals.models] };
}

switch (command) {
  case 'tools':
    for (const name of names)
      for (const file of transcripts(name).slice(-Number(values.last))) printTools(file);
    break;
  case 'usage': {
    const all = names.length
      ? names
      : readdirSync(projects)
          .filter((dir) => dir.startsWith(`${WORK_PREFIX}-`))
          .map((dir) => dir.slice(WORK_PREFIX.length + 1));
    for (const name of all) console.log(name, JSON.stringify(usageFor(name)));
    break;
  }
  default:
    console.error('usage: transcript.mjs tools <name> [--last n] | usage [name ...]');
    process.exit(2);
}
