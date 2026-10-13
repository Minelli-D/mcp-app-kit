// Tests of the gateway (gateway/server.mjs). Run: node --test tests/test-gateway.mjs
// Supabase Auth, the bridge and the web app are small stand-ins that answer with
// what they received. The tokens are real ES256 tokens.

import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { createGateway, loadConfig } from '../gateway/server.mjs';

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

// A stand-in server: answers with a JSON description of the request it got.
function echoServer(special = () => false) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      seen.push(record);
      if (special(req, res, record)) return;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'a=b', 'Mcp-Session-Id': 'session-1', 'Mcp-Later-Header': 'kept', 'X-Inner': 'hidden' });
      res.end(JSON.stringify(record));
    });
  });
  return { server, seen };
}

const signing = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KID = 'key-1';
const publicJwk = { ...signing.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' };

const PASSWORD = 'the-right-password';
const BRIDGE_REFUSAL = '{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error: invalid JSON"},"id":null}';
const OWN_PAGE_POLICY =
  "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

let clock = Date.parse('2026-10-10T10:00:00Z');
let keyListCalls = 0;
let keyListBroken = false;
// What the stand-in login server does with /token and /logout. Null: it answers them like any other path.
let loginServer = null;
let auth;
let bridge;
let app;
let gateway;
let base;
let config;

function token(claims = {}, { key = signing.privateKey, header = {} } = {}) {
  const head = b64({ alg: 'ES256', kid: KID, typ: 'JWT', ...header });
  const body = b64({
    iss: `${config.publicUrl}/auth/v1`,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'me@example.test',
    is_anonymous: false,
    exp: Math.floor(clock / 1000) + 600,
    ...claims,
  });
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${signature.toString('base64url')}`;
}

// Makes the stand-in login server answer like Supabase Auth: one password for everybody, and
// refresh tokens that work once. Returns what it was asked and every token it gave out.
function useLoginServer({ access = (email) => token({ email }), waitMs = 0 } = {}) {
  const live = new Map();
  const told = { password: 0, refresh: 0, logout: [], tokens: [] };
  const pair = (email) => {
    const tokens = {
      access_token: access(email),
      refresh_token: `refresh-${randomBytes(9).toString('hex')}`,
      token_type: 'bearer',
      expires_in: 600,
    };
    live.set(tokens.refresh_token, email);
    told.tokens.push(tokens.access_token, tokens.refresh_token);
    return tokens;
  };
  loginServer = (req, res, record) => {
    const answer = (status, body) => {
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body ? JSON.stringify(body) : '');
      }, waitMs);
      return true;
    };
    let sent = {};
    try {
      sent = JSON.parse(record.body);
    } catch {
      // No JSON: nothing was sent.
    }
    if (req.url === '/token?grant_type=password') {
      told.password += 1;
      if (sent.password !== PASSWORD) return answer(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return answer(200, pair(sent.email));
    }
    if (req.url === '/token?grant_type=refresh_token') {
      told.refresh += 1;
      const email = live.get(sent.refresh_token);
      live.delete(sent.refresh_token);
      if (!email) return answer(400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      return answer(200, pair(email));
    }
    if (req.url.startsWith('/logout')) {
      told.logout.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      return answer(204);
    }
    return false;
  };
  return told;
}

// The cookies that an answer sets: name -> { value, text }. "text" is the whole Set-Cookie line.
function cookiesSet(response) {
  const found = new Map();
  for (const text of response.headers.getSetCookie()) {
    const pair = text.split(';')[0];
    found.set(pair.slice(0, pair.indexOf('=')), { value: pair.slice(pair.indexOf('=') + 1), text });
  }
  return found;
}

// The Cookie header a browser sends after that answer, with other cookies of its own.
function cookieHeader(response, ...others) {
  const kept = [...cookiesSet(response)].filter(([, cookie]) => cookie.value !== '').map(([name, cookie]) => `${name}=${cookie.value}`);
  return [...kept, ...others].join('; ');
}

function logIn(fields = {}, { from = base, headers = {} } = {}) {
  return fetch(`${from}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ email: 'me@example.test', password: PASSWORD, next: '/', ...fields }).toString(),
  });
}

// One more gateway, with other settings, for one test. It is closed when the test ends, also
// when the test fails: a server that stays open would keep the whole run from ending.
async function extraGateway(t, settings, options = {}) {
  const server = createGateway(settings, { now: () => clock, ...options });
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  return listen(server);
}

// Logs in and returns the Cookie header of the session.
async function sessionCookie(...others) {
  const response = await logIn();
  assert.equal(response.status, 303);
  return cookieHeader(response, ...others);
}

// A request whose first line is exactly "GET <target>": fetch would tidy the address first.
function rawGet(target, headers = {}) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    http.get({ hostname, port, path: target, headers, agent: false }, (answer) => {
      answer.resume();
      answer.on('end', () => resolve({ status: answer.statusCode, location: answer.headers.location }));
    }).on('error', reject);
  });
}

const asHtml = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

// A gateway with two public names, for one test. The two names are two ways to write this
// laptop, on one port: "127.0.0.1" is the name of the app, "localhost" the name for ChatGPT.
async function twoNames(t, options = {}) {
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const found = probe.address().port;
      probe.close(() => resolve(found));
    });
  });
  const names = { port, app: `http://127.0.0.1:${port}`, mcp: `http://localhost:${port}`, appHost: `127.0.0.1:${port}`, mcpHost: `localhost:${port}` };
  const server = createGateway(loadConfig({
    PUBLIC_URL: names.app,
    MCP_PUBLIC_URL: names.mcp,
    AUTH_URL: config.authUrl,
    MCP_UPSTREAM_URL: config.mcpUpstreamUrl,
    APP_UPSTREAM_URL: config.appUpstreamUrl,
    ALLOWED_EMAILS: 'me@example.test',
  }), { now: () => clock, ...options });
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return names;
}

// One request with exactly this Host header (fetch chooses the Host itself). It always goes
// to 127.0.0.1: the Host header alone says which name was asked for.
// Returns { status, headers, text, json }.
function ask(names, host, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: names.port, path, method, agent: false, headers: { Host: host, ...headers } }, (answer) => {
      const chunks = [];
      answer.on('data', (chunk) => chunks.push(chunk));
      answer.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Not JSON: the test looks at the text.
        }
        resolve({ status: answer.statusCode, headers: answer.headers, text, json });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

// The status of a request from a program so old that it sends no Host header at all.
function statusWithoutHost(names, path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(names.port, '127.0.0.1', () => socket.write(`GET ${path} HTTP/1.0\r\n\r\n`));
    let text = '';
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('end', () => resolve(Number(text.split(' ')[1])));
    socket.on('error', reject);
  });
}

function callMcp(bearer, options = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...options.headers,
    },
    body: options.body ?? '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });
}

before(async () => {
  auth = echoServer((req, res, record) => {
    if (req.url !== '/.well-known/jwks.json') return loginServer ? loginServer(req, res, record) : false;
    keyListCalls += 1;
    if (keyListBroken) {
      res.writeHead(500).end();
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
    return true;
  });
  bridge = echoServer((req, res, record) => {
    // A body that the bridge cannot read: it says no, in the words of the real one.
    if (record.body === 'not json' || record.body === 'long no') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(record.body === 'long no' ? 'n'.repeat(5000) : BRIDGE_REFUSAL);
      return true;
    }
    if (req.method !== 'GET') return false;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: one\n\n');
    setTimeout(() => res.end('data: two\n\n'), 300);
    return true;
  });
  app = echoServer();
  const [authUrl, bridgeUrl, appUrl] = await Promise.all([listen(auth.server), listen(bridge.server), listen(app.server)]);
  config = loadConfig({
    PUBLIC_URL: 'https://app.example.test',
    AUTH_URL: authUrl,
    MCP_UPSTREAM_URL: `${bridgeUrl}/mcp-innersecret`,
    APP_UPSTREAM_URL: appUrl,
    ALLOWED_EMAILS: 'Me@Example.test, second@example.test',
    APP_TITLE: 'Test App',
    // What the stand-in app has open, as an installable web app would: see OPEN_PATHS.
    OPEN_PATHS: '/manifest.webmanifest, /sw.js, /offline, /static/',
  });
});

beforeEach(async () => {
  // A new gateway for every test: no key list and no request counters left from the test before.
  gateway?.close();
  gateway?.closeAllConnections();
  gateway = createGateway(config, { now: () => clock });
  base = await listen(gateway);
  // A whole second, so that "ten minutes from now" is exactly 600 seconds in every test.
  clock = Math.ceil(clock / 1000) * 1000;
  keyListCalls = 0;
  keyListBroken = false;
  loginServer = null;
  for (const stub of [auth, bridge, app]) stub.seen.length = 0;
});

after(() => {
  for (const server of [gateway, auth.server, bridge.server, app.server]) {
    server.close();
    server.closeAllConnections();
  }
});

// ---- settings ----------------------------------------------------------------

test('settings: refuses to start with nobody allowed', () => {
  const env = { PUBLIC_URL: 'https://a.test', AUTH_URL: 'http://auth:9999', MCP_UPSTREAM_URL: 'http://127.0.0.1:8000/mcp-x' };
  assert.throws(() => loadConfig({ ...env, ALLOWED_EMAILS: ' , ' }), /ALLOWED_EMAILS/);
  assert.throws(() => loadConfig(env), /ALLOWED_EMAILS/);
});

test('settings: refuses addresses that are not complete', () => {
  const env = { PUBLIC_URL: 'https://a.test', AUTH_URL: 'http://auth:9999', MCP_UPSTREAM_URL: 'http://127.0.0.1:8000/mcp-x', ALLOWED_EMAILS: 'me@a.test' };
  assert.throws(() => loadConfig({ ...env, PUBLIC_URL: 'a.test' }), /PUBLIC_URL/);
  assert.throws(() => loadConfig({ ...env, PUBLIC_URL: 'https://a.test/folder' }), /PUBLIC_URL/);
  assert.throws(() => loadConfig({ ...env, AUTH_URL: undefined }), /AUTH_URL/);
  assert.throws(() => loadConfig({ ...env, MCP_UPSTREAM_URL: 'ftp://x' }), /MCP_UPSTREAM_URL/);
  assert.equal(loadConfig({ ...env, PUBLIC_URL: 'https://a.test/' }).publicUrl, 'https://a.test');
});

// ---- /mcp --------------------------------------------------------------------

test('mcp: without a token it answers 401 and says where the login server is', async () => {
  const response = await callMcp(null);
  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get('www-authenticate'),
    'Bearer resource_metadata="https://app.example.test/.well-known/oauth-protected-resource/mcp"',
  );
  assert.equal(bridge.seen.length, 0);
});

