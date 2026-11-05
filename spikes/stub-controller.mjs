// Spike S5, Codex under Switch without a login: a second, throwaway controller whose
// env file sets CODEX_HOME to a scratch home that uses the stub model. Real Switch launch
// path (session home, `codex app-server`, auto mode), fake model. ~/.codex is untouched.
//
//   node spikes/stub-controller.mjs enroll     # enroll, write the scratch home and env file
//   node spikes/stub-controller.mjs agent      # seed hook trust, create agent and room
//   node spikes/stub-controller.mjs run-cmd    # print the command that runs it
//   node spikes/stub-controller.mjs cleanup    # delete agent and room, revoke the controller
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gateway, Mattermost } from './switch-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(homedir(), '.local/share/clearance-tools');
const WORK = join(TOOLS, 'spike-work');
const DATA = join(TOOLS, 'controller-data-stub');
const CLI = join(TOOLS, 'controller-src/console/packages/agent-controller/dist/cli.mjs');
const CODEX_HOME = join(WORK, 'codex-home-switch');
const DIR = join(WORK, 's5-codex-switch');
const ENV_FILE = '/home/prashant/projects/Clearance/data/controller-stub.env';
const MACHINE = 'clearance-stub-codex';
const AGENT = 'spike-codex';
const ROOM = 'spike-codex-room';
const PATH_VALUE = `${join(TOOLS, 'node_modules/.bin')}:${join(homedir(), '.local/bin')}:${join(homedir(), '.volta/bin')}:/usr/local/bin:/usr/bin:/bin`;

const g = new Gateway();
await g.login();
const command = process.argv[2];

if (command === 'enroll') {
  execFileSync('bash', [join(HERE, 'make-workdir.sh'), 's5-codex-switch']);
  mkdirSync(join(DIR, '.codex'), { recursive: true });
  writeFileSync(
    join(DIR, '.codex/hooks.json'),
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: `node ${join(HERE, 'vendor-hook.mjs')} codex`, timeout: 5 }] }],
          PermissionRequest: [{ hooks: [{ type: 'command', command: `node ${join(HERE, 'vendor-hook.mjs')} codex`, timeout: 5 }] }],
        },
      },
      null,
      2
    )}\n`
  );
  mkdirSync(CODEX_HOME, { recursive: true });
  writeFileSync(
    join(CODEX_HOME, 'config.toml'),
    [
      'model = "stub-model"',
      'model_provider = "stub"',
      '[model_providers.stub]',
      'name = "stub"',
      'base_url = "http://127.0.0.1:7792/v1"',
      'wire_api = "responses"',
      `[projects."${DIR}"]`,
      'trust_level = "trusted"',
      '',
    ].join('\n')
  );
  writeFileSync(ENV_FILE, `CODEX_HOME=${CODEX_HOME}\nPATH=${PATH_VALUE}\nSWITCH_CONTROLLER_SELF_UPDATE=off\n`, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  if (!existsSync(join(DATA, 'controller.db'))) {
    const { code } = await g.post('/management/enrollment-codes');
    execFileSync(
      'node',
      [CLI, 'enroll', '--server', 'http://127.0.0.1:8000', '--code', code, '--name', MACHINE, '--data-dir', DATA, '--secret-store', 'file'],
      { stdio: 'ignore' }
    );
  }
  console.log(`enrolled ${MACHINE}; data ${DATA}; env ${ENV_FILE}`);
} else if (command === 'run-cmd') {
  console.log(`node ${CLI} run --data-dir ${DATA} --env-file ${ENV_FILE}`);
} else if (command === 'agent') {
  console.log(execFileSync('node', [join(HERE, 'codex-hooks-trust.mjs'), CODEX_HOME, DIR, '--seed']).toString().split('\n').filter((l) => /seeded|trusted/.test(l)).map((l) => l.replace(/"sourcePath".*"trustStatus"/, '"trustStatus"').slice(0, 200)).join('\n'));
  const controllers = await g.get('/management/controllers');
  const stub = controllers.find((c) => c.name === MACHINE && !c.revoked_at);
  if (!stub) throw new Error('stub controller is not enrolled');
  console.log('stub controller providers', JSON.stringify(stub.status?.providers?.filter((p) => p.provider === 'codex')));
  const created = await g.post('/management/agents', {
    name: AGENT,
    description: 'Clearance throwaway: Codex hooks under Switch with a stub model',
    controller_id: stub.id,
    desired_state: 'running',
    definition: { provider: 'codex', model: 'stub-model', instructions: '', auto_mode: true, auto_approve: false, directory: DIR, isolation: 'shared' },
  });
  const m = new Mattermost();
  await m.login();
  const room = await g.post('/rooms', {
    name: ROOM,
    description: 'Clearance throwaway Codex stub room',
    agent_ids: [created.agent_id ?? created.id],
    user_names: [m.me.username],
  });
  console.log(JSON.stringify({ agent: created.name, room: room.name, channel: room.external_channel_id }));
} else if (command === 'cleanup') {
  const rooms = await g.get('/rooms');
  const room = rooms.find((r) => r.name === ROOM);
  if (room) console.log(JSON.stringify(await g.post('/rooms/bulk-delete', { room_ids: [room.id] })));
  const agents = await g.get('/management/agents');
  const agent = agents.find((a) => a.name === AGENT);
  if (agent) console.log(JSON.stringify(await g.delete(`/management/agents/${agent.agent_id ?? agent.id}`)));
  const controllers = await g.get('/management/controllers');
  const stub = controllers.find((c) => c.name === MACHINE && !c.revoked_at);
  if (stub) console.log(JSON.stringify(await g.delete(`/management/controllers/${stub.id}`)));
} else {
  console.error('usage: stub-controller.mjs enroll|agent|run-cmd|cleanup');
  process.exit(2);
}
