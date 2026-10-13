// The gateway: the only public door of the pod.
//
//   /mcp                  An MCP client (ChatGPT, Claude). Needs a valid login token from Supabase Auth, then goes to the bridge.
//   /auth/v1/...          Supabase Auth, but only the few paths the OAuth login needs.
//   /.well-known/...      The two documents an MCP client reads to find the login server.
//   /oauth/consent        The page where I log in and allow (or deny) an app.
//   /login, /logout       The login of the web app. The session is two cookies.
//   every other address   The web app, passed through unchanged. A few of its files are open
//                         to everybody; all the rest needs a session.
//
// It has no dependencies and cannot make a login token: it checks tokens with the
// PUBLIC key that Supabase Auth publishes. It never accepts a token it did not check,
// and it never passes a token on to the bridge or to the app.
//
// One public name (PUBLIC_URL) or two: with MCP_PUBLIC_URL, ChatGPT has a name of its own.
// Then /mcp and its two documents answer on that name only, and everything else on the
// first name only. The "Host" of a request says which name was asked for.

import http from 'node:http';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  REFRESH_COOKIE_SECONDS, STYLE_PATH, cookieNames, escapeHtml, fromThisSite, pagesFor,
  readCookies, safeNext, setCookie, withoutSessionCookies,
} from './session.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const MAX_MCP_BODY = 8 * 1024 * 1024;
const MAX_AUTH_BODY = 64 * 1024;
const MAX_APP_BODY = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const CLOCK_LEEWAY_SECONDS = 30;
const JWKS_MAX_AGE_MS = 10 * 60_000;
const JWKS_RETRY_AFTER_MS = 10_000;
const JWKS_TIMEOUT_MS = 5000;
const AUTH_TIMEOUT_MS = 10_000;
const MAX_EMAIL_LENGTH = 320;

// How many requests one address may make, and how many everybody together may make.
const LIMITS = {
  login: { windowMs: 10 * 60_000, perClient: 10, total: 50 },
  register: { windowMs: 60 * 60_000, perClient: 30, total: 100 },
  token: { windowMs: 10 * 60_000, perClient: 120, total: 600 },
};

// The only Supabase Auth paths that are reachable from outside. Everything else
// (admin, signup, password recovery, ...) answers 404.
const AUTH_ROUTES = [
  { method: 'GET', path: /^\/\.well-known\/(jwks\.json|openid-configuration|oauth-authorization-server)$/ },
  { method: 'GET', path: /^\/oauth\/authorize$/ },
  { method: 'POST', path: /^\/oauth\/token$/, limit: 'token' },
  { method: 'POST', path: /^\/oauth\/clients\/register$/, limit: 'register' },
  { method: 'GET', path: /^\/oauth\/userinfo$/ },
  { method: 'GET', path: /^\/oauth\/authorizations\/[A-Za-z0-9_-]{1,128}$/ },
  { method: 'POST', path: /^\/oauth\/authorizations\/[A-Za-z0-9_-]{1,128}\/consent$/ },
  // The login of the consent page. Only the password login, nothing else of /token.
  { method: 'POST', path: /^\/token$/, limit: 'login', query: 'grant_type=password' },
];

// An MCP client builds these two addresses from the login server address ".../auth/v1".
const DISCOVERY_ALIASES = {
  '/.well-known/oauth-authorization-server/auth/v1': '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration/auth/v1': '/.well-known/openid-configuration',
};

// A path that starts with one of these names belongs to the gateway and never goes to the app.
const OWN_NAMES = /^\/(?:mcp|auth|oauth|\.well-known)(?:\/|$)/;

