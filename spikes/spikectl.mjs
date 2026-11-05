// Spike driver: throwaway managed agents, rooms and Mattermost messages over REST.
//
//   node spikes/spikectl.mjs status
//   node spikes/spikectl.mjs agent-create <name> <directory> [--provider claude] [--model haiku]
//        [--instructions-file f] [--auto-mode true|false]
//   node spikes/spikectl.mjs room-create <room-name> <agent-name>
//   node spikes/spikectl.mjs say <room-name> <text> [--wait 180] [--quiet 25]
//   node spikes/spikectl.mjs agent-restart <agent-name>
//   node spikes/spikectl.mjs agent-delete <agent-name>
//   node spikes/spikectl.mjs room-delete <room-name>
//   node spikes/spikectl.mjs channel-log <room-name> [--since-ms N]
//   node spikes/spikectl.mjs purge-throwaways   # remove agent rows named spike-* and clearance-s9
//
// No secrets are printed. `say` posts as Mattermost `user` and prints every post
// that follows until the channel has been quiet for --quiet seconds.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Gateway, Mattermost, sleep } from './switch-api.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: 'string', default: 'claude' },
    model: { type: 'string' },
    'instructions-file': { type: 'string' },
    'auto-mode': { type: 'string', default: 'true' },
    wait: { type: 'string', default: '240' },
    quiet: { type: 'string', default: '30' },
    'since-ms': { type: 'string' },
    'no-mention': { type: 'boolean', default: false },
  },
});
const [command, ...args] = positionals;

const g = new Gateway();
await g.login();

async function controllerId() {
  const controllers = await g.get('/management/controllers');
  const live = controllers.filter((c) => !c.revoked_at);
  if (live.length === 0) throw new Error('no enrolled controller');
  return live[0].id;
}

async function agentByName(name) {
  const agents = await g.get('/management/agents');
  const agent = agents.find((a) => a.name === name);
  if (!agent) throw new Error(`no managed agent named ${name}`);
  return agent;
}

async function roomByName(name) {
  const rooms = await g.get('/rooms');
  const room = rooms.find((r) => r.name === name);
  if (!room) throw new Error(`no room named ${name}`);
  return g.get(`/rooms/${room.id}`);
}

async function mattermost() {
  const m = new Mattermost();
  await m.login();
  return m;
}

