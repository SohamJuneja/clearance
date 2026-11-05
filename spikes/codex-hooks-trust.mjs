// Spike S5, Codex: read hook trust from `codex app-server` (`hooks/list`), and with
// --seed record it in $CODEX_HOME/config.toml as [hooks.state."<key>"] trusted_hash,
// so hooks run without the interactive /hooks review.
//
//   node spikes/codex-hooks-trust.mjs <codex-home> <project-dir> [--seed]
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [codexHome, dir, flag] = process.argv.slice(2);
const seed = flag === '--seed';

function listHooks() {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], {
      cwd: dir,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('codex app-server did not answer hooks/list in time'));
    }, 20_000);
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'hooks/list', params: { cwds: [dir] } });
      }
      if (message.id === 2) {
        clearTimeout(timer);
        child.kill();
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result.data);
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'clearance_spike', title: 'Clearance spike', version: '0.0.1' } },
    });
  });
}

const show = (entries) => {
  for (const entry of entries) {
    for (const hook of entry.hooks)
      console.log(
        JSON.stringify({
          key: hook.key,
          event: hook.eventName,
          source: hook.source,
          sourcePath: hook.sourcePath,
          trustStatus: hook.trustStatus,
          enabled: hook.enabled,
          currentHash: hook.currentHash,
        })
      );
    if (entry.warnings?.length) console.log('warnings', JSON.stringify(entry.warnings));
    if (entry.errors?.length) console.log('errors', JSON.stringify(entry.errors));
    if (!entry.hooks.length) console.log(`no hooks seen for ${entry.cwd}`);
  }
};

const before = await listHooks();
show(before);
if (seed) {
  const untrusted = before.flatMap((entry) => entry.hooks).filter((hook) => hook.trustStatus !== 'trusted');
  const toml = untrusted
    .map((hook) => `\n[hooks.state."${hook.key}"]\ntrusted_hash = "${hook.currentHash}"\n`)
    .join('');
  appendFileSync(join(codexHome, 'config.toml'), toml);
  console.log(`seeded ${untrusted.length} hooks`);
  show(await listHooks());
}