// The paths of the app that anybody may read without the login (the setting OPEN_PATHS): its
// stylesheet, its pictures, what a phone fetches without cookies. They must hold nothing
// private. An entry that ends with "/" opens everything under it; any other entry is one
// exact path. Only an address written plainly counts: no "..", no "%", no "//", nothing that
// the app could read in another way than the gateway does.
const DEFAULT_OPEN_PATHS = ['/static/'];
const PLAIN_PATH = /^(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/;

function openPathTest(entries) {
  return (path) => PLAIN_PATH.test(path)
    && entries.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const SIGNATURES = {
  ES256: { keyType: 'ec', options: { dsaEncoding: 'ieee-p1363' } },
  RS256: { keyType: 'rsa', options: {} },
};

const CONSENT_FILES = {
  '/oauth/consent': ['consent.html', 'text/html; charset=utf-8'],
  '/oauth/consent.js': ['consent.js', 'text/javascript; charset=utf-8'],
  '/oauth/consent.css': ['consent.css', 'text/css; charset=utf-8'],
};

const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

// The pages the gateway writes for the web app (login, logout, refusals). They hold no
// script: they may load the stylesheet of the app and its fonts, and send a form to this site.
const OWN_PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

// ---- settings ----------------------------------------------------------------

function httpUrl(name, value, { anyScheme = false } = {}) {
  let url;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new Error(`${name} must be a full address, like http://name:port`);
  }
  if (url.protocol !== 'http:' && !(anyScheme && url.protocol === 'https:')) {
    throw new Error(`${name} must start with http://${anyScheme ? ' or https://' : ''}`);
  }
  return value.replace(/\/+$/, '');
}

// A host name with its port, written one way, so that two of them can be compared: small
// letters, no dot at the end of the name, and no port when it is the usual one of the
// scheme. Null for a text that is not a host name.
function hostKey(host, protocol) {
  if (typeof host !== 'string' || !/^[A-Za-z0-9._\-[\]:]+$/.test(host)) return null;
  let url;
  try {
    url = new URL(`${protocol}//${host}`);
  } catch {
    return null;
  }
  const name = url.hostname.replace(/\.$/, '');
  return name ? name + (url.port ? `:${url.port}` : '') : null;
}

// The second public name, for ChatGPT. Without the setting, or with the same address as the
// first name, there is one name: { url: the first name, host: null }.
function mcpName(value, publicUrl) {
  if (!value) return { url: publicUrl, host: null };
  const url = new URL(httpUrl('MCP_PUBLIC_URL', value, { anyScheme: true }));
  if (url.pathname !== '/') throw new Error('MCP_PUBLIC_URL must not have a path');
  const first = new URL(publicUrl);
  if (url.origin === first.origin) return { url: publicUrl, host: null };
  const host = hostKey(url.host, url.protocol);
  if (host === hostKey(first.host, first.protocol)) {
    throw new Error('MCP_PUBLIC_URL must have another host name or port than PUBLIC_URL (or be the same address): the gateway tells the two apart by the "Host" of a request');
  }
  // Written the way a client writes it: small letters, no usual port.
  return { url: url.origin, host };
}

export function loadConfig(env) {
  const allowedEmails = new Set(
    (env.ALLOWED_EMAILS ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean),
  );
  if (allowedEmails.size === 0) throw new Error('ALLOWED_EMAILS is not set: nobody could use the bridge');
  const publicUrl = httpUrl('PUBLIC_URL', env.PUBLIC_URL, { anyScheme: true });
  if (new URL(publicUrl).pathname !== '/') throw new Error('PUBLIC_URL must not have a path');
  const mcp = mcpName(env.MCP_PUBLIC_URL, publicUrl);
  return {
    publicUrl,
    // The address of /mcp for ChatGPT, and the "Host" that means it (null: there is one name).
    mcpPublicUrl: mcp.url,
    mcpHost: mcp.host,
    authUrl: httpUrl('AUTH_URL', env.AUTH_URL),
    mcpUpstreamUrl: httpUrl('MCP_UPSTREAM_URL', env.MCP_UPSTREAM_URL),
    appUpstreamUrl: env.APP_UPSTREAM_URL ? httpUrl('APP_UPSTREAM_URL', env.APP_UPSTREAM_URL) : null,
    allowedEmails,
    appTitle: appTitle(env.APP_TITLE),
    mcpVersions: listOf('MCP_VERSIONS', env.MCP_VERSIONS, DEFAULT_MCP_VERSIONS, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
    openPaths: listOf('OPEN_PATHS', env.OPEN_PATHS, DEFAULT_OPEN_PATHS, /^\/[A-Za-z0-9._\/-]*$/),
    port: Number(env.PORT ?? 9000),
  };
}

// The name of the app on the pages of the gateway: one short line. "App" when it is not set.
function appTitle(value) {
  const title = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (title.length > 60) throw new Error('APP_TITLE is longer than 60 characters');
  return title || 'App';
}

// A setting that is a list with commas between its entries. Not set or empty: the usual list.
function listOf(name, value, usual, shape) {
  const entries = String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return usual;
  for (const entry of entries) {
    if (!shape.test(entry) || entry.includes('..') || entry.includes('//')) throw new Error(`${name} has an entry that cannot be used: ${entry}`);
  }
  return entries;
}

// ---- small helpers -----------------------------------------------------------

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return res.destroy();
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function sendPage(res, status, html, headers = {}) {
  if (res.headersSent) return res.destroy();
  const data = Buffer.from(html);
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': data.length,
    ...OWN_PAGE_HEADERS,
    ...headers,
  });
  res.end(data);
}

