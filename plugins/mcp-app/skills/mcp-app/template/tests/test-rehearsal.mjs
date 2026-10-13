// The whole pod, for real, on this laptop. Run: node --test tests/test-rehearsal.mjs
//
// It builds the pod of k8s/pod.yaml out of Docker containers. The gateway, the login server
// (Supabase Auth), the bridge and a stand-in for the web app share one network address, as
// the containers of a pod do, and each gets the settings that pod.yaml gives it. The database
// is a plain postgres:16 whose only user is "tenant" and that has no role "postgres": the
// hardest case of POSTGRES_MODE=existing. It is prepared with k8s/auth-db.sql, the way
// k8s/deploy.sh does it.
//
// Then the test plays an MCP client such as ChatGPT (find the login server, register, log in,
// allow, get a token, use the bridge) and a browser (log in to the web app, use it, renew the
// session, log out). At the end the example app of app/ takes the place of the stand-in.
//
// The pod has two public names, as on a cluster, and one port. Here the two names are two
// ways to write this laptop: "127.0.0.1" is the name of the app and the login, "localhost"
// is the name for MCP. The MCP client is played against the second, the browser against the first.
// Needs Docker. Takes a minute or two. Everything it starts is removed at the end.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { makeSecrets, roleToken } from '../k8s/secrets.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DB_IMAGE = 'postgres:16';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const EMAIL = 'me@example.test';
const GUEST = { email: 'guest@example.test', password: 'guest-password-123456' };

// Names that no other run and no other program on this laptop uses.
const id = `mcp-app-test-rehearsal-${process.pid}-${randomBytes(3).toString('hex')}`;
const names = { net: id, db: `${id}-db`, gateway: `${id}-gateway`, auth: `${id}-auth`, bridge: `${id}-bridge`, app: `${id}-app`, cleaner: `${id}-cleaner` };
const secrets = makeSecrets(EMAIL);

// The settings of the app (settings.env), read line by line as the scripts read them.
const SET = Object.fromEntries(readFileSync(join(ROOT, 'settings.env'), 'utf8').split('\n')
  .map((line) => /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)).filter(Boolean)
  .map(([, name, value]) => [name, value.trim().replace(/^"(.*)"$|^'(.*)'$/, '$1$2')]));
const APP_NAME = SET.APP_NAME;
// The database of the login server and its user, named as k8s/lib.sh names them.
const DB = APP_NAME.replaceAll('-', '_');
const ROLE = `${DB}_auth`;
// What k8s/deploy.sh fills in in pod.yaml, for this test: the names of the settings, and the
// name that the test database has in the test network.
const FILLED = {
  APP_NAME, APP_TITLE: SET.APP_TITLE, DB_NAME: DB, DB_ROLE: ROLE, POSTGRES_SERVICE: 'postgres',
  MCP_COMMAND: SET.MCP_COMMAND, MCP_VERSIONS: SET.MCP_VERSIONS, OPEN_PATHS: SET.OPEN_PATHS,
};
const state = {};
let work;
let space;
// The address of the app and the login, and the address for ChatGPT.
let publicUrl;
let mcpUrl;

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function dockerWorks() {
  try {
    docker('version', '--format', '{{.Server.Version}}');
    return true;
  } catch {
    return false;
  }
}

// Removes everything this test started. It runs at the end, and also when the setup fails,
// when the run is stopped with Ctrl-C, and when the program ends in any other way.
let cleaned = false;
function cleanUp() {
  if (cleaned) return;
  cleaned = true;
  // The containers that share the address of the gateway go first. "-v": also their unnamed volumes.
  for (const name of [names.app, names.bridge, names.auth, names.gateway, names.db, names.cleaner]) {
    try { docker('rm', '-f', '-v', name); } catch { /* it was never started */ }
  }
  try { docker('network', 'rm', names.net); } catch { /* it was never made */ }
  if (!work) return;
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // Files written by the bridge can belong to the user of the container: remove them from a container.
    try { docker('run', '--rm', '--name', names.cleaner, '-v', `${work}:/work`, DB_IMAGE, 'rm', '-rf', '/work/data'); } catch { /* best effort */ }
    rmSync(work, { recursive: true, force: true });
  }
}
process.on('exit', cleanUp);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanUp();
    process.exit(1);
  });
}

