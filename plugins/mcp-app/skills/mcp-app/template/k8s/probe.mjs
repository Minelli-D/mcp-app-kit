// Plays a browser and an MCP client against the PUBLIC addresses of the app, with the real
// login. It reads pages only, writes nothing, and prints no secret: the email and the
// password are read from the Kubernetes Secret inside this program and are never shown,
// never put on a command line.
//
//   node k8s/probe.mjs
//
// It answers three questions:
//   1. Does the login of the web app work, and is the app behind it?
//   2. What does the MCP address answer to a client that asks in the newest protocol version
//      first (as ChatGPT does)?
//   3. Does the older handshake (initialize, tools/list) work?

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// settings.env, read line by line (the same rule as k8s/lib.sh: it is never run).
function settings() {
  const found = {};
  for (const line of readFileSync(`${ROOT}settings.env`, 'utf8').split('\n')) {
    const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.replace(/\r$/, ''));
    if (!match || line.trim().startsWith('#')) continue;
    found[match[1]] = match[2].trim().replace(/^"(.*)"$|^'(.*)'$/, '$1$2');
  }
  return found;
}

const set = settings();
for (const name of ['APP_NAME', 'APP_HOST', 'K8S_CONTEXT', 'K8S_NAMESPACE']) {
  if (!set[name]) {
    console.error(`probe: ${name} is not in settings.env`);
    process.exit(2);
  }
}
const APP = `https://${set.APP_HOST}`;
const MCP = `https://${set.MCP_HOST || set.APP_HOST}`;

let secret;
try {
  secret = JSON.parse(execFileSync('kubectl', ['--context', set.K8S_CONTEXT, '-n', set.K8S_NAMESPACE, 'get', 'secret', set.APP_NAME, '-o', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
} catch {
  console.error(`probe: the Secret ${set.APP_NAME} cannot be read (context ${set.K8S_CONTEXT}, namespace ${set.K8S_NAMESPACE}).`);
  process.exit(2);
}
const value = (key) => Buffer.from(secret.data[key], 'base64').toString('utf8');

let problems = 0;
function say(good, text) {
  if (!good) problems += 1;
  console.log(`${good ? 'ok     ' : 'PROBLEM'} ${text}`);
}
const short = (text) => String(text).replace(/\s+/g, ' ').slice(0, 200);

// ---- 1. the login of the web app ----------------------------------------------------

const started = Date.now();
const login = await fetch(`${APP}/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: APP, 'Sec-Fetch-Site': 'same-origin' },
  body: new URLSearchParams({ email: value('LOGIN_EMAIL'), password: value('LOGIN_PASSWORD'), next: '/' }).toString(),
}).catch((error) => ({ status: 0, headers: new Headers(), error }));
const pairs = (login.headers.getSetCookie?.() ?? []).map((line) => line.split(';')[0]);
const access = pairs.find((pair) => /session-access=/.test(pair));
say(login.status === 303 && Boolean(access), `the login of the web app: ${login.status}${login.status === 303 ? ` in ${Date.now() - started} ms` : ''}`
  + (login.status === 429 ? ' (too many tries from this address: wait ten minutes)' : ''));
if (!access) {
  console.log('The rest needs a login, so the probe stops here. Look at: bash k8s/doctor.sh');
  process.exit(1);
}
const Cookie = pairs.join('; ');
const token = access.slice(access.indexOf('=') + 1);

const home = await fetch(`${APP}/`, { headers: { Cookie }, redirect: 'manual' });
say(home.status === 200, `the app behind the login: ${home.status}`);
// A form as Chrome sends it (it posts to a page that does not exist, so nothing can change).
const form = await fetch(`${APP}/probe-of-the-kit-no-such-page`, {
  method: 'POST', redirect: 'manual',
  headers: { Cookie, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }, body: 'a=b',
});
say(form.status !== 403 && form.status !== 401, `a form as Chrome sends it gets through the gateway: ${form.status} (403 would mean: refused as "another site")`);

// ---- 2. an MCP client that asks in the newest version first ---------------------------

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const call = async (body, more = {}) => {
  const answer = await fetch(`${MCP}/mcp`, { method: 'POST', headers: { ...headers, ...more }, body: JSON.stringify(body) });
  return { status: answer.status, text: await answer.text() };
};
// The answer of the bridge is one JSON-RPC message, plain or inside an event stream.
const message = (text) => {
  const line = text.split('\n').find((one) => one.startsWith('data: '));
  try { return JSON.parse(line ? line.slice(6) : text); } catch { return null; }
};

const closed = await fetch(`${MCP}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
say(closed.status === 401 && /resource_metadata=/.test(closed.headers.get('www-authenticate') ?? ''),
  `without a token the MCP address answers ${closed.status} and says where the login server is`);

const newest = await call(
  { jsonrpc: '2.0', id: 'probe-discover', method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'probe', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } },
  { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' },
);
const fallback = newest.status === 400 && /Unsupported protocol version/.test(newest.text);
say(fallback || newest.status === 200, `a first request in version 2026-07-28: ${newest.status}  ${short(newest.text)}`);
if (fallback) console.log('        (this is the answer of an older MCP server: the client goes on with "initialize")');

// ---- 3. the older handshake -------------------------------------------------------------

const versions = (set.MCP_VERSIONS || '2025-11-25').split(',').map((one) => one.trim()).filter(Boolean);
const version = versions[0];
const started2 = await call({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
const server = message(started2.text)?.result;
say(started2.status === 200 && Boolean(server), `initialize (${version}): ${started2.status}${server ? `, server "${server.serverInfo?.name}", version ${server.protocolVersion}` : `  ${short(started2.text)}`}`);
const noted = await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'MCP-Protocol-Version': version });
say(noted.status === 202 || noted.status === 200, `the "initialized" notice: ${noted.status}`);
const listed = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { 'MCP-Protocol-Version': version });
const tools = message(listed.text)?.result?.tools ?? [];
say(listed.status === 200 && tools.length > 0, `tools/list: ${listed.status}, ${tools.length} tool(s)${tools.length ? `: ${tools.slice(0, 6).map((tool) => tool.name).join(', ')}${tools.length > 6 ? ', ...' : ''}` : `  ${short(listed.text)}`}`);

// ---- the end: this session is closed again ----------------------------------------------

const out = await fetch(`${APP}/logout`, { method: 'POST', redirect: 'manual', headers: { Origin: APP, 'Sec-Fetch-Site': 'same-origin', Cookie } });
say(out.status === 303, `logout: ${out.status}`);
console.log(problems === 0 ? '\nEverything answered as it should.' : `\n${problems} problem(s). See the doctor playbook for what each one means.`);
process.exit(problems === 0 ? 0 : 1);
