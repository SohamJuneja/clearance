// Spike helper: which environment variable NAMES do a Switch-launched agent's tool
// subprocesses get? Watches the descendants of the provider process whose argv
// contains <pattern>, prints names only, never values.
//
//   node spikes/child-env.mjs <argv-pattern> <VAR_NAME> [--seconds 40]
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

const [pattern, wanted, flag, secondsText] = process.argv.slice(2);
const seconds = flag === '--seconds' ? Number(secondsText) : 40;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function table() {
  const procs = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
      procs.set(Number(entry), { ppid, argv });
    } catch {
      // Gone already.
    }
  }
  return procs;
}

function descendants(procs, root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const parent = stack.pop();
    for (const [pid, proc] of procs)
      if (proc.ppid === parent) {
        out.push(pid);
        stack.push(pid);
      }
  }
  return out;
}

const deadline = Date.now() + seconds * 1000;
const printed = new Set();
while (Date.now() < deadline) {
  const procs = table();
  const roots = [...procs].filter(
    ([pid, proc]) => pid !== process.pid && proc.argv.includes(pattern) && proc.argv.includes('--output-format')
  );
  for (const [root] of roots) {
    for (const pid of descendants(procs, root)) {
      if (printed.has(pid)) continue;
      let names;
      let exe = '';
      try {
        names = readFileSync(`/proc/${pid}/environ`, 'utf8')
          .split('\0')
          .filter(Boolean)
          .map((kv) => kv.slice(0, kv.indexOf('=')));
        exe = readlinkSync(`/proc/${pid}/exe`);
      } catch {
        continue;
      }
      printed.add(pid);
      console.log(
        `child of ${root}: pid ${pid} exe ${exe} env=${names.length} ${wanted}=${names.includes(wanted) ? 'PRESENT' : 'absent'} argv=${procs.get(pid).argv.slice(0, 60)}`
      );
      if (printed.size === 1) console.log(`  names: ${names.sort().join(' ')}`);
    }
  }
  await sleep(500);
}
console.log(printed.size ? `saw ${printed.size} descendants` : 'saw no descendants');