// The last lines that each container wrote: shown when the setup fails.
function showLogs() {
  for (const name of [names.db, names.gateway, names.auth, names.bridge, names.app]) {
    const logs = spawnSync('docker', ['logs', '--tail', '15', name], { encoding: 'utf8' });
    if (logs.status === 0) console.error(`---- ${name}\n${logs.stdout}${logs.stderr}`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(label, check, seconds = 60) {
  for (let i = 0; i < seconds * 2; i += 1) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not start within ${seconds} seconds`);
}

// True when the address answers 200. A plain HTTP request, not fetch: against a Docker
// port whose program is still starting, fetch can stay silent for ever.
function answers(url) {
  return new Promise((resolve) => {
    const request = httpGet(url, (answer) => {
      answer.resume();
      resolve(answer.statusCode === 200);
    });
    request.setTimeout(2000, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

// One container of the pod, as k8s/pod.yaml describes it: its image and its settings. A
// secret comes from k8s/secrets.mjs, the two host names become the two addresses of this
// test, and the other ${NAME} values are filled in as k8s/deploy.sh fills them in.
// "$(NAME)" is the value of a setting named earlier, as Kubernetes fills it in.
function fromPodYaml(container) {
  const yaml = readFileSync(join(ROOT, 'k8s/pod.yaml'), 'utf8');
  const start = yaml.indexOf(`\n        - name: ${container}\n`);
  assert.notEqual(start, -1, `pod.yaml has no container "${container}"`);
  const rest = yaml.slice(start + 1);
  const block = rest.slice(0, rest.slice(1).search(/^ {8}- name: |^ {6}volumes:/m) + 1);
  const env = {};
  for (const [, name, kind, text] of block.matchAll(/^ {12}- name: (\S+)\n {14}(value|valueFrom): (.*)$/gm)) {
    if (kind === 'value') {
      env[name] = text.replace(/^"(.*)"$/, '$1')
        .replaceAll('https://${APP_HOST}', publicUrl)
        .replaceAll('https://${MCP_HOST}', mcpUrl)
        .replace(/\$\{(\w+)\}/g, (all, setting) => {
          assert.ok(setting in FILLED, `${container}: ${name} uses \${${setting}}, which this test does not fill in`);
          return FILLED[setting];
        })
        .replace(/\$\((\w+)\)/g, (_, other) => env[other]);
    } else {
      const key = /^\{ secretKeyRef: \{ name: \$\{APP_NAME\}, key: (\w+) \} \}$/.exec(text)?.[1];
      assert.ok(key in secrets, `${container}: ${name} wants a secret that k8s/secrets.mjs does not make`);
      env[name] = secrets[key];
    }
  }
  const probe = /readinessProbe:\n\s+exec: \{ command: \[(.*)\] \}/.exec(block)?.[1];
  return {
    image: /^ {10}image: (\S+)$/m.exec(block)[1],
    env,
    // The health check that the kubelet runs inside the container.
    probe: probe?.split(', ').map((word) => word.replace(/^"(.*)"$/, '$1')),
  };
}

// The psql command of k8s/deploy.sh, read from the script itself.
const PSQL_IN_POD = /^PSQL_IN_POD='(.*)'$/m.exec(readFileSync(join(ROOT, 'k8s/deploy.sh'), 'utf8'))[1];

// Runs k8s/auth-db.sql the way k8s/deploy.sh does: psql inside the database container, as the
// superuser of that database, with the password as a psql variable on standard input.
// Returns { status, stdout, stderr }. A password of null leaves the variable out.
function prepareDatabase(password) {
  const file = readFileSync(join(ROOT, 'k8s/auth-db.sql'), 'utf8');
  const names_ = `\\set db_name '${DB}'\n\\set db_role '${ROLE}'\n`;
  const input = (password === null ? '' : `\\set auth_password '${password}'\n`) + names_ + file;
  return spawnSync('docker', ['exec', '-i', names.db, 'sh', '-c', PSQL_IN_POD], { input, encoding: 'utf8' });
}

// One question to the database server, as its superuser.
function sql(database, query) {
  return docker('exec', names.db, 'psql', '-X', '-h', '127.0.0.1', '-U', 'tenant', '-d', database, '-tAc', query);
}

// One question as the user of the login server, with a password, over the network: this
// is how the login server itself gets in. The password travels in the environment.
function sqlAsAuthUser(password, database, query) {
  return spawnSync('docker', ['exec', '-e', 'PGPASSWORD', names.db, 'psql', '-X', '-h', 'postgres', '-U', ROLE, '-d', database, '-tAc', query], {
    encoding: 'utf8', env: { ...process.env, PGPASSWORD: password },
  });
}

// What the database server looks like: its users, its databases, and what is in the two
// databases that matter. (Not the stored form of a password: that is new after every run.)
function snapshot() {
  const schemas = "select n.nspname || ' owner=' || pg_get_userbyid(n.nspowner) || ' things=' || (select count(*) from pg_class c where c.relnamespace = n.oid)"
    + " from pg_namespace n where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' order by 1";
  const databases = sql('tenant', "select datname || ' owner=' || pg_get_userbyid(datdba) || ' rights=' || coalesce(datacl::text, 'default') from pg_database order by 1");
  return {
    users: sql('tenant', "select rolname || ' login=' || rolcanlogin || ' super=' || rolsuper || ' createdb=' || rolcreatedb || ' createrole=' || rolcreaterole"
      + " || ' password=' || (rolpassword is not null) from pg_authid where rolname !~ '^pg_' order by 1").split('\n'),
    databases: databases.split('\n'),
    settings: sql('tenant', "select coalesce(d.datname, '*') || '/' || coalesce(r.rolname, '*') || ' ' || array_to_string(s.setconfig, ',')"
      + ' from pg_db_role_setting s left join pg_database d on d.oid = s.setdatabase left join pg_roles r on r.oid = s.setrole order by 1').split('\n').filter(Boolean),
    tenant: sql('tenant', schemas).split('\n'),
    own: new RegExp(`^${DB} `, 'm').test(databases) ? sql(DB, schemas).split('\n') : null,
  };
}

// Runs a few lines of JavaScript inside the pod, in the gateway container, and returns what
// they print. The lines come in on standard input, as in k8s/deploy.sh.
function inPod(code) {
  return execFileSync('docker', ['exec', '-i', names.gateway, 'node', '--input-type=module', '-'], {
    input: code, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

// The way k8s/deploy.sh makes the user: k8s/create-user.mjs runs inside the pod, with its
// three secrets written in front of it. The address of the login server is the container's own.
function createUser(password) {
  const settings = JSON.stringify({ SERVICE_KEY: secrets.AUTH_SERVICE_KEY, LOGIN_EMAIL: EMAIL, LOGIN_PASSWORD: password });
  return inPod(`Object.assign(process.env, ${settings});\n${readFileSync(join(ROOT, 'k8s/create-user.mjs'), 'utf8')}`);
}

// One request to the login server from inside the pod: from outside it cannot be reached.
function callAuthInPod(path, { method = 'GET', token, json } = {}) {
  const options = {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  };
  return JSON.parse(inPod(`
    const response = await fetch(${JSON.stringify(`http://127.0.0.1:9999${path}`)}, ${JSON.stringify(options)});
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    console.log(JSON.stringify({ status: response.status, data }));`));
}

// True when a program listens on that port inside the pod.
function listensInPod(port) {
  return inPod(`
    import { connect } from 'node:net';
    const socket = connect(${port}, '127.0.0.1');
    socket.on('connect', () => { console.log('yes'); socket.end(); });
    socket.on('error', () => console.log('no'));`) === 'yes';
}

// True when another pod of the same network can connect to that port of this pod.
function reachableFromAnotherPod(port) {
  const tried = spawnSync('docker', ['exec', names.db, 'timeout', '5', 'bash', '-c', `exec 3<>/dev/tcp/${names.gateway}/${port}`], { encoding: 'utf8' });
  return tried.status === 0;
}

// The stand-in for the web app: it answers with what it received. Inside the pod only, like the app.
const APP_STAND_IN = `
  require('node:http').createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'theme=dark; Path=/' });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
    });
  }).listen(8080, '127.0.0.1');`;

function envFile(name, values) {
  const path = join(work, name);
  writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
  return path;
}

async function call(url, { method = 'GET', token, json, form, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    redirect: 'manual',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON: the caller looks at the text.
  }
  return { status: response.status, headers: response.headers, data, text };
}

// One MCP request through the gateway, at the name for ChatGPT. The bridge answers with JSON
// or with a stream.
async function mcp(token, method, params = {}) {
  const response = await call(`${mcpUrl}/mcp`, {
    method: 'POST',
    token,
    json: { jsonrpc: '2.0', id: 1, method, params },
    headers: { Accept: 'application/json, text/event-stream' },
  });
  if (response.status !== 200) return response;
  const line = response.text.split('\n').find((l) => l.startsWith('data: '));
  return { status: 200, data: response.data ?? JSON.parse(line.slice(6)) };
}

function claims(token) {
  const [head, body] = token.split('.').slice(0, 2).map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()));
  return { head, body };
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

// What a browser does with the login form of the web app.
function logInToApp(email, password, next = '/') {
  return call(`${publicUrl}/login`, { method: 'POST', form: { email, password, next } });
}

// What ChatGPT does after the user pressed "Connect": ask, log in, allow, get the tokens.
async function login({ clientId, scope, password = secrets.LOGIN_PASSWORD, action = 'approve' }) {
  const verifier = randomBytes(40).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'state-1',
    resource: `${mcpUrl}/mcp`,
    ...(scope ? { scope } : {}),
  });
  const asked = await call(`${state.metadata.authorization_endpoint}?${query}`);
  assert.equal(asked.status, 302);
  const consentPage = asked.headers.get('location');
  assert.ok(consentPage.startsWith(`${publicUrl}/oauth/consent?authorization_id=`), consentPage);
  const authorizationId = new URL(consentPage).searchParams.get('authorization_id');

  const session = await call(`${publicUrl}/auth/v1/token?grant_type=password`, { method: 'POST', json: { email: EMAIL, password } });
  if (session.status !== 200) return { loginStatus: session.status };
  const userToken = session.data.access_token;

  const details = await call(`${publicUrl}/auth/v1/oauth/authorizations/${authorizationId}`, { token: userToken });
  assert.equal(details.status, 200);
  let back = details.data.redirect_url;
  if (!back) {
    const answer = await call(`${publicUrl}/auth/v1/oauth/authorizations/${authorizationId}/consent`, {
      method: 'POST', token: userToken, json: { action },
    });
    assert.equal(answer.status, 200);
    back = answer.data.redirect_url;
  }
  const result = new URL(back);
  assert.equal(`${result.origin}${result.pathname}`, REDIRECT);
  const code = result.searchParams.get('code');
  if (!code) return { consentPage, details: details.data, error: result.searchParams.get('error') };
  assert.equal(result.searchParams.get('state'), 'state-1');

  const exchange = (codeVerifier) => call(state.metadata.token_endpoint, {
    method: 'POST',
    form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: codeVerifier, resource: `${mcpUrl}/mcp` },
  });
  return { consentPage, details: details.data, code, exchange, verifier, userToken };
}

async function start() {
  work = mkdtempSync(join(tmpdir(), 'mcp-app-test-rehearsal-'));
  // The containers run as another user than the one of this test.
  space = join(work, 'data');
  mkdirSync(join(space, 'notes'), { recursive: true });
  chmodSync(work, 0o755);
  chmodSync(space, 0o777);
  chmodSync(join(space, 'notes'), 0o777);
  writeFileSync(join(space, 'hello.md'), '# Hello from the volume\n', { mode: 0o666 });
  const port = await freePort();
  publicUrl = `http://127.0.0.1:${port}`;
  mcpUrl = `http://localhost:${port}`;

  // The Postgres of the cluster: its superuser is "tenant" and there is no role "postgres".
  // In the network it has the name that the Service has on the cluster.
  docker('network', 'create', names.net);
  docker('run', '-d', '--name', names.db, '--network', names.net, '--network-alias', 'postgres',
    '--env-file', envFile('db.env', { POSTGRES_USER: 'tenant', POSTGRES_PASSWORD: randomBytes(16).toString('hex'), POSTGRES_DB: 'tenant' }), DB_IMAGE);
  // "-h 127.0.0.1": while the image prepares itself, Postgres answers on its socket only.
  await waitFor('The database', async () => sql('tenant', 'select 1') === '1');

  // k8s/auth-db.sql, the way k8s/deploy.sh runs it. First without a password: it must refuse.
  state.fresh = snapshot();
  state.refused = { noPassword: prepareDatabase(null), shortPassword: prepareDatabase('short'), after: snapshot() };
  const prepared = prepareDatabase(secrets.AUTH_DB_PASSWORD);
  assert.equal(prepared.status, 0, `k8s/auth-db.sql failed: ${prepared.stderr}`);
  state.prepared = { ...prepared, after: snapshot() };

  // The pod. The gateway is started first and the others move in at its network address, so
  // that 127.0.0.1 is the same place for all of them, as in a pod.
  // Locked like on the cluster: not root, no extra rights, nothing writable but the files and /tmp.
  const locked = ['--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only'];
  const inThePod = ['--network', `container:${names.gateway}`, ...locked];
  const [gateway, auth, bridge] = ['gateway', 'auth', 'bridge'].map(fromPodYaml);
  assert.equal(gateway.env.PUBLIC_URL, publicUrl, 'pod.yaml was not read');
  assert.equal(gateway.env.MCP_PUBLIC_URL, mcpUrl, 'pod.yaml gives the gateway no second name');
  state.auth = auth;
  const bridgeImage = docker('build', '-q', join(ROOT, 'bridge'));
  state.bridgeImage = bridgeImage;
  const gatewayImage = docker('build', '-q', join(ROOT, 'gateway'));
  docker('run', '-d', '--init', '--name', names.gateway, '--network', names.net, ...locked, '-p', `${new URL(publicUrl).host}:9000`,
    '--env-file', envFile('gateway.env', gateway.env), gatewayImage);
  docker('run', '-d', '--name', names.auth, ...inThePod, '--env-file', envFile('auth.env', auth.env), auth.image);
  docker('run', '-d', '--init', '--name', names.bridge, ...inThePod, '--tmpfs', '/tmp', '-v', `${space}:/data`,
    '--env-file', envFile('bridge.env', bridge.env), bridgeImage);
  docker('run', '-d', '--init', '--name', names.app, ...inThePod, '--entrypoint', 'node', gatewayImage, '-e', APP_STAND_IN);

  await waitFor('The gateway', () => answers(`${publicUrl}/healthz`));
  // The login server is ready when the health check of pod.yaml says so.
  await waitFor('Supabase Auth', async () => docker('exec', names.auth, ...auth.probe) === '');
  await waitFor('The bridge', async () => listensInPod(8000));
  await waitFor('The stand-in for the app', async () => listensInPod(8080));

  assert.match(createUser(secrets.LOGIN_PASSWORD), /the user is created/);
}

