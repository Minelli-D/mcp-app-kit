// The small parts of the browser login of the web app: the pages the gateway writes itself,
// the two session cookies, and the checks on what a visitor sends. No dependencies, and
// nothing here remembers anything.

// ---- pages ---------------------------------------------------------------------

// Text from a visitor, made safe to write into a page.
export function escapeHtml(text) {
  const safe = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text).replace(/[&<>"']/g, (character) => safe[character]);
}

// The pages that the gateway writes itself (login, logout, refusals) have a stylesheet of
// their own, which the gateway serves too: they need nothing of the app. The mark after "?"
// is new with every start of the gateway (so with every deploy): a browser that kept the old
// stylesheet gets the new one at once.
export const STYLE_PATH = '/login/style.css';
const STYLE = `${STYLE_PATH}?v=${Date.now().toString(36)}`;

function page(title, body) {
  return '<!doctype html><html lang=en><head><meta charset=utf-8>\n'
    + '<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
    + `<title>${title}</title><link rel=stylesheet href="${STYLE}"></head><body><main>\n`
    + `${body}</main></body></html>\n`;
}

// The pages for one app. "title" is the name of the app, from the settings (APP_TITLE): it is
// written into the pages as text.
export function pagesFor(title) {
  const name = escapeHtml(title);
  const bar = `<div class=bar><h1>${name}</h1></div>\n`;

  // A page with one sentence and one link. Nothing of the request is written into it.
  const notePage = (message, address, label) => page(name, bar
    + `<p class=warn>${message}</p>\n`
    + `<div class=actions><a class=btn href="${address}">${label}</a></div>\n`);

  return {
    // "message" is a sentence of the gateway. "next" and "email" come from the visitor.
    loginPage({ next = '/', email = '', message = '' } = {}) {
      const typed = email ? ` value="${escapeHtml(email)}"` : '';
      return page('Log in', '<form class=login method=post action="/login">\n'
        + `<p class=app>${name}</p>\n`
        + '<h1>Log in</h1>\n'
        + (message ? `<p class=warn>${escapeHtml(message)}</p>\n` : '')
        + `<div class=write><label for=email>Email</label><input id=email name=email type=email autocomplete=username required${typed}></div>\n`
        + '<div class=write><label for=password>Password</label><input id=password name=password type=password autocomplete=current-password required></div>\n'
        + `<input type=hidden name=next value="${escapeHtml(next)}">\n`
        + '<div class=actions><button class=btn>Log in</button></div>\n'
        + '</form>\n');
    },
    logoutPage() {
      return page('Log out', '<form method=post action="/logout">\n'
        + bar
        + `<p>You are logged in to ${name} on this device.</p>\n`
        + '<div class=actions><button class=btn>Log out</button></div>\n'
        + '</form>');
    },
    loginAgain: notePage('You are not logged in any more. Nothing was saved.', '/login', 'Log in again'),
    otherSite: notePage('This request came from another site, so it was not done.', '/', `Back to ${name}`),
  };
}

// ---- cookies -------------------------------------------------------------------

export const REFRESH_COOKIE_SECONDS = 30 * 24 * 3600;

const SECURE_NAMES = { access: '__Host-session-access', refresh: '__Host-session-refresh' };
const PLAIN_NAMES = { access: 'session-access', refresh: 'session-refresh' };
const EVERY_SESSION_COOKIE = new Set([...Object.values(SECURE_NAMES), ...Object.values(PLAIN_NAMES)]);

// A browser takes a "__Host-" cookie only over https, from this exact host and for the whole
// site. On plain http (local tests) such a cookie cannot exist: there the names are plain.
export function cookieNames(secure) {
  return secure ? SECURE_NAMES : PLAIN_NAMES;
}

// One Set-Cookie line. A script cannot read the cookie (HttpOnly) and a form on another
// site cannot send it (SameSite). Zero seconds removes the cookie.
export function setCookie(name, value, seconds, secure) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function cookieParts(header) {
  return (typeof header === 'string' ? header : '').split(';').map((part) => part.trim()).filter(Boolean);
}

// The cookies of a request: name -> value. A value that cannot be read is left out.
export function readCookies(header) {
  const cookies = new Map();
  for (const part of cookieParts(header)) {
    const at = part.indexOf('=');
    if (at < 1 || cookies.has(part.slice(0, at))) continue;
    try {
      cookies.set(part.slice(0, at), decodeURIComponent(part.slice(at + 1)));
    } catch {
      // Not written by the gateway.
    }
  }
  return cookies;
}

// The Cookie header for the app: every cookie but the login. Undefined when nothing is left.
export function withoutSessionCookies(header) {
  const kept = cookieParts(header).filter((part) => !EVERY_SESSION_COOKIE.has(part.split('=')[0]));
  return kept.length ? kept.join('; ') : undefined;
}

// ---- checks on what a visitor sends ----------------------------------------------

const MAX_NEXT_LENGTH = 2000;
// Tab, new line and the like. A browser drops some of them from an address, so "/<tab>/evil"
// would become "//evil": another site.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

// Where to go after the login. The visitor (or a link somebody sent him) chooses this value,
// so it is used only when it is a plain path of this site. Anything else gives the first page.
export function safeNext(value) {
  if (typeof value !== 'string' || value.length > MAX_NEXT_LENGTH) return '/';
  if (!value.startsWith('/') || value.includes('//') || value.includes('\\') || CONTROL_CHARACTERS.test(value)) return '/';
  let url;
  try {
    url = new URL(`http://gateway${value}`);
  } catch {
    return '/';
  }
  // Written the way a browser sends it: only characters that are safe in a header.
  const next = url.pathname + url.search;
  return url.host === 'gateway' && !next.startsWith('//') ? next : '/';
}

// True when a request that changes something does not come from another site. A browser
// says where a request comes from; a request without these headers (curl, an old browser)
// is let through, because it cannot have been made by a page of another site in a browser of today.
//
// "Origin: null" is what a browser sends when it may not say where a form comes from: Chrome
// does so for every form of a page that was served with "Referrer-Policy: no-referrer". It is
// taken only together with "Sec-Fetch-Site: same-origin": the browser writes that header
// itself, and no page can.
export function fromThisSite(headers, origin) {
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  if (headers.origin === 'null') return site === 'same-origin';
  return headers.origin === undefined || headers.origin === origin;
}
