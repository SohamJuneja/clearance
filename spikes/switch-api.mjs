// Spike helper: small REST clients for the Switch Gateway and Mattermost.
// Secrets come from Switch's .env and are never printed. Node 22, no dependencies.
import { readFileSync } from 'node:fs';

export const SWITCH_ENV_FILE =
  process.env.SWITCH_ENV_FILE ?? '/home/prashant/projects/Clearance/vendor/switch/.env';
export const GATEWAY = process.env.SWITCH_GATEWAY_URL ?? 'http://127.0.0.1:3000';
export const BRIDGE = process.env.SWITCH_BRIDGE_URL ?? 'http://127.0.0.1:8000';
export const MATTERMOST = process.env.MATTERMOST_URL ?? 'http://127.0.0.1:8065';

export function readEnvFile(path) {
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    env[line.slice(0, eq).trim()] = value;
  }
  return env;
}

export const switchEnv = () => readEnvFile(SWITCH_ENV_FILE);

async function asJson(res, what) {
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 800);
    throw new Error(`${what} -> ${res.status}: ${detail}`);
  }
  return body;
}

export class Gateway {
  constructor(base = GATEWAY) {
    this.base = base;
    this.cookie = '';
  }
  async login(env = switchEnv()) {
    const res = await fetch(`${this.base}/gateway/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: env.GATEWAY_ADMIN_EMAIL, password: env.GATEWAY_ADMIN_PASSWORD }),
    });
    const body = await asJson(res, 'gateway login');
    this.cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    if (!this.cookie) throw new Error('gateway login returned no session cookie');
    return body;
  }
  async call(method, path, body) {
    const res = await fetch(`${this.base}/gateway${path}`, {
      method,
      headers: {
        cookie: this.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return asJson(res, `gateway ${method} ${path}`);
  }
  get(path) {
    return this.call('GET', path);
  }
  post(path, body = {}) {
    return this.call('POST', path, body);
  }
  patch(path, body) {
    return this.call('PATCH', path, body);
  }
  put(path, body) {
    return this.call('PUT', path, body);
  }
  delete(path) {
    return this.call('DELETE', path);
  }
}

export class Mattermost {
  constructor(base = MATTERMOST) {
    this.base = base;
    this.token = '';
    this.me = null;
  }
  async login(env = switchEnv()) {
    const res = await fetch(`${this.base}/api/v4/users/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login_id: env.MATTERMOST_USER, password: env.MATTERMOST_USER_PASSWORD }),
    });
    this.me = await asJson(res, 'mattermost login');
    this.token = res.headers.get('token');
    return this.me;
  }
  async call(method, path, body) {
    const res = await fetch(`${this.base}/api/v4${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return asJson(res, `mattermost ${method} ${path}`);
  }
  post(channelId, message, rootId) {
    return this.call('POST', '/posts', { channel_id: channelId, message, ...(rootId ? { root_id: rootId } : {}) });
  }
  async postsSince(channelId, since) {
    const out = await this.call('GET', `/channels/${channelId}/posts?since=${since}`);
    return out.order.map((id) => out.posts[id]).sort((a, b) => a.create_at - b.create_at);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