const skip = dockerWorks() ? false : 'Docker is not running';

before(async () => {
  if (skip) return;
  try {
    await start();
  } catch (error) {
    showLogs();
    cleanUp();
    throw error;
  }
});

after(() => {
  if (!skip) cleanUp();
});

// ---- the database: the Postgres that is already there ------------------------------

test('the test database is like the one of the cluster: one user "tenant", no "postgres"', { skip }, () => {
  assert.deepEqual(state.fresh.users, ['tenant login=true super=true createdb=true createrole=true password=true']);
  assert.equal(state.fresh.own, null);
});

test('the database file stops before it makes anything when the password is missing or too short', { skip }, () => {
  assert.notEqual(state.refused.noPassword.status, 0);
  assert.match(state.refused.noPassword.stderr, /auth_password is not set/);
  assert.notEqual(state.refused.shortPassword.status, 0);
  assert.match(state.refused.shortPassword.stderr, /shorter than 16 characters/);
  assert.deepEqual(state.refused.after, state.fresh);
});

test('the database file makes a user, a database and a schema for the login server, and the role "postgres"', { skip }, () => {
  const made = state.prepared.after;
  // (the database lists them by name, and the name of the first one comes from the settings)
  assert.deepEqual([...made.users].sort(), [
    `${ROLE} login=true super=false createdb=false createrole=false password=true`,
    'tenant login=true super=true createdb=true createrole=true password=true',
    'postgres login=false super=false createdb=false createrole=false password=false',
  ].sort());
  // Its owner has every right on the new database; everybody else has lost the right to connect.
  const database = made.databases.find((line) => line.startsWith(`${DB} `));
  assert.equal(database, `${DB} owner=${ROLE} rights={=T/${ROLE},${ROLE}=CTc/${ROLE}}`);
  assert.deepEqual(made.databases.filter((line) => !line.startsWith(`${DB} `)), state.fresh.databases, 'the other databases are as they were');
  assert.deepEqual(made.settings, [`${DB}/${ROLE} search_path=auth`]);
  assert.ok(made.own.includes(`auth owner=${ROLE} things=0`), made.own.join('; '));
  // The password went in on standard input and nothing was printed.
  assert.equal(state.prepared.stdout, '');
  assert.ok(!state.prepared.stderr.includes(secrets.AUTH_DB_PASSWORD));
});

