// Spike: which layer really removes claude.ai connectors from a Switch-managed Claude session?
// Reads the session's own init message, through spikes/claude-init-tee on a probe controller's PATH.
// The prompt is one harmless word and no connector tool is ever called.
//
//   node spikes/connector-probe.mjs start login|isolated|isolated-envkey
//   node spikes/connector-probe.mjs layer <control|env|deny|disable|both|local|isolated> [--prompt text]
//   node spikes/connector-probe.mjs read <workdir-name>
//   node spikes/connector-probe.mjs stop     # stop and revoke every probe controller
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Gateway, Mattermost, sleep } from './switch-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(homedir(), '.local/share/clearance-tools');
const WORK = join(TOOLS, 'spike-work');
const CLI = join(TOOLS, 'controller-src/console/packages/agent-controller/dist/cli.mjs');
const LOGS = '/home/you/projects/Clearance/data/spike-logs';
const INIT_LOG = join(LOGS, 'claude-init.jsonl');
const AGENT_HOME = join(TOOLS, 'agent-home-probe');
const NODE_BIN = dirname(process.execPath);
const REAL_HOME = homedir();
const DUMMY_KEY = 'dummy-not-a-real-key-for-the-local-stub';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { prompt: { type: 'string', default: 'reply with the single word OK' } },
});
const [command, arg] = positionals;

const LAYERS = {
  control: { machine: 'probe-login', settings: {} },
  env: { machine: 'probe-login', settings: { env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } } },
  deny: { machine: 'probe-login', settings: { permissions: { deny: ['mcp__claude_ai_*'] } } },
  disable: { machine: 'probe-login', settings: { disableClaudeAiConnectors: true } },
  both: { machine: 'probe-login', settings: { disableClaudeAiConnectors: true, permissions: { deny: ['mcp__claude_ai_*'] } } },
  isolated: { machine: 'probe-isolated', settings: {} },
  // What scripts/setup-agents.ts writes: the same layers, from the gitignored local settings.
  local: {
    machine: 'probe-login',
    file: '.claude/settings.local.json',
    settings: {
      disableClaudeAiConnectors: true,
      permissions: { deny: ['mcp__claude_ai_*'] },
      enabledPlugins: { 'andrej-karpathy-skills@karpathy-skills': false, 'superpowers@claude-plugins-official': false, 'band-peer@jam': false },
    },
  },
};

const g = new Gateway();
await g.login();

const dataDir = (machine) => join(TOOLS, `controller-data-${machine}`);
const pidFile = (machine) => join(LOGS, `${machine}.pid`);

async function enroll(machine) {
  if (existsSync(join(dataDir(machine), 'controller.db'))) return;
  const { code } = await g.post('/management/enrollment-codes');
  execFileSync(
    process.execPath,
    [CLI, 'enroll', '--server', 'http://127.0.0.1:8000', '--code', code, '--name', machine, '--data-dir', dataDir(machine), '--secret-store', 'file'],
    { stdio: 'ignore' }
  );
}

