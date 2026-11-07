// Spike helper: read data/spike-logs/hook-calls.jsonl.
//
//   node spikes/hook-log.mjs summary [--since ISO]
//   node spikes/hook-log.mjs raw <index>            # one record, scrubbed
//   node spikes/hook-log.mjs fixture <index> <file> # write a scrubbed payload to a fixture
//
// Scrubbing replaces the home directory, the user name and the session and
// transcript ids so a fixture carries the real shape and nothing personal.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { parseArgs } from 'node:util';

const LOG = '/home/you/projects/Clearance/data/spike-logs/hook-calls.jsonl';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { since: { type: 'string' } },
});
const [command, ...args] = positionals;
const records = readFileSync(LOG, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

function scrub(value) {
  let text = JSON.stringify(value);
  const home = homedir();
  text = text.split(home).join('/home/agent-user');
  text = text.split(home.replaceAll('/', '-')).join('-home-agent-user');
  const user = userInfo().username;
  text = text.replaceAll(new RegExp(`\\b${user}\\b`, 'g'), 'agent-user');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <scrubbed>');
  text = text.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
    '00000000-0000-4000-8000-000000000000'
  );
  return JSON.parse(text);
}

switch (command) {
  case 'summary':
    records.forEach((r, i) => {
      if (values.since && r.at < values.since) return;
      const b = r.body ?? {};
      console.log(
        [
          i,
          r.at,
          r.path,
          b.hook_event_name,
          b.tool_name,
          `mode=${b.permission_mode}`,
          `model=${b.model ?? '-'}`,
          `auth=${JSON.stringify(r.authorization)}`,
          `ans=${r.answered.answer?.hookSpecificOutput?.permissionDecision ?? r.answered.status}`,
          String(b.tool_input?.command ?? '').slice(0, 70),
        ].join(' | ')
      );
    });
    break;
  case 'raw':
    console.log(JSON.stringify(scrub(records[Number(args[0])]), null, 2));
    break;
  case 'fixture':
    writeFileSync(args[1], `${JSON.stringify(scrub(records[Number(args[0])].body), null, 2)}\n`);
    console.log(`wrote ${args[1]}`);
    break;
  default:
    console.error('usage: hook-log.mjs summary|raw <i>|fixture <i> <file>');
    process.exit(2);
}
