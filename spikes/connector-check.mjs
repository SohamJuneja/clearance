// Spike S6 side finding: which MCP servers does a session know about, per its transcript?
// Prints server names and counts only, from the newest transcript of a spike directory.
//
//   node spikes/connector-check.mjs <workdir-name>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const name = process.argv[2];
const prefix = join(homedir(), '.local/share/clearance-tools/spike-work').replaceAll(/[/.]/g, '-');
const dir = join(homedir(), '.claude', 'projects', `${prefix}-${name}`);
const newest = readdirSync(dir)
  .filter((file) => file.endsWith('.jsonl'))
  .map((file) => join(dir, file))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const text = readFileSync(newest, 'utf8');
const servers = new Map();
for (const match of text.matchAll(/mcp__([A-Za-z0-9_-]+?)__[A-Za-z0-9_-]+/g))
  servers.set(match[1], (servers.get(match[1]) ?? 0) + 1);
console.log(newest.split('/').pop());
console.log([...servers].map(([server, count]) => `${server}:${count}`).join(' ') || 'no mcp__ names');
