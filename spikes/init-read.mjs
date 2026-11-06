// Spike: what did a real agent's session actually get? Reads the newest init message for a working
// directory from the log spikes/claude-init-tee writes, when a controller has that on its PATH:
//
//   CLEARANCE_EXTRA_PATH=/home/prashant/projects/Clearance/spikes/claude-init-tee \
//     scripts/setup-controller.sh --owner priya --restart
//   node spikes/init-read.mjs <working-directory>
import { readFileSync } from 'node:fs';

const LOG = '/home/prashant/projects/Clearance/data/spike-logs/claude-init.jsonl';
const dir = process.argv[2];
const inits = readFileSync(LOG, 'utf8')
  .split('\n')
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  })
  .filter((m) => m.subtype === 'init' && m.cwd === dir);
const init = inits.at(-1);
if (!init) {
  console.log(JSON.stringify({ dir, init: 'NOT SEEN', sessions_seen: 0 }));
  process.exit(1);
}
const tools = init.tools ?? [];
console.log(
  JSON.stringify(
    {
      dir,
      sessions_seen: inits.length,
      claude_code_version: init.claude_code_version,
      model: init.model,
      permissionMode: init.permissionMode,
      apiKeySource: init.apiKeySource,
      tools_total: tools.length,
      tools_mcp_claude_ai: tools.filter((t) => t.startsWith('mcp__claude_ai_')).length,
      mcp_tool_servers: [...new Set(tools.filter((t) => t.startsWith('mcp__')).map((t) => t.split('__')[1]))],
      mcp_servers: (init.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`),
      plugins: (init.plugins ?? []).map((p) => p.name),
    },
    null,
    1
  )
);