test('the database "tenant" got nothing', { skip }, () => {
  // Looked at now, after the login server has made its tables and its user.
  const now = snapshot();
  assert.deepEqual(now.tenant, state.fresh.tenant);
  assert.ok(!now.tenant.some((line) => line.startsWith('auth ')), 'no schema "auth" in tenant');
  assert.equal(sql('tenant', "select count(*) from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')"), '0');
});

test('the login server made its tables in its own database, in the schema "auth"', { skip }, () => {
  const tables = sql(DB, "select table_name from information_schema.tables where table_schema = 'auth' order by 1").split('\n');
  for (const table of ['users', 'refresh_tokens', 'sessions', 'oauth_clients']) assert.ok(tables.includes(table), `no table ${table}`);
  assert.equal(sql(DB, "select count(*) from information_schema.tables where table_schema = 'public'"), '0');
  assert.equal(sql(DB, `select count(*) from pg_tables where schemaname = 'auth' and tableowner <> '${ROLE}'`), '0');
});

test('the user of the login server gets in with its password, into its own database, without special rights', { skip }, () => {
  const password = secrets.AUTH_DB_PASSWORD;
  const inside = sqlAsAuthUser(password, DB, "select current_user || ' ' || current_schema()");
  assert.equal(inside.stdout.trim(), `${ROLE} auth`, inside.stderr);
  assert.notEqual(sqlAsAuthUser('not-the-password-not-the-password', DB, 'select 1').status, 0);
  assert.notEqual(sqlAsAuthUser(password, DB, 'create role another_user').status, 0);
  assert.notEqual(sqlAsAuthUser(password, DB, 'create database another_database').status, 0);
  assert.notEqual(sqlAsAuthUser(password, DB, 'select rolpassword from pg_authid').status, 0);
});

// ---- the pod ----------------------------------------------------------------------

test('the login server is the one of pod.yaml, locked, and its health check works', { skip }, () => {
  assert.equal(state.auth.image, 'supabase/gotrue:v2.197.0');
  assert.equal(state.auth.env.GOTRUE_API_HOST, '127.0.0.1');
  assert.equal(state.auth.env.GOTRUE_DB_DATABASE_URL, `postgres://${ROLE}:${secrets.AUTH_DB_PASSWORD}@postgres:5432/${DB}`);
  assert.deepEqual(state.auth.probe, ['wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:9999/health']);
  assert.equal(docker('exec', names.auth, ...state.auth.probe), '');
  assert.equal(docker('exec', names.auth, 'id', '-u'), '1000');
  assert.equal(docker('inspect', '--format', '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}', names.auth), 'true [ALL]');
});

test('from another pod, only the gateway can be reached: not the login server, not the app', { skip }, () => {
  assert.equal(reachableFromAnotherPod(9000), true, 'the gateway');
  assert.equal(reachableFromAnotherPod(9999), false, 'the login server');
  assert.equal(reachableFromAnotherPod(8080), false, 'the app');
  assert.equal(listensInPod(9999) && listensInPod(8080), true, 'inside the pod both answer');
});

test('the user script can run again and changes nothing', { skip }, () => {
  assert.match(createUser('another-password-123'), /the user is already there/);
});

// ---- ChatGPT ----------------------------------------------------------------------

test('without a token, the bridge says where to log in, and the login server describes itself', { skip }, async () => {
  const refused = await mcp(null, 'tools/list');
  assert.equal(refused.status, 401);
  const pointer = /resource_metadata="([^"]+)"/.exec(refused.headers.get('www-authenticate'))[1];
  // The pointer and the resource are on the name for ChatGPT; the login server is on the name of the app.
  assert.equal(pointer, `${mcpUrl}/.well-known/oauth-protected-resource/mcp`);

  const resource = (await call(pointer)).data;
  assert.equal(resource.resource, `${mcpUrl}/mcp`);
  const issuer = resource.authorization_servers[0];
  assert.equal(issuer, `${publicUrl}/auth/v1`);

  // The address a client builds from the login server address (RFC 8414).
  const metadata = (await call(`${publicUrl}/.well-known/oauth-authorization-server/auth/v1`)).data;
  assert.equal(metadata.issuer, issuer);
  for (const name of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'jwks_uri']) {
    assert.ok(metadata[name].startsWith(`${issuer}/`), `${name}: ${metadata[name]}`);
  }
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  // The same document, at the address an OpenID client tries.
  assert.equal((await call(`${issuer}/.well-known/openid-configuration`)).data.issuer, issuer);
  state.metadata = metadata;
});

test('the public key list holds no private key', { skip }, async () => {
  const { keys } = (await call(state.metadata.jwks_uri)).data;
  assert.equal(keys.length, 1);
  assert.equal(keys[0].alg, 'ES256');
  assert.equal(keys[0].d, undefined);
  assert.equal(keys[0].k, undefined);
});