// The Set-Cookie header for a list of cookies. No header for an empty list.
function withCookies(cookies) {
  return cookies.length > 0 ? { 'Set-Cookie': cookies } : {};
}

function redirect(res, address, cookies = []) {
  res.writeHead(303, { Location: address, 'Content-Length': 0, 'Cache-Control': 'no-store', ...withCookies(cookies) });
  res.end();
}

// Reads a small form. Gives null when it is larger than a login form can be.
function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_AUTH_BODY) resolve(null);
      else chunks.push(chunk);
    });
    req.on('end', () => {
      const isForm = (req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded');
      resolve(new URLSearchParams(isForm ? Buffer.concat(chunks).toString('utf8') : ''));
    });
    req.on('error', reject);
  });
}

function clientAddress(req) {
  // ingress-nginx sets X-Real-IP itself, so a visitor cannot choose it.
  const fromProxy = req.headers['x-real-ip'];
  return (typeof fromProxy === 'string' && fromProxy) || req.socket.remoteAddress || 'unknown';
}

function createLimiter(now) {
  const counters = new Map();
  return function allowed(name, client) {
    const limit = LIMITS[name];
    const time = now();
    if (counters.size > 10_000) {
      for (const [key, counter] of counters) if (counter.resetAt <= time) counters.delete(key);
    }
    let ok = true;
    for (const [key, max] of [[`${name}|${client}`, limit.perClient], [`${name}|*`, limit.total]]) {
      let counter = counters.get(key);
      if (!counter || counter.resetAt <= time) {
        counter = { count: 0, resetAt: time + limit.windowMs };
        counters.set(key, counter);
      }
      counter.count += 1;
      if (counter.count > max) ok = false;
    }
    return ok;
  };
}

// ---- login tokens ------------------------------------------------------------

// One request to the login server, with a JSON answer. It always ends: with the answer
// ({ status, data }; data is null when the answer is not JSON) or with an error.
function askJson(url, { method = 'GET', headers = {}, body, timeoutMs = JWKS_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? null : JSON.stringify(body);
    const sent = text === null ? headers : { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) };
    const request = http.request(url, { method, headers: sent }, (answer) => {
      const chunks = [];
      let size = 0;
      answer.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_AUTH_BODY) request.destroy(new Error('the answer is too large'));
        else chunks.push(chunk);
      });
      answer.on('end', () => {
        let data = null;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // Not JSON: the caller gets null.
        }
        resolve({ status: answer.statusCode, data });
      });
      answer.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('no answer in time')));
    request.on('error', reject);
    request.end(text ?? undefined);
  });
}

class TokenError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

function createTokenChecker(config, now) {
  const issuer = `${config.publicUrl}/auth/v1`;
  let keys = new Map();
  let fetchedAt = -Infinity;
  let loading = null;

  async function loadKeys() {
    const { status, data } = await askJson(`${config.authUrl}/.well-known/jwks.json`);
    if (status !== 200) throw new Error(`the key list answered ${status}`);
    if (!data) throw new Error('the key list is not JSON');
    const fresh = new Map();
    for (const jwk of data.keys ?? []) {
      if (!jwk.kid || !SIGNATURES[jwk.alg]) continue;
      if (jwk.alg === 'ES256' && jwk.crv !== 'P-256') continue;
      try {
        fresh.set(jwk.kid, { alg: jwk.alg, key: createPublicKey({ key: jwk, format: 'jwk' }) });
      } catch {
        // A key this program cannot read is skipped: tokens signed with it are refused.
      }
    }
    keys = fresh;
    fetchedAt = now();
  }

  async function keyFor(kid) {
    const age = now() - fetchedAt;
    if (age > JWKS_MAX_AGE_MS || (!keys.has(kid) && age > JWKS_RETRY_AFTER_MS)) {
      loading ??= loadKeys().finally(() => { loading = null; });
      try {
        await loading;
      } catch (error) {
        // An old key list is still good enough for a key that is already known.
        if (!keys.has(kid)) throw new TokenError(`Cannot read the key list: ${error.message}`, 503);
      }
    }
    return keys.get(kid);
  }

  return async function check(token) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new TokenError('The token is not a JWT');
    let header;
    let claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new TokenError('The token cannot be read');
    }
    // Only public-key signatures. This refuses "none" and tokens signed with a shared secret.
    const signature = SIGNATURES[header?.alg];
    if (!signature || typeof header.kid !== 'string') throw new TokenError('The token has the wrong kind of signature');
    const known = await keyFor(header.kid);
    if (!known || known.alg !== header.alg || known.key.asymmetricKeyType !== signature.keyType) {
      throw new TokenError('The token is signed with an unknown key');
    }
    let valid = false;
    try {
      valid = verifySignature(
        'sha256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        { key: known.key, ...signature.options },
        Buffer.from(parts[2], 'base64url'),
      );
    } catch {
      // A signature of the wrong shape is a wrong signature.
    }
    if (!valid) throw new TokenError('The token signature is wrong');

    const seconds = now() / 1000;
    if (typeof claims?.exp !== 'number' || claims.exp + CLOCK_LEEWAY_SECONDS < seconds) throw new TokenError('The token has expired');
    if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_LEEWAY_SECONDS > seconds) throw new TokenError('The token is not valid yet');
    if (claims.iss !== issuer) throw new TokenError('The token comes from another login server');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes('authenticated') || claims.role !== 'authenticated' || claims.is_anonymous === true) {
      throw new TokenError('The token is not the token of a logged-in user');
    }
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
    if (!config.allowedEmails.has(email)) throw new TokenError('This user may not use the bridge', 403);
    return claims;
  };
}