test('mcp: a valid token reaches the bridge, and the token itself does not', async () => {
  const response = await callMcp(token(), { headers: { 'Mcp-Protocol-Version': '2025-06-18', Cookie: 'x=y' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mcp-session-id'), 'session-1');
  assert.equal(response.headers.get('set-cookie'), null);
  const got = await response.json();
  assert.equal(got.url, '/mcp-innersecret');
  assert.equal(got.body, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  assert.equal(got.headers['mcp-protocol-version'], '2025-06-18');
  assert.equal(got.headers.authorization, undefined);
  assert.equal(got.headers.cookie, undefined);
});

const OLD_SERVER_WORDS = 'Bad Request: Unsupported protocol version: 2026-07-28 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)';

test('mcp: every header of the protocol itself reaches the bridge, and comes back from it', async () => {
  // ChatGPT sends "Mcp-Method" and "Mcp-Name" next to the body. A bridge that gets the body
  // without them answers 400 "header does not match the request body".
  const response = await callMcp(token(), {
    headers: {
      'Mcp-Protocol-Version': '2025-11-25',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'write_file',
      'Mcp-Param-Path': '/projects/notes/a.md',
      'X-Other': 'not of the protocol',
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mcp-later-header'), 'kept');
  assert.equal(response.headers.get('x-inner'), null);
  const got = (await response.json()).headers;
  assert.equal(got['mcp-method'], 'tools/call');
  assert.equal(got['mcp-name'], 'write_file');
  assert.equal(got['mcp-param-path'], '/projects/notes/a.md');
  assert.equal(got['x-other'], undefined);
  assert.equal(got.authorization, undefined);
});

test('mcp: a protocol version that the bridge cannot serve is answered in the words of an older server', async () => {
  // The file server behind the bridge is from before 2026-07-28. ChatGPT asks in that
  // version first; this answer makes it go on with the older handshake.
  const response = await callMcp(token(), {
    headers: { 'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' },
    body: '{"jsonrpc":"2.0","id":"openai-mcp-discover","method":"server/discover","params":{}}',
  });
  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', error: { code: -32000, message: OLD_SERVER_WORDS }, id: null });
  assert.equal(bridge.seen.length, 0);
  // Every version of the list goes on to the bridge, and so does a request that names none.
  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']) {
    assert.equal((await callMcp(token(), { headers: { 'Mcp-Protocol-Version': version } })).status, 200, version);
  }
  assert.equal((await callMcp(token())).status, 200);
  assert.equal(bridge.seen.length, 6);
  // The login comes first: without a token the answer is 401, whatever the version.
  assert.equal((await callMcp(null, { headers: { 'Mcp-Protocol-Version': '2026-07-28' } })).status, 401);
  // A long made-up version is cut in the answer.
  const long = await callMcp(token(), { headers: { 'Mcp-Protocol-Version': 'v'.repeat(500) } });
  assert.equal(long.status, 400);
  assert.ok((await long.text()).length < 300);
});

test('mcp: a compressed body goes on with the header that says how it is compressed', async () => {
  // Without that header the bridge reads the compressed bytes as text and answers "invalid JSON".
  const packed = gzipSync('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  const response = await callMcp(token(), { headers: { 'Content-Encoding': 'gzip' }, body: packed });
  assert.equal(response.status, 200);
  const got = await response.json();
  assert.equal(got.headers['content-encoding'], 'gzip');
  assert.equal(got.headers['content-length'], String(packed.length));
});

test('mcp: the allowed email is compared without looking at capital letters', async () => {
  assert.equal((await callMcp(token({ email: 'ME@example.TEST' }))).status, 200);
});

test('mcp: a logged-in user who is not on the list gets 403', async () => {
  const response = await callMcp(token({ email: 'other@example.test' }));
  assert.equal(response.status, 403);
  assert.equal(bridge.seen.length, 0);
});

const refused = {
  'an expired token': () => token({ exp: Math.floor(clock / 1000) - 120 }),
  'a token without an end time': () => token({ exp: undefined }),
  'a token that is not valid yet': () => token({ nbf: Math.floor(clock / 1000) + 600 }),
  'a token from another login server': () => token({ iss: 'https://evil.example/auth/v1' }),
  'a token for another audience': () => token({ aud: 'other' }),
  'a service token': () => token({ role: 'service_role' }),
  'a token of an anonymous user': () => token({ is_anonymous: true }),
  'a token signed by somebody else': () => token({}, { key: stranger.privateKey }),
  'a token with an unknown key name': () => token({}, { header: { kid: 'key-2' } }),
  'a token without a key name': () => token({}, { header: { kid: undefined } }),
  // The signature of a user who is not on the list, with the content of a user who is.
  'a token with a changed content': () => {
    const [head, , signature] = token({ email: 'other@example.test' }).split('.');
    return `${head}.${token().split('.')[1]}.${signature}`;
  },
  'a token with no signature ("none")': () => `${b64({ alg: 'none', kid: KID })}.${token().split('.')[1]}.`,
  // The classic trick: sign with a shared secret, using the PUBLIC key as the secret.
  'a token signed with the public key as a shared secret': () => {
    const head = b64({ alg: 'HS256', kid: KID, typ: 'JWT' });
    const body = token().split('.')[1];
    const secret = signing.publicKey.export({ type: 'spki', format: 'pem' });
    return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
  },
  'a text that is not a token': () => 'abc.def',
};

for (const [name, make] of Object.entries(refused)) {
  test(`mcp: refuses ${name}`, async () => {
    const response = await callMcp(make());
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /^Bearer error="invalid_token", .*resource_metadata="https:\/\/app\.example\.test\//);
    assert.equal(bridge.seen.length, 0);
  });
}

test('mcp: a token close to its end is still accepted for 30 seconds', async () => {
  assert.equal((await callMcp(token({ exp: Math.floor(clock / 1000) - 20 }))).status, 200);
});

test('mcp: the key list is read once, not for every request', async () => {
  await callMcp(token());
  await callMcp(token());
  await callMcp(token());
  assert.equal(keyListCalls, 1);
});

test('mcp: an unknown key name does not make the gateway ask for the key list every time', async () => {
  await callMcp(token());
  for (let i = 0; i < 5; i += 1) await callMcp(token({}, { header: { kid: 'key-2' } }));
  assert.equal(keyListCalls, 1);
  clock += 11_000;
  await callMcp(token({}, { header: { kid: 'key-2' } }));
  assert.equal(keyListCalls, 2);
});

test('mcp: when the key list cannot be read, known keys still work and nobody new gets in', async () => {
  keyListBroken = true;
  assert.equal((await callMcp(token())).status, 503);
  keyListBroken = false;
  clock += 11_000;
  assert.equal((await callMcp(token())).status, 200);
  keyListBroken = true;
  clock += 11 * 60_000;
  assert.equal((await callMcp(token({ exp: Math.floor(clock / 1000) + 600 }))).status, 200);
});

test('mcp: a stream from the bridge arrives piece by piece', async () => {
  const response = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token()}`, Accept: 'text/event-stream' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(first, 'data: one\n\n');
  const second = new TextDecoder().decode((await reader.read()).value);
  assert.equal(second, 'data: two\n\n');
});

test('mcp: a body that is too large is refused', async () => {
  const response = await callMcp(token(), { body: 'x'.repeat(8 * 1024 * 1024 + 1) }).catch((error) => error);
  // The gateway answers 413 and closes; some clients see the closed connection first.
  if (response instanceof Error) return;
  assert.equal(response.status, 413);
});

test('mcp: other methods are refused before anything else', async () => {
  const response = await fetch(`${base}/mcp`, { method: 'PUT', headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(response.status, 405);
});

test('mcp: a bridge that does not answer gives 502', async () => {
  const broken = createGateway({ ...config, mcpUpstreamUrl: 'http://127.0.0.1:1/mcp-x' }, { now: () => clock });
  const url = await listen(broken);
  const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: '{}' });
  assert.equal(response.status, 502);
  broken.close();
  broken.closeAllConnections();
});

// ---- the documents an MCP client reads -----------------------------------------

test('discovery: the resource document names the bridge and the login server', async () => {
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    const document = await response.json();
    assert.equal(document.resource, 'https://app.example.test/mcp');
    assert.deepEqual(document.authorization_servers, ['https://app.example.test/auth/v1']);
  }
});

test('discovery: the login server documents are found at the addresses a client tries', async () => {
  const expected = {
    '/.well-known/oauth-authorization-server/auth/v1': '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration/auth/v1': '/.well-known/openid-configuration',
    '/auth/v1/.well-known/openid-configuration': '/.well-known/openid-configuration',
    '/auth/v1/.well-known/oauth-authorization-server': '/.well-known/oauth-authorization-server',
  };
  for (const [asked, forwarded] of Object.entries(expected)) {
    const response = await fetch(base + asked);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).url, forwarded);
  }
});

// ---- Supabase Auth: only the login paths ---------------------------------------

test('auth: the OAuth paths are passed on, with the query and the body', async () => {
  let response = await fetch(`${base}/auth/v1/oauth/authorize?client_id=abc&state=s%201`, { redirect: 'manual' });
  assert.equal((await response.json()).url, '/oauth/authorize?client_id=abc&state=s%201');

  response = await fetch(`${base}/auth/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Real-IP': '203.0.113.9' },
    body: 'grant_type=authorization_code&code=c',
  });
  const got = await response.json();
  assert.equal(got.url, '/oauth/token');
  assert.equal(got.body, 'grant_type=authorization_code&code=c');
  assert.equal(got.headers['x-forwarded-for'], '203.0.113.9');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);

  response = await fetch(`${base}/auth/v1/oauth/authorizations/abc123/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer user-token' },
    body: '{"action":"approve"}',
  });
  assert.equal((await response.json()).headers.authorization, 'Bearer user-token');
});

test('auth: everything else of Supabase Auth is closed', async () => {
  const closed = [
    ['GET', '/auth/v1/admin/users'],
    ['POST', '/auth/v1/admin/users'],
    ['POST', '/auth/v1/admin/oauth/clients'],
    ['POST', '/auth/v1/signup'],
    ['POST', '/auth/v1/recover'],
    ['POST', '/auth/v1/otp'],
    ['GET', '/auth/v1/user'],
    ['PUT', '/auth/v1/user'],
    ['GET', '/auth/v1/settings'],
    ['POST', '/auth/v1/token'],
    ['POST', '/auth/v1/token?grant_type=refresh_token'],
    ['POST', '/auth/v1/token?grant_type=password&x=1'],
    ['GET', '/auth/v1/token?grant_type=password'],
    ['DELETE', '/auth/v1/oauth/grants'],
    ['GET', '/auth/v1/oauth/authorizations/abc/../../admin/users'],
    ['GET', '/auth/v1/oauth/authorizations/abc%2F..%2Fadmin'],
    ['POST', '/auth/v1/oauth/token/extra'],
    ['GET', '/auth/v1/'],
  ];
  for (const [method, path] of closed) {
    const response = await fetch(base + path, { method });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal(auth.seen.length, 0);
});

test('auth: the password login is limited to 10 tries in 10 minutes for one address', async () => {
  const tryLogin = (address) => fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Real-IP': address },
    body: '{"email":"me@example.test","password":"wrong"}',
  });
  for (let i = 0; i < 10; i += 1) assert.equal((await tryLogin('203.0.113.1')).status, 200);
  const blocked = await tryLogin('203.0.113.1');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '600');
  assert.equal((await tryLogin('203.0.113.2')).status, 200);
  clock += 10 * 60_000 + 1;
  assert.equal((await tryLogin('203.0.113.1')).status, 200);
});

test('auth: the password login is limited to 50 tries in 10 minutes for everybody together', async () => {
  const tryLogin = (i) => fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'X-Real-IP': `198.51.100.${i}` }, body: '{}',
  });
  for (let i = 0; i < 50; i += 1) assert.equal((await tryLogin(i)).status, 200);
  assert.equal((await tryLogin(200)).status, 429);
});

test('auth: a body that is too large is refused', async () => {
  const response = await fetch(`${base}/auth/v1/oauth/clients/register`, { method: 'POST', body: 'x'.repeat(64 * 1024 + 1) })
    .catch((error) => error);
  if (response instanceof Error) return;
  assert.equal(response.status, 413);
});

// ---- the consent page ----------------------------------------------------------

test('consent: the page and its two files are served, and nothing may be loaded from elsewhere', async () => {
  const types = { '/oauth/consent': 'text/html', '/oauth/consent.js': 'text/javascript', '/oauth/consent.css': 'text/css' };
  for (const [path, type] of Object.entries(types)) {
    const response = await fetch(`${base}${path}?authorization_id=abc`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), new RegExp(`^${type}`));
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'; script-src 'self'/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const page = await (await fetch(`${base}/oauth/consent`)).text();
  assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)/, 'no script written inside the page');
  assert.doesNotMatch(page, /https?:\/\//, 'no address of another site');
});

// ---- the web app: its addresses ------------------------------------------------

test('app: with a session, the web app gets the request unchanged', async () => {
  useLoginServer();
  const response = await fetch(`${base}/e/a%20b?x=1&y=%2F`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: await sessionCookie(), 'X-Real-IP': '203.0.113.9' },
    body: 'answer=hello',
  });
  assert.equal(response.status, 200);
  const got = await response.json();
  assert.equal(got.method, 'POST');
  assert.equal(got.url, '/e/a%20b?x=1&y=%2F');
  assert.equal(got.body, 'answer=hello');
  assert.equal(got.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(got.headers['x-forwarded-for'], '203.0.113.9');
  // The answer comes back as the app sent it, with the app's own cookie and nothing added.
  assert.deepEqual(response.headers.getSetCookie(), ['a=b']);
  assert.equal(response.headers.get('content-type'), 'application/json');
});

test('app: without a web app, its addresses and the login are closed', async (t) => {
  const url = await extraGateway(t, { ...config, appUpstreamUrl: null });
  for (const path of ['/', '/e/one', '/static/app.css', '/login', '/logout']) {
    const response = await fetch(url + path, { redirect: 'manual' });
    assert.equal(response.status, 404, path);
  }
});

test('app: a few files are open to everybody, with GET and HEAD only', async () => {
  const open = ['/static/app.css', '/static/Nunito.woff2', '/static/icon-192.png?v=3', '/manifest.webmanifest', '/sw.js', '/offline'];
  for (const path of open) {
    for (const method of ['GET', 'HEAD']) {
      app.seen.length = 0;
      const response = await fetch(base + path, { method, redirect: 'manual' });
      assert.equal(response.status, 200, `${method} ${path}`);
      assert.equal(app.seen.length, 1);
      assert.equal(app.seen[0].method, method);
      assert.equal(app.seen[0].url, path);
    }
  }
  // Any other method on them needs a session, like the rest of the app.
  app.seen.length = 0;
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await fetch(`${base}/static/app.css`, { method })).status, 401, method);
  }
  assert.equal(app.seen.length, 0);
});

test('app: an address that only looks like an open file is not open', async () => {
  const closed = [
    '/offline.json', '/offline/', '/offline/x', '/sw.js/x', '/sw.json', '/manifest.webmanifest.bak', '/static', '/static/',
    '/static/..%2fe/one', '/static/%2e%2e/e/one', '/static/.%2e/e/one', '/static/a%2Fb', '/static/.hidden', '/static//app.css',
    '/static/a/../../e/one', '/Static/app.css', '/x/static/app.css', '/theme/dark', '/e/one', '/n/note', '/x', '/',
    '//evil.example/static/app.css', '//static/app.css',
  ];
  for (const path of closed) {
    const response = await rawGet(path);
    assert.equal(response.status, 303, path);
    assert.equal(response.location, `/login?next=${encodeURIComponent(path)}`);
  }
  assert.equal(app.seen.length, 0);
});

test('app: with a session, an odd address goes to the app exactly as it was sent', async () => {
  useLoginServer();
  const cookie = await sessionCookie();
  for (const path of ['/static/..%2fe/one', '/static/a/../../e/one', '//evil.example/static/app.css', '/e/%2e%2e/x?a=%2F']) {
    app.seen.length = 0;
    assert.equal((await rawGet(path, { Cookie: cookie })).status, 200, path);
    assert.equal(app.seen[0].url, path);
  }
});

test('app: a request that is not for a path of this site is refused', async () => {
  useLoginServer();
  const cookie = await sessionCookie();
  for (const target of ['http://evil.example/static/app.css', 'http://evil.example/e/one', 'https://app.example.test/e/one']) {
    assert.equal((await rawGet(target, { Cookie: cookie })).status, 400, target);
  }
  assert.equal(app.seen.length, 0);
});

test('app: an app that lives under a folder gets that folder in front of the path', async (t) => {
  useLoginServer();
  const url = await extraGateway(t, { ...config, appUpstreamUrl: `${config.appUpstreamUrl}/inner` });
  const cookie = cookieHeader(await logIn({}, { from: url }));
  assert.equal((await (await fetch(`${url}/e/one?x=1`, { headers: { Cookie: cookie } })).json()).url, '/inner/e/one?x=1');
  assert.equal((await (await fetch(`${url}/static/app.css`)).json()).url, '/inner/static/app.css');
});

test('app: a body that is too large is refused', async () => {
  useLoginServer();
  const response = await fetch(`${base}/e/one`, { method: 'POST', headers: { Cookie: await sessionCookie() }, body: 'x'.repeat(1024 * 1024 + 1) })
    .catch((error) => error);
  if (response instanceof Error) return;
  assert.equal(response.status, 413);
});

test('app: an app that does not answer gives 502', async (t) => {
  useLoginServer();
  const url = await extraGateway(t, { ...config, appUpstreamUrl: 'http://127.0.0.1:1' });
  const cookie = cookieHeader(await logIn({}, { from: url }));
  assert.equal((await fetch(`${url}/e/one`, { headers: { Cookie: cookie } })).status, 502);
});

// ---- the web app: no session ---------------------------------------------------

test('session: without one, a page sends the visitor to the login and remembers the address', async () => {
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(`${base}/e/one?x=1&y=a%20b`, { method, redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login?next=%2Fe%2Fone%3Fx%3D1%26y%3Da%2520b');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(response.headers.getSetCookie(), []);
  }
  assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).headers.get('location'), '/login?next=%2F');
  assert.equal(app.seen.length, 0);
});

test('session: without one, any other method gets 401 and a link to the login', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await fetch(`${base}/e/one`, { method, redirect: 'manual', body: method === 'DELETE' ? undefined : 'answer=x' });
    assert.equal(response.status, 401, method);
    const page = await response.text();
    assert.match(page, /Log in again/);
    assert.match(page, /<a [^>]*href="\/login"/);
  }
  assert.equal(app.seen.length, 0);
});

test('session: cookies that are not a login do not open the app', async () => {
  useLoginServer();
  const cookies = [
    'theme=dark',
    '__Host-session-access=abc.def.ghi',
    `__Host-session-access=${token({}, { key: stranger.privateKey })}`,
    `__Host-session-access=${token({ email: 'other@example.test' })}`,
    `__Host-session-access=${token({ exp: Math.floor(clock / 1000) - 120 })}`,
    `__Host-session-access=${token({ iss: 'https://evil.example/auth/v1' })}`,
    // The plain names are for http:// only: on https:// they are not the session.
    `session-access=${token()}`,
    '__Host-session-access=%E0%A4%A',
  ];
  for (const cookie of cookies) {
    const response = await fetch(`${base}/e/one`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(response.status, 303, cookie.slice(0, 40));
  }
  assert.equal(app.seen.length, 0);
});

test('session: the names the gateway keeps for itself never go to the app', async () => {
  useLoginServer();
  const cookie = await sessionCookie();
  for (const path of ['/mcp/', '/mcp/x', '/oauth', '/oauth/consent.html', '/oauth/token', '/.well-known/jwks.json', '/.well-known/x', '/auth', '/auth/v2/token']) {
    for (const headers of [{}, { Cookie: cookie }]) {
      const response = await fetch(base + path, { headers, redirect: 'manual' });
      assert.equal(response.status, 404, path);
      assert.deepEqual(await response.json(), { error: 'not_found' });
    }
  }
  assert.equal(app.seen.length, 0);
  assert.equal(bridge.seen.length, 0);
});

test('session: every other address is the app\'s: closed without a session, and never the bridge', async () => {
  for (const path of ['/', '/admin', '/mcp-innersecret', '/login/x', '/healthz/x']) {
    const response = await fetch(base + path, { redirect: 'manual' });
    assert.equal(response.status, 303, path);
  }
  assert.equal((await fetch(`${base}/mcp-innersecret`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal(app.seen.length, 0);
  assert.equal(bridge.seen.length, 0);
});

// ---- the login page ------------------------------------------------------------

test('login: the page has the form and looks like the app', async () => {
  const response = await fetch(`${base}/login?next=%2Fe%2Fone%3Fx%3D1`);
  assert.equal(response.status, 200);
  const page = await response.text();
  // The stylesheet of these pages is the gateway's own. Its address has a mark that is new with
  // every start of the gateway, so a deploy brings a new look at once.
  assert.match(page, /<link rel=stylesheet href="\/login\/style\.css\?v=[0-9a-z]{6,}">/);
  assert.match(page, /<form class=login method=post action="\/login">/);
  assert.match(page, /<input id=email name=email type=email autocomplete=username required>/);
  assert.match(page, /<input id=password name=password type=password autocomplete=current-password required>/);
  assert.match(page, /<input type=hidden name=next value="\/e\/one\?x=1">/);
  assert.equal(page.match(/<button/g).length, 1);
  assert.match(page, /<button class=btn>Log in<\/button>/);
  assert.doesNotMatch(page, /class=warn/, 'no message before the first try');
  assert.doesNotMatch(page, /<script/);
  // The name of the app from the settings, and one heading that says what the page is for.
  assert.match(page, /<p class=app>Test App<\/p>\n<h1>Log in<\/h1>/);
  assert.equal(page.match(/<h1>/g).length, 1);
  assert.doesNotMatch(page, /<img|https?:\/\//, 'no picture and no address of another site');
  assert.equal(app.seen.length + auth.seen.length, 0);
});

test('login: other methods are refused', async () => {
  for (const method of ['PUT', 'DELETE', 'HEAD']) {
    const response = await fetch(`${base}/login`, { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET, POST');
  }
});

const badNext = {
  'another site without a scheme': '//evil.example/x',
  'a backslash': '/\\evil.example',
  'a backslash later': '/x\\..\\y',
  'a full address': 'https://evil.example/',
  'a script': 'javascript:alert(1)',
  'two slashes later': '/x//evil.example',
  'a tab': '/\t/evil.example',
  'a new line': '/x\r\nSet-Cookie: a=b',
  'a zero byte': '/x\u0000y',
  'no slash at the start': 'e/one',
  'a space at the start': ' /e/one',
  'nothing': '',
  'a very long address': `/${'x'.repeat(5000)}`,
};

for (const [name, next] of Object.entries(badNext)) {
  test(`login: "next" with ${name} is not used`, async () => {
    useLoginServer();
    const response = await logIn({ next });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/');
    assert.deepEqual([...cookiesSet(response).keys()], ['__Host-session-access', '__Host-session-refresh'], 'only the two session cookies');
    // The login page does not keep it either.
    const page = await (await fetch(`${base}/login?next=${encodeURIComponent(next)}`)).text();
    assert.match(page, /<input type=hidden name=next value="\/">/);
  });
}

test('login: a plain path of this site is used as "next"', async () => {
  useLoginServer();
  const kept = {
    '/': '/',
    '/e/one': '/e/one',
    '/e/one?x=1&y=a%20b': '/e/one?x=1&y=a%20b',
    '/n/café → x': '/n/caf%C3%A9%20%E2%86%92%20x',
    '/e/../x': '/x',
  };
  for (const [next, location] of Object.entries(kept)) {
    const response = await logIn({ next });
    assert.equal(response.status, 303, next);
    assert.equal(response.headers.get('location'), location);
  }
  // No "next" at all: the first page.
  const response = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'me@example.test', password: PASSWORD }).toString(),
  });
  assert.equal(response.headers.get('location'), '/');
});

test('login: on https the two cookies have the __Host- names and every protection', async () => {
  const told = useLoginServer();
  const response = await logIn({ next: '/e/one' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/e/one');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const cookies = cookiesSet(response);
  assert.deepEqual([...cookies.keys()], ['__Host-session-access', '__Host-session-refresh']);
  const [access, refresh] = told.tokens;
  assert.equal(cookies.get('__Host-session-access').text, `__Host-session-access=${access}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure`);
  assert.equal(cookies.get('__Host-session-refresh').text, `__Host-session-refresh=${refresh}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure`);
  for (const cookie of cookies.values()) assert.doesNotMatch(cookie.text, /domain/i);
  // The login server got the email and the password, and the visitor's address for its own counting.
  const asked = auth.seen.find((request) => request.url === '/token?grant_type=password');
  assert.deepEqual(JSON.parse(asked.body), { email: 'me@example.test', password: PASSWORD });
  assert.equal(asked.method, 'POST');
  assert.equal(told.password, 1);
});

test('login: on http (local tests) the cookies have plain names and no "Secure"', async (t) => {
  const told = useLoginServer({ access: (email) => token({ email, iss: 'http://app.local.test:8080/auth/v1' }) });
  const url = await extraGateway(t, loadConfig({
    PUBLIC_URL: 'http://app.local.test:8080',
    AUTH_URL: config.authUrl,
    MCP_UPSTREAM_URL: config.mcpUpstreamUrl,
    APP_UPSTREAM_URL: config.appUpstreamUrl,
    ALLOWED_EMAILS: 'me@example.test',
  }));
  const response = await logIn({}, { from: url });
  assert.equal(response.status, 303);
  const cookies = cookiesSet(response);
  const [access, refresh] = told.tokens;
  assert.equal(cookies.get('session-access').text, `session-access=${access}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax`);
  assert.equal(cookies.get('session-refresh').text, `session-refresh=${refresh}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
  assert.equal(cookies.size, 2);
  // And they are the session there.
  const page = await fetch(`${url}/e/one`, { headers: { Cookie: cookieHeader(response) }, redirect: 'manual' });
  assert.equal(page.status, 200);
  assert.equal((await page.json()).headers.cookie, undefined);
  // The same origin check, with the http address.
  const post = (origin) => fetch(`${url}/e/one`, { method: 'POST', headers: { Cookie: cookieHeader(response), Origin: origin }, body: 'a=b' });
  assert.equal((await post('http://app.local.test:8080')).status, 200);
  assert.equal((await post('https://app.local.test:8080')).status, 403);
});

const failedLogins = {
  'a wrong password': { fields: { password: 'not-the-password' } },
  'no password': { fields: { password: '' } },
  'no email': { fields: { email: '' } },
  'a user who is not on the list': { fields: { email: 'other@example.test' } },
  'a token with a wrong signature from the login server': { access: (email) => token({ email }, { key: stranger.privateKey }) },
  'a token of another login server': { access: (email) => token({ email, iss: 'https://evil.example/auth/v1' }) },
  'a token that has already expired': { access: (email) => token({ email, exp: Math.floor(clock / 1000) - 120 }) },
  'a token for another audience': { access: (email) => token({ email, aud: 'other' }) },
  'a token signed with a shared secret': {
    access: () => {
      const head = b64({ alg: 'HS256', kid: KID, typ: 'JWT' });
      const body = token().split('.')[1];
      return `${head}.${body}.${createHmac('sha256', 'secret').update(`${head}.${body}`).digest('base64url')}`;
    },
  },
  'an answer without a refresh token': {
    server: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: token() }));
      return true;
    },
  },
  'an answer that is not JSON': {
    server: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>hello</h1>');
      return true;
    },
  },
  'a login server in trouble': {
    server: (req, res) => {
      res.writeHead(500).end();
      return true;
    },
  },
};