test('an app registers itself', { skip }, async () => {
  const registered = await call(state.metadata.registration_endpoint, {
    method: 'POST',
    json: { client_name: 'ChatGPT', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
  });
  assert.equal(registered.status, 201);
  state.clientId = registered.data.client_id;
});

test('a wrong password gives no login', { skip }, async () => {
  const result = await login({ clientId: state.clientId, password: 'not-the-password' });
  assert.equal(result.loginStatus, 400);
});

test('log in, allow, and get a token that opens the bridge', { skip }, async () => {
  const result = await login({ clientId: state.clientId });
  assert.equal((await call(result.consentPage)).status, 200);
  assert.equal(result.details.client.name, 'ChatGPT');
  assert.equal(result.details.redirect_uri, REDIRECT);

  assert.equal((await result.exchange('a-wrong-verifier-a-wrong-verifier-a-wrong-verifier')).status, 400, 'PKCE: the wrong verifier is refused');
  const tokens = await result.exchange(result.verifier);
  assert.equal(tokens.status, 200);
  assert.equal((await result.exchange(result.verifier)).status, 400, 'a code works once');

  const { head, body } = claims(tokens.data.access_token);
  assert.equal(head.alg, 'ES256');
  assert.equal(body.iss, `${publicUrl}/auth/v1`);
  assert.equal(body.email, EMAIL);
  assert.equal(body.client_id, state.clientId);
  state.tokens = tokens.data;
  state.userToken = result.userToken;
});

test('with the token: list the tools, write a file, read it back', { skip }, async () => {
  const token = state.tokens.access_token;
  const started = await mcp(token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(started.status, 200);
  assert.ok(started.data.result.serverInfo);

  const tools = (await mcp(token, 'tools/list')).data.result.tools.map((tool) => tool.name);
  assert.ok(tools.includes('write_file') && tools.includes('list_directory'), tools.join(', '));

  const written = await mcp(token, 'tools/call', { name: 'write_file', arguments: { path: '/data/notes/from-mcp.md', content: '# Test\n' } });
  assert.notEqual(written.data.result.isError, true, JSON.stringify(written.data));
  assert.equal(readFileSync(join(space, 'notes/from-mcp.md'), 'utf8'), '# Test\n');

  const read = await mcp(token, 'tools/call', { name: 'read_text_file', arguments: { path: '/data/hello.md' } });
  assert.match(JSON.stringify(read.data.result), /Hello from the volume/);

  const outside = await mcp(token, 'tools/call', { name: 'read_text_file', arguments: { path: '/etc/passwd' } });
  assert.equal(outside.data.result.isError, true, 'the bridge reaches only the files of the volume');
});

test('with the token: a request with a compressed body is read too', { skip }, async () => {
  // A client may compress what it sends. The gateway must pass on the header that says so,
  // or the bridge reads the compressed bytes as text and answers 400 "invalid JSON".
  const response = await fetch(`${mcpUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${state.tokens.access_token}`,
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      Accept: 'application/json, text/event-stream',
    },
    body: gzipSync(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 200));
  assert.match(text, /"write_file"/);
});

// The official MCP client, told to ask in the newest protocol version first, as ChatGPT does.
// It is in the image of the bridge. It prints the version it ended up with and the tool names.
const NEWEST_FIRST_CLIENT = `
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const client = new Client({ name: 'newest-first', version: '1' }, { versionNegotiation: { mode: 'auto' } });
const transport = new StreamableHTTPClientTransport(new URL(process.env.MCP_URL), {
  requestInit: { headers: { Authorization: 'Bearer ' + process.env.MCP_TOKEN } },
});
await client.connect(transport);
const { tools } = await client.listTools();
const read = await client.callTool({ name: 'read_text_file', arguments: { path: '/data/hello.md' } });
console.log(JSON.stringify({ version: client.getNegotiatedProtocolVersion(), tools: tools.map((tool) => tool.name), read: JSON.stringify(read).slice(0, 400) }));
await client.close();
`;

test('ChatGPT asks in the protocol version of 2026-07-28 first: it is answered like an older server', { skip }, async () => {
  // What ChatGPT sends first to an MCP address (read from a gateway log, October 2026).
  const response = await fetch(`${mcpUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${state.tokens.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'server/discover',
      'User-Agent': 'openai-mcp/1.0.0',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'openai-mcp-discover',
      method: 'server/discover',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'openai-mcp', version: '1.0.0' }, 'io.modelcontextprotocol/clientCapabilities': {} } },
    }),
  });
  assert.equal(response.status, 400);
  const answer = await response.json();
  assert.equal(answer.error.code, -32000);
  assert.match(answer.error.message, /^Bad Request: Unsupported protocol version: 2026-07-28 \(supported versions: 2025-11-25, /);
  assert.equal(answer.id, null);
});

test('a client that asks in the newest version first goes on with the older handshake and gets the tools', { skip }, () => {
  const script = join(work, 'newest-first-client.mjs');
  writeFileSync(script, NEWEST_FIRST_CLIENT);
  const inside = '/usr/local/lib/node_modules/supergateway/newest-first-client.mjs';
  const told = JSON.parse(docker('run', '--rm', '--network', 'host', '--entrypoint', 'node',
    '-e', `MCP_URL=${mcpUrl}/mcp`, '-e', `MCP_TOKEN=${state.tokens.access_token}`, '-v', `${script}:${inside}:ro`,
    state.bridgeImage, inside));
  assert.equal(told.version, '2025-11-25');
  assert.ok(told.tools.includes('write_file') && told.tools.includes('list_directory'), told.tools.join(', '));
  assert.match(told.read, /Hello from the volume/);
});

test('the two names are kept apart: ChatGPT\'s name has only /mcp, and the name of the app has no /mcp', { skip }, async () => {
  const token = state.tokens.access_token;
  // On the name for ChatGPT: the health check and the two documents, and nothing of the app or the login.
  assert.equal((await call(`${mcpUrl}/healthz`)).status, 200);
  assert.equal((await call(`${mcpUrl}/.well-known/oauth-protected-resource`)).data.resource, `${mcpUrl}/mcp`);
  const notThere = [
    '/', '/login', '/logout', '/static/app.css', '/manifest.webmanifest', '/sw.js', '/offline', '/notes/one',
    '/oauth/consent', '/oauth/consent.js', '/auth/v1/.well-known/jwks.json', '/auth/v1/.well-known/openid-configuration',
    '/.well-known/oauth-authorization-server/auth/v1', `/mcp-${secrets.MCP_SECRET}`,
  ];
  for (const path of notThere) {
    const answer = await call(mcpUrl + path, { token });
    assert.equal(answer.status, 404, path);
    assert.deepEqual(answer.data, { error: 'not_found' }, path);
  }
  assert.equal((await call(`${mcpUrl}/auth/v1/token?grant_type=password`, { method: 'POST', json: { email: EMAIL, password: 'x' } })).status, 404);
  assert.equal((await call(`${mcpUrl}/login`, { method: 'POST', form: { email: EMAIL, password: 'x' } })).status, 404);

  // On the name of the app: no /mcp and no document about it, not even with the token that opens the bridge.
  for (const path of ['/mcp', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    assert.equal((await call(publicUrl + path, { token })).status, 404, path);
  }
  const post = await call(`${publicUrl}/mcp`, { method: 'POST', token, json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(post.status, 404);
  assert.equal(post.headers.get('www-authenticate'), null);
});

test('the second time, the same app is sent back without asking again; "openid" works too', { skip }, async () => {
  const result = await login({ clientId: state.clientId, scope: 'openid email' });
  const tokens = await result.exchange(result.verifier);
  assert.equal(tokens.status, 200);
  assert.ok(tokens.data.id_token, 'an ID token needs the ES256 key of k8s/secrets.mjs');
  assert.equal((await mcp(tokens.data.access_token, 'tools/list')).status, 200);
});

test('the refresh token gives a new token that works', { skip }, async () => {
  const refreshed = await call(state.metadata.token_endpoint, {
    method: 'POST', form: { grant_type: 'refresh_token', refresh_token: state.tokens.refresh_token, client_id: state.clientId },
  });
  assert.equal(refreshed.status, 200);
  assert.equal((await mcp(refreshed.data.access_token, 'tools/list')).status, 200);
  state.tokens = refreshed.data;
});

test('saying "Deny" gives the app no code', { skip }, async () => {
  const other = await call(state.metadata.registration_endpoint, {
    method: 'POST', json: { client_name: 'Another app', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
  });
  const result = await login({ clientId: other.data.client_id, action: 'deny' });
  assert.equal(result.code, undefined);
  assert.equal(result.error, 'access_denied');
});

test('an app cannot ask to be sent to an address it did not register', { skip }, async () => {
  const query = new URLSearchParams({
    response_type: 'code', client_id: state.clientId, redirect_uri: 'https://evil.example/callback',
    code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
  });
  assert.equal((await call(`${state.metadata.authorization_endpoint}?${query}`)).status, 400);
});

test('tokens that must not open the bridge', { skip }, async () => {
  const good = state.tokens.access_token;
  const [head, body, signature] = good.split('.');
  const changed = Buffer.from(JSON.stringify({ ...claims(good).body, email: 'someone@else.test' })).toString('base64url');
  assert.equal((await mcp(`${head}.${changed}.${signature}`, 'tools/list')).status, 401, 'a changed token');
  assert.equal((await mcp(`${head}.${body}.${signature.slice(0, -4)}AAAA`, 'tools/list')).status, 401, 'a changed signature');
  assert.equal((await mcp(secrets.AUTH_SERVICE_KEY, 'tools/list')).status, 401, 'the admin token of the login server');
  assert.equal((await mcp(roleToken('anon', secrets.AUTH_JWT_SECRET), 'tools/list')).status, 401, 'a token signed with the shared secret');
});

test('another user of Supabase Auth, not on the list, gets 403', { skip }, async () => {
  const made = callAuthInPod('/admin/users', { method: 'POST', token: secrets.AUTH_SERVICE_KEY, json: { ...GUEST, email_confirm: true } });
  assert.equal(made.status, 200);
  const session = await call(`${publicUrl}/auth/v1/token?grant_type=password`, { method: 'POST', json: GUEST });
  assert.equal(session.status, 200);
  assert.equal((await mcp(session.data.access_token, 'tools/list')).status, 403);
});

test('from outside: no signup, no admin, no inner bridge address', { skip }, async () => {
  const service = secrets.AUTH_SERVICE_KEY;
  assert.equal((await call(`${publicUrl}/auth/v1/signup`, { method: 'POST', json: { email: 'x@example.test', password: 'password-123456' } })).status, 404);
  assert.equal((await call(`${publicUrl}/auth/v1/admin/users`, { token: service })).status, 404);
  assert.equal((await call(`${publicUrl}/auth/v1/user`, { token: state.userToken })).status, 404);
  // The inner address of the bridge is, from outside, one more address of the app: it needs a session.
  const inner = await call(`${publicUrl}/mcp-${secrets.MCP_SECRET}`, { method: 'POST', json: {} });
  assert.equal(inner.status, 401);
  assert.match(inner.text, /Log in again/);
  // And on the name for ChatGPT there is no signup, no admin and no such address at all.
  assert.equal((await call(`${mcpUrl}/auth/v1/signup`, { method: 'POST', json: { email: 'x@example.test', password: 'password-123456' } })).status, 404);
  assert.equal((await call(`${mcpUrl}/auth/v1/admin/users`, { token: service })).status, 404);
  assert.equal((await call(`${mcpUrl}/mcp-${secrets.MCP_SECRET}`, { method: 'POST', json: {} })).status, 404);
  // And Supabase Auth itself refuses a signup, even when asked directly, inside the pod.
  const direct = callAuthInPod('/signup', { method: 'POST', json: { email: 'x@example.test', password: 'password-123456' } });
  assert.equal(direct.data.error_code, 'signup_disabled');
});

// ---- the browser: the login of the web app ------------------------------------------
// The gateway allows 10 password tries in 10 minutes from one address, and this whole file
// comes from one address: the ChatGPT part above makes 5 of them, this part 3.

test('the web app: a page needs a session, the open paths of the settings do not', { skip }, async () => {
  const page = await call(`${publicUrl}/notes/one?x=1`);
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/login?next=%2Fnotes%2Fone%3Fx%3D1');
  assert.equal((await call(`${publicUrl}/`, { method: 'POST', form: { a: 'b' } })).status, 401);
  // Only what the setting OPEN_PATHS names is open (in the sample settings: /static/).
  for (const path of ['/static/app.css', '/static/img/logo.png']) {
    const open = await call(publicUrl + path);
    assert.equal(open.status, 200, path);
    assert.equal(open.data.url, path);
  }
  for (const path of ['/manifest.webmanifest', '/staticx/app.css', '/static']) {
    assert.equal((await call(publicUrl + path)).status, 303, path);
  }
  const form = await call(`${publicUrl}/login?next=%2Fnotes%2Fone`);
  assert.equal(form.status, 200);
  assert.match(form.text, /<input type=hidden name=next value="\/notes\/one">/);
});

test('the web app: a wrong password gives the login page again, and no session', { skip }, async () => {
  const failed = await logInToApp(EMAIL, 'not-the-password');
  assert.equal(failed.status, 401);
  assert.match(failed.text, /Wrong email or password\./);
  assert.deepEqual(failed.headers.getSetCookie(), []);
});

test('the web app: a user who is not on the list cannot log in', { skip }, async () => {
  const failed = await logInToApp(GUEST.email, GUEST.password);
  assert.equal(failed.status, 401);
  assert.match(failed.text, /Wrong email or password\./);
  assert.deepEqual(failed.headers.getSetCookie(), []);
});

test('the web app: log in with the real user, and the app gets the request without the login', { skip }, async () => {
  const done = await logInToApp(EMAIL, secrets.LOGIN_PASSWORD, '/notes/one?x=1');
  assert.equal(done.status, 303);
  assert.equal(done.headers.get('location'), '/notes/one?x=1');
  const cookies = cookiesSet(done);
  // This test runs on http://: plain names, no "Secure". On the cluster (https) they are "__Host-" cookies.
  assert.deepEqual([...cookies.keys()], ['session-access', 'session-refresh']);
  assert.match(cookies.get('session-access').text, /; Path=\/; Max-Age=3[56]\d\d; HttpOnly; SameSite=Lax$/, 'kept for the hour the token lasts');
  assert.match(cookies.get('session-refresh').text, /; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/);
  const { head, body } = claims(cookies.get('session-access').value);
  assert.equal(head.alg, 'ES256');
  assert.equal(body.email, EMAIL);
  assert.equal(body.iss, `${publicUrl}/auth/v1`);
  state.session = { access: cookies.get('session-access').value, refresh: cookies.get('session-refresh').value };

  const cookie = `session-access=${state.session.access}; theme=dark; session-refresh=${state.session.refresh}`;
  const page = await call(`${publicUrl}/notes/one?x=1`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.data.url, '/notes/one?x=1');
  assert.equal(page.data.headers.cookie, 'theme=dark');
  assert.equal(page.data.headers.authorization, undefined);
  assert.deepEqual(page.headers.getSetCookie(), ['theme=dark; Path=/'], 'the cookie of the app, and no new session cookie');

  const saved = await call(`${publicUrl}/notes/one`, { method: 'POST', form: { answer: 'hello' }, headers: { Cookie: cookie, Origin: publicUrl } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.body, 'answer=hello');
  assert.ok(!saved.text.includes(state.session.access) && !saved.text.includes(state.session.refresh), 'no token reached the app');
  // The same request from another site is refused.
  const foreign = await call(`${publicUrl}/notes/one`, { method: 'POST', form: { answer: 'x' }, headers: { Cookie: cookie, Origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
});

test('the web app: its session opens nothing on the name for ChatGPT', { skip }, async () => {
  const cookie = `session-access=${state.session.access}; session-refresh=${state.session.refresh}`;
  assert.equal((await call(`${publicUrl}/notes/one`, { headers: { Cookie: cookie } })).status, 200, 'it is a good session');
  for (const path of ['/', '/notes/one', '/static/app.css', '/logout']) {
    const answer = await call(mcpUrl + path, { headers: { Cookie: cookie } });
    assert.equal(answer.status, 404, path);
    assert.deepEqual(answer.headers.getSetCookie(), []);
  }
  assert.equal((await call(`${mcpUrl}/notes/one`, { method: 'POST', form: { answer: 'x' }, headers: { Cookie: cookie } })).status, 404);
  // A cookie is not a token: the bridge still wants its own.
  const bridge = await call(`${mcpUrl}/mcp`, { method: 'POST', json: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { Cookie: cookie } });
  assert.equal(bridge.status, 401);
});

test('the web app: the session is renewed with the real refresh token', { skip }, async () => {
  // The browser has dropped the access cookie (it ran out): only the refresh cookie is left.
  const renewed = await call(`${publicUrl}/e/two`, { headers: { Cookie: `session-refresh=${state.session.refresh}` } });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.data.headers.cookie, undefined);
  const cookies = cookiesSet(renewed);
  assert.deepEqual([...cookies.keys()], ['theme', 'session-access', 'session-refresh']);
  assert.notEqual(cookies.get('session-refresh').value, state.session.refresh, 'a refresh token works once: the browser gets the next one');
  assert.equal(claims(cookies.get('session-access').value).body.email, EMAIL);
  state.session = { access: cookies.get('session-access').value, refresh: cookies.get('session-refresh').value };

  // The new access token is a session by itself: no cookie is set again.
  const next = await call(`${publicUrl}/e/three`, { headers: { Cookie: `session-access=${state.session.access}` } });
  assert.equal(next.status, 200);
  assert.deepEqual(next.headers.getSetCookie(), ['theme=dark; Path=/']);

  // Five requests at the same moment, all with the refresh cookie only: every one gets through.
  const together = await Promise.all([1, 2, 3, 4, 5].map((n) => call(`${publicUrl}/e/${n}`, { headers: { Cookie: `session-refresh=${state.session.refresh}` } })));
  assert.deepEqual(together.map((answer) => answer.status), [200, 200, 200, 200, 200]);
  const given = new Set(together.map((answer) => cookiesSet(answer).get('session-refresh').value));
  assert.equal(given.size, 1, 'all five got the same new refresh token');
  const last = cookiesSet(together[0]);
  state.session = { access: last.get('session-access').value, refresh: last.get('session-refresh').value };
});

test('the web app: an answer that got lost on the way does not end the session', { skip }, async () => {
  // On a phone an answer can get lost: the login server has already swapped the refresh token,
  // and the browser still holds the old one. A moment later the browser asks again with that
  // old token. That must still be a session, not the end of it.
  const old = state.session.refresh;
  const lost = await call(`${publicUrl}/e/lost`, { headers: { Cookie: `session-refresh=${old}` } });
  assert.equal(lost.status, 200);
  // Not at the same moment: the gateway joins only requests that arrive together.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const again = await call(`${publicUrl}/e/again`, { headers: { Cookie: `session-refresh=${old}` } });
  assert.equal(again.status, 200, 'the old refresh token, a moment later, is still a session');
  const cookies = cookiesSet(again);
  state.session = { access: cookies.get('session-access').value, refresh: cookies.get('session-refresh').value };
  // The session goes on from the token that the browser got this time.
  const next = await call(`${publicUrl}/e/next`, { headers: { Cookie: `session-refresh=${state.session.refresh}` } });
  assert.equal(next.status, 200);
  const last = cookiesSet(next);
  state.session = { access: last.get('session-access').value, refresh: last.get('session-refresh').value };
});

test('the web app: a session token does not open the admin paths, and a made-up cookie opens nothing', { skip }, async () => {
  assert.equal((await call(`${publicUrl}/auth/v1/admin/users`, { token: state.session.access })).status, 404);
  const forged = `session-access=${secrets.AUTH_SERVICE_KEY}; session-refresh=not-a-refresh-token`;
  const refused = await call(`${publicUrl}/e/one`, { headers: { Cookie: forged } });
  assert.equal(refused.status, 303);
  assert.equal(cookiesSet(refused).get('session-refresh').value, '', 'the dead cookies are removed');
});

test('the web app: logging out ends the session at the login server, and ChatGPT stays connected', { skip }, async () => {
  const cookie = `session-access=${state.session.access}; session-refresh=${state.session.refresh}`;
  assert.equal((await call(`${publicUrl}/logout`)).status, 200);
  const out = await call(`${publicUrl}/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: publicUrl } });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get('location'), '/login');
  const cookies = cookiesSet(out);
  assert.equal(cookies.get('session-access').text, 'session-access=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  assert.equal(cookies.get('session-refresh').text, 'session-refresh=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');

  // The login server was told: the refresh token of that session is dead.
  const after = await call(`${publicUrl}/e/one`, { headers: { Cookie: `session-refresh=${state.session.refresh}` } });
  assert.equal(after.status, 303);
  assert.equal(after.headers.get('location'), '/login?next=%2Fe%2Fone');

  // Only that session was ended. The login of ChatGPT still renews itself and still opens the bridge.
  const refreshed = await call(state.metadata.token_endpoint, {
    method: 'POST', form: { grant_type: 'refresh_token', refresh_token: state.tokens.refresh_token, client_id: state.clientId },
  });
  assert.equal(refreshed.status, 200);
  assert.equal((await mcp(refreshed.data.access_token, 'tools/list')).status, 200);
});

