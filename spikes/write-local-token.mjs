// Spike T1: write <dir>/.claude/settings.local.json with an `env` block holding
// CLEARANCE_HOOK_TOKEN (from the repo's .env), mode 600. Never prints the token.
//
//   node spikes/write-local-token.mjs <dir>
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEnvFile } from './switch-api.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: write-local-token.mjs <dir>');
  process.exit(2);
}
const token = readEnvFile('/home/prashant/projects/Clearance/.env').CLEARANCE_HOOK_TOKEN;
if (!token) throw new Error('CLEARANCE_HOOK_TOKEN is empty');
mkdirSync(join(dir, '.claude'), { recursive: true });
const file = join(dir, '.claude', 'settings.local.json');
writeFileSync(file, `${JSON.stringify({ env: { CLEARANCE_HOOK_TOKEN: token } }, null, 2)}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`wrote ${file} (mode 600), token length ${token.length}`);