for (const [name, { fields = {}, access, server }] of Object.entries(failedLogins)) {
  test(`login: ${name} gives no session, with the same words every time`, async () => {
    useLoginServer(access ? { access } : {});
    if (server) loginServer = server;
    const response = await logIn({ next: '/e/one', ...fields });
    assert.equal(response.status, 401);
    assert.deepEqual(response.headers.getSetCookie(), []);
    assert.equal(response.headers.get('location'), null);
    const page = await response.text();
    assert.match(page, /<p class=warn>Wrong email or password\.<\/p>/);
    // The page is ready for the next try: the form, and the address to go to afterwards.
    assert.match(page, /<form class=login method=post action="\/login">/);
    assert.match(page, /<input type=hidden name=next value="\/e\/one">/);
    assert.ok(!page.includes(PASSWORD) && !page.includes('not-the-password'), 'the password is never written back');
    assert.equal(app.seen.length, 0);
  });
}

test('login: a form that is too large is refused', async () => {
  useLoginServer();
  const response = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `email=me@example.test&password=${'x'.repeat(64 * 1024 + 1)}`,
  }).catch((error) => error);
  if (response instanceof Error) return;
  assert.equal(response.status, 413);
  assert.equal(auth.seen.length, 0);
});

test('login: 10 tries in 10 minutes for one address, counted together with the consent page', async () => {
  const told = useLoginServer();
  const from = (address) => ({ headers: { 'X-Real-IP': address } });
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await logIn({ password: 'not-the-password' }, from('203.0.113.1'))).status, 401);
  }
  // Now even the right password is refused, and the login server is not asked.
  const blocked = await logIn({ next: '/e/one' }, from('203.0.113.1'));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '600');
  assert.deepEqual(blocked.headers.getSetCookie(), []);
  const page = await blocked.text();
  assert.match(page, /<p class=warn>Too many tries\. Wait a few minutes\.<\/p>/);
  assert.match(page, /<input type=hidden name=next value="\/e\/one">/);
  assert.equal(told.password, 10);
  // The login of the consent page is the same door: it is closed too.
  const consent = await fetch(`${base}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'X-Real-IP': '203.0.113.1' }, body: '{}' });
  assert.equal(consent.status, 429);
  // Another address is not touched, and the time passes.
  assert.equal((await logIn({}, from('203.0.113.2'))).status, 303);
  clock += 10 * 60_000 + 1;
  assert.equal((await logIn({}, from('203.0.113.1'))).status, 303);
});

test('login: taps on the button while a login is on its way join it: one call, one count, one session', async () => {
  // On the phone a login takes a moment, and the owner taps the button again. Every tap was
  // a login of its own: the login server did the slow password check five times at once,
  // each one made the others slower, and the taps used up the tries of the address.
  const told = useLoginServer({ waitMs: 150 });
  const from = { headers: { 'X-Real-IP': '203.0.113.9' } };
  const taps = await Promise.all([1, 2, 3, 4, 5].map(() => logIn({}, from)));
  assert.deepEqual(taps.map((answer) => answer.status), [303, 303, 303, 303, 303]);
  assert.equal(told.password, 1);
  const sessions = new Set(taps.map((answer) => answer.headers.getSetCookie().join('\n')));
  assert.equal(sessions.size, 1, 'every tap got the same session');
  assert.match([...sessions][0], /__Host-session-refresh=refresh-/);
  // The five taps were one try: nine more wrong passwords fit before the address is stopped.
  told.password = 0;
  for (let i = 0; i < 9; i += 1) {
    assert.equal((await logIn({ password: 'not-the-password' }, from)).status, 401);
  }
  assert.equal((await logIn({}, from)).status, 429);
  assert.equal(told.password, 9);

  // Taps with a wrong password join too, and get the same plain answer.
  const other = { headers: { 'X-Real-IP': '203.0.113.10' } };
  const wrong = await Promise.all([1, 2, 3].map(() => logIn({ password: 'not-the-password' }, other)));
  assert.deepEqual(wrong.map((answer) => answer.status), [401, 401, 401]);
  assert.equal(told.password, 10);
  // Another password, another address or another email at the same moment is a login of its own.
  told.password = 0;
  await Promise.all([
    logIn({}, { headers: { 'X-Real-IP': '203.0.113.11' } }),
    logIn({}, { headers: { 'X-Real-IP': '203.0.113.12' } }),
    logIn({ password: 'not-the-password' }, { headers: { 'X-Real-IP': '203.0.113.11' } }),
    logIn({ email: 'second@example.test' }, { headers: { 'X-Real-IP': '203.0.113.11' } }),
  ]);
  assert.equal(told.password, 4);
  // A login that is over is not kept: the next tap is a new login.
  await logIn({}, { headers: { 'X-Real-IP': '203.0.113.11' } });
  assert.equal(told.password, 5);
});

test('login: 50 tries in 10 minutes for everybody together', async () => {
  useLoginServer();
  for (let i = 0; i < 50; i += 1) {
    assert.equal((await logIn({ password: 'not-the-password' }, { headers: { 'X-Real-IP': `198.51.100.${i}` } })).status, 401);
  }
  assert.equal((await logIn({}, { headers: { 'X-Real-IP': '198.51.100.200' } })).status, 429);
});

test('login: what the visitor typed is written into the page as text, never as HTML', async () => {
  useLoginServer();
  const attack = '"><script>alert(1)</script><img src=x onerror=alert(2)>\'&';
  // An address is first written the way a browser sends it, then as text.
  const next = asHtml(new URL(`http://x/e/${attack}?q=${attack}`).href.slice('http://x'.length));
  assert.ok(next.includes('&#39;&amp;') && !/[<>"']/.test(next));

  let page = await (await fetch(`${base}/login?next=${encodeURIComponent(`/e/${attack}?q=${attack}`)}`)).text();
  assert.doesNotMatch(page, /<script|<img/);
  assert.ok(page.includes(`<input type=hidden name=next value="${next}">`), page);

  const failed = await logIn({ email: `${attack}@example.test`, password: 'not-the-password', next: `/e/${attack}?q=${attack}` });
  assert.equal(failed.status, 401);
  page = await failed.text();
  assert.doesNotMatch(page, /<script|<img/);
  assert.ok(page.includes(` value="${asHtml(attack)}@example.test"`), 'the email is given back, as text');
  assert.ok(page.includes(`<input type=hidden name=next value="${next}">`), page);
  // An email far too long to be one is not given back at all.
  const long = await (await logIn({ email: `${'x'.repeat(400)}@example.test`, password: 'not-the-password' })).text();
  assert.ok(!long.includes('xxxxxxxx'));
});

// ---- the session ---------------------------------------------------------------

test('session: the app gets the request without the two login cookies, and with its own', async () => {
  const told = useLoginServer();
  const cookie = await sessionCookie('theme=dark', 'other=1');
  const response = await fetch(`${base}/n/note?x=1`, { headers: { Cookie: `seen=yes; ${cookie}` }, redirect: 'manual' });
  assert.equal(response.status, 200);
  const got = await response.json();
  assert.equal(got.url, '/n/note?x=1');
  assert.equal(got.headers.cookie, 'seen=yes; theme=dark; other=1');
  assert.deepEqual(response.headers.getSetCookie(), ['a=b'], 'a session that is still good sets no cookie');
  assert.equal(told.refresh, 0);
  // With nothing but the login cookies, the app gets no Cookie header at all.
  const bare = await (await fetch(`${base}/x`, { headers: { Cookie: await sessionCookie() } })).json();
  assert.equal(bare.headers.cookie, undefined);
});

test('session: an access token that ran out is renewed once for several requests at the same time', async () => {
  const told = useLoginServer({ waitMs: 100 });
  const first = await logIn();
  const before = cookiesSet(first);
  clock += 11 * 60_000;
  const cookie = cookieHeader(first, 'theme=dark');
  const replies = await Promise.all([1, 2, 3, 4, 5].map((n) => fetch(`${base}/e/${n}`, { headers: { Cookie: cookie }, redirect: 'manual' })));
  assert.equal(told.refresh, 1, 'one call to the login server for the five requests');
  const [, , access, refresh] = told.tokens;
  for (const reply of replies) {
    assert.equal(reply.status, 200);
    const cookies = cookiesSet(reply);
    assert.deepEqual([...cookies.keys()], ['a', '__Host-session-access', '__Host-session-refresh'], 'the cookie of the app, then the new session');
    assert.equal(cookies.get('__Host-session-access').text, `__Host-session-access=${access}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure`);
    assert.equal(cookies.get('__Host-session-refresh').text, `__Host-session-refresh=${refresh}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure`);
    assert.equal((await reply.json()).headers.cookie, 'theme=dark');
  }
  assert.notEqual(access, before.get('__Host-session-access').value);
  assert.equal(app.seen.length, 5);
  // The refresh token was sent to the login server, with the visitor's address.
  const asked = auth.seen.find((request) => request.url === '/token?grant_type=refresh_token');
  assert.deepEqual(JSON.parse(asked.body), { refresh_token: before.get('__Host-session-refresh').value });
  // The new cookies are a session: the login server is not asked again.
  assert.equal((await fetch(`${base}/e/6`, { headers: { Cookie: cookieHeader(replies[0]) } })).status, 200);
  assert.equal(told.refresh, 1);
});

test('session: with only the refresh cookie left, the session is renewed, also for a POST', async () => {
  const told = useLoginServer();
  const refresh = cookiesSet(await logIn()).get('__Host-session-refresh').value;
  const response = await fetch(`${base}/e/one`, {
    method: 'POST', headers: { Cookie: `__Host-session-refresh=${refresh}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'answer=kept',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).body, 'answer=kept', 'the body is not lost while the gateway asks the login server');
  assert.equal(cookiesSet(response).get('__Host-session-refresh').value, told.tokens[3]);
  assert.equal(told.refresh, 1);
});

test('session: a refresh token that the login server refuses ends in the login (GET) or 401 (POST)', async () => {
  const told = useLoginServer();
  const cookie = '__Host-session-access=abc.def.ghi; __Host-session-refresh=never-given; theme=dark';
  const cleared = (response) => {
    const cookies = cookiesSet(response);
    assert.deepEqual([...cookies.keys()], ['__Host-session-access', '__Host-session-refresh']);
    for (const [name, found] of cookies) assert.equal(found.text, `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
  };
  const page = await fetch(`${base}/e/one`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/login?next=%2Fe%2Fone');
  cleared(page);
  const post = await fetch(`${base}/e/one`, { method: 'POST', headers: { Cookie: cookie }, body: 'answer=x' });
  assert.equal(post.status, 401);
  assert.match(await post.text(), /Log in again/);
  cleared(post);
  assert.equal(told.refresh, 2);
  assert.equal(app.seen.length, 0);
});

const untrusted = {
  'signed by somebody else': (email) => token({ email }, { key: stranger.privateKey }),
  'of another login server': (email) => token({ email, iss: 'https://evil.example/auth/v1' }),
  'of a user who is not on the list': () => token({ email: 'other@example.test' }),
  'that has already expired': (email) => token({ email, exp: Math.floor(clock / 1000) - 120 }),
};

for (const [name, access] of Object.entries(untrusted)) {
  test(`session: a renewal that gives a token ${name} ends the session`, async () => {
    useLoginServer();
    const refresh = cookiesSet(await logIn()).get('__Host-session-refresh').value;
    loginServer = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: access('me@example.test'), refresh_token: 'refresh-new' }));
      return true;
    };
    const response = await fetch(`${base}/e/one`, { headers: { Cookie: `__Host-session-refresh=${refresh}` }, redirect: 'manual' });
    assert.equal(response.status, 303);
    const cookies = cookiesSet(response);
    assert.equal(cookies.get('__Host-session-access').value, '', 'no cookie with the bad token');
    assert.equal(cookies.get('__Host-session-refresh').value, '');
    assert.equal(app.seen.length, 0);
  });
}