// ---- at the end -------------------------------------------------------------------

test('a second run of the database file changes nothing, and everything still works', { skip }, async () => {
  const count = () => sql(DB, 'select (select count(*) from auth.users) || \' users, \' || (select count(*) from auth.oauth_clients) || \' apps\'');
  const before = { ...snapshot(), rows: count() };
  assert.equal(before.rows, '2 users, 2 apps');
  const again = prepareDatabase(secrets.AUTH_DB_PASSWORD);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout + again.stderr, '', 'nothing to say');
  assert.deepEqual({ ...snapshot(), rows: count() }, before);
  // The password is still the one that was given: a new connection gets in.
  assert.equal(sqlAsAuthUser(secrets.AUTH_DB_PASSWORD, DB, 'select count(*) from users').stdout.trim(), '2');
  // And the login server, which was running all the time, still knows the user.
  const users = callAuthInPod('/admin/users', { token: secrets.AUTH_SERVICE_KEY });
  assert.equal(users.status, 200);
  assert.deepEqual(users.data.users.map((user) => user.email).sort(), [GUEST.email, EMAIL]);
  assert.equal((await mcp(state.tokens.access_token, 'tools/list')).status, 200);
});

test('the files written by the bridge are still there', { skip }, () => {
  assert.ok(existsSync(join(space, 'notes/from-mcp.md')));
});