function startDetached(machine, env, envFileBody) {
  const envFile = join(LOGS, `${machine}.env`);
  writeFileSync(envFile, envFileBody, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  const log = openSync(join(LOGS, `${machine}.log`), 'a');
  const child = spawn(process.execPath, [CLI, 'run', '--data-dir', dataDir(machine), '--env-file', envFile], {
    detached: true,
    stdio: ['ignore', log, log],
    env,
  });
  child.unref();
  writeFileSync(pidFile(machine), String(child.pid));
  console.log(`${machine} started, pid ${child.pid}`);
}

const probePath = (extra = []) =>
  [join(HERE, 'claude-init-tee'), ...extra, NODE_BIN, join(REAL_HOME, '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':');

function scanTranscripts(home, workdirName) {
  const prefix = join(WORK, workdirName).replaceAll(/[/.]/g, '-');
  const dir = join(home, '.claude/projects', prefix);
  if (!existsSync(dir)) return { transcript: 'none' };
  const names = new Map();
  for (const file of execFileSync('ls', [dir]).toString().split('\n').filter((f) => f.endsWith('.jsonl'))) {
    for (const match of readFileSync(join(dir, file), 'utf8').matchAll(/mcp__([A-Za-z0-9_-]+?)__[A-Za-z0-9_-]+/g))
      names.set(match[1], (names.get(match[1]) ?? 0) + 1);
  }
  return { transcript_mcp_mentions: Object.fromEntries(names) };
}

function readInit(cwd) {
  if (!existsSync(INIT_LOG)) return null;
  const lines = readFileSync(INIT_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((m) => m && m.subtype === 'init' && m.cwd === cwd);
  return lines.at(-1) ?? null;
}

function summarize(init) {
  if (!init) return { init: 'NOT SEEN' };
  const tools = init.tools ?? [];
  const connector = tools.filter((t) => t.startsWith('mcp__claude_ai_'));
  const servers = init.mcp_servers ?? [];
  return {
    claude_code_version: init.claude_code_version,
    model: init.model,
    permissionMode: init.permissionMode,
    apiKeySource: init.apiKeySource,
    tools_total: tools.length,
    tools_mcp_claude_ai: connector.length,
    connector_examples: connector.slice(0, 3),
    tools_mcp_other: [...new Set(tools.filter((t) => t.startsWith('mcp__') && !t.startsWith('mcp__claude_ai_')).map((t) => t.split('__')[1]))],
    mcp_servers: servers.map((s) => `${s.name}:${s.status}`),
    plugins: (init.plugins ?? []).map((p) => p.name),
    skills_count: (init.skills ?? []).length,
  };
}

switch (command) {
  case 'start': {
    if (arg === 'login') {
      await enroll('probe-login');
      startDetached(
        'probe-login',
        { HOME: REAL_HOME, USER: process.env.USER ?? 'prashant', SHELL: '/bin/bash', LANG: 'C.UTF-8', PATH: probePath() },
        `PATH=${probePath()}\nSWITCH_CONTROLLER_SELF_UPDATE=off\n`
      );
    } else {
      // An isolated HOME: no login, no user settings, no plugins. A dummy key and a local stub stand in
      // for the API key that does not exist yet. "isolated" uses apiKeyHelper, "isolated-envkey" the env file.
      await enroll('probe-isolated');
      rmSync(AGENT_HOME, { recursive: true, force: true });
      mkdirSync(join(AGENT_HOME, '.claude'), { recursive: true, mode: 0o700 });
      const helper = arg === 'isolated';
      if (helper) {
        const keyFile = join(AGENT_HOME, '.claude/api-key');
        writeFileSync(keyFile, `${DUMMY_KEY}\n`, { mode: 0o600 });
        writeFileSync(
          join(AGENT_HOME, '.claude/settings.json'),
          `${JSON.stringify({ apiKeyHelper: `cat ${keyFile}` }, null, 2)}\n`
        );
      }
      const body = [
        `PATH=${probePath()}`,
        'SWITCH_CONTROLLER_SELF_UPDATE=off',
        'ANTHROPIC_BASE_URL=http://127.0.0.1:7793',
        ...(helper ? [] : [`ANTHROPIC_API_KEY=${DUMMY_KEY}`]),
        '',
      ].join('\n');
      startDetached(
        'probe-isolated',
        { HOME: AGENT_HOME, USER: process.env.USER ?? 'prashant', SHELL: '/bin/bash', LANG: 'C.UTF-8', PATH: probePath() },
        body
      );
    }
    break;
  }
  case 'layer': {
    const layer = LAYERS[arg];
    if (!layer) throw new Error(`unknown layer ${arg}`);
    const name = `spike-conn-${arg}`;
    const workdir = `conn-${arg}`;
    const dir = execFileSync('bash', [join(HERE, 'make-workdir.sh'), workdir]).toString().trim();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, layer.file ?? '.claude/settings.json'), `${JSON.stringify(layer.settings, null, 2)}\n`);
    const controllers = await g.get('/management/controllers');
    const controller = controllers.find((c) => c.name === layer.machine && !c.revoked_at);
    if (!controller) throw new Error(`no controller ${layer.machine}; run start first`);
    const created = await g.post('/management/agents', {
      name,
      description: 'Clearance throwaway connector probe',
      controller_id: controller.id,
      desired_state: 'running',
      definition: { provider: 'claude', model: 'haiku', instructions: '', auto_mode: true, auto_approve: false, directory: dir, isolation: 'shared' },
    });
    const id = created.agent_id ?? created.id;
    await sleep(6000);
    const m = new Mattermost();
    await m.login();
    const room = await g.post('/rooms', { name: `spike-conn-${arg}-room`, description: 'throwaway', agent_ids: [id], user_names: [m.me.username] });
    const since = Date.now() - 1;
    await m.post(room.external_channel_id, `@${name} ${values.prompt}`);
    let init = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !init) {
      await sleep(2000);
      init = readInit(dir);
    }
    // Connectors can arrive after init, so leave time for the turn to finish before reading the transcript.
    await sleep(20_000);
    const posts = (await m.postsSince(room.external_channel_id, since)).filter((p) => p.user_id !== m.me.id && !p.delete_at);
    const home = layer.machine === 'probe-isolated' ? AGENT_HOME : REAL_HOME;
    console.log(
      JSON.stringify(
        { layer: arg, settings: layer.settings, ...summarize(init), ...scanTranscripts(home, workdir), replies: posts.map((p) => p.message.slice(0, 120)).filter((t) => !/^\*\*Work|Starting a session|added to the channel/.test(t)) },
        null,
        1
      )
    );
    await g.post('/rooms/bulk-delete', { room_ids: [room.id] });
    await g.delete(`/management/agents/${id}`);
    await g.delete(`/agents/${id}`).catch(() => {});
    break;
  }
  case 'read':
    console.log(JSON.stringify(summarize(readInit(join(WORK, arg))), null, 1));
    break;
  case 'stop': {
    for (const machine of ['probe-login', 'probe-isolated']) {
      if (existsSync(pidFile(machine))) {
        try {
          process.kill(Number(readFileSync(pidFile(machine), 'utf8')), 'SIGTERM');
        } catch {
          // Already gone.
        }
        rmSync(pidFile(machine), { force: true });
      }
    }
    await sleep(2000);
    const controllers = await g.get('/management/controllers');
    for (const c of controllers.filter((c) => c.name.startsWith('probe-') && !c.revoked_at)) {
      console.log(c.name, JSON.stringify(await g.delete(`/management/controllers/${c.id}`)));
    }
    for (const machine of ['probe-login', 'probe-isolated']) rmSync(dataDir(machine), { recursive: true, force: true });
    break;
  }
  default:
    console.error('see the header of this file');
    process.exit(2);
}