test('session: when the login server is in trouble, nobody gets in and the cookies are kept for later', async () => {
  const told = useLoginServer();
  const first = await logIn();
  const refresh = cookiesSet(first).get('__Host-session-refresh').value;
  const working = loginServer;
  loginServer = (req, res) => {
    res.writeHead(500).end();
    return true;
  };
  const response = await fetch(`${base}/e/one`, { headers: { Cookie: `__Host-session-refresh=${refresh}` }, redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.deepEqual(response.headers.getSetCookie(), [], 'the cookies are not cleared');
  assert.equal(app.seen.length, 0);
  // The login server is back: the same refresh token still works.
  loginServer = working;
  assert.equal((await fetch(`${base}/e/one`, { headers: { Cookie: `__Host-session-refresh=${refresh}` } })).status, 200);
  assert.equal(told.refresh, 1);
});

test('session: when the public keys cannot be read, a renewed token is not trusted and the cookies are kept', async (t) => {
  useLoginServer();
  const refresh = cookiesSet(await logIn()).get('__Host-session-refresh').value;
  // A gateway that has just started: it has no key yet, and now it cannot get one.
  const url = await extraGateway(t, config);
  keyListBroken = true;
  const response = await fetch(`${url}/e/one`, { headers: { Cookie: `__Host-session-refresh=${refresh}` }, redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.deepEqual(response.headers.getSetCookie(), []);
  assert.equal(app.seen.length, 0);
});

test('session: a request from another site cannot use it', async () => {
  useLoginServer();
  const cookie = await sessionCookie();
  const post = (headers, method = 'POST') => fetch(`${base}/e/one`, { method, headers: { Cookie: cookie, ...headers }, body: method === 'DELETE' ? undefined : 'a=b', redirect: 'manual' });

  const refused = [
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
    { 'Sec-Fetch-Site': 'something-new' },
    { Origin: 'https://evil.example' },
    { Origin: 'http://app.example.test' },
    { Origin: 'https://app.example.test.evil.example' },
    { Origin: 'https://sub.app.example.test' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'same-origin', Origin: 'https://evil.example' },
    { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://app.example.test' },
    // "null" is what a browser sends when it may not say where a form comes from. Alone it
    // proves nothing: a page of another site can make a browser send it.
    { 'Sec-Fetch-Site': 'cross-site', Origin: 'null' },
    { 'Sec-Fetch-Site': 'same-site', Origin: 'null' },
    { 'Sec-Fetch-Site': 'none', Origin: 'null' },
  ];
  for (const headers of refused) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await post(headers, method);
      assert.equal(response.status, 403, `${method} ${JSON.stringify(headers)}`);
      assert.match(await response.text(), /another site/);
    }
  }
  assert.equal(app.seen.length, 0);

  const allowed = [
    {},
    { 'Sec-Fetch-Site': 'same-origin' },
    { 'Sec-Fetch-Site': 'none' },
    { Origin: 'https://app.example.test' },
    { 'Sec-Fetch-Site': 'same-origin', Origin: 'https://app.example.test' },
    // What Chrome sends with a form of a page that was served with "Referrer-Policy:
    // no-referrer": "Origin" is "null". The browser itself still says that the form is from
    // this site, in a header that no page can write.
    { 'Sec-Fetch-Site': 'same-origin', Origin: 'null' },
  ];
  for (const headers of allowed) assert.equal((await post(headers)).status, 200, JSON.stringify(headers));
  // A link on another site may open a page: reading is not changed by this check.
  const link = await fetch(`${base}/e/one`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(link.status, 200);
  // Without a session the answer is the same refusal: it says nothing about the session.
  assert.equal((await fetch(`${base}/e/one`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: 'a=b' })).status, 403);
});

// ---- logging out ---------------------------------------------------------------

test('logout: the page has one button', async () => {
  const response = await fetch(`${base}/logout`);
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /<form method=post action="\/logout">/);
  assert.equal(page.match(/<button/g).length, 1);
  assert.doesNotMatch(page, /<script/);
  assert.equal(auth.seen.length, 0, 'opening the page does not log out');
});

test('logout: it tells the login server, clears the two cookies and goes to the login', async () => {
  const told = useLoginServer();
  const cookie = await sessionCookie('theme=dark');
  const response = await fetch(`${base}/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://app.example.test' }, redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/login');
  const cookies = cookiesSet(response);
  assert.deepEqual([...cookies.keys()], ['__Host-session-access', '__Host-session-refresh']);
  for (const [name, found] of cookies) assert.equal(found.text, `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
  // Only this session is ended: ChatGPT keeps its own login.
  assert.deepEqual(told.logout, [{ method: 'POST', url: '/logout?scope=local', authorization: `Bearer ${told.tokens[0]}` }]);
});

test('logout: with an access token that ran out, it renews first so that it can tell the login server', async () => {
  const told = useLoginServer();
  const cookie = await sessionCookie();
  clock += 11 * 60_000;
  const response = await fetch(`${base}/logout`, { method: 'POST', headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(told.refresh, 1);
  assert.deepEqual(told.logout.map((call) => call.authorization), [`Bearer ${told.tokens[2]}`]);
  assert.equal(cookiesSet(response).get('__Host-session-refresh').value, '', 'the renewed tokens are not given to the browser');
});

test('logout: it always ends at the login, also without a session or without a login server', async () => {
  const told = useLoginServer();
  const none = await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual' });
  assert.equal(none.status, 303);
  assert.equal(none.headers.get('location'), '/login');
  assert.equal(cookiesSet(none).size, 2);
  assert.equal(told.logout.length, 0);

  const forged = await fetch(`${base}/logout`, { method: 'POST', headers: { Cookie: `__Host-session-access=${token({}, { key: stranger.privateKey })}` }, redirect: 'manual' });
  assert.equal(forged.status, 303);
  assert.equal(told.logout.length, 0, 'a token the gateway did not check is not sent anywhere');

  const cookie = await sessionCookie();
  loginServer = (req, res) => {
    res.writeHead(500).end();
    return true;
  };
  const down = await fetch(`${base}/logout`, { method: 'POST', headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(down.status, 303);
  assert.equal(cookiesSet(down).size, 2);
});

test('logout: another site cannot log me out, and other methods are refused', async () => {
  const told = useLoginServer();
  const cookie = await sessionCookie();
  for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }]) {
    const response = await fetch(`${base}/logout`, { method: 'POST', headers: { Cookie: cookie, ...headers }, redirect: 'manual' });
    assert.equal(response.status, 403);
    assert.deepEqual(response.headers.getSetCookie(), []);
  }
  assert.equal(told.logout.length, 0);
  assert.equal((await fetch(`${base}/logout`, { method: 'DELETE' })).status, 405);
});

// ---- across everything ---------------------------------------------------------

test('no login token ever reaches the app or the bridge', async () => {
  const told = useLoginServer();
  const first = await logIn();
  const cookie = cookieHeader(first, 'theme=dark');
  const bearer = token();
  const withToken = { Cookie: cookie, Authorization: `Bearer ${told.tokens[0]}` };
  await fetch(`${base}/e/one?x=1`, { headers: withToken });
  await fetch(`${base}/e/one`, { method: 'POST', headers: withToken, body: 'answer=x' });
  await fetch(`${base}/static/app.css`, { headers: withToken });
  await fetch(`${base}/manifest.webmanifest`, { method: 'HEAD', headers: withToken });
  await callMcp(bearer, { headers: { Cookie: cookie } });
  clock += 11 * 60_000;
  const renewed = await fetch(`${base}/e/two`, { headers: { Cookie: cookie } });
  assert.equal(renewed.status, 200);
  await fetch(`${base}/e/three`, { method: 'POST', headers: { Cookie: cookieHeader(renewed) }, body: 'answer=y' });
  await callMcp(token(), { headers: { Cookie: cookieHeader(renewed) } });
  await fetch(`${base}/logout`, { method: 'POST', headers: { Cookie: cookieHeader(renewed) }, redirect: 'manual' });

  assert.equal(app.seen.length, 6);
  assert.equal(bridge.seen.length, 2);
  assert.equal(told.tokens.length, 4);
  const reached = JSON.stringify([...app.seen, ...bridge.seen]);
  for (const secret of [...told.tokens, bearer]) {
    assert.ok(!reached.includes(secret), 'a token was passed on');
  }
  for (const request of [...app.seen, ...bridge.seen]) {
    assert.equal(request.headers.authorization, undefined);
    assert.doesNotMatch(request.headers.cookie ?? '', /session-(access|refresh)/);
  }
  assert.ok(app.seen.every((request) => request.headers.cookie === 'theme=dark' || request.headers.cookie === 'a=b; theme=dark' || request.headers.cookie === 'a=b'));
});

test('the gateway\'s own pages may load nothing but the stylesheet, and are never kept', async () => {
  useLoginServer();
  const cookie = await sessionCookie();
  const pages = {
    'the login page': await fetch(`${base}/login`),
    'a failed login': await logIn({ password: 'not-the-password' }),
    'the logout page': await fetch(`${base}/logout`),
    'the 401 page': await fetch(`${base}/e/one`, { method: 'POST', body: 'a=b' }),
    'the 403 page': await fetch(`${base}/e/one`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' }, body: 'a=b' }),
    'the 403 page of the logout': await fetch(`${base}/logout`, { method: 'POST', headers: { Origin: 'https://evil.example' } }),
  };
  for (let i = 0; i < 12; i += 1) await logIn({ password: 'not-the-password' });
  pages['the 429 page'] = await logIn();
  assert.deepEqual(Object.values(pages).map((page) => page.status), [200, 401, 200, 401, 403, 403, 429]);
  for (const [name, response] of Object.entries(pages)) {
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', name);
    assert.equal(response.headers.get('content-security-policy'), OWN_PAGE_POLICY, name);
    assert.equal(response.headers.get('cache-control'), 'no-store', name);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', name);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', name);
    const page = await response.text();
    assert.match(page, /^<!doctype html><html lang=en>/, name);
    assert.match(page, /<link rel=stylesheet href="\/login\/style\.css\?v=[0-9a-z]{6,}">/, name);
    assert.doesNotMatch(page, /<script|<img|style=|https?:\/\//, name);
  }
});

test('log: one line for each request, with the kind of request and nothing of its address', async (t) => {
  useLoginServer();
  const lines = [];
  const url = await extraGateway(t, config, { log: (entry) => lines.push(entry) });
  const cookie = cookieHeader(await logIn({}, { from: url }));
  await fetch(`${url}/healthz`);
  await fetch(`${url}/login?next=%2Fe%2Fprivate-name`);
  await fetch(`${url}/e/private-name?word=private-word`, { redirect: 'manual' });
  await fetch(`${url}/e/private-name?word=private-word`, { headers: { Cookie: cookie } });
  await fetch(`${url}/static/app.css`);
  await fetch(`${url}/mcp`, { method: 'POST', body: '{}' });
  await fetch(`${url}/oauth/nothing-here`);
  await fetch(`${url}/logout`, { method: 'POST', headers: { Cookie: cookie }, redirect: 'manual' });
  // A line is written when the answer is over, which can be a moment after the answer arrived.
  for (let i = 0; i < 100 && lines.length < 9; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(lines.map((line) => `${line.route} ${line.method} ${line.status}`).sort(), [
    'app GET 200', 'app GET 200', 'app-login GET 303', 'health GET 200', 'login GET 200', 'login POST 303',
    'logout POST 303', 'mcp POST 401', 'unknown GET 404',
  ]);
  for (const line of lines) {
    // Only a refusal on /mcp says more: why.
    assert.deepEqual(Object.keys(line), line.route === 'mcp' ? ['route', 'method', 'status', 'ms', 'why'] : ['route', 'method', 'status', 'ms']);
  }
  const written = JSON.stringify(lines);
  assert.ok(!written.includes('private') && !written.includes('example.test') && !written.includes(PASSWORD));
});

test('log: a refusal on /mcp says why, and a refusal of the bridge says what was sent', async (t) => {
  const lines = [];
  const url = await extraGateway(t, config, { log: (entry) => lines.push(entry) });
  const good = token();
  const call = (headers, body) => fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body,
  }).then((response) => response.text());
  await call({}, '{}');
  await call({ Authorization: `Bearer ${token({ exp: Math.floor(clock / 1000) - 120 })}` }, '{}');
  await call({ Authorization: `Bearer ${good}` }, '{}');
  await call({
    Authorization: `Bearer ${good}`,
    Cookie: 'private=cookie',
    'User-Agent': `probe/1 ${'x'.repeat(200)}`,
    'Mcp-Protocol-Version': '2025-06-18',
    'Content-Encoding': 'identity',
  }, 'not json');
  await call({ Authorization: `Bearer ${good}` }, 'long no');
  await call({ Authorization: `Bearer ${good}`, 'User-Agent': 'openai-mcp/1.0.0', 'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' }, '{}');
  for (let i = 0; i < 100 && lines.length < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const said = lines.map(({ ms, ...rest }) => rest);
  assert.deepEqual(said.slice(0, 4), [
    { route: 'mcp', method: 'POST', status: 401, why: 'no token' },
    { route: 'mcp', method: 'POST', status: 401, why: 'The token has expired' },
    { route: 'mcp', method: 'POST', status: 200 },
    {
      route: 'mcp',
      method: 'POST',
      status: 400,
      why: 'the bridge said no',
      sent: {
        type: 'application/json',
        encoding: 'identity',
        length: '8',
        accept: 'application/json, text/event-stream',
        version: '2025-06-18',
        agent: `probe/1 ${'x'.repeat(72)}`,
        // The first bytes of the body, as numbers: "not json".
        start: '6e6f74206a736f6e',
      },
      answer: BRIDGE_REFUSAL,
    },
  ]);
  // A long answer is cut.
  assert.equal(said[4].answer, 'n'.repeat(300));
  // A version that is answered by the gateway itself: what was asked, without the body.
  assert.deepEqual(said[5], {
    route: 'mcp',
    method: 'POST',
    status: 400,
    why: 'this protocol version is not served',
    sent: {
      type: 'application/json',
      length: '2',
      accept: 'application/json, text/event-stream',
      version: '2026-07-28',
      rpc: 'server/discover',
      agent: 'openai-mcp/1.0.0',
    },
  });
  const written = JSON.stringify(lines);
  assert.ok(!written.includes(good) && !written.includes('private') && !written.includes('innersecret') && !written.includes('example.test'));
});

// ---- two public names: one for the app, one for ChatGPT ---------------------------

const MCP_BODY = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
const RESOURCE_DOCUMENTS = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'];

test('two names: the setting is optional, and the same address twice is one name', () => {
  const env = { PUBLIC_URL: 'https://a.test', AUTH_URL: 'http://auth:9999', MCP_UPSTREAM_URL: 'http://127.0.0.1:8000/mcp-x', ALLOWED_EMAILS: 'me@a.test' };
  for (const same of [undefined, '', 'https://a.test', 'https://a.test/', 'https://A.TEST', 'https://a.test:443']) {
    const settings = loadConfig({ ...env, MCP_PUBLIC_URL: same });
    assert.equal(settings.mcpPublicUrl, 'https://a.test', String(same));
    assert.equal(settings.mcpHost, null, String(same));
  }
  // The second name is kept the way a client writes it: small letters, no usual port.
  const two = loadConfig({ ...env, MCP_PUBLIC_URL: 'https://MCP.a.test:443/' });
  assert.equal(two.mcpPublicUrl, 'https://mcp.a.test');
  assert.equal(two.mcpHost, 'mcp.a.test');
  assert.equal(two.publicUrl, 'https://a.test');
  assert.equal(loadConfig({ ...env, MCP_PUBLIC_URL: 'https://a.test:8443' }).mcpHost, 'a.test:8443', 'another port is another name');
});

test('two names: refuses a second name that is not a full address, or that a Host header cannot tell from the first', () => {
  const env = { PUBLIC_URL: 'https://a.test', AUTH_URL: 'http://auth:9999', MCP_UPSTREAM_URL: 'http://127.0.0.1:8000/mcp-x', ALLOWED_EMAILS: 'me@a.test' };
  assert.throws(() => loadConfig({ ...env, MCP_PUBLIC_URL: 'mcp.a.test' }), /MCP_PUBLIC_URL/);
  assert.throws(() => loadConfig({ ...env, MCP_PUBLIC_URL: 'ftp://mcp.a.test' }), /MCP_PUBLIC_URL/);
  assert.throws(() => loadConfig({ ...env, MCP_PUBLIC_URL: 'https://mcp.a.test/mcp' }), /MCP_PUBLIC_URL/);
  // The same name with http:// and with https://: both are "Host: a.test".
  assert.throws(() => loadConfig({ ...env, MCP_PUBLIC_URL: 'http://a.test' }), /MCP_PUBLIC_URL/);
  assert.throws(() => loadConfig({ ...env, MCP_PUBLIC_URL: 'http://a.test.:80' }), /MCP_PUBLIC_URL/);
});

test('two names: on the MCP name, /mcp, the health check and the two documents answer', async (t) => {
  const names = await twoNames(t);
  const refused = await ask(names, names.mcpHost, '/mcp', { method: 'POST', body: MCP_BODY });
  assert.equal(refused.status, 401);
  assert.equal(refused.headers['www-authenticate'], `Bearer resource_metadata="${names.mcp}/.well-known/oauth-protected-resource/mcp"`);
  assert.equal((await ask(names, names.mcpHost, '/healthz')).status, 200);
  for (const path of RESOURCE_DOCUMENTS) {
    const document = await ask(names, names.mcpHost, path);
    assert.equal(document.status, 200, path);
    // The resource is on the MCP name; the login server is on the name of the app.
    assert.equal(document.json.resource, `${names.mcp}/mcp`);
    assert.deepEqual(document.json.authorization_servers, [`${names.app}/auth/v1`]);
  }
  assert.equal(bridge.seen.length, 0);
});

test('two names: a token of the login server opens the bridge on the MCP name', async (t) => {
  const names = await twoNames(t);
  const issuer = `${names.app}/auth/v1`;
  const call = (bearer) => ask(names, names.mcpHost, '/mcp', {
    method: 'POST', body: MCP_BODY, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, Cookie: 'x=y' },
  });
  const done = await call(token({ iss: issuer }));
  assert.equal(done.status, 200);
  assert.equal(done.json.url, '/mcp-innersecret');
  assert.equal(done.json.body, MCP_BODY);
  assert.equal(done.json.headers.authorization, undefined);
  assert.equal(done.json.headers.cookie, undefined);
  assert.equal(done.headers['mcp-session-id'], 'session-1');
  // The login server is the one on the name of the app: a token that names the MCP name as
  // its login server is not one of its tokens.
  for (const bad of [token({ iss: `${names.mcp}/auth/v1` }), token({ iss: issuer }, { key: stranger.privateKey }), token({ iss: issuer, email: 'second@example.test' })]) {
    const answer = await call(bad);
    assert.ok(answer.status === 401 || answer.status === 403, String(answer.status));
    if (answer.status === 401) assert.ok(answer.headers['www-authenticate'].endsWith(`resource_metadata="${names.mcp}/.well-known/oauth-protected-resource/mcp"`));
  }
  assert.equal(bridge.seen.length, 1);
});

test('two names: on the MCP name nothing else answers: no app, no login, no login server, no file', async (t) => {
  const names = await twoNames(t);
  const closed = [
    ['GET', '/'], ['GET', '/x'], ['GET', '/e/one'], ['GET', '/n/note'], ['GET', '/theme/dark'], ['GET', '/offline.json'],
    ['GET', '/static/app.css'], ['GET', '/manifest.webmanifest'], ['GET', '/sw.js'], ['GET', '/offline'],
    ['GET', '/login'], ['POST', '/login'], ['GET', '/logout'], ['POST', '/logout'],
    ['GET', '/oauth/consent'], ['GET', '/oauth/consent.js'], ['GET', '/oauth/consent.css'],
    ['GET', '/auth/v1/.well-known/jwks.json'], ['GET', '/auth/v1/.well-known/openid-configuration'], ['GET', '/auth/v1/oauth/authorize?client_id=abc'],
    ['POST', '/auth/v1/oauth/token'], ['POST', '/auth/v1/oauth/clients/register'], ['POST', '/auth/v1/token?grant_type=password'],
    ['GET', '/.well-known/oauth-authorization-server/auth/v1'], ['GET', '/.well-known/openid-configuration/auth/v1'],
    ['GET', '/mcp/'], ['GET', '/mcp-innersecret'], ['POST', '/e/one'], ['GET', '/healthz/x'],
  ];
  for (const [method, path] of closed) {
    const answer = await ask(names, names.mcpHost, path, { method, body: method === 'POST' ? 'email=me%40example.test&password=x' : undefined });
    assert.equal(answer.status, 404, `${method} ${path}`);
    assert.deepEqual(answer.json, { error: 'not_found' }, `${method} ${path}`);
    assert.equal(answer.headers['set-cookie'], undefined);
    assert.equal(answer.headers.location, undefined);
  }
  assert.equal(app.seen.length + auth.seen.length + bridge.seen.length, 0, 'nothing was passed on');
});

test('two names: on the name of the app everything answers as before, but not /mcp and its documents', async (t) => {
  const names = await twoNames(t);
  const issuer = `${names.app}/auth/v1`;
  useLoginServer({ access: (email) => token({ email, iss: issuer }) });
  const onApp = (path, options) => ask(names, names.appHost, path, options);

  assert.equal((await onApp('/healthz')).status, 200);
  assert.match((await onApp('/login')).text, /<form class=login method=post action="\/login">/);
  assert.equal((await onApp('/oauth/consent')).status, 200);
  assert.equal((await onApp('/static/app.css')).json.url, '/static/app.css');
  assert.equal((await onApp('/e/one')).headers.location, '/login?next=%2Fe%2Fone');
  assert.equal((await onApp('/auth/v1/oauth/authorize?client_id=abc')).json.url, '/oauth/authorize?client_id=abc');
  assert.equal((await onApp('/.well-known/oauth-authorization-server/auth/v1')).json.url, '/.well-known/oauth-authorization-server');
  assert.equal((await onApp('/auth/v1/admin/users')).status, 404);

  // The login, and a page with the session.
  const form = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: names.app }, body: `email=me%40example.test&password=${PASSWORD}&next=%2Fe%2Fone` };
  const done = await onApp('/login', form);
  assert.equal(done.status, 303);
  assert.equal(done.headers.location, '/e/one');
  const cookie = done.headers['set-cookie'].map((line) => line.split(';')[0]).join('; ');
  assert.match(cookie, /^session-access=[^;]+; session-refresh=[^;]+$/);
  assert.equal((await onApp('/e/one', { headers: { Cookie: cookie } })).json.url, '/e/one');
  assert.equal((await onApp('/e/one', { method: 'POST', headers: { Cookie: cookie, Origin: names.app }, body: 'a=b' })).status, 200);
  // The address of the MCP name is another site for the app.
  assert.equal((await onApp('/e/one', { method: 'POST', headers: { Cookie: cookie, Origin: names.mcp }, body: 'a=b' })).status, 403);

  // /mcp and its documents are not here: not without a token, not with a good one, not with the session.
  bridge.seen.length = 0;
  for (const headers of [{}, { Authorization: `Bearer ${token({ iss: issuer })}` }, { Cookie: cookie }]) {
    for (const [method, path] of [['POST', '/mcp'], ['GET', '/mcp'], ['DELETE', '/mcp'], ...RESOURCE_DOCUMENTS.map((document) => ['GET', document])]) {
      const answer = await onApp(path, { method, headers, body: method === 'POST' ? MCP_BODY : undefined });
      assert.equal(answer.status, 404, `${method} ${path}`);
      assert.deepEqual(answer.json, { error: 'not_found' });
      assert.equal(answer.headers['www-authenticate'], undefined);
    }
  }
  assert.equal(bridge.seen.length, 0);
});

test('two names: the session of the app opens nothing on the MCP name', async (t) => {
  const names = await twoNames(t);
  const issuer = `${names.app}/auth/v1`;
  const told = useLoginServer({ access: (email) => token({ email, iss: issuer }) });
  const done = await ask(names, names.appHost, '/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `email=me%40example.test&password=${PASSWORD}`,
  });
  const cookie = done.headers['set-cookie'].map((line) => line.split(';')[0]).join('; ');
  app.seen.length = 0;
  for (const [method, path] of [['GET', '/'], ['GET', '/e/one'], ['POST', '/e/one'], ['GET', '/static/app.css'], ['POST', '/logout'], ['GET', '/login']]) {
    const answer = await ask(names, names.mcpHost, path, { method, headers: { Cookie: cookie }, body: method === 'POST' ? 'a=b' : undefined });
    assert.equal(answer.status, 404, `${method} ${path}`);
    assert.equal(answer.headers['set-cookie'], undefined, 'the cookies are not even cleared here');
  }
  // With only the refresh cookie, the gateway does not ask the login server for a new session there.
  const [, refresh] = told.tokens;
  assert.equal((await ask(names, names.mcpHost, '/e/one', { headers: { Cookie: `session-refresh=${refresh}` } })).status, 404);
  assert.equal(told.refresh, 0);
  // A cookie is not a token: /mcp still wants its own.
  const mcp = await ask(names, names.mcpHost, '/mcp', { method: 'POST', headers: { Cookie: cookie }, body: MCP_BODY });
  assert.equal(mcp.status, 401);
  assert.equal(app.seen.length + bridge.seen.length, 0);
  assert.equal(told.logout.length, 0);
});

test('two names: the name in "Host" is read without looking at capital letters or a dot at the end', async (t) => {
  const names = await twoNames(t);
  for (const host of [`LOCALHOST:${names.port}`, `LocalHost:${names.port}`, `localhost.:${names.port}`, `LOCALHOST.:${names.port}`]) {
    assert.equal((await ask(names, host, '/mcp', { method: 'POST', body: MCP_BODY })).status, 401, host);
    assert.equal((await ask(names, host, '/.well-known/oauth-protected-resource')).json.resource, `${names.mcp}/mcp`, host);
    assert.equal((await ask(names, host, '/login')).status, 404, host);
  }
});

test('two names: any other "Host", or none, is the name of the app', async (t) => {
  const names = await twoNames(t);
  const others = [
    '10.42.0.17:9000', 'evil.example', `evil.example:${names.port}`, `localhost.evil.example:${names.port}`, `notlocalhost:${names.port}`,
    // The right name with another port, or without one, is not the MCP name either.
    'localhost', 'localhost:1', `localhost:${names.port}0`, `[::1]:${names.port}`, `localhost..:${names.port}`, `localhost:${names.port}@x`, 'localhost:port',
  ];
  for (const host of others) {
    assert.equal((await ask(names, host, '/healthz')).status, 200, host);
    assert.equal((await ask(names, host, '/login')).status, 200, host);
    assert.equal((await ask(names, host, '/static/app.css')).status, 200, host);
    assert.equal((await ask(names, host, '/mcp', { method: 'POST', body: MCP_BODY })).status, 404, host);
    assert.equal((await ask(names, host, '/.well-known/oauth-protected-resource')).status, 404, host);
  }
  // A program so old that it sends no "Host" at all.
  assert.equal(await statusWithoutHost(names, '/healthz'), 200);
  assert.equal(await statusWithoutHost(names, '/login'), 200);
  assert.equal(await statusWithoutHost(names, '/mcp'), 404);
  assert.equal(bridge.seen.length, 0);
});

test('two names: "X-Forwarded-Host" is not believed', async (t) => {
  const names = await twoNames(t);
  // A visitor of the app who says "I came for the MCP name" is still on the app.
  const pretend = { 'X-Forwarded-Host': names.mcpHost, Forwarded: `host=${names.mcpHost}`, 'X-Host': names.mcpHost, 'X-Original-Host': names.mcpHost };
  assert.equal((await ask(names, names.appHost, '/login', { headers: pretend })).status, 200);
  assert.equal((await ask(names, names.appHost, '/mcp', { method: 'POST', headers: pretend, body: MCP_BODY })).status, 404);
  // And the other way round.
  const back = { 'X-Forwarded-Host': names.appHost, Forwarded: `host=${names.appHost}`, 'X-Host': names.appHost, 'X-Original-Host': names.appHost };
  assert.equal((await ask(names, names.mcpHost, '/login', { headers: back })).status, 404);
  assert.equal((await ask(names, names.mcpHost, '/mcp', { method: 'POST', headers: back, body: MCP_BODY })).status, 401);
});

test('two names: with https names, the usual port of https counts as no port', async (t) => {
  const url = await extraGateway(t, loadConfig({
    PUBLIC_URL: 'https://app.example.test',
    MCP_PUBLIC_URL: 'https://mcp.example.test',
    AUTH_URL: config.authUrl,
    MCP_UPSTREAM_URL: config.mcpUpstreamUrl,
    APP_UPSTREAM_URL: config.appUpstreamUrl,
    ALLOWED_EMAILS: 'me@example.test',
  }));
  const names = { port: Number(new URL(url).port) };
  for (const host of ['mcp.example.test', 'mcp.example.test:443', 'MCP.Example.Test.', 'mcp.example.test.:443']) {
    const refused = await ask(names, host, '/mcp', { method: 'POST', body: MCP_BODY });
    assert.equal(refused.status, 401, host);
    assert.equal(refused.headers['www-authenticate'], 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"');
    assert.equal((await ask(names, host, '/login')).status, 404, host);
    assert.equal((await ask(names, host, '/mcp', { method: 'POST', body: MCP_BODY, headers: { Authorization: `Bearer ${token()}` } })).status, 200, host);
  }
  for (const host of ['app.example.test', 'app.example.test:443', 'mcp.example.test:80', 'mcp.example.test:8443', 'mcp.example.test.evil.example', 'xmcp.example.test']) {
    assert.equal((await ask(names, host, '/mcp', { method: 'POST', body: MCP_BODY })).status, 404, host);
    assert.equal((await ask(names, host, '/login')).status, 200, host);
  }
});

test('two names: a real client reaches each name at its own address', async (t) => {
  const names = await twoNames(t);
  assert.equal((await fetch(`${names.mcp}/mcp`, { method: 'POST', body: MCP_BODY })).status, 401);
  assert.equal((await fetch(`${names.mcp}/login`)).status, 404);
  assert.equal((await fetch(`${names.app}/login`)).status, 200);
  assert.equal((await fetch(`${names.app}/mcp`, { method: 'POST', body: MCP_BODY })).status, 404);
  const document = await (await fetch(`${names.mcp}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual([document.resource, document.authorization_servers[0]], [`${names.mcp}/mcp`, `${names.app}/auth/v1`]);
});

test('two names: the log line does not say which name was asked', async (t) => {
  const lines = [];
  const names = await twoNames(t, { log: (entry) => lines.push(entry) });
  await ask(names, names.mcpHost, '/mcp', { method: 'POST', body: MCP_BODY });
  await ask(names, names.mcpHost, '/login');
  await ask(names, names.appHost, '/mcp', { method: 'POST', body: MCP_BODY });
  await ask(names, names.appHost, '/login');
  for (let i = 0; i < 100 && lines.length < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(lines.map((line) => `${line.route} ${line.method} ${line.status}`).sort(), ['login GET 200', 'mcp POST 401', 'unknown GET 404', 'unknown POST 404']);
  for (const line of lines) {
    const { ms, ...rest } = line;
    assert.equal(typeof ms, 'number');
    // The refusal on /mcp says why, and that is all.
    if (line.route === 'mcp') assert.deepEqual(rest, { route: 'mcp', method: 'POST', status: 401, why: 'no token' });
    else assert.deepEqual(Object.keys(line), ['route', 'method', 'status', 'ms']);
  }
});

// ---- the settings of one app ---------------------------------------------------------------

const BASE_ENV = { PUBLIC_URL: 'https://a.test', AUTH_URL: 'http://auth:9999', MCP_UPSTREAM_URL: 'http://127.0.0.1:8000/mcp-x', ALLOWED_EMAILS: 'me@a.test' };

test('settings: the name of the app is one short line, and "App" when it is not set', () => {
  assert.equal(loadConfig(BASE_ENV).appTitle, 'App');
  assert.equal(loadConfig({ ...BASE_ENV, APP_TITLE: '   ' }).appTitle, 'App');
  assert.equal(loadConfig({ ...BASE_ENV, APP_TITLE: '  Notes \n  & <Co>  ' }).appTitle, 'Notes & <Co>');
  assert.equal(loadConfig({ ...BASE_ENV, APP_TITLE: 'x'.repeat(60) }).appTitle.length, 60);
  assert.throws(() => loadConfig({ ...BASE_ENV, APP_TITLE: 'x'.repeat(61) }), /APP_TITLE/);
});

test('settings: the name of the app is written into every page as text, never as HTML', async (t) => {
  useLoginServer();
  const url = await extraGateway(t, { ...config, appTitle: 'Notes & <b>Co</b> "x"' });
  const name = 'Notes &amp; &lt;b&gt;Co&lt;/b&gt; &quot;x&quot;';
  const login = await (await fetch(`${url}/login`)).text();
  assert.ok(login.includes(`<p class=app>${name}</p>`), login);
  const logout = await (await fetch(`${url}/logout`)).text();
  assert.ok(logout.includes(`<h1>${name}</h1>`) && logout.includes(`You are logged in to ${name} on this device.`));
  const refused = await (await fetch(`${url}/e/one`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: 'a=b' })).text();
  assert.ok(refused.includes(`Back to ${name}`));
  const consent = await (await fetch(`${url}/oauth/consent`)).text();
  assert.ok(consent.includes(`<title>${name}: allow an app</title>`) && consent.includes(`<h1>${name}</h1>`));
  for (const page of [login, logout, refused, consent]) {
    assert.ok(!page.includes('<b>Co') && !page.includes('{{APP_TITLE}}'));
  }
});

test('settings: OPEN_PATHS says which paths of the app need no login', async (t) => {
  // Not set: only what is under /static/.
  assert.deepEqual(loadConfig(BASE_ENV).openPaths, ['/static/']);
  assert.deepEqual(loadConfig({ ...BASE_ENV, OPEN_PATHS: ' /static/ , /favicon.ico,,' }).openPaths, ['/static/', '/favicon.ico']);
  for (const bad of ['static/', '/a/../b', '/a//b', '/a b', '/a?x=1', '/%2e%2e/']) {
    assert.throws(() => loadConfig({ ...BASE_ENV, OPEN_PATHS: bad }), /OPEN_PATHS/, bad);
  }

  const usual = await extraGateway(t, { ...config, openPaths: ['/static/'] });
  const status = async (url, path) => (await fetch(`${url}${path}`, { redirect: 'manual' })).status;
  assert.equal(await status(usual, '/static/app.css'), 200);
  assert.equal(await status(usual, '/static/fonts/a.woff2'), 200);
  for (const path of ['/static', '/static/', '/manifest.webmanifest', '/sw.js', '/staticx/app.css', '/', '/notes']) {
    assert.equal(await status(usual, path), 303, path);
  }

  // An entry that ends with "/" opens what is under it; any other entry is one exact path.
  const other = await extraGateway(t, { ...config, openPaths: ['/public/', '/favicon.ico'] });
  for (const path of ['/public/a.css', '/public/img/a.png', '/favicon.ico']) assert.equal(await status(other, path), 200, path);
  for (const path of ['/static/app.css', '/favicon.icon', '/favicon.ico/x', '/publicity', '/public/../notes', '/public/%2e%2e/notes', '/public//a']) {
    assert.equal(await status(other, path), 303, path);
  }
  // Open is for reading only.
  assert.equal((await fetch(`${other}/public/a.css`, { method: 'POST', body: 'a=b' })).status, 401);
});

test('settings: MCP_VERSIONS says which protocol versions go on to the bridge', async (t) => {
  assert.deepEqual(loadConfig(BASE_ENV).mcpVersions, ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);
  assert.deepEqual(loadConfig({ ...BASE_ENV, MCP_VERSIONS: '2026-07-28, 2025-11-25' }).mcpVersions, ['2026-07-28', '2025-11-25']);
  for (const bad of ['latest', '2025-11', '2025-11-25;2025-06-18', '25-11-2025']) {
    assert.throws(() => loadConfig({ ...BASE_ENV, MCP_VERSIONS: bad }), /MCP_VERSIONS/, bad);
  }
  const url = await extraGateway(t, { ...config, mcpVersions: ['2026-07-28', '2025-11-25'] });
  const ask = (version) => fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Protocol-Version': version },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });
  assert.equal((await ask('2026-07-28')).status, 200);
  assert.equal((await ask('2025-11-25')).status, 200);
  const refused = await ask('2025-06-18');
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), {
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Bad Request: Unsupported protocol version: 2025-06-18 (supported versions: 2026-07-28, 2025-11-25)' },
    id: null,
  });
});

test('the stylesheet of the gateway pages is a file of the gateway, open to everybody', async (t) => {
  const response = await fetch(`${base}/login/style.css`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const css = await response.text();
  assert.match(css, /prefers-color-scheme: dark/);
  assert.doesNotMatch(css, /url\(|@import|https?:/, 'it loads nothing from anywhere');
  assert.equal(app.seen.length, 0, 'the app is not asked for it');
  assert.equal((await fetch(`${base}/login/style.css`, { method: 'POST' })).status, 405);
  // Nothing else under /login is the gateway's: it goes to the app, behind the login.
  assert.equal((await fetch(`${base}/login/other.css`, { redirect: 'manual' })).status, 303);
  // On the name for the MCP client there is no login page, so no stylesheet either.
  const names = await twoNames(t);
  assert.equal((await ask(names, names.appHost, '/login/style.css')).status, 200);
  assert.equal((await ask(names, names.mcpHost, '/login/style.css')).status, 404);
});

test('health: answers without a token', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});