// ---- the example app in the place of the stand-in -------------------------------------
//
// Until here the web app was a stand-in that answers with what it received. Now the image of
// app/ moves into the pod, with the settings of pod.yaml, and the same login is used on it.

test('the example app moves into the pod, locked, and its health check works', { skip }, async () => {
  const app = fromPodYaml('app');
  assert.equal(app.env.DATA_DIR, '/data');
  docker('rm', '-f', names.app);
  const image = docker('build', '-q', join(ROOT, 'app'));
  docker('run', '-d', '--init', '--name', names.app, '--network', `container:${names.gateway}`, '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '-v', `${space}:/data`,
    '--env-file', envFile('app.env', app.env), image);
  await waitFor('The example app', async () => listensInPod(8080));
  // The health check of pod.yaml, as the kubelet runs it inside the container.
  const yaml = readFileSync(join(ROOT, 'k8s/pod.yaml'), 'utf8');
  const probe = /exec: \{ command: \[python, -c, "(.*)"\] \}/.exec(yaml)?.[1];
  assert.ok(probe, 'pod.yaml has no health check for the app');
  assert.equal(docker('exec', names.app, 'python', '-c', probe), '');
  assert.equal(docker('exec', names.app, 'id', '-u'), '1000');
  assert.equal(reachableFromAnotherPod(8080), false, 'only the gateway next to it reaches the app');
});