switch (command) {
  case 'status': {
    const controllers = await g.get('/management/controllers');
    console.log(
      JSON.stringify(
        controllers.map((c) => ({ id: c.id, name: c.name, connected: c.connected, online: c.online, workspaces_dir: c.status?.machine?.workspaces_dir, sessions_running: c.status?.machine?.sessions_running, agents: c.status?.agents, providers: c.status?.providers?.map((p) => `${p.provider}:${p.auth}:${p.version}`) })),
        null,
        1
      )
    );
    const agents = await g.get('/management/agents');
    console.log(
      JSON.stringify(
        agents.map((a) => ({
          id: a.id,
          name: a.name,
          desired: a.desired_state,
          status: a.status ?? a.observed,
          dir: a.definition?.directory,
          model: a.definition?.model,
        })),
        null,
        1
      )
    );
    const rooms = await g.get('/rooms');
    console.log(JSON.stringify(rooms.map((r) => ({ id: r.id, name: r.name })), null, 1));
    break;
  }
  case 'agent-create': {
    const [name, directory] = args;
    const definition = {
      provider: values.provider,
      ...(values.model ? { model: values.model } : {}),
      instructions: values['instructions-file'] ? readFileSync(values['instructions-file'], 'utf8') : '',
      auto_mode: values['auto-mode'] === 'true',
      auto_approve: false,
      ...(directory ? { directory } : {}),
      isolation: 'shared',
    };
    const created = await g.post('/management/agents', {
      name,
      description: `Clearance throwaway spike agent ${name}`,
      controller_id: await controllerId(),
      desired_state: 'running',
      definition,
    });
    console.log(JSON.stringify({ id: created.id, name: created.name, definition: created.definition }, null, 1));
    break;
  }
  case 'room-create': {
    const [roomName, agentName] = args;
    const agent = await agentByName(agentName);
    const me = await (await mattermost()).me.username;
    const room = await g.post('/rooms', {
      name: roomName,
      description: 'Clearance throwaway spike room',
      agent_ids: [agent.agent_id ?? agent.id],
      user_names: [me],
    });
    console.log(
      JSON.stringify(
        {
          id: room.id,
          name: room.name,
          external_channel_id: room.external_channel_id,
          bridge: room.bridge_id ?? room.bridge,
        },
        null,
        1
      )
    );
    break;
  }
  case 'say': {
    const [roomName, text] = args;
    const room = await roomByName(roomName);
    if (!room.external_channel_id) throw new Error(`room ${roomName} has no Mattermost channel`);
    const m = await mattermost();
    const since = Date.now() - 1;
    const posted = await m.post(room.external_channel_id, text);
    console.log(`[user] ${text}`);
    const deadline = Date.now() + Number(values.wait) * 1000;
    const quietMs = Number(values.quiet) * 1000;
    const seen = new Set([posted.id]);
    let last = Date.now();
    let replies = 0;
    const printed = new Map();
    while (Date.now() < deadline) {
      await sleep(3000);
      const posts = await m.postsSince(room.external_channel_id, since);
      for (const p of posts) {
        if (p.delete_at) continue;
        const already = printed.get(p.id);
        if (already === p.update_at) continue;
        printed.set(p.id, p.update_at);
        seen.add(p.id);
        last = Date.now();
        if (p.id === posted.id) continue;
        if (p.user_id !== m.me.id) replies += 1;
        const attachments = p.props?.attachments
          ? ` [attachments: ${JSON.stringify(p.props.attachments).slice(0, 400)}]`
          : '';
        console.log(`[${p.user_id === m.me.id ? 'user' : p.props?.override_username ?? 'bot:' + p.user_id.slice(0, 6)}${already ? ' edit' : ''}] ${p.message}${attachments}`);
      }
      if (replies > 0 && Date.now() - last > quietMs) break;
    }
    console.log(replies > 0 ? `-- ${replies} post updates` : '-- NO REPLY before the deadline');
    break;
  }
  case 'channel-log': {
    const [roomName] = args;
    const room = await roomByName(roomName);
    const m = await mattermost();
    const posts = await m.postsSince(room.external_channel_id, Number(values['since-ms'] ?? 0));
    for (const p of posts) {
      if (p.delete_at) continue;
      console.log(`${new Date(p.create_at).toISOString()} [${p.user_id === m.me.id ? 'user' : p.user_id.slice(0, 6)}] ${p.message}`);
    }
    break;
  }
  case 'agent-restart': {
    const agent = await agentByName(args[0]);
    console.log(JSON.stringify(await g.post('/management/operations', { controller_id: agent.controller_id, agent_id: agent.agent_id ?? agent.id, kind: 'agent.restart' })));
    break;
  }
  case 'agent-delete': {
    const agent = await agentByName(args[0]);
    console.log(JSON.stringify(await g.delete(`/management/agents/${agent.agent_id ?? agent.id}`)));
    break;
  }
  case 'room-delete': {
    const room = await roomByName(args[0]);
    console.log(JSON.stringify(await g.post('/rooms/bulk-delete', { room_ids: [room.id] })));
    break;
  }
  case 'purge-throwaways': {
    // Deleting a managed agent leaves its agent row behind. Only spike names are touched.
    const listed = await g.get('/agents');
    const throwaway = (listed.agents ?? listed).filter(
      (a) => a.name.startsWith('spike-') || a.name === 'clearance-s9'
    );
    for (const agent of throwaway) {
      await g.delete(`/agents/${agent.id ?? agent.agent_id}`);
      console.log(`deleted ${agent.name}`);
    }
    const left = await g.get('/agents');
    console.log(`left: ${(left.agents ?? left).map((a) => a.name).join(',')}`);
    break;
  }
  default:
    console.error('unknown command; see the header of this file');
    process.exit(2);
}
