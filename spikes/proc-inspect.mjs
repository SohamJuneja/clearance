// Spike helper: how did Switch launch a provider CLI? Prints argv with bearer
// tokens masked, and environment variable NAMES only (never values), for every
// live process whose argv mentions --agent <name> (or the given pattern).
//
//   node spikes/proc-inspect.mjs <pattern> [--show VAR_NAME ...]
//
// --show prints whether a named variable is present and its length, not its value.
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

const [pattern, ...rest] = process.argv.slice(2);
if (!pattern) {
  console.error('usage: proc-inspect.mjs <pattern> [--show NAME ...]');
  process.exit(2);
}
const show = rest.filter((arg) => arg !== '--show');
const re = new RegExp(pattern);

const mask = (text) =>
  text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1***')
    .replace(/(swlr_|sk-ant-|sk-)[A-Za-z0-9._-]+/g, '$1***');

for (const entry of readdirSync('/proc')) {
  if (!/^\d+$/.test(entry)) continue;
  let argv;
  try {
    argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    continue;
  }
  if (Number(entry) === process.pid || !re.test(argv.join(' '))) continue;
  let environ = [];
  try {
    environ = readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').filter(Boolean);
  } catch {
    // Not ours to read.
  }
  const names = environ.map((kv) => kv.slice(0, kv.indexOf('='))).sort();
  let exe = '';
  try {
    exe = readlinkSync(`/proc/${entry}/exe`);
  } catch {
    // Gone already.
  }
  console.log(`pid ${entry} exe ${exe}`);
  console.log(`argv: ${mask(argv.join(' ')).slice(0, 3000)}`);
  console.log(`env names (${names.length}): ${names.join(' ')}`);
  for (const name of show) {
    const hit = environ.find((kv) => kv.startsWith(`${name}=`));
    console.log(`  ${name}: ${hit ? `present, length ${hit.length - name.length - 1}` : 'ABSENT'}`);
  }
}