test('the example app: its stylesheet is open, every page needs the login', { skip }, async () => {
  const css = await call(`${publicUrl}/static/app.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  for (const path of ['/', '/f/hello.md', '/f/notes/from-mcp.md', '/nothing']) {
    const closed = await call(`${publicUrl}${path}`);
    assert.equal(closed.status, 303, path);
    assert.equal(closed.headers.get('location'), `/login?next=${encodeURIComponent(path)}`, path);
    assert.ok(!closed.text.includes('Hello'), path);
  }
});

test('the example app: with the login it shows the files, also the one that the MCP client wrote', { skip }, async () => {
  const done = await logInToApp(EMAIL, secrets.LOGIN_PASSWORD);
  assert.equal(done.status, 303);
  const cookies = cookiesSet(done);
  state.real = `session-access=${cookies.get('session-access').value}; session-refresh=${cookies.get('session-refresh').value}`;
  const home = await call(`${publicUrl}/`, { headers: { Cookie: state.real } });
  assert.equal(home.status, 200);
  assert.match(home.text, /<h1>You are logged in<\/h1>/);
  assert.match(home.text, /<li><a href="\/f\/hello\.md">hello\.md<\/a><\/li>/);
  assert.match(home.text, /<li><a href="\/f\/notes\/from-mcp\.md">notes\/from-mcp\.md<\/a><\/li>/, 'the file that the bridge wrote');
  assert.match(home.headers.get('content-security-policy'), /^default-src 'none';/, "the app's own headers come through");
  const file = await call(`${publicUrl}/f/notes/from-mcp.md`, { headers: { Cookie: state.real } });
  assert.equal(file.status, 200);
  assert.match(file.text, /<pre># Test\n<\/pre>/);
});

test('the example app: a form goes through the login into a file; a form from another site does not', { skip }, async () => {
  const file = join(space, 'notes/from-the-app.md');
  const form = { name: 'from-the-app', text: 'Written in the app.' };
  const post = (headers) => call(`${publicUrl}/notes`, { method: 'POST', form, headers });

  assert.equal((await post({ Cookie: state.real, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ Cookie: state.real, Origin: 'null', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({ Origin: publicUrl })).status, 401);
  assert.equal(existsSync(file), false, 'nothing was written');

  // As Chrome sends a form of this app: "Origin: null", and the browser's own word that it is from this site.
  const saved = await post({ Cookie: state.real, Origin: 'null', 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get('location'), '/f/notes/from-the-app.md');
  assert.equal(readFileSync(file, 'utf8'), 'Written in the app.\n');
});

test('the example app: the MCP client reads the file that the app wrote', { skip }, async () => {
  const read = await mcp(state.tokens.access_token, 'tools/call', { name: 'read_text_file', arguments: { path: '/data/notes/from-the-app.md' } });
  assert.match(JSON.stringify(read.data.result), /Written in the app\./);
});