// ---- passing a request on ----------------------------------------------------

// "only" names the headers that are copied; "prefix" adds every header whose name starts so.
function copyHeaders(source, { only, prefix, without = [] } = {}) {
  const out = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name === 'host' || without.includes(name)) continue;
    if (only && !only.includes(name) && !(prefix && name.startsWith(prefix))) continue;
    out[name] = value;
  }
  return out;
}

// What a request said about itself, for the log line of a request that the bridge refused.
// Never the token, a cookie or the body: only these headers, each cut short.
const LOGGED_HEADERS = {
  type: 'content-type',
  encoding: 'content-encoding',
  length: 'content-length',
  transfer: 'transfer-encoding',
  accept: 'accept',
  version: 'mcp-protocol-version',
  rpc: 'mcp-method',
  agent: 'user-agent',
};
const LOGGED_HEADER_LENGTH = 80;

// Every header of the MCP protocol starts with these letters ("Mcp-Session-Id",
// "Mcp-Protocol-Version", and since 2026-07-28 "Mcp-Method", "Mcp-Name", "Mcp-Param-...").
const MCP_HEADERS = 'mcp-';
// The protocol versions that the bridge can serve (the setting MCP_VERSIONS). A stdio MCP
// server from before 2026-07-28 (the version without "initialize") cannot answer that
// version, and the bridge alone gives such a request half an answer. So any version that is
// not in the list is answered here, in the words of an MCP server of before: the client
// (ChatGPT asks in the newest version first) then goes on with the older handshake.
// Add a version only when the MCP server behind the bridge can really answer it.
const DEFAULT_MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const LOGGED_ANSWER_LENGTH = 300;
const LOGGED_BODY_BYTES = 8;

function sentFacts(headers) {
  const facts = {};
  for (const [name, header] of Object.entries(LOGGED_HEADERS)) {
    if (headers[header] !== undefined) facts[name] = String(headers[header]).slice(0, LOGGED_HEADER_LENGTH);
  }
  return facts;
}

// "path" replaces the path of the target, and is sent exactly as it is written: an address
// inside "target" would be tidied first ("/a/../b" becomes "/b").
// "cookies" are cookies of the gateway itself: they go on the answer next to the cookies
// that the answer already has.
// "responsePrefix": headers of the answer that are passed on because their name starts so.
// "onRefused" is called when the other side answers 400 or more, with the start of that
// answer and the first bytes of the body that was sent ("start", as numbers).
function forward(req, res, target, { headers, maxBody, path, responseHeaders, responsePrefix, extraResponseHeaders = {}, cookies = [], onRefused }) {
  let start = '';
  const upstream = http.request(target, { method: req.method, headers, ...(path ? { path } : {}) }, (answer) => {
    const answerHeaders = { ...copyHeaders(answer.headers, { only: responseHeaders, prefix: responsePrefix }), ...extraResponseHeaders };
    if (cookies.length > 0) answerHeaders['set-cookie'] = [...(answerHeaders['set-cookie'] ?? []), ...cookies];
    if (onRefused && answer.statusCode >= 400) {
      let text = '';
      answer.on('data', (chunk) => {
        if (text.length < LOGGED_ANSWER_LENGTH) text += chunk.toString();
      });
      answer.on('end', () => onRefused({ start, answer: text.slice(0, LOGGED_ANSWER_LENGTH) }));
    }
    res.writeHead(answer.statusCode, answerHeaders);
    answer.pipe(res);
  });
  // The time limit is only for the START of the answer: an answer can be a long stream.
  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('timeout')));
  upstream.on('response', () => upstream.setTimeout(0));
  upstream.on('error', () => {
    if (res.headersSent) res.destroy();
    else sendJson(res, 502, { error: 'bad_gateway' }, withCookies(cookies));
  });
  res.on('close', () => upstream.destroy());

  let received = 0;
  req.on('data', (chunk) => {
    if (received === 0) start = chunk.subarray(0, LOGGED_BODY_BYTES).toString('hex');
    received += chunk.length;
    if (received > maxBody) {
      req.unpipe(upstream);
      upstream.destroy();
      sendJson(res, 413, { error: 'too_large' }, { Connection: 'close', ...withCookies(cookies) });
    }
  });
  req.pipe(upstream);
}

// ---- the server --------------------------------------------------------------

export function createGateway(config, { now = Date.now, log = () => {} } = {}) {
  const checkToken = createTokenChecker(config, now);
  const allowed = createLimiter(now);
  // /mcp and its documents are on the MCP name. The login server stays on the first name.
  const mcpPublicUrl = config.mcpPublicUrl ?? config.publicUrl;
  const mcpHost = config.mcpHost ?? null;
  const mcpProtocol = new URL(mcpPublicUrl).protocol;
  const resource = `${mcpPublicUrl}/mcp`;
  const metadataUrl = `${mcpPublicUrl}/.well-known/oauth-protected-resource/mcp`;
  // The name of the app, for the pages. In the consent page it stands where "{{APP_TITLE}}" is.
  const appTitle = config.appTitle ?? 'App';
  const pages = pagesFor(appTitle);
  const files = Object.fromEntries(Object.entries(CONSENT_FILES).map(([path, [file, type]]) => [
    path,
    { body: Buffer.from(readFileSync(HERE + file, 'utf8').replaceAll('{{APP_TITLE}}', escapeHtml(appTitle))), type },
  ]));
  const style = readFileSync(`${HERE}style.css`);
  const mcpVersions = config.mcpVersions ?? DEFAULT_MCP_VERSIONS;
  const isOpen = openPathTest(config.openPaths ?? DEFAULT_OPEN_PATHS);
  // The session of the web app.
  const secure = config.publicUrl.startsWith('https://');
  const origin = new URL(config.publicUrl).origin;
  const cookieName = cookieNames(secure);
  const noCookies = [setCookie(cookieName.access, '', 0, secure), setCookie(cookieName.refresh, '', 0, secure)];
  const renewals = new Map();
  // The logins that are on their way to the login server: see login().
  const logins = new Map();
  // More words for the log line of an answer: why /mcp said no.
  const notes = new WeakMap();
  const appPrefix = config.appUpstreamUrl ? new URL(config.appUpstreamUrl).pathname.replace(/\/$/, '') : '';

  function toAuth(req, res, path, query, limit) {
    if (limit && !allowed(limit, clientAddress(req))) {
      return sendJson(res, 429, { error: 'too_many_requests' }, { 'Retry-After': '600' });
    }
    forward(req, res, `${config.authUrl}${path}${query}`, {
      headers: {
        ...copyHeaders(req.headers, { only: ['content-type', 'content-length', 'accept', 'authorization'] }),
        'x-forwarded-for': clientAddress(req),
      },
      maxBody: MAX_AUTH_BODY,
      responseHeaders: ['content-type', 'content-length', 'location', 'www-authenticate', 'retry-after'],
      extraResponseHeaders: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  async function toBridge(req, res) {
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
      return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST, GET, DELETE' });
    }
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(req.headers.authorization ?? '');
    if (!match) {
      notes.set(res, { why: 'no token' });
      return sendJson(res, 401, { error: 'unauthorized' }, {
        'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}"`,
      });
    }
    try {
      await checkToken(match[1]);
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      notes.set(res, { why: error.message });
      if (error.status !== 401) {
        const name = error.status === 403 ? 'forbidden' : 'temporarily_unavailable';
        return sendJson(res, error.status, { error: name, error_description: error.message });
      }
      return sendJson(res, 401, { error: 'invalid_token', error_description: error.message }, {
        'WWW-Authenticate': `Bearer error="invalid_token", error_description="${error.message}", resource_metadata="${metadataUrl}"`,
      });
    }
    const version = req.headers['mcp-protocol-version'];
    if (version !== undefined && !mcpVersions.includes(version)) {
      notes.set(res, { why: 'this protocol version is not served', sent: sentFacts(req.headers) });
      return sendJson(res, 400, {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: `Bad Request: Unsupported protocol version: ${version.slice(0, 40)} (supported versions: ${mcpVersions.join(', ')})`,
        },
        id: null,
      });
    }
    // The login token stops here: the bridge never sees it.
    // What describes the body must go with it: without "content-encoding" the bridge reads a
    // compressed body as text, and without the headers of the protocol it answers that the
    // headers do not match the body.
    forward(req, res, config.mcpUpstreamUrl, {
      headers: copyHeaders(req.headers, {
        only: ['content-type', 'content-length', 'content-encoding', 'accept', 'last-event-id'],
        prefix: MCP_HEADERS,
      }),
      maxBody: MAX_MCP_BODY,
      responseHeaders: ['content-type', 'content-length', 'cache-control'],
      responsePrefix: MCP_HEADERS,
      // Tells nginx to send each piece of a stream at once.
      extraResponseHeaders: { 'X-Accel-Buffering': 'no' },
      onRefused: ({ start, answer }) => {
        notes.set(res, { why: 'the bridge said no', sent: { ...sentFacts(req.headers), start }, answer });
      },
    });
  }

  // ---- the login of the web app ----

  // One call of the gateway itself to the login server. The visitor's address goes with it:
  // the login server counts the tries of each address.
  function askAuth(path, { client, body, bearer }) {
    return askJson(`${config.authUrl}${path}`, {
      method: 'POST',
      headers: { 'x-forwarded-for': client, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body,
      timeoutMs: AUTH_TIMEOUT_MS,
    });
  }

  // True when the token passes every check that /mcp makes.
  async function trusted(token) {
    try {
      await checkToken(token);
      return true;
    } catch (error) {
      if (error instanceof TokenError) return false;
      throw error;
    }
  }

  // The session in a pair of tokens from the login server. The access token is checked
  // like any other: an answer of the login server is not trusted because it is an answer.
  async function sessionFrom(tokens) {
    if (typeof tokens?.access_token !== 'string' || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
      throw new TokenError('The login server gave no tokens');
    }
    const claims = await checkToken(tokens.access_token);
    return { access: tokens.access_token, refresh: tokens.refresh_token, expires: claims.exp };
  }

  // The access token is kept until it runs out, the refresh token for 30 days.
  function sessionCookies(session) {
    const seconds = Math.max(0, Math.floor(session.expires - now() / 1000));
    return [
      setCookie(cookieName.access, session.access, seconds, secure),
      setCookie(cookieName.refresh, session.refresh, REFRESH_COOKIE_SECONDS, secure),
    ];
  }

  async function passwordLogin(email, password, client) {
    if (!email || !password) throw new TokenError('The form is not filled in');
    const { status, data } = await askAuth('/token?grant_type=password', { client, body: { email, password } });
    if (status !== 200) throw new TokenError('The login server said no');
    return sessionFrom(data);
  }

  // A new pair of tokens for a refresh token. Null when the login server says the refresh
  // token is no good; an error when the login server is in trouble or gives a bad token.
  async function renew(refresh, client) {
    const { status, data } = await askAuth('/token?grant_type=refresh_token', { client, body: { refresh_token: refresh } });
    if (status >= 400 && status < 500 && status !== 429) return null;
    if (status !== 200) throw new Error(`the login server answered ${status}`);
    return sessionFrom(data);
  }

  // A refresh token works once. Requests that arrive together with the same one share one call.
  function renewOnce(refresh, client) {
    let running = renewals.get(refresh);
    if (!running) {
      running = renew(refresh, client).finally(() => renewals.delete(refresh));
      renewals.set(refresh, running);
    }
    return running;
  }

  // Looks for the session of a request. "cookies" are the cookies to set on the answer:
  // the new pair after a renewal, or two empty ones when the session is over for good.
  async function findSession(req) {
    const sent = readCookies(req.headers.cookie);
    const access = sent.get(cookieName.access);
    if (access && await trusted(access)) return { open: true, cookies: [] };
    const refresh = sent.get(cookieName.refresh);
    if (!refresh) return { open: false, cookies: [] };
    try {
      const session = await renewOnce(refresh, clientAddress(req));
      return session ? { open: true, cookies: sessionCookies(session) } : { open: false, cookies: noCookies };
    } catch (error) {
      // A new token that fails the checks: the session is over.
      if (error instanceof TokenError && error.status !== 503) return { open: false, cookies: noCookies };
      // The login server is in trouble: the cookies stay, a later request tries again.
      log({ error: `renewal: ${error.message}` });
      return { open: false, cookies: [] };
    }
  }

  async function login(req, res, url) {
    if (req.method === 'GET') {
      return sendPage(res, 200, pages.loginPage({ next: safeNext(url.searchParams.get('next')) }));
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
    const form = await readForm(req);
    if (!form) return sendJson(res, 413, { error: 'too_large' }, { Connection: 'close' });
    const next = safeNext(form.get('next'));
    const email = (form.get('email') ?? '').trim();
    const again = (status, message, headers) => {
      sendPage(res, status, pages.loginPage({ next, email: email.length <= MAX_EMAIL_LENGTH ? email : '', message }), headers);
    };
    // A tap on the button while the same login is still on its way joins it: one call to the
    // login server and one count for all of them. The password check is slow on purpose, and
    // five of them at once made every one slower, and used up the tries of the address.
    const password = form.get('password') ?? '';
    const key = createHash('sha256').update(JSON.stringify([clientAddress(req), email, password])).digest('hex');
    let running = logins.get(key);
    if (!running) {
      // The same counter as the login of the consent page: it is the same password.
      if (!allowed('login', clientAddress(req))) {
        return again(429, 'Too many tries. Wait a few minutes.', { 'Retry-After': '600' });
      }
      running = passwordLogin(email, password, clientAddress(req)).finally(() => logins.delete(key));
      logins.set(key, running);
    }
    let session;
    try {
      session = await running;
    } catch (error) {
      if (!(error instanceof TokenError)) log({ error: `login: ${error.message}` });
      // The same words for every kind of failure: the page does not say which part was wrong.
      return again(401, 'Wrong email or password.');
    }
    redirect(res, next, sessionCookies(session));
  }

  // Tells the login server that this session is over. Only this one: ChatGPT keeps its own.
  // The login server wants an access token that is still good, so one that ran out is renewed first.
  async function endSession(req) {
    const sent = readCookies(req.headers.cookie);
    let access = sent.get(cookieName.access);
    if (!access || !(await trusted(access))) {
      const refresh = sent.get(cookieName.refresh);
      access = refresh ? (await renewOnce(refresh, clientAddress(req)))?.access : null;
    }
    if (access) await askAuth('/logout?scope=local', { client: clientAddress(req), bearer: access });
  }

  async function logout(req, res) {
    if (req.method === 'GET') return sendPage(res, 200, pages.logoutPage());
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
    if (!fromThisSite(req.headers, origin)) return sendPage(res, 403, pages.otherSite);
    try {
      await endSession(req);
    } catch {
      // Best effort: the cookies are cleared in any case.
    }
    redirect(res, '/login', noCookies);
  }

  // Everything that is not the gateway's own is the app's. Returns the kind of request, for the log.
  async function toApp(req, res) {
    const reading = req.method === 'GET' || req.method === 'HEAD';
    // The path exactly as it was sent, because that is what the app gets.
    const sentPath = req.url.split('?', 1)[0];
    let cookies = [];
    if (!(reading && isOpen(sentPath))) {
      if (!reading && !fromThisSite(req.headers, origin)) {
        sendPage(res, 403, pages.otherSite);
        return 'app-refused';
      }
      const session = await findSession(req);
      cookies = session.cookies;
      if (!session.open) {
        if (reading) redirect(res, `/login?next=${encodeURIComponent(req.url)}`, cookies);
        else sendPage(res, 401, pages.loginAgain, withCookies(cookies));
        return 'app-login';
      }
    }
    // The login stops here: the app gets neither the two cookies nor a token in a header.
    const cookie = withoutSessionCookies(req.headers.cookie);
    forward(req, res, config.appUpstreamUrl, {
      path: `${appPrefix}${req.url}`,
      headers: {
        ...copyHeaders(req.headers, { without: ['cookie', 'authorization'] }),
        ...(cookie ? { cookie } : {}),
        'x-forwarded-for': clientAddress(req),
      },
      maxBody: MAX_APP_BODY,
      cookies,
    });
    return 'app';
  }

  // Answers the request and returns the kind of request it was, for the log.
  async function handle(req, res) {
    // Only a path of this site. "GET http://another.site/..." is not one.
    let url = null;
    try {
      if (req.url.startsWith('/')) url = new URL(`http://gateway${req.url}`);
    } catch {
      // An address that cannot be read is refused like any other that is not a path.
    }
    if (!url) {
      sendJson(res, 400, { error: 'bad_request' });
      return 'unknown';
    }
    const path = url.pathname;
    const onlyGet = () => {
      if (req.method === 'GET') return true;
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      return false;
    };

    // With two public names each name answers only its own addresses, and the "Host" of the
    // request says which name it is. Any other "Host", or none, is the first name (the
    // kubelet asks for /healthz that way). "X-Forwarded-Host" is not read: a visitor writes it.
    const onMcpName = mcpHost !== null && hostKey(req.headers.host, mcpProtocol) === mcpHost;
    const mcpIsHere = mcpHost === null || onMcpName;

    if (path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return 'health';
    }

    if (mcpIsHere && path === '/mcp') {
      await toBridge(req, res);
      return 'mcp';
    }

    const isResourceDocument = path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp';
    // On the MCP name nothing else answers. On the first name of two, /mcp and its documents
    // do not: they fall through to the end, where the gateway's own names give 404.
    if (onMcpName && !isResourceDocument) {
      sendJson(res, 404, { error: 'not_found' });
      return 'unknown';
    }

    if (mcpIsHere && isResourceDocument) {
      if (onlyGet()) {
        sendJson(res, 200, {
          resource,
          authorization_servers: [`${config.publicUrl}/auth/v1`],
          bearer_methods_supported: ['header'],
          scopes_supported: ['email'],
          resource_name: `${appTitle}: MCP`,
        });
      }
      return 'metadata';
    }

    if (DISCOVERY_ALIASES[path]) {
      if (onlyGet()) toAuth(req, res, DISCOVERY_ALIASES[path], '');
      return 'discovery';
    }

    if (path.startsWith('/auth/v1/')) {
      const authPath = path.slice('/auth/v1'.length);
      const route = AUTH_ROUTES.find((r) => r.method === req.method && r.path.test(authPath));
      if (!route || (route.query && url.search !== `?${route.query}`)) {
        sendJson(res, 404, { error: 'not_found' });
        return 'auth-blocked';
      }
      toAuth(req, res, authPath, url.search, route.limit);
      return 'auth';
    }

    if (files[path]) {
      if (onlyGet()) {
        const { body, type } = files[path];
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, ...PAGE_HEADERS });
        res.end(body);
      }
      return 'consent';
    }

    if (config.appUpstreamUrl && !OWN_NAMES.test(path)) {
      if (path === '/login') {
        await login(req, res, url);
        return 'login';
      }
      // The stylesheet of the gateway's own pages. A day in the browser's memory: its address
      // on the pages changes with every start of the gateway.
      if (path === STYLE_PATH) {
        if (onlyGet()) {
          res.writeHead(200, {
            'Content-Type': 'text/css; charset=utf-8',
            'Content-Length': style.length,
            'Cache-Control': 'public, max-age=86400',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(style);
        }
        return 'login';
      }
      if (path === '/logout') {
        await logout(req, res);
        return 'logout';
      }
      return toApp(req, res);
    }

    sendJson(res, 404, { error: 'not_found' });
    return 'unknown';
  }

  const server = http.createServer((req, res) => {
    const started = now();
    let route = null;
    let over = false;
    // The log names the kind of request, never the path: paths and queries hold secrets.
    // The line is written when the answer is over AND its kind is known: an answer that is
    // written at once is over before "handle" has said what kind of request it was.
    // A refusal on /mcp adds why (see "notes").
    const writeLine = () => {
      if (over && route) log({ route, method: req.method, status: res.statusCode, ms: now() - started, ...notes.get(res) });
    };
    res.on('close', () => {
      over = true;
      writeLine();
    });
    handle(req, res).then(
      (name) => { route = name; },
      (error) => {
        route = 'error';
        log({ error: String(error?.message ?? error) });
        sendJson(res, 500, { error: 'server_error' });
      },
    ).then(writeLine);
  });
  // Longer than the 60 s that nginx keeps an idle connection open.
  server.keepAliveTimeout = 75_000;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    console.error(`gateway: ${error.message}`);
    process.exit(1);
  }
  const server = createGateway(config, {
    log: (entry) => {
      if (entry.route !== 'health') console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));
    },
  });
  server.listen(config.port, '0.0.0.0', () => console.log(`gateway: listening on :${config.port} for ${config.publicUrl}`));
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  });
}
